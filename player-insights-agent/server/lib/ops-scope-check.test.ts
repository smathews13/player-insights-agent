import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetOpsScopeCache, readOpsScopesPage } from './ops-scope-check';

function response(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function request(input: string | URL | { url: string }): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function token(init?: RequestInit): string {
  const headers = new Headers(init?.headers);
  return headers.get('authorization')?.replace('Bearer ', '') ?? '';
}

beforeEach(() => forgetOpsScopeCache());

describe('paginated Ops catalog scope comparison', () => {
  it('returns a first page without crawling schemas or tables and keeps an opaque cursor', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn((input: string | URL | { url: string }, init?: RequestInit) => {
      const url = request(input);
      calls.push(url);
      const principal = token(init);
      if (url.includes('/catalogs?')) {
        return Promise.resolve(
          response({
            catalogs:
              principal === 'user-token'
                ? [{ name: 'shared' }, { name: 'user-only' }]
                : [{ name: 'shared' }, { name: 'app-only' }],
          })
        );
      }
      const parts = url.split('/');
      const asset = decodeURIComponent(parts[parts.length - 1] ?? '');
      return Promise.resolve(
        response({}, asset === 'shared' || asset === `${principal.split('-')[0]}-only` ? 200 : 404)
      );
    }) as unknown as typeof fetch;
    const page = await readOpsScopesPage({
      userToken: 'user-token',
      principal: 'operator@example.test',
      signal: new AbortController().signal,
      limit: 50,
      fetchImpl,
      appToken: () => Promise.resolve({ host: 'https://workspace.example', token: 'app-token' }),
      now: () => Date.parse('2026-09-03T20:00:00Z'),
    });
    expect(page.assets).toHaveLength(3);
    expect(page.nextCursor).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.moreResults).toBe(true);
    expect(calls.filter((url) => url.includes('/catalogs?'))).toHaveLength(2);
    expect(calls.some((url) => url.includes('/schemas?') || url.includes('/tables?'))).toBe(false);
  });

  it('pages the user/app union with exact status and no duplicate assets', async () => {
    const fetchImpl = vi.fn((input: string | URL | { url: string }, init?: RequestInit) => {
      const url = request(input);
      const principal = token(init);
      if (url.includes('/catalogs?')) {
        return Promise.resolve(
          response({
            catalogs:
              principal === 'user-token'
                ? [{ name: 'shared' }, { name: 'user-only' }]
                : [{ name: 'shared' }, { name: 'app-only' }],
          })
        );
      }
      const parts = url.split('/');
      const asset = decodeURIComponent(parts[parts.length - 1] ?? '');
      const visible = asset === 'shared' || (principal === 'user-token' ? asset === 'user-only' : asset === 'app-only');
      return Promise.resolve(response({}, visible ? 200 : 404));
    }) as unknown as typeof fetch;
    const first = await readOpsScopesPage({
      userToken: 'user-token',
      principal: 'operator@example.test',
      signal: new AbortController().signal,
      limit: 2,
      fetchImpl,
      appToken: () => Promise.resolve({ host: 'https://workspace.example', token: 'app-token' }),
    });
    const second = await readOpsScopesPage({
      userToken: 'user-token',
      principal: 'operator@example.test',
      signal: new AbortController().signal,
      cursor: first.nextCursor!,
      limit: 2,
      fetchImpl,
      appToken: () => Promise.resolve({ host: 'https://workspace.example', token: 'app-token' }),
    });
    const rows = [...first.assets, ...second.assets];
    expect(new Set(rows.map((row) => row.asset)).size).toBe(3);
    expect(rows).toContainEqual({
      asset: 'user-only',
      type: 'Catalog',
      userScope: 'in',
      appScope: 'out',
    });
    expect(rows).toContainEqual({
      asset: 'app-only',
      type: 'Catalog',
      userScope: 'out',
      appScope: 'in',
    });
    expect(JSON.stringify(rows)).not.toMatch(/Reachable|Not checked|Partial/i);
  });

  it('applies server-side search and type while traversing only enough hierarchy to answer', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn((input: string | URL | { url: string }) => {
      const url = request(input);
      calls.push(url);
      if (url.includes('/catalogs?')) return Promise.resolve(response({ catalogs: [{ name: 'main' }] }));
      if (url.includes('/schemas?')) {
        return Promise.resolve(response({ schemas: [{ full_name: 'main.analytics' }, { full_name: 'main.other' }] }));
      }
      return Promise.resolve(response({}));
    }) as unknown as typeof fetch;
    const page = await readOpsScopesPage({
      userToken: 'user-token',
      principal: 'operator@example.test',
      signal: new AbortController().signal,
      query: 'analytics',
      filter: 'schema',
      fetchImpl,
      appToken: () => Promise.resolve({ host: 'https://workspace.example', token: 'app-token' }),
    });
    expect(page.assets).toEqual([{ asset: 'main.analytics', type: 'Schema', userScope: 'in', appScope: 'in' }]);
    expect(calls.some((url) => url.includes('/schemas?'))).toBe(true);
    expect(calls.some((url) => url.includes('/tables?'))).toBe(false);
  });

  it('preserves user results when the app identity fails', async () => {
    const fetchImpl = vi.fn((input: string | URL | { url: string }, init?: RequestInit) => {
      const url = request(input);
      if (token(init) === 'app-token') return Promise.resolve(response({ message: 'raw secret failure' }, 503));
      if (url.includes('/catalogs?')) return Promise.resolve(response({ catalogs: [{ name: 'user-only' }] }));
      return Promise.resolve(response({}, 404));
    }) as unknown as typeof fetch;
    const page = await readOpsScopesPage({
      userToken: 'user-token',
      principal: 'operator@example.test',
      signal: new AbortController().signal,
      fetchImpl,
      appToken: () => Promise.resolve({ host: 'https://workspace.example', token: 'app-token' }),
    });
    expect(page.assets).toContainEqual({
      asset: 'user-only',
      type: 'Catalog',
      userScope: 'in',
      appScope: 'unavailable',
    });
    expect(page.app.availability).toBe('unavailable');
    expect(JSON.stringify(page)).not.toContain('raw secret failure');
  });

  it('bounds an upstream promise that ignores cancellation', async () => {
    const never = new Promise<Response>(() => {});
    const started = Date.now();
    const page = await readOpsScopesPage({
      userToken: 'user-token',
      principal: 'operator@example.test',
      signal: new AbortController().signal,
      fetchImpl: vi.fn(() => never),
      appToken: () => Promise.resolve({ host: 'https://workspace.example', token: 'app-token' }),
      upstreamTimeoutMs: 20,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(page.user.availability).toBe('unavailable');
    expect(page.app.availability).toBe('unavailable');
    expect(page.assets).toEqual([]);
    expect(page.moreResults).toBe(false);
  });

  it('stops promptly when the client cancels', async () => {
    const controller = new AbortController();
    const pending = readOpsScopesPage({
      userToken: 'user-token',
      principal: 'operator@example.test',
      signal: controller.signal,
      fetchImpl: vi.fn(() => new Promise<Response>(() => {})),
      appToken: () => Promise.resolve({ host: 'https://workspace.example', token: 'app-token' }),
      upstreamTimeoutMs: 500,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ assets: [] });
  });
});
