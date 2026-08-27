import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_QUERY_STATUSES,
  cancelAstrolabeWarehouseQueries,
  createDatabricksWarehouseCancellationTransport,
  type ActiveQueryStatus,
  type QueryHistoryPage,
  type QueryHistoryRow,
  type WarehouseCancellationTransport,
} from './warehouse-cancellation';

const WAREHOUSE = 'warehouse-123';
const OWNER = 'reader@example.com';

function astrolabeTags(extra: Record<string, string> = {}): Record<string, string> {
  return { application: 'Astrolabe', ...extra };
}

function row(queryId: string, tags: unknown, extra: Partial<QueryHistoryRow> = {}): QueryHistoryRow {
  return {
    query_id: queryId,
    status: 'RUNNING',
    warehouse_id: WAREHOUSE,
    executed_as_user_name: OWNER,
    query_tags: tags,
    ...extra,
  };
}

function staticTransport(rows: QueryHistoryRow[], cancel?: (statementId: string) => Promise<void>) {
  const cancelled: string[] = [];
  const transport: WarehouseCancellationTransport = {
    listQueries({ status }) {
      return Promise.resolve({ res: status === 'RUNNING' ? rows : [] });
    },
    async cancelStatement(statementId) {
      cancelled.push(statementId);
      await cancel?.(statementId);
    },
  };
  return { transport, cancelled };
}

