import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response } from 'express';

import {
  configuredResourceName,
  forgetWorkspaceId,
  lookupVectorConnection,
  QUESTION_COST_RUNS_QUERY,
  RESOURCE_ACTIVITY_QUERY,
  setupOpsRoutes,
} from './ops-routes';
import type { InsightsAppKit } from './insights-routes';
import type { OpsCostPayload } from '../../shared/ops-contract';

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

  it('attributes legacy Genie traces by configured space without double-counting current resource calls', () => {
    expect(RESOURCE_ACTIVITY_QUERY).toContain("trace->'genie_spaces'");
    expect(RESOURCE_ACTIVITY_QUERY).toContain("space->>'id' = c.resource_id");
    expect(RESOURCE_ACTIVITY_QUERY).toContain('AND NOT EXISTS');
    expect(RESOURCE_ACTIVITY_QUERY).toContain('COALESCE(a.calls, 0) + COALESCE(l.calls, 0)');
  });

  it('passes complete-day bounds to billing and the run ledger', async () => {
    let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
    const app = {
      get: (path: string, registered: (req: Request, res: Response) => Promise<void>) => {
        if (path === '/api/ops/cost') handler = registered;
      },
    } as unknown as Application;
    const lakebase = vi.fn().mockResolvedValue({
      rows: [
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
    });
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

    expect(payload.range).toEqual({ from: '2026-08-10', to: '2026-08-17' });
    expect(payload.billingLagDays).toBe(1);
    expect(lakebase).toHaveBeenCalledWith(QUESTION_COST_RUNS_QUERY, ['2026-08-10', '2026-08-17']);
    expect(statementBodies[0].parameters).toEqual(
      expect.arrayContaining([
        { name: 'from_day', value: '2026-08-10', type: 'DATE' },
        { name: 'to_day', value: '2026-08-17', type: 'DATE' },
      ])
    );
    expect(payload.perQuestion.runs[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'serving-endpoint', quality: 'per-token', amount: 12 }),
        expect.objectContaining({ id: 'sql-warehouse', quality: 'estimate', amount: 7 }),
        expect.objectContaining({ id: 'genie', quality: 'unknown', amount: null }),
      ])
    );
    expect(payload.budgets).toEqual({ total: { USD: null, DBU: null }, resources: {} });
    expect(payload.budgetsReadable).toBe(true);
    expect(payload.honesty?.priceSource).toBe('list_prices');
    expect(payload.honesty?.contractRates).toBe('unavailable');
  });

  it('traces configured Vector Search identity, activity, USD, and DBUs into one allocated tile', async () => {
    let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
    const app = {
      get: (path: string, registered: (req: Request, res: Response) => Promise<void>) => {
        if (path === '/api/ops/cost') handler = registered;
      },
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
    const fetchImpl = vi.fn((input: string | URL | globalThis.Request) => {
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
    expect(genie.map((tile) => tile.resourceId)).toEqual(['space-data', 'space-dictionary']);
    expect(genie.every((tile) => tile.resourceKind === 'genie-space')).toBe(true);
    expect(genie.map((tile) => tile.evidence?.activity?.calls)).toEqual([3, 2]);
    expect(payload.tiles.some((tile) => tile.id === 'foundation-model')).toBe(false);
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
