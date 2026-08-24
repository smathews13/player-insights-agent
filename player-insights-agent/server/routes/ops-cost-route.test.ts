import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response } from 'express';

import { forgetWorkspaceId, QUESTION_COST_RUNS_QUERY, setupOpsRoutes } from './ops-routes';
import type { InsightsAppKit } from './insights-routes';
import type { OpsCostPayload } from '../../shared/ops-contract';

const saved = {
  host: process.env.DATABRICKS_HOST,
  warehouse: process.env.DATABRICKS_SQL_WAREHOUSE_ID,
  endpoint: process.env.DATABRICKS_SERVING_ENDPOINT_NAME,
  app: process.env.DATABRICKS_APP_NAME,
};

beforeEach(() => {
  forgetWorkspaceId();
  process.env.DATABRICKS_HOST = 'https://workspace.example.test';
  process.env.DATABRICKS_SQL_WAREHOUSE_ID = 'warehouse-1';
  process.env.DATABRICKS_SERVING_ENDPOINT_NAME = 'agent-endpoint';
  process.env.DATABRICKS_APP_NAME = 'player-insights';
});

afterEach(() => {
  forgetWorkspaceId();
  for (const [key, value] of Object.entries(saved)) {
    const name =
      key === 'host'
        ? 'DATABRICKS_HOST'
        : key === 'warehouse'
          ? 'DATABRICKS_SQL_WAREHOUSE_ID'
          : key === 'endpoint'
            ? 'DATABRICKS_SERVING_ENDPOINT_NAME'
            : 'DATABRICKS_APP_NAME';
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
        server: { extend: (register: (target: Application) => void) => register(app) },
      } as unknown as InsightsAppKit,
      {
        isAdminRoute: () => true,
        now: () => Date.parse('2026-08-18T12:00:00Z'),
        fetchImpl,
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
  });
});