describe('owner cancellation boundary', () => {
  it('cancels only the signed-in owner matching the tagged run or correlation', async () => {
    const secretSql = 'SELECT private_player_name FROM secret_catalog.hidden.players';
    const rows = [
      row('own-run', astrolabeTags({ run_id: 'run-1' }), { query_text: secretSql }),
      row('own-correlation', astrolabeTags({ correlation_id: 'corr-1' })),
      row('other-run', astrolabeTags({ run_id: 'run-2' })),
      row('other-user', astrolabeTags({ run_id: 'run-1' }), {
        executed_as_user_name: 'other@example.com',
      }),
      row('submitter-is-not-owner', astrolabeTags({ run_id: 'run-1' }), {
        executed_as_user_name: 'other@example.com',
        user_name: OWNER,
      }),
      row('other-app', { application: 'SomethingElse', run_id: 'run-1' }),
      row('wrong-case-app', { application: 'astrolabe', run_id: 'run-1' }),
      row('catalog-explorer', undefined, {
        query_source: { source_name: 'Catalog Explorer' },
      }),
      row('unknown-source', undefined),
    ];
    const { transport, cancelled } = staticTransport(rows);

    const result = await cancelAstrolabeWarehouseQueries({
      warehouseId: WAREHOUSE,
      scope: {
        mode: 'owner',
        signedInEmail: 'READER@example.com',
        runId: 'run-1',
        correlationId: 'corr-1',
      },
      transport,
      sleep: () => Promise.resolve(),
    });

    expect(cancelled).toEqual(['own-run', 'own-correlation']);
    expect(result).toEqual({
      matched: 2,
      cancel_requested: 2,
      already_finished_or_raced: 0,
      refused: 0,
      failed: 0,
      details: [
        { query_id: 'own-run', query_status: 'RUNNING', outcome: 'cancel_requested' },
        { query_id: 'own-correlation', query_status: 'RUNNING', outcome: 'cancel_requested' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(secretSql);
    expect(JSON.stringify(result)).not.toContain('private_player_name');
  });
});

describe('admin cancellation boundary', () => {
  it('cancels all and only exactly Astrolabe-tagged active queries', async () => {
    const rows = [
      row('array-tags', [
        { key: 'application', value: 'Astrolabe' },
        { key: 'run_id', value: 'run-array' },
      ]),
      row('map-tags', astrolabeTags({ run_id: 'run-map' }), {
        executed_as_user_name: 'someone-else@example.com',
      }),
      row('other-app', { application: 'Catalog Explorer' }),
      row('untagged-catalog-explorer', undefined, {
        query_source: { source_name: 'Catalog Explorer' },
      }),
      row('wrong-warehouse', astrolabeTags(), { warehouse_id: 'warehouse-other' }),
      row('finished-despite-filter', astrolabeTags(), { status: 'FINISHED' }),
      row('conflicting-application-tags', [
        { key: 'application', value: 'Astrolabe' },
        { key: 'application', value: 'OtherApp' },
      ]),
    ];
    const { transport, cancelled } = staticTransport(rows);

    const result = await cancelAstrolabeWarehouseQueries({
      warehouseId: WAREHOUSE,
      scope: { mode: 'admin' },
      transport,
      sleep: () => Promise.resolve(),
    });

    expect(cancelled).toEqual(['array-tags', 'map-tags']);
    expect(result.matched).toBe(2);
    expect(result.cancel_requested).toBe(2);
  });
});

describe('bounded Query History sweep', () => {
  it('lists every active status separately, paginates twice, and de-duplicates statement IDs', async () => {
    const calls: Array<{
      warehouseId: string;
      status: ActiveQueryStatus;
      pageToken?: string;
      maxResults: number;
    }> = [];
    const cancelled: string[] = [];
    let runningPass = 0;
    const transport: WarehouseCancellationTransport = {
      listQueries(input): Promise<QueryHistoryPage> {
        calls.push(input);
        if (input.status !== 'RUNNING') return Promise.resolve({ res: [] });
        if (input.pageToken === 'running-page-2') {
          return Promise.resolve({
            res: [row('first-visible', astrolabeTags()), row('from-page-two', astrolabeTags())],
          });
        }
        runningPass += 1;
        if (runningPass === 1) {
          return Promise.resolve({
            res: [row('first-visible', astrolabeTags())],
            next_page_token: 'running-page-2',
            has_next_page: true,
          });
        }
        return Promise.resolve({
          res: [row('first-visible', astrolabeTags()), row('late-visible', astrolabeTags())],
        });
      },
      cancelStatement(statementId) {
        cancelled.push(statementId);
        return Promise.resolve();
      },
    };
    const sleep = vi.fn(() => Promise.resolve());

    const result = await cancelAstrolabeWarehouseQueries({
      warehouseId: WAREHOUSE,
      scope: { mode: 'admin' },
      transport,
      sleep,
    });

    expect(new Set(calls.map(({ status }) => status))).toEqual(new Set(ACTIVE_QUERY_STATUSES));
    for (const status of ACTIVE_QUERY_STATUSES) {
      expect(calls.filter((call) => call.status === status && call.pageToken === undefined)).toHaveLength(2);
    }
    expect(calls.filter((call) => call.pageToken === 'running-page-2')).toHaveLength(1);
    expect(calls.every((call) => call.warehouseId === WAREHOUSE && call.maxResults === 999)).toBe(true);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);
    expect(cancelled).toEqual(['first-visible', 'from-page-two', 'late-visible']);
    expect(result.matched).toBe(3);
    expect(result.cancel_requested).toBe(3);
    expect(result.details).toHaveLength(3);
  });
});

describe('cancel result honesty', () => {
  it('separates races, refusals, and failures without returning provider messages', async () => {
    const rows = [
      row('raced-409', astrolabeTags()),
      row('not-running', astrolabeTags()),
      row('refused-403', astrolabeTags()),
      row('failed-500', astrolabeTags()),
    ];
    const { transport } = staticTransport(rows, (statementId) => {
      if (statementId === 'raced-409') {
        throw Object.assign(new Error('conflict'), { statusCode: 409 });
      }
      if (statementId === 'not-running') {
        throw Object.assign(new Error('Statement is not in a running state: SELECT secret_value'), {
          status: 400,
        });
      }
      if (statementId === 'refused-403') {
        throw Object.assign(new Error('PERMISSION_DENIED for SELECT secret_value'), { statusCode: 403 });
      }
      throw Object.assign(new Error('Internal failure while cancelling SELECT secret_value'), {
        response: { status: 500 },
      });
    });

    const result = await cancelAstrolabeWarehouseQueries({
      warehouseId: WAREHOUSE,
      scope: { mode: 'admin' },
      transport,
      sleep: () => Promise.resolve(),
    });

    expect(result).toMatchObject({
      matched: 4,
      cancel_requested: 0,
      already_finished_or_raced: 2,
      refused: 1,
      failed: 1,
    });
    expect(result.details).toEqual([
      {
        query_id: 'raced-409',
        query_status: 'RUNNING',
        outcome: 'already_finished_or_raced',
        provider_status: 409,
      },
      {
        query_id: 'not-running',
        query_status: 'RUNNING',
        outcome: 'already_finished_or_raced',
        provider_status: 400,
      },
      {
        query_id: 'refused-403',
        query_status: 'RUNNING',
        outcome: 'refused',
        provider_status: 403,
      },
      {
        query_id: 'failed-500',
        query_status: 'RUNNING',
        outcome: 'failed',
        provider_status: 500,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret_value');
    expect(JSON.stringify(result)).not.toContain('PERMISSION_DENIED');
  });
});

describe('Databricks low-level transport', () => {
  it('uses Query History and per-statement cancel only, never a warehouse lifecycle API', async () => {
    const requests: Array<{
      path: string;
      method: 'GET' | 'POST';
      headers: Headers;
      raw: false;
      query?: unknown;
    }> = [];
    const transport = createDatabricksWarehouseCancellationTransport({
      request(options) {
        requests.push(options);
        return Promise.resolve(
          options.method === 'GET'
            ? {
                res: [row('statement/with space', astrolabeTags())],
                next_page_token: 'next+page',
                has_next_page: true,
              }
            : {}
        );
      },
    });

    const page = await transport.listQueries({
      warehouseId: WAREHOUSE,
      status: 'COMPILING',
      pageToken: 'prior+page',
      maxResults: 999,
    });
    await transport.cancelStatement('statement/with space');

    expect(page.next_page_token).toBe('next+page');
    expect(requests.every(({ headers }) => headers instanceof Headers)).toBe(true);
    expect(requests.map(({ headers: _headers, ...request }) => request)).toEqual([
      {
        path: '/api/2.0/sql/history/queries',
        method: 'GET',
        raw: false,
        query: {
          filter_by: {
            warehouse_ids: [WAREHOUSE],
            statuses: ['COMPILING'],
          },
          include_metrics: false,
          max_results: 999,
          page_token: 'prior+page',
        },
      },
      {
        path: '/api/2.0/sql/statements/statement%2Fwith%20space/cancel',
        method: 'POST',
        raw: false,
      },
    ]);
    expect(requests.some(({ path }) => path.includes('/warehouses/') || path.endsWith('/stop'))).toBe(false);
  });
});
