import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response } from 'express';

import { forgetWorkspaceId, setupOpsRoutes } from './ops-routes';
import type { InsightsAppKit } from './insights-routes';
import type { CostBriefPayload } from '../../shared/ops-contract';

/**
 * The trailing-31-day cost brief is a separate, on-demand read for the PDF
 * export. These cover the parts that are unique to it: the trailing-31-complete-day
 * window it queries (never today), the early no-warehouse answer, and the failure
 * path. Its success internals reuse `readRangeCostBreakdown`, already exercised
 * through the current-month cost route.
 */

const NOW = Date.parse('2026-08-18T12:00:00Z');

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
    const name = {
      host: 'DATABRICKS_HOST',
      warehouse: 'DATABRICKS_SQL_WAREHOUSE_ID',
      endpoint: 'DATABRICKS_SERVING_ENDPOINT_NAME',
      app: 'DATABRICKS_APP_NAME',
    }[key as keyof typeof saved];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function captureBriefHandler(deps: Parameters<typeof setupOpsRoutes>[1], appkitOver: Partial<InsightsAppKit> = {}) {
  let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
  const app = {
    get: (path: string, registered: (req: Request, res: Response) => Promise<void>) => {
      if (path === '/api/ops/cost/brief') handler = registered;
    },
    post: () => {},
  } as unknown as Application;
  setupOpsRoutes(
    {
      lakebase: { query: () => Promise.resolve({ rows: [] }) },
      server: { extend: (register: (target: Application) => void) => register(app) },
      ...appkitOver,
    } as unknown as InsightsAppKit,
    deps
  );
  if (!handler) throw new Error('The cost-brief route was not registered.');
  return handler;
}

const request = () =>
  ({
    query: {},
    headers: {},
    header: (name: string) => (name === 'x-forwarded-access-token' ? 'caller-token' : undefined),
  }) as unknown as Request;

describe('the trailing-31-day cost brief route', () => {
  it('answers no-warehouse without reading billing, over the trailing 31 complete days', async () => {
    delete process.env.DATABRICKS_SQL_WAREHOUSE_ID;
    const handler = captureBriefHandler({ isAdminRoute: () => true, now: () => NOW });
    let payload = {} as CostBriefPayload;
    await handler(request(), { json: (body: CostBriefPayload) => (payload = body) } as unknown as Response);

    expect(payload.period).toBe('trailing_31d');
    expect(payload.state).toBe('no-warehouse');
    // 31 complete days ending yesterday (2026-08-17), never today.
    expect(payload.range).toEqual({ from: '2026-07-18', to: '2026-08-17' });
    expect(payload.generatedAt).toBe('2026-08-18T12:00:00.000Z');
    expect(payload.resources).toEqual([]);
  });

  it('reads billing over the trailing-31-day window and reports it unreadable when the query fails', async () => {
    const statementBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn((input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/preview/scim/v2/Me')) {
        return Promise.resolve(
          new Response('{}', { status: 200, headers: { 'x-databricks-org-id': 'workspace-1' } })
        );
      }
      statementBodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify({ status: { state: 'FAILED', error: { message: 'billing blew up' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as unknown as typeof fetch;

    const handler = captureBriefHandler({
      isAdminRoute: () => true,
      now: () => NOW,
      fetchImpl,
      readAppBillingTag: () => Promise.resolve('matched'),
      readOrchestratorReport: () => Promise.resolve({ report: null }),
    });
    let payload = {} as CostBriefPayload;
    await handler(request(), { json: (body: CostBriefPayload) => (payload = body) } as unknown as Response);

    expect(payload.state).toBe('unreadable');
    expect(payload.reason).toContain('billing blew up');
    // The trailing-31-day bounds reached the billing statement.
    expect(statementBodies[0]?.parameters).toEqual(
      expect.arrayContaining([
        { name: 'from_day', value: '2026-07-18', type: 'DATE' },
        { name: 'to_day', value: '2026-08-17', type: 'DATE' },
      ])
    );
  });
});
