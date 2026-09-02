import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { isAdminRoute } from '../lib/admin-roles';
import type { ResourceTagSummary } from '../lib/resource-tagging';
import { setupResourceTagRoutes } from './resource-tag-routes';
import type { InsightsAppKit } from './insights-routes';

type Handler = (req: RequestFixture, res: ResponseFixture) => Promise<void>;

class RequestFixture extends EventEmitter {
  body: unknown = {};
  private readonly headers: Record<string, string>;

  constructor(headers: Record<string, string> = {}) {
    super();
    this.headers = headers;
  }

  header(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
}

class ResponseFixture extends EventEmitter {
  statusCode = 200;
  writableEnded = false;
  body: unknown;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: unknown) {
    this.body = body;
    this.writableEnded = true;
    return this;
  }
}

const summary: ResourceTagSummary = {
  headline: '1 of 1 supported resources tagged',
  supportedTotal: 1,
  supportedCovered: 1,
  tagged: 1,
  alreadyCorrect: 0,
  supportedFailed: 0,
  permissionRequired: 0,
  unsupported: 0,
  notApplicable: 0,
  results: [],
  updatedAt: '2026-09-02T00:00:00.000Z',
};

function responseDetail(response: ResponseFixture): string {
  if (!response.body || typeof response.body !== 'object') return '';
  const detail = (response.body as { detail?: unknown }).detail;
  return typeof detail === 'string' ? detail : '';
}

function routes(
  overrides: {
    read?: () => Promise<ResourceTagSummary | null>;
    write?: () => Promise<void>;
    clear?: () => Promise<boolean>;
    apply?: (
      ...args: Parameters<typeof import('../lib/resource-tagging').applyAstrolabeTags>
    ) => Promise<ResourceTagSummary>;
  } = {}
) {
  const handlers = new Map<string, Handler>();
  const appkit = {
    lakebase: { query: vi.fn(() => Promise.resolve({ rows: [] })) },
    server: {
      extend: (register: (app: Record<string, (path: string, handler: Handler) => void>) => void) =>
        register({
          get: (path, handler) => handlers.set(`GET ${path}`, handler),
          post: (path, handler) => handlers.set(`POST ${path}`, handler),
          delete: (path, handler) => handlers.set(`DELETE ${path}`, handler),
        }),
    },
  } as unknown as InsightsAppKit;
  setupResourceTagRoutes(appkit, {
    readReport: () => Promise.resolve(null),
    resolveExperimentId: () => Promise.resolve('experiment'),
    read: overrides.read ?? vi.fn(() => Promise.resolve(null)),
    write: overrides.write ?? vi.fn(() => Promise.resolve()),
    clear: overrides.clear ?? vi.fn(() => Promise.resolve(true)),
    apply: overrides.apply as typeof import('../lib/resource-tagging').applyAstrolabeTags | undefined,
  });
  return handlers;
}

describe('Resource Tags routes', () => {
  it('keeps read, apply, and clear behind the server admin boundary', () => {
    expect(isAdminRoute('/api/settings/resource-tags')).toBe(true);
    expect(isAdminRoute('/api/settings/resource-tags/anything')).toBe(true);
  });

  it('loads the one durable current result after reload or redeploy', async () => {
    const handler = routes({ read: vi.fn(() => Promise.resolve(summary)) }).get('GET /api/settings/resource-tags')!;
    const response = new ResponseFixture();
    await handler(new RequestFixture(), response);
    expect(response.body).toEqual({ summary });
  });

  it('passes only the trusted forwarded OAuth token and replaces the saved result', async () => {
    const previous = { ...summary, headline: 'previous' };
    const apply = vi.fn(() => Promise.resolve(summary));
    const write = vi.fn(() => Promise.resolve());
    const handler = routes({
      read: vi.fn(() => Promise.resolve(previous)),
      apply: apply as never,
      write,
    }).get('POST /api/settings/resource-tags')!;
    const request = new RequestFixture({
      'x-forwarded-access-token': 'obo-token',
      'x-forwarded-email': 'admin@example.com',
    });
    request.body = { mode: 'unresolved' };
    const response = new ResponseFixture();
    await handler(request, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(summary);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'obo-token',
        previous,
        mode: 'unresolved',
      })
    );
    expect(write).toHaveBeenCalledWith(expect.anything(), summary, 'admin@example.com');
  });

  it('clears saved UI state without claiming applied tags were removed', async () => {
    const handler = routes({ clear: vi.fn(() => Promise.resolve(true)) }).get('DELETE /api/settings/resource-tags')!;
    const response = new ResponseFixture();
    await handler(new RequestFixture({ 'x-forwarded-email': 'admin@example.com' }), response);
    expect(response.body).toMatchObject({ cleared: true, removed: true });
    expect(responseDetail(response)).toContain('Applied Databricks tags were not removed');
  });

  it('keeps saved results when transactional clear fails', async () => {
    const handler = routes({ clear: vi.fn(() => Promise.reject(new Error('database unavailable'))) }).get(
      'DELETE /api/settings/resource-tags'
    )!;
    const response = new ResponseFixture();
    await handler(new RequestFixture({ 'x-forwarded-email': 'admin@example.com' }), response);
    expect(response.statusCode).toBe(503);
    expect(responseDetail(response)).toContain('saved result is unchanged');
  });
});
