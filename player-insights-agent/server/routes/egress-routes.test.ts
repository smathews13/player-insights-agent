import { describe, expect, it, vi } from 'vitest';
import type { Application, Request, Response } from 'express';
import { isAdminRoute } from '../lib/admin-roles';
import type { LakebaseReader } from '../lib/lakebase-store';
import { EGRESS_ADMIN_ROUTES, setupEgressRoutes } from './egress-routes';
import type { InsightsAppKit } from './insights-routes';

type Handler = (req: Request, res: Response) => Promise<void>;

function setup(query = vi.fn(() => Promise.resolve({ rows: [] }))) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path: string, handler: Handler) {
      handlers.set(`POST ${path}`, handler);
    },
    put(path: string, handler: Handler) {
      handlers.set(`PUT ${path}`, handler);
    },
  } as unknown as Application;
  const lakebase: LakebaseReader['lakebase'] = { query };
  const appkit = {
    lakebase,
    server: { extend: (register: (target: Application) => void) => register(app) },
  } as unknown as InsightsAppKit;
  setupEgressRoutes(appkit, { isAdminRoute, now: () => 1 });
  return { handlers, query };
}

function response() {
  const result = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      result.statusCode = code;
      return result;
    },
    json(body: unknown) {
      result.body = body;
      return result;
    },
  };
  return result as unknown as Response & typeof result;
}

describe('egress administrator records route', () => {
  it('is covered by the same admin prefix as controls and classification', () => {
    expect(EGRESS_ADMIN_ROUTES).toContain('/api/egress/admin/events');
    for (const path of EGRESS_ADMIN_ROUTES) expect(isAdminRoute(path), path).toBe(true);
    expect(isAdminRoute('/api/egress/events')).toBe(false);
  });

  it('registers only when every administrator route is guarded', () => {
    const handlers = new Map<string, Handler>();
    const appkit = {
      lakebase: { query: vi.fn() },
      server: {
        extend: (register: (target: Application) => void) =>
          register({
            get: (path: string, handler: Handler) => handlers.set(`GET ${path}`, handler),
            post: (path: string, handler: Handler) => handlers.set(`POST ${path}`, handler),
            put: (path: string, handler: Handler) => handlers.set(`PUT ${path}`, handler),
          } as unknown as Application),
      },
    } as unknown as InsightsAppKit;

    setupEgressRoutes(appkit, {
      isAdminRoute: (path) => path !== '/api/egress/admin/events' && isAdminRoute(path),
    });

    expect(handlers.size).toBe(0);
  });

  it('rejects arbitrary query keys before Lakebase is called', async () => {
    const { handlers, query } = setup();
    const handler = handlers.get('GET /api/egress/admin/events');
    expect(handler).toBeDefined();
    const res = response();

    await handler?.({ query: { limit: '20', sql: 'SELECT * FROM secrets' } } as unknown as Request, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_egress_events_query' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a forged cursor before Lakebase is called', async () => {
    const { handlers, query } = setup();
    const handler = handlers.get('GET /api/egress/admin/events');
    const res = response();

    await handler?.({ query: { limit: '20', cursor: 'not-a-cursor' } } as unknown as Request, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'invalid_egress_events_cursor' });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns a bounded fixed-query page with storage provenance', async () => {
    const { handlers, query } = setup();
    const handler = handlers.get('GET /api/egress/admin/events');
    const res = response();

    await handler?.({ query: {} } as unknown as Request, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      events: [],
      readState: 'read',
      pageSize: 20,
      nextCursor: null,
      storage: {
        store: 'Lakebase (Postgres)',
      },
    });
    const [statement, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(statement).toContain('ORDER BY occurred_at DESC, id DESC');
    expect(params).toEqual([21]);
  });
});
