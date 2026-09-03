import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareScopeInventories, forgetOpsScopeCache, readScopeInventory } from './ops-scope-check';

function response(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => forgetOpsScopeCache());

describe('Ops catalog scope comparison', () => {
  it('walks every returned page and the complete catalog/schema/table hierarchy', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn((input: string | URL | { url: string }) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.endsWith('/catalogs')) {
        return Promise.resolve(
          parsed.searchParams.has('page_token')
            ? response({ catalogs: [{ name: 'second' }] })
            : response({ catalogs: [{ name: 'first' }], next_page_token: 'catalog-page-2' })
        );
      }
      if (path.endsWith('/schemas')) {
        const catalog = parsed.searchParams.get('catalog_name');
        return Promise.resolve(response({ schemas: [{ full_name: `${catalog}.analytics` }] }));
      }
      const catalog = parsed.searchParams.get('catalog_name');
      return Promise.resolve(response({ tables: [{ full_name: `${catalog}.analytics.events` }] }));
    }) as unknown as typeof fetch;
    const inventory = await readScopeInventory({
      host: 'https://workspace.example',
      token: 'user-token',
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect([...inventory.catalogs]).toEqual(['first', 'second']);
    expect([...inventory.schemas].sort()).toEqual(['first.analytics', 'second.analytics']);
    expect([...inventory.tables].sort()).toEqual(['first.analytics.events', 'second.analytics.events']);
    expect(calls.some((url) => url.includes('page_token=catalog-page-2'))).toBe(true);
    expect(calls.every((url) => url.includes('max_results=100'))).toBe(true);
  });

  it('returns the union with exact per-principal scope states', () => {
    const payload = compareScopeInventories(
      {
        catalogs: new Set(['shared', 'user-only']),
        schemas: new Set(['shared.default']),
        tables: new Set(['shared.default.user_table']),
      },
      {
        catalogs: new Set(['shared', 'app-only']),
        schemas: new Set(['shared.default']),
        tables: new Set(['shared.default.app_table']),
      },
      '2026-09-03T20:00:00.000Z'
    );
    expect(payload.assets).toContainEqual({
      asset: 'user-only',
      type: 'Catalog',
      userScope: 'in',
      appScope: 'out',
    });
    expect(payload.assets).toContainEqual({
      asset: 'shared.default.app_table',
      type: 'Table',
      userScope: 'out',
      appScope: 'in',
    });
    expect(JSON.stringify(payload)).not.toMatch(/Reachable|Not checked/i);
    expect(payload.user.provenance).toBe('obo');
    expect(payload.app.provenance).toBe('app-service-principal');
  });

  it('treats a credential refusal as no visible assets without returning raw errors', async () => {
    const inventory = await readScopeInventory({
      host: 'https://workspace.example',
      token: 'refused-token',
      signal: new AbortController().signal,
      fetchImpl: vi.fn(() => Promise.resolve(response({ message: 'secret raw workspace error' }, 403))),
    });
    expect([...inventory.catalogs]).toEqual([]);
    expect(JSON.stringify(inventory)).not.toContain('secret raw workspace error');
  });
});
