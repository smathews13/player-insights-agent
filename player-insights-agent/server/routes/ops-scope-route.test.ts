import type { Application, Request, Response as ExpressResponse } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InsightsAppKit } from './insights-routes';
import { forgetOpsScopeCache } from '../lib/ops-scope-check';
import { setupOpsRoutes } from './ops-routes';

type Handler = (req: Request, res: ExpressResponse) => Promise<void>;

function harness(role: string) {
  const get = new Map<string, Handler>();
  setupOpsRoutes(
    {
      lakebase: { query: vi.fn(() => Promise.resolve({ rows: [] })) },
      server: {
        extend: (register: (target: Application) => void) =>
          register({
            get: (path: string, handler: Handler) => get.set(path, handler),
            post: () => undefined,
          } as unknown as Application),
      },
    } as InsightsAppKit,
    {
      isAdminRoute: () => true,
      scopeCheckRole: () => Promise.resolve(role),
      scopeAppToken: () => Promise.resolve({ host: 'https://workspace.example', token: 'app-token' }),
      fetchImpl: vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ catalogs: [] }),
        } as Response)
      ),
      now: () => Date.parse('2026-09-03T20:00:00Z'),
    }
  );
  return get.get('/api/ops/scopes')!;
}

async function invoke(
  handler: Handler,
  query: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    'x-forwarded-email': 'operator@example.test',
    'x-forwarded-access-token': 'user-token',
  };
  const req = {
    query,
    header: (name: string) => headers[name.toLowerCase()],
    once: () => req,
    off: () => req,
  } as unknown as Request;
  let status = 200;
  let body: unknown;
  const res = {
    destroyed: false,
    writableEnded: false,
    once: () => res,
    off: () => res,
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as ExpressResponse;
  await handler(req, res);
  return { status, body };
}

afterEach(() => {
  forgetOpsScopeCache();
  vi.restoreAllMocks();
});

describe('GET /api/ops/scopes', () => {
  it.each([
    ['admin', 200],
    ['owner', 200],
    ['super_admin', 200],
    ['consumer', 403],
  ])('independently authorizes %s', async (role, expected) => {
    const answer = await invoke(harness(role));
    expect(answer.status).toBe(expected);
    if (role === 'consumer') expect(answer.body).toMatchObject({ error: 'admin_role_required' });
  });

  it('returns only safe credential provenance and scope rows', async () => {
    const answer = await invoke(harness('admin'));
    expect(answer.body).toMatchObject({
      user: { label: 'Signed-in user', provenance: 'obo', availability: 'available' },
      app: { label: 'App service principal', provenance: 'app-service-principal', availability: 'available' },
      assets: [],
      nextCursor: null,
      moreResults: false,
    });
    expect(JSON.stringify(answer.body)).not.toMatch(/token|secret|authorization/i);
  });

  it('accepts bounded page, search, type, and cursor query parameters', async () => {
    const answer = await invoke(harness('admin'), { limit: '500', q: 'events', type: 'table' });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ assets: [], moreResults: false });
  });
});
