import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response } from 'express';

import {
  configuredResourceName,
  forgetWorkspaceId,
  GENIE_APP_ACTIVITY_QUERY,
  lookupVectorConnection,
  QUESTION_COST_RUNS_QUERY,
  RESOURCE_ACTIVITY_QUERY,
  setupOpsRoutes,
} from './ops-routes';
import type { InsightsAppKit } from './insights-routes';
import type { OpsCostPayload } from '../../shared/ops-contract';
import { USER_MONITORING_ACTIVITY_QUERY } from '../lib/user-spend';

const saved = {
  host: process.env.DATABRICKS_HOST,
  warehouse: process.env.DATABRICKS_SQL_WAREHOUSE_ID,
  endpoint: process.env.DATABRICKS_SERVING_ENDPOINT_NAME,
  app: process.env.DATABRICKS_APP_NAME,
  dataGenie: process.env.PLAYER_INSIGHTS_DATA_GENIE_ID,
  dataTitle: process.env.PLAYER_INSIGHTS_DATA_GENIE_TITLE,
  dictGenie: process.env.PLAYER_INSIGHTS_DICTIONARY_GENIE_ID,
  dictTitle: process.env.PLAYER_INSIGHTS_DICTIONARY_GENIE_TITLE,
  index: process.env.PLAYER_INSIGHTS_SEMANTIC_INDEX,
  semanticEndpoint: process.env.PLAYER_INSIGHTS_SEMANTIC_ENDPOINT,
  rebuildJob: process.env.PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID,
};

const ENV_NAMES: Record<keyof typeof saved, string> = {
  host: 'DATABRICKS_HOST',
  warehouse: 'DATABRICKS_SQL_WAREHOUSE_ID',
  endpoint: 'DATABRICKS_SERVING_ENDPOINT_NAME',
  app: 'DATABRICKS_APP_NAME',
  dataGenie: 'PLAYER_INSIGHTS_DATA_GENIE_ID',
  dataTitle: 'PLAYER_INSIGHTS_DATA_GENIE_TITLE',
  dictGenie: 'PLAYER_INSIGHTS_DICTIONARY_GENIE_ID',
  dictTitle: 'PLAYER_INSIGHTS_DICTIONARY_GENIE_TITLE',
  index: 'PLAYER_INSIGHTS_SEMANTIC_INDEX',
  semanticEndpoint: 'PLAYER_INSIGHTS_SEMANTIC_ENDPOINT',
  rebuildJob: 'PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID',
};

beforeEach(() => {
  forgetWorkspaceId();
  process.env.DATABRICKS_HOST = 'https://workspace.example.test';
  process.env.DATABRICKS_SQL_WAREHOUSE_ID = 'warehouse-1';
  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'agent-endpoint';
  process.env.DATABRICKS_APP_NAME = 'player-insights';
  delete process.env.PLAYER_INSIGHTS_DATA_GENIE_ID;
  delete process.env.PLAYER_INSIGHTS_DATA_GENIE_TITLE;
  delete process.env.PLAYER_INSIGHTS_DICTIONARY_GENIE_ID;
  delete process.env.PLAYER_INSIGHTS_DICTIONARY_GENIE_TITLE;
  delete process.env.PLAYER_INSIGHTS_SEMANTIC_INDEX;
  delete process.env.PLAYER_INSIGHTS_SEMANTIC_ENDPOINT;
  delete process.env.PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID;
});

