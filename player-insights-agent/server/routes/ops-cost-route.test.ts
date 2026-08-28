import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response } from 'express';

import { forgetWorkspaceId, QUESTION_COST_RUNS_QUERY, RESOURCE_ACTIVITY_QUERY, setupOpsRoutes } from './ops-routes';
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
    expect(payload.budgets).toEqual({ total: null, resources: {} });
    expect(payload.budgetsReadable).toBe(true);
    expect(payload.honesty?.priceSource).toBe('list_prices');
    expect(payload.honesty?.contractRates).toBe('unavailable');
  });

  it('shows four configured resources and excludes untagged Vector Search calls', async () => {
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
          new globalThis.Response(JSON.stringify({ endpoint_name: 'vs-endpoint' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new globalThis.Response(
          JSON.stringify({
            status: { state: 'SUCCEEDED' },
            result: { data_array: [['__range', null, 'USD', '0', null, '']] },
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
                  value: 'cat.schema.index',
                  source: 'artifact',
                  mutability: 'baked',
                  baked: true,
                  required: false,
                },
              ],
              checks: [
                {
                  id: 'semantic-index-endpoint',
                  kind: 'vector-endpoint',
                  name: 'vs-endpoint-from-connections',
                  label: 'Vector Search endpoint',
                  status: 'ok',
                  detail: 'Reachable.',
                  checked_with: 'GET /api/2.0/vector-search/indexes',
                  duration_ms: 2,
                  error: '',
                  remedy: null,
                },
              ],
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

    expect(payload.state).toBe('no-rows');
    const genie = payload.tiles.filter((tile) => tile.id.startsWith('genie:'));
    expect(genie.map((tile) => tile.resourceId)).toEqual(['space-data', 'space-dictionary']);
    expect(genie.every((tile) => tile.resourceKind === 'genie-space')).toBe(true);
    expect(genie.map((tile) => tile.evidence?.activity?.calls)).toEqual([3, 2]);
    expect(payload.tiles.some((tile) => tile.id === 'foundation-model')).toBe(false);
    expect(payload.tiles.find((tile) => tile.id === 'vector-search')).toMatchObject({
      resourceId: 'cat.schema.index',
      secondaryResourceId: 'vs-endpoint-from-connections',
      resourceKind: 'vector-index',
      unavailable: 'Vector Search dollars unavailable',
      evidence: { billingRows: null, activity: { calls: 5, observedCalls: 7, unit: 'queries' } },
    });
    expect(payload.tiles.find((tile) => tile.id === 'app-compute')).toMatchObject({
      unavailable: 'No Apps billing rows matched this app in this range.',
      note: 'system_billing=astrolabe is on this app; Apps billing is matched by app name.',
      remedy: '',
    });
    expect(payload.tiles.some((tile) => tile.id === 'index-rebuild-job')).toBe(false);
    expect(payload.budgets).toEqual({ total: 250, resources: { 'app-compute': 40 } });
    expect(payload.budgetsReadable).toBe(true);
  });
});
