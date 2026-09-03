import { createHash } from 'node:crypto';
import type { OpsScopeAsset, OpsScopeAssetType, OpsScopePayload } from '../../shared/ops-scope-contract';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { DiscoveryPageCache, discoveryLimiter } from './discovery-control';

const PAGE_SIZE = 100;
const INVENTORY_CONCURRENCY = 4;
const scopeCache = new DiscoveryPageCache<OpsScopePayload>(32, 15_000);
let cachedAppCredential: { key: string; host: string; token: string; expiresAt: number } | null = null;

interface ScopeReadOptions {
  host: string;
  token: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

interface NamedRow {
  name?: unknown;
  full_name?: unknown;
}

interface InventoryPage {
  rows: NamedRow[];
  next: string;
}

export interface ScopeInventory {
  catalogs: Set<string>;
  schemas: Set<string>;
  tables: Set<string>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('base64url').slice(0, 16);
}

function query(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams({ max_results: String(PAGE_SIZE), ...params });
  return `${path}?${search.toString()}`;
}

async function page(
  path: string,
  key: 'catalogs' | 'schemas' | 'tables',
  options: ScopeReadOptions
): Promise<InventoryPage> {
  const call = options.fetchImpl ?? fetch;
  const response = await discoveryLimiter.run(options.signal, () =>
    call(`${options.host}${path}`, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: options.signal,
    })
  );
  if (response.status === 401 || response.status === 403) return { rows: [], next: '' };
  if (!response.ok) throw new Error('catalog_explorer_unavailable');
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    rows: Array.isArray(body[key]) ? (body[key] as NamedRow[]) : [],
    next: text(body.next_page_token),
  };
}

async function allPages(
  path: string,
  key: 'catalogs' | 'schemas' | 'tables',
  params: Record<string, string>,
  options: ScopeReadOptions
): Promise<NamedRow[]> {
  const rows: NamedRow[] = [];
  const seen = new Set<string>();
  let next = '';
  do {
    const current = await page(query(path, { ...params, ...(next ? { page_token: next } : {}) }), key, options);
    rows.push(...current.rows);
    if (!current.next) return rows;
    if (seen.has(current.next)) throw new Error('catalog_explorer_repeated_page');
    seen.add(current.next);
    next = current.next;
  } while (!options.signal.aborted);
  throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
}

async function mapBounded<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(INVENTORY_CONCURRENCY, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        await run(item);
      }
    })
  );
}

export async function readScopeInventory(options: ScopeReadOptions): Promise<ScopeInventory> {
  const catalogs = new Set<string>();
  const schemas = new Set<string>();
  const tables = new Set<string>();
  const catalogRows = await allPages('/api/2.1/unity-catalog/catalogs', 'catalogs', {}, options);
  for (const row of catalogRows) {
    const name = text(row.name);
    if (name) catalogs.add(name);
  }
  await mapBounded([...catalogs], async (catalog) => {
    const schemaRows = await allPages('/api/2.1/unity-catalog/schemas', 'schemas', { catalog_name: catalog }, options);
    const underCatalog: string[] = [];
    for (const row of schemaRows) {
      const fullName = text(row.full_name);
      const shortName = text(row.name);
      const name = fullName || (shortName ? `${catalog}.${shortName}` : '');
      if (!name) continue;
      schemas.add(name);
      underCatalog.push(name);
    }
    await mapBounded(underCatalog, async (schemaName) => {
      const schema = schemaName.slice(catalog.length + 1);
      const tableRows = await allPages(
        '/api/2.1/unity-catalog/tables',
        'tables',
        { catalog_name: catalog, schema_name: schema },
        options
      );
      for (const row of tableRows) {
        const fullName = text(row.full_name) || text(row.name);
        if (fullName) tables.add(fullName.includes('.') ? fullName : `${schemaName}.${fullName}`);
      }
    });
  });
  return { catalogs, schemas, tables };
}

function assetRows(type: OpsScopeAssetType, user: Set<string>, app: Set<string>): OpsScopeAsset[] {
  return [...new Set([...user, ...app])]
    .sort((left, right) => left.localeCompare(right))
    .map((asset) => ({
      asset,
      type,
      userScope: user.has(asset) ? 'in' : 'out',
      appScope: app.has(asset) ? 'in' : 'out',
    }));
}

export function compareScopeInventories(user: ScopeInventory, app: ScopeInventory, checkedAt: string): OpsScopePayload {
  return {
    checkedAt,
    assets: [
      ...assetRows('Catalog', user.catalogs, app.catalogs),
      ...assetRows('Schema', user.schemas, app.schemas),
      ...assetRows('Table', user.tables, app.tables),
    ],
    user: { label: 'Signed-in user', provenance: 'obo' },
    app: { label: 'App service principal', provenance: 'app-service-principal' },
  };
}

export async function mintAppScopeToken(
  signal: AbortSignal,
  deps: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<{ host: string; token: string }> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const host = normalizeWorkspaceHost(env.DATABRICKS_HOST);
  const clientId = text(env.DATABRICKS_CLIENT_ID);
  const clientSecret = text(env.DATABRICKS_CLIENT_SECRET);
  if (!host || !clientId || !clientSecret) throw new Error('app_scope_credential_unavailable');
  const cacheKey = `${host}\u0000${clientId}`;
  if (cachedAppCredential?.key === cacheKey && cachedAppCredential.expiresAt > Date.now() + 60_000) {
    return { host, token: cachedAppCredential.token };
  }
  const response = await (deps.fetchImpl ?? fetch)(`${host}/oidc/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'all-apis',
    }),
    signal,
  });
  if (!response.ok) throw new Error('app_scope_credential_unavailable');
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const token = text(body.access_token);
  if (!token) throw new Error('app_scope_credential_unavailable');
  const expiresIn =
    typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? Math.max(60, body.expires_in) : 3600;
  cachedAppCredential = { key: cacheKey, host, token, expiresAt: Date.now() + expiresIn * 1000 };
  return { host, token };
}

export async function readOpsScopes(input: {
  userToken: string;
  principal: string;
  signal: AbortSignal;
  now?: () => number;
  fetchImpl?: typeof fetch;
  appToken?: () => Promise<{ host: string; token: string }>;
}): Promise<OpsScopePayload> {
  const appCredential = await (
    input.appToken ?? (() => mintAppScopeToken(input.signal, { fetchImpl: input.fetchImpl }))
  )();
  const key = `${input.principal.toLowerCase()}\u0000${tokenKey(input.userToken)}\u0000${tokenKey(appCredential.token)}`;
  const cached = scopeCache.get(key, (input.now ?? Date.now)());
  if (cached) return cached;
  const options = { host: appCredential.host, signal: input.signal, fetchImpl: input.fetchImpl };
  const [user, app] = await Promise.all([
    readScopeInventory({ ...options, token: input.userToken }),
    readScopeInventory({ ...options, token: appCredential.token }),
  ]);
  const payload = compareScopeInventories(user, app, new Date((input.now ?? Date.now)()).toISOString());
  scopeCache.set(key, payload, (input.now ?? Date.now)());
  return payload;
}

export function forgetOpsScopeCache(): void {
  scopeCache.clear();
  cachedAppCredential = null;
}