afterEach(() => {
  forgetWorkspaceId();
  for (const [key, value] of Object.entries(saved) as Array<[keyof typeof saved, string | undefined]>) {
    const name = ENV_NAMES[key];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the ranged cost route', () => {
  it('reads the current model configuration resource descriptor shape', () => {
    const configured = {
      index_name: 'catalog.schema.semantic_index',
      endpoint_name: 'semantic-endpoint',
      status: 'ONLINE',
    };
    expect(configuredResourceName(configured, ['index_name', 'name'])).toBe('catalog.schema.semantic_index');
    expect(configuredResourceName(configured, ['endpoint_name', 'endpoint'])).toBe('semantic-endpoint');
    expect(configuredResourceName({ value: true }, ['value'])).toBe('true');
  });

  it('establishes an exact active-index relationship only for a one-index endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ endpoint_name: 'semantic-endpoint' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ num_indexes: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      ) as typeof fetch;
    await expect(
      lookupVectorConnection({
        host: 'https://workspace.example.test',
        token: 'redacted',
        index: 'catalog.schema.semantic_index',
        configuredEndpoint: 'semantic-endpoint',
        fetchImpl,
      })
    ).resolves.toEqual({ endpoint: 'semantic-endpoint', endpointIndexCount: 1, reason: '' });
  });

  it('keeps shared, absent-key, and failed endpoint metadata unavailable', async () => {
    const sharedFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ endpoint_name: 'shared-endpoint' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ num_indexes: 3 }), { status: 200 })) as typeof fetch;
    await expect(
      lookupVectorConnection({
        host: 'https://workspace.example.test',
        token: 'redacted',
        index: 'catalog.schema.semantic_index',
        fetchImpl: sharedFetch,
      })
    ).resolves.toMatchObject({ endpoint: 'shared-endpoint', endpointIndexCount: 3 });

    const absentFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ name: 'index-without-endpoint' }), { status: 200 })
      ) as typeof fetch;
    await expect(
      lookupVectorConnection({
        host: 'https://workspace.example.test',
        token: 'redacted',
        index: 'catalog.schema.semantic_index',
        fetchImpl: absentFetch,
      })
    ).resolves.toMatchObject({ endpointIndexCount: null, reason: 'The active index named no endpoint.' });

    const failedFetch = vi.fn().mockRejectedValue(new Error('permission denied')) as typeof fetch;
    const failed = await lookupVectorConnection({
      host: 'https://workspace.example.test',
      token: 'redacted',
      index: 'catalog.schema.semantic_index',
      fetchImpl: failedFetch,
    });
    expect(failed.endpointIndexCount).toBeNull();
    expect(failed.reason).toContain('permission denied');
  });

  it('uses the active index host when the released endpoint is stale', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ endpoint_name: 'active-endpoint' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ num_indexes: 1 }), { status: 200 })) as typeof fetch;
    const evidence = await lookupVectorConnection({
      host: 'https://workspace.example.test',
      token: 'redacted',
      index: 'catalog.schema.semantic_index',
      configuredEndpoint: 'stale-released-endpoint',
      fetchImpl,
    });
    expect(evidence).toEqual({
      endpoint: 'active-endpoint',
      endpointIndexCount: 1,
      reason: '',
      drift: 'Released endpoint stale-released-endpoint differs from the active index host active-endpoint.',
    });
  });

  it('attributes legacy Genie traces by configured space without double-counting current resource calls', () => {
    expect(RESOURCE_ACTIVITY_QUERY).toContain("trace->'genie_spaces'");
    expect(RESOURCE_ACTIVITY_QUERY).toContain("space->>'id' = c.resource_id");
    expect(RESOURCE_ACTIVITY_QUERY).toContain('AND NOT EXISTS');
    expect(RESOURCE_ACTIVITY_QUERY).toContain('COALESCE(a.calls, 0) + COALESCE(l.calls, 0)');
    expect(GENIE_APP_ACTIVITY_QUERY).toContain("(r.completed_at AT TIME ZONE 'UTC')::date");
    expect(GENIE_APP_ACTIVITY_QUERY).toContain("resource->>'id' = configured.space_id");
    expect(GENIE_APP_ACTIVITY_QUERY).toContain("space->>'id' = configured.space_id");
    expect(GENIE_APP_ACTIVITY_QUERY).toContain('AND NOT EXISTS');
  });

  it('passes complete-day bounds to billing and the run ledger', async () => {
    let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
    const app = {
      get: (path: string, registered: (req: Request, res: Response) => Promise<void>) => {
        if (path === '/api/ops/cost') handler = registered;
      },
      post: () => {},
    } as unknown as Application;
    const lakebase = vi.fn((sql: string) =>
      Promise.resolve({
        rows: sql.includes('SELECT email, role, added_by, added_at')
          ? [
              {
                email: 'active@example.test',
                role: 'consumer',
                added_by: 'admin@example.test',
                added_at: new Date('2026-08-01T00:00:00Z'),
              },
              {
                email: 'session-only@example.test',
                role: 'consumer',
                added_by: 'admin@example.test',
                added_at: new Date('2026-08-02T00:00:00Z'),
              },
            ]
          : sql === USER_MONITORING_ACTIVITY_QUERY
            ? [
                {
                  user_email: 'active@example.test',
                  questions: 2,
                  runs: 1,
                  first_active: new Date('2026-08-16T10:00:00Z'),
                  last_active: new Date('2026-08-16T12:00:00Z'),
                },
                {
                  user_email: 'session-only@example.test',
                  questions: 0,
                  runs: 0,
                  first_active: new Date('2026-08-17T10:00:00Z'),
                  last_active: new Date('2026-08-17T10:00:00Z'),
                },
              ]
            : [
                {
                  run_id: 'run-1',
                  correlation_id: 'req-00000000-0000-0000-0000-000000000001',
                  trace_id: 'trace-1',
                  completed_at: new Date('2026-08-16T12:00:00Z'),
                  total_tokens: '250',
                  runs_in_range: 1,
                  token_covered_runs: 1,
                  total_recorded_tokens: '250',
                },
              ],
      })
    );
    const statementBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn((input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/preview/scim/v2/Me')) {
        return Promise.resolve(
          new globalThis.Response('{}', {
            status: 200,
            headers: { 'x-databricks-org-id': 'workspace-1' },
          })
        );
      }
      statementBodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
      return Promise.resolve(
        new globalThis.Response(
          JSON.stringify({
            status: { state: 'SUCCEEDED' },
            result: {
              data_array: [
                ['serving-endpoint', '12', 'USD', '7', null, '2026-08-16'],
                ['sql-warehouse', '7', 'USD', '7', null, '2026-08-16'],
                ['__range', null, 'USD', '7', null, '2026-08-16'],
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    }) as typeof fetch;

    setupOpsRoutes(
      {
        lakebase: { query: lakebase },
        servingTransport: () => Promise.reject(new Error('serving must not be asked')),
        server: { extend: (register: (target: Application) => void) => register(app) },
      } as unknown as InsightsAppKit,
      {
        isAdminRoute: () => true,
        now: () => Date.parse('2026-08-18T12:00:00Z'),
        fetchImpl,
        readAppBillingTag: () => Promise.resolve('matched'),
        readFirstAppDeployment: () => Promise.resolve({ deployedAt: '2026-01-01T00:00:00Z' }),
        queryHistoryTransport: {
          listQueries: () =>
            Promise.resolve({
              res: [
                {
                  query_id: 'astrolabe-query-1',
                  warehouse_id: 'warehouse-1',
                  query_tags: { application: 'Astrolabe', surface: 'benchmark', tool: 'genie_result' },
                  metrics: { execution_time_ms: 100 },
                },
              ],
            }),
        },
      }
    );

    let payload = {} as OpsCostPayload;
    await handler!(
      {
        query: { from: '2026-08-10', to: '2026-08-17' },
        headers: {},
        header: (name: string) => (name === 'x-forwarded-access-token' ? 'caller-token' : undefined),
      } as unknown as Request,
      { json: (body: OpsCostPayload) => (payload = body) } as unknown as Response
    );

    expect(payload.period).toBe('current_month');
    expect(payload.range).toEqual({ from: '2026-08-01', to: '2026-08-17' });
    expect(payload.billingLagDays).toBe(1);
    expect(lakebase).toHaveBeenCalledWith(QUESTION_COST_RUNS_QUERY, ['2026-08-01', '2026-08-17']);
    expect(statementBodies[0].parameters).toEqual(
      expect.arrayContaining([
        { name: 'from_day', value: '2026-08-01', type: 'DATE' },
        { name: 'to_day', value: '2026-08-17', type: 'DATE' },
      ])
    );
    expect(payload.perQuestion.runs[0].parts.map((part) => part.id)).toEqual(
      expect.arrayContaining(['serving-endpoint', 'foundation-model', 'sql-warehouse', 'genie'])
    );
    expect(payload.budgets).toEqual({ total: { USD: null, DBU: null }, resources: {} });
    expect(payload.budgetsReadable).toBe(true);
    expect(payload.recentMonthlySpend?.map((month) => month.month)).toEqual(['2026-07', '2026-06', '2026-05']);
    expect(payload.honesty?.priceSource).toBe('list_prices');
    expect(payload.honesty?.contractRates).toBe('unavailable');

    await handler!(
      {
        query: { from: '2026-08-10', to: '2026-08-17', userBrowse: '1' },
        headers: {},
        header: (name: string) =>
          name === 'x-forwarded-access-token'
            ? 'caller-token'
            : name === 'x-forwarded-email'
              ? 'admin@example.test'
              : undefined,
      } as unknown as Request,
      { json: (body: OpsCostPayload) => (payload = body) } as unknown as Response
    );
    expect(payload.userMonitoring?.users.map((row) => row.email).sort()).toEqual([
      'active@example.test',
      'session-only@example.test',
    ]);
    expect(payload.userMonitoring?.pagination.total).toBe(2);
    expect(
      payload.userMonitoring?.users.every(
        (row) => row.lastActive === null || Number.isFinite(Date.parse(row.lastActive))
      )
    ).toBe(true);
  });

  it('traces configured Vector Search identity, activity, USD, and DBUs into one allocated tile', async () => {
    let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
    const app = {
      get: (path: string, registered: (req: Request, res: Response) => Promise<void>) => {
        if (path === '/api/ops/cost') handler = registered;
      },
      post: () => {},
    } as unknown as Application;
    const lakebase = vi.fn((sql: string) => {
      if (sql === RESOURCE_ACTIVITY_QUERY) {
        return Promise.resolve({
          rows: [
            { tile_id: 'genie:data', astrolabe_calls: '3', observed_calls: '4' },
            { tile_id: 'genie:dictionary', astrolabe_calls: '2', observed_calls: '2' },
            { tile_id: 'vector-search', astrolabe_calls: '5', observed_calls: '7' },
          ],
        });
      }
      if (sql.includes('cost_budgets')) {
        return Promise.resolve({
          rows: [
            {
              settings: {
                total: 250,
                resources: {
                  'app-compute': 40,
                  'index-rebuild-job': 30,
                },
              },
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    process.env.PLAYER_INSIGHTS_DATA_GENIE_ID = 'space-data';
    process.env.PLAYER_INSIGHTS_DATA_GENIE_TITLE = 'Player data';
    process.env.PLAYER_INSIGHTS_DICTIONARY_GENIE_ID = 'space-dictionary';
    process.env.PLAYER_INSIGHTS_DICTIONARY_GENIE_TITLE = 'Dictionary';
    process.env.PLAYER_INSIGHTS_SEMANTIC_INDEX = 'cat.schema.index';
    process.env.PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID = 'job-123';
    const fetchImpl = vi.fn((input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/preview/scim/v2/Me')) {
        return Promise.resolve(
          new globalThis.Response('{}', {
            status: 200,
            headers: { 'x-databricks-org-id': 'workspace-1' },
          })
        );
      }
      if (url.includes('/vector-search/indexes/')) {
        return Promise.resolve(
          new globalThis.Response(JSON.stringify({ endpoint_name: 'vs-endpoint-from-connections' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (url.includes('/vector-search/endpoints/')) {
        return Promise.resolve(
          new globalThis.Response(JSON.stringify({ num_indexes: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      const statement =
        typeof init?.body === 'string' ? ((JSON.parse(init.body) as { statement?: string }).statement ?? '') : '';
      if (statement.includes('WITH configured_spaces AS')) {
        return Promise.resolve(
          new globalThis.Response(
            JSON.stringify({
              status: { state: 'SUCCEEDED' },
              result: {
                data_array: [
                  [
                    '2026-08-17',
                    'person@example.test',
                    'human',
                    'GENIE_CODE',
                    'UI',
                    'PAYGO',
                    'GENIE_FREE_USAGE',
                    'space-data',
                    'query-history-exact',
                    '12.5',
                    '0',
                    '0',
                    '0',
                    '0',
                    '1',
                    '2026-08-17',
                  ],
                  [
                    '2026-08-17',
                    'person@example.test',
                    'human',
                    'GENIE_ONE',
                    'UI',
                    'PAYGO',
                    'GENIE_FREE_USAGE',
                    'space-dictionary',
                    'query-history-allocation',
                    '3',
                    '0',
                    '0',
                    '0',
                    '0',
                    '1',
                    '2026-08-17',
                  ],
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(
        new globalThis.Response(
          JSON.stringify({
            status: { state: 'SUCCEEDED' },
            result: {
              data_array: [
                [
                  'component',
                  'vector-search',
                  '14',
                  'USD',
                  '1',
                  '2',
                  null,
                  '2026-08-17',
                  '8',
                  '0',
                  '2',
                  '0',
                  '',
                  'priced',
                  '0',
                  '0',
                  '2026-01-01T00:00:00Z',
                  '0',
                  '2',
                  '2',
                  '6',
                  '1',
                ],
                [
                  'component',
                  'app-compute',
                  '21',
                  'USD',
                  '1',
                  '2',
                  null,
                  '2026-08-17',
                  '7',
                  '0',
                  '2',
                  '0',
                  '',
                  'priced',
                  '0',
                  '0',
                  '2026-01-01T00:00:00Z',
                  '2',
                  '0',
                  '1',
                  '7',
                  '1',
                ],
                [
                  'range',
                  '__range',
                  null,
                  'USD',
                  '1',
                  '2',
                  null,
                  '2026-08-17',
                  '8',
                  '0',
                  '2',
                  '0',
                  '',
                  '',
                  '0',
                  '0',
                  '2026-01-01T00:00:00Z',
                  '0',
                  '2',
                  '2',
                  '6',
                  '1',
                ],
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );
    }) as typeof fetch;

    setupOpsRoutes(
      {
        lakebase: { query: lakebase },
        servingTransport: () => Promise.reject(new Error('serving must not be asked')),
        server: { extend: (register: (target: Application) => void) => register(app) },
      } as unknown as InsightsAppKit,
      {
        isAdminRoute: () => true,
        now: () => Date.parse('2026-08-18T12:00:00Z'),
        fetchImpl,
        readAppBillingTag: () => Promise.resolve('matched'),
        readFirstAppDeployment: () => Promise.resolve({ deployedAt: '2026-01-01T00:00:00Z' }),
        queryHistoryTransport: { listQueries: () => Promise.resolve({ res: [] }) },
        readOrchestratorReport: () =>
          Promise.resolve({
            report: {
              checked_at: '2026-08-18T12:00:00Z',
              status: 'ok',
              principal: 'app',
              principal_resolved: true,
              table_source: 'release',
              build_sha: 'abc',
              configuration: [
                {
                  key: 'semantic_index',
                  env_var: '',
                  value: {
                    index_name: 'cat.schema.index',
                    endpoint_name: 'vs-endpoint-from-connections',
                    status: 'ONLINE',
                  },
                  source: 'artifact',
                  mutability: 'baked',
                  baked: true,
                  required: false,
                },
              ],
              checks: [],
              assumptions: [],
              counts: { ok: 0, failed: 0, unverified: 0 },
              source: 'configuration',
            },
          }),
      }
    );

    let payload = {} as OpsCostPayload;
    await handler!(
      {
        query: { from: '2026-08-10', to: '2026-08-17' },
        headers: {},
        header: (name: string) => (name === 'x-forwarded-access-token' ? 'caller-token' : undefined),
      } as unknown as Request,
      { json: (body: OpsCostPayload) => (payload = body) } as unknown as Response
    );

    expect(payload.state).toBe('ready');
    const genie = payload.tiles.filter((tile) => tile.id.startsWith('genie:'));
    expect(genie).toHaveLength(2);
    expect(genie.map((tile) => [tile.id, tile.resourceId])).toEqual([
      ['genie:data', 'space-data'],
      ['genie:dictionary', 'space-dictionary'],
    ]);
    expect(payload.genieInstances?.map((instance) => instance.spaceId)).toEqual(['space-data', 'space-dictionary']);
    expect(payload.genieInstances).toMatchObject([
      { allowanceUsedDbus: 12.5, promotionalDbus: 0, underlyingTotalDbus: 12.5 },
      { allowanceUsedDbus: 0, promotionalDbus: 3, underlyingTotalDbus: 3 },
    ]);
    expect(payload.genieAccounting?.reconciliation).toMatchObject({
      sourceRows: 2,
      sourceDbus: 15.5,
      classifiedDbus: 15.5,
      classificationDifferenceDbus: 0,
    });
    expect(payload.tiles.some((tile) => tile.id === 'foundation-model')).toBe(true);
    const vector = payload.tiles.find((tile) => tile.id === 'vector-search');
    expect(vector).toMatchObject({
      resourceId: 'cat.schema.index',
      secondaryResourceId: 'vs-endpoint-from-connections',
      resourceKind: 'vector-index',
      amount: 7,
      quality: 'rate',
      unavailable: '',
      evidence: { billingRows: 2, activity: { calls: 5, observedCalls: 7, unit: 'queries' } },
    });
    expect(vector?.dbus).toBe(3);
    expect(payload.tiles.find((tile) => tile.id === 'app-compute')).toMatchObject({
      amount: 10.5,
      dbus: 3.5,
      basis: 'per-day',
      resourceId: 'player-insights',
      attribution: 'deployment',
      unavailable: '',
      note: '',
      remedy: '',
    });
    expect(payload.tiles.some((tile) => tile.id === 'index-rebuild-job')).toBe(false);
    expect(payload.budgets).toEqual({
      total: { USD: 250, DBU: null },
      resources: { 'app-compute': { USD: 40, DBU: null } },
    });
    expect(payload.budgetsReadable).toBe(true);
  });
});
