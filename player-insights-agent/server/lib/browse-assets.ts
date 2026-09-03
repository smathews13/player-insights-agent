/**
 * List what the signed-in user can see, for Connections pickers.
 *
 * Calls the workspace as the forwarded user token. Catalog browse needs the
 * optional `catalog.*:read` scopes; when the sign-in does not carry them the
 * answer is {@link BrowseUnavailable}, never an empty list. See
 * `shared/browse-contract.ts`.
 */
import { createHash } from 'node:crypto';
import {
  browseAppsHasNoScopeDetail,
  browseScopeUnavailableDetail,
  type BrowseFailed,
  type BrowseItem,
  type BrowseKind,
  type BrowseOk,
  type BrowseResponse,
  type BrowseUnavailable,
  type ConnectionTypeAvailability,
  type ConnectionTypesResponse,
  type UnityCatalogSearchItem,
  type UnityCatalogSearchResponse,
} from '../../shared/browse-contract';
import { declaredUserApiScopes } from '../../shared/declared-scopes';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { looksLikeMissingScope, scopesFromToken } from '../routes/access-verification';
import { refusalCause, scopeForPath, scopesFromRefusal, tokenScopeVerdict } from './dependency-probes';
import { DISCOVERY_MAX_CONCURRENCY, DiscoveryPageCache, discoveryLimiter } from './discovery-control';

/** How long one browse call may take. Same order as a metadata probe. */
export const BROWSE_TIMEOUT_MS = 15_000;

/** Default page size for paged Databricks list APIs. */
export const BROWSE_PAGE_SIZE = 100;
/** At most 500 rows can be loaded into one picker traversal. */
export const BROWSE_PAGE_LIMIT = 5;
export const UC_SEARCH_RESULT_LIMIT = 100;
const UC_SEARCH_CATALOG_SCAN_LIMIT = 24;
const UC_SEARCH_SCHEMA_SCAN_LIMIT = 32;

/**
 * Workspace API families this module lists, mapped to Apps-API scopes.
 *
 * Catalog paths reuse {@link scopeForPath}. Workspace list is not on the probe
 * map today. Its scope is `workspace.workspace:read`, which is the name the
 * Apps API accepts: the bare `workspace` the OAuth server advertises is
 * rejected there, exactly as `unity-catalog` is. A deployment that has not
 * declared it gets `unavailable` here rather than a 403 nobody can read.
 */
const BROWSE_SCOPE_BY_PATH: Readonly<Record<string, string>> = {
  '/api/2.1/unity-catalog/catalogs': 'catalog.catalogs:read',
  '/api/2.1/unity-catalog/schemas': 'catalog.schemas:read',
  '/api/2.1/unity-catalog/tables': 'catalog.tables:read',
  // Volumes list has no Apps-API scope of its own (`catalog.volumes` is
  // rejected). Browsing still goes through the same UC token family the three
  // catalog reads open: the call is made when those are held, and a bare 403 is
  // reported as a grant problem rather than as a missing browse scope. See
  // listVolumes.
  '/api/2.0/sql/warehouses': 'sql',
  '/api/2.0/genie/spaces': 'dashboards.genie',
  '/api/2.0/workspace/list': 'workspace.workspace:read',
  '/api/2.0/workspace/get-status': 'workspace.workspace:read',
  '/api/2.0/workspace/export': 'workspace.workspace:read',
  '/api/2.0/serving-endpoints': 'serving.serving-endpoints',
  '/api/2.0/vector-search/endpoints': 'vectorsearch.vector-search-endpoints:read',
  '/api/2.0/vector-search/indexes': 'vectorsearch.vector-search-indexes:read',
  '/api/2.0/postgres/projects': 'postgres',
};

function scopeForBrowsePath(path: string): string {
  const exact = BROWSE_SCOPE_BY_PATH[path];
  if (exact) return exact;
  // Lakebase branch/database lists sit under /api/2.0/postgres/{parent}/...
  if (path.startsWith('/api/2.0/postgres/')) return 'postgres';
  return scopeForPath(path.endsWith('/') ? path : `${path}/`);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function unavailable(kind: BrowseKind, scope: string): BrowseUnavailable {
  return {
    status: 'unavailable',
    kind,
    reason: 'scope_not_carried',
    scope,
    detail: browseScopeUnavailableDetail(scope),
  };
}

function unavailableNoAppsScope(kind: BrowseKind, family: string): BrowseUnavailable {
  return {
    status: 'unavailable',
    kind,
    reason: 'apps_has_no_scope',
    scope: '',
    detail: browseAppsHasNoScopeDetail(family),
  };
}

function failed(
  kind: BrowseKind,
  detail: string,
  error = '',
  incompleteReason: BrowseFailed['incomplete_reason'] = 'failed'
): BrowseFailed {
  return { status: 'failed', kind, detail, error, incomplete_reason: incompleteReason };
}

function ok(kind: BrowseKind, items: BrowseItem[], nextPageToken = '', path = '', page = 1): BrowseOk {
  const capped = page >= BROWSE_PAGE_LIMIT && Boolean(nextPageToken);
  return {
    status: 'ok',
    kind,
    items,
    next_page_token: capped ? '' : nextPageToken,
    path,
    pagination: {
      complete: !nextPageToken,
      incomplete_reason: nextPageToken ? (capped ? 'page_cap' : 'more_available') : '',
      page,
      page_limit: BROWSE_PAGE_LIMIT,
      page_size: BROWSE_PAGE_SIZE,
      returned: items.length,
    },
  };
}

export interface BrowseCallOptions {
  host: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Aborted when the browser disconnects or the route deadline expires. */
  signal?: AbortSignal;
  /** Signed-in user identity. Required for page caching; never inferred from a token. */
  principal?: string;
  /** One-based page number, used to enforce the traversal cap. */
  page?: number;
  /** Override declared scopes for tests. Defaults to the container's list. */
  declaredScopes?: string[] | null;
}

type WorkspaceAnswer =
  | { kind: 'http'; status: number; body: Record<string, unknown> }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'unreachable'; message: string };

const pageCache = new DiscoveryPageCache<Extract<WorkspaceAnswer, { kind: 'http' }>>();

export function resetBrowsePageCache(): void {
  pageCache.clear();
}

function cacheKey(pathAndQuery: string, options: BrowseCallOptions): string {
  const principal = options.principal?.trim().toLocaleLowerCase() ?? '';
  if (!principal) return '';
  const tokenHash = createHash('sha256').update(options.token).digest('base64url').slice(0, 16);
  return `${principal}\u0000${tokenHash}\u0000${pathAndQuery}`;
}

function combinedBrowseSignal(options: BrowseCallOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? BROWSE_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

async function workspaceGet(pathAndQuery: string, options: BrowseCallOptions): Promise<WorkspaceAnswer> {
  const call = options.fetchImpl ?? fetch;
  const key = cacheKey(pathAndQuery, options);
  const cached = key ? pageCache.get(key) : undefined;
  if (cached) return cached;
  const signal = combinedBrowseSignal(options);
  try {
    const response = await discoveryLimiter.run(signal, () =>
      call(`${options.host}${pathAndQuery}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${options.token}` },
        signal,
      })
    );
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const answer = { kind: 'http' as const, status: response.status, body: body ?? {} };
    // Only successful immutable metadata pages are cached. Refusals and
    // transport failures must be retried, and never become another user's view.
    if (key && response.status >= 200 && response.status < 300) pageCache.set(key, answer);
    return answer;
  } catch (error) {
    if (signal.aborted) {
      const reasonName = (signal.reason as Error | undefined)?.name;
      return reasonName === 'TimeoutError' ? { kind: 'timeout' } : { kind: 'cancelled' };
    }
    const name = (error as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout' };
    return { kind: 'unreachable', message: (error as Error)?.message ?? String(error) };
  }
}

/**
 * Whether browsing should be refused before the workspace is asked.
 *
 * Returns the scope name when the sign-in demonstrably lacks it, or when the
 * app does not declare it so no sign-in can carry it. Returns null when the
 * call should still be made (scope held, or token silent).
 */
export function browseBlockedByScope(input: {
  apiPath: string;
  token: string;
  declaredScopes?: string[] | null;
}): string | null {
  const scope = scopeForBrowsePath(input.apiPath);
  if (!scope) return null;

  const declared = input.declaredScopes === undefined ? declaredUserApiScopes() : input.declaredScopes;
  // App does not ask for it: no sign-in it hands out can carry it.
  if (declared && !declared.includes(scope)) {
    return scope;
  }

  const held = scopesFromToken(input.token);
  if (held === null) return null;
  const verdict = tokenScopeVerdict(held, scope);
  if (verdict === false) return scope;
  return null;
}

/**
 * Turn a workspace HTTP answer into a browse response for one kind.
 *
 * Pure against the answer, so tests cover scope refusal without a network.
 */
export function interpretBrowseAnswer(input: {
  kind: BrowseKind;
  apiPath: string;
  answer: WorkspaceAnswer;
  itemsFromBody: (body: Record<string, unknown>) => {
    items: BrowseItem[];
    next_page_token: string;
  };
  path?: string;
  /** Scopes readable off the token, or null when the token did not say. */
  tokenScopes?: string[] | null;
  /** One-based page number within this picker traversal. */
  page?: number;
}): BrowseResponse {
  const { kind, apiPath, answer } = input;

  if (answer.kind === 'timeout') {
    return failed(
      kind,
      'The workspace did not answer in time, so nothing about this list was established.',
      'timeout',
      'deadline'
    );
  }
  if (answer.kind === 'cancelled') {
    return failed(kind, 'Resource discovery was cancelled, so this list is incomplete.', 'cancelled', 'cancelled');
  }
  if (answer.kind === 'unreachable') {
    return failed(kind, 'The workspace could not be asked for this list, so nothing was established.', answer.message);
  }

  const { status, body } = answer;
  if (status >= 200 && status < 300) {
    const parsed = input.itemsFromBody(body);
    return ok(kind, parsed.items, parsed.next_page_token, input.path ?? '', input.page ?? 1);
  }

  const code = text(body.error_code);
  const message = text(body.message);
  const scope = scopeForBrowsePath(apiPath);
  const named = scopesFromRefusal(message);
  const looksScope = named.length > 0 || looksLikeMissingScope(message);
  const tokenScopes = input.tokenScopes ?? null;
  const scopeHeld = tokenScopes === null ? null : tokenScopeVerdict(tokenScopes, scope);

  if (status === 403 || code === 'PERMISSION_DENIED') {
    // Scope held: this is a grant problem, not a browse-capability problem.
    if (scopeHeld === true && !looksScope) {
      return failed(
        kind,
        `The workspace refused this list: HTTP ${status}${code ? ` ${code}` : ''}. ` +
          'Your sign-in carries the API permission, so this is likely a grant on the object.',
        message || `HTTP ${status}`
      );
    }
    // Scope named by the workspace, or a bare catalog 403 when the token does
    // not demonstrably hold the scope. Catalog metadata refusals often arrive
    // with no body; the three catalog scopes are optional on this app, so that
    // shape is reported as browsing unavailable rather than empty or failed.
    if (looksScope || (scope.startsWith('catalog.') && scopeHeld !== true)) {
      return unavailable(kind, scope || named[0] || 'required');
    }
    const cause = refusalCause({ message, code, scope, scopeHeld });
    if (cause.kind === 'scope') {
      return unavailable(kind, cause.scope || scope || 'required');
    }
    return failed(
      kind,
      `The workspace refused this list: HTTP ${status}${code ? ` ${code}` : ''}. ` +
        'That may be a grant on the object rather than a missing sign-in permission.',
      message || `HTTP ${status}`
    );
  }

  return failed(
    kind,
    `The workspace refused this list: HTTP ${status}${code ? ` ${code}` : ''}.`,
    message || `HTTP ${status}`
  );
}

function pageQuery(pageToken: string | undefined, pageSize = BROWSE_PAGE_SIZE): string {
  const parts = [`max_results=${pageSize}`];
  // Warehouses use page_size; UC uses max_results. Callers pass the right one
  // via extraQuery when needed. Default is UC-shaped.
  if (pageToken) parts.push(`page_token=${encodeURIComponent(pageToken)}`);
  return parts.join('&');
}

async function listWithGuard(
  kind: BrowseKind,
  apiPath: string,
  pathAndQuery: string,
  options: BrowseCallOptions,
  itemsFromBody: (body: Record<string, unknown>) => {
    items: BrowseItem[];
    next_page_token: string;
  },
  listedPath = ''
): Promise<BrowseResponse> {
  const page = options.page ?? (pathAndQuery.includes('page_token=') ? 2 : 1);
  if (!Number.isInteger(page) || page < 1 || page > BROWSE_PAGE_LIMIT) {
    return failed(kind, `Resource discovery is limited to ${BROWSE_PAGE_LIMIT} pages per list.`, 'page cap reached');
  }
  if (!options.host) {
    return failed(kind, 'This app was given no workspace host, so it does not know where to browse.');
  }
  if (!options.token) {
    return failed(kind, 'This request carried no signed-in user token, so browsing as you is not possible.');
  }

  const blocked = browseBlockedByScope({
    apiPath,
    token: options.token,
    declaredScopes: options.declaredScopes,
  });
  if (blocked) return unavailable(kind, blocked);

  const answer = await workspaceGet(pathAndQuery, options);
  return interpretBrowseAnswer({
    kind,
    apiPath,
    answer,
    itemsFromBody,
    path: listedPath,
    tokenScopes: scopesFromToken(options.token),
    page,
  });
}

function catalogItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.catalogs) ? body.catalogs : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = text((row as Record<string, unknown>).name);
    if (!name) continue;
    items.push({ id: name, label: name, secondary: '', expandable: false });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function schemaItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.schemas) ? body.schemas : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const fullName = text(record.full_name);
    const name = text(record.name);
    // Prefer the schema segment alone as `id`: the next drill-down already has
    // the catalog in the query string.
    const schemaName = name.includes('.')
      ? name.slice(name.indexOf('.') + 1)
      : name || (fullName.includes('.') ? fullName.slice(fullName.indexOf('.') + 1) : fullName);
    if (!schemaName) continue;
    items.push({
      id: schemaName,
      label: schemaName,
      // The two-part name, because one field stores it: `data_catalogs` takes
      // either a whole catalog or a single `catalog.schema`, and those mean
      // materially different things. Carried here so the picker for that field
      // can offer the exact string rather than assemble one and be wrong.
      secondary: fullName,
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function tableItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.tables) ? body.tables : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const fullName = text(record.full_name) || text(record.name);
    if (!fullName) continue;
    const short = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
    items.push({
      id: fullName,
      label: short,
      secondary: text(record.table_type),
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function warehouseItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.warehouses) ? body.warehouses : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = text(record.id);
    if (!id) continue;
    items.push({
      id,
      label: text(record.name) || id,
      secondary: text(record.state),
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function genieItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.spaces) ? body.spaces : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = text(record.space_id) || text(record.id);
    if (!id) continue;
    items.push({
      id,
      label: text(record.title) || id,
      secondary: '',
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

/**
 * One row per serving endpoint, whatever it serves.
 *
 * Deliberately unfiltered. Three settings pick from this list, and they do not
 * want the same rows: the foundation model wants a chat endpoint, the benchmark
 * judge usually the same, and a deployment can point either at an agent
 * endpoint somebody else logged. Filtering by `task` would hide a legitimate
 * pick from one of them, so the task is reported instead and the reader
 * chooses. An endpoint with no task reports its readiness, which is the only
 * other thing the list payload knows about it.
 */
function servingEndpointItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.endpoints) ? body.endpoints : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    if (!name) continue;
    const state = record.state;
    const ready = state && typeof state === 'object' ? text((state as Record<string, unknown>).ready) : '';
    items.push({
      id: name,
      label: name,
      secondary: text(record.task) || ready,
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function notebookItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.objects) ? body.objects : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const path = text(record.path);
    if (!path) continue;
    const objectType = text(record.object_type).toUpperCase();
    // Directories and notebooks only. Libraries, files, repos stay out of a
    // "pick a notebook" picker.
    if (objectType !== 'DIRECTORY' && objectType !== 'NOTEBOOK') continue;
    const label = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    items.push({
      id: path,
      label: label || path,
      secondary: objectType === 'NOTEBOOK' ? text(record.language) : 'Directory',
      expandable: objectType === 'DIRECTORY',
    });
  }
  return { items, next_page_token: '' };
}

export async function listCatalogs(options: BrowseCallOptions & { pageToken?: string }): Promise<BrowseResponse> {
  const apiPath = '/api/2.1/unity-catalog/catalogs';
  const query = pageQuery(options.pageToken);
  return listWithGuard('catalogs', apiPath, `${apiPath}?${query}`, options, catalogItems);
}

export async function listSchemas(
  options: BrowseCallOptions & { catalog: string; pageToken?: string }
): Promise<BrowseResponse> {
  const catalog = options.catalog.trim();
  if (!catalog) {
    return failed('schemas', 'A catalog name is required to list schemas.');
  }
  const apiPath = '/api/2.1/unity-catalog/schemas';
  const query = `catalog_name=${encodeURIComponent(catalog)}&${pageQuery(options.pageToken)}`;
  return listWithGuard('schemas', apiPath, `${apiPath}?${query}`, options, schemaItems);
}

export async function listTables(
  options: BrowseCallOptions & { catalog: string; schema: string; pageToken?: string }
): Promise<BrowseResponse> {
  const catalog = options.catalog.trim();
  const schema = options.schema.trim();
  if (!catalog || !schema) {
    return failed('tables', 'A catalog and schema are required to list tables.');
  }
  const apiPath = '/api/2.1/unity-catalog/tables';
  const query =
    `catalog_name=${encodeURIComponent(catalog)}` +
    `&schema_name=${encodeURIComponent(schema)}` +
    `&${pageQuery(options.pageToken)}`;
  return listWithGuard('tables', apiPath, `${apiPath}?${query}`, options, tableItems);
}

export async function validateUnityCatalogAsset(
  options: BrowseCallOptions & { resourceType: 'catalog' | 'schema' | 'table'; value: string }
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const value = options.value.trim();
  const apiPath =
    options.resourceType === 'catalog'
      ? '/api/2.1/unity-catalog/catalogs'
      : options.resourceType === 'schema'
        ? '/api/2.1/unity-catalog/schemas'
        : '/api/2.1/unity-catalog/tables';
  if (!options.host || !options.token) {
    return { ok: false, detail: 'The signed-in user context needed to validate this asset is unavailable.' };
  }
  const blocked = browseBlockedByScope({
    apiPath,
    token: options.token,
    declaredScopes: options.declaredScopes,
  });
  if (blocked) return { ok: false, detail: blocked };
  const answer = await workspaceGet(`${apiPath}/${encodeURIComponent(value)}`, options);
  if (answer.kind === 'http' && answer.status >= 200 && answer.status < 300) return { ok: true };
  if (answer.kind === 'http') {
    return {
      ok: false,
      detail: `Unity Catalog could not validate ${value}: HTTP ${answer.status}.`,
    };
  }
  return {
    ok: false,
    detail:
      answer.kind === 'timeout'
        ? `Validation timed out for ${value}.`
        : `Validation was cancelled before ${value} could be confirmed.`,
  };
}

export function normalizedUnityCatalogSearch(value: string): { words: string; compact: string } {
  const words = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[._\-\s]+/g, ' ')
    .replace(/\s+/g, ' ');
  return { words, compact: words.replace(/\s+/g, '') };
}

export function matchesUnityCatalogSearch(
  value: string,
  query: ReturnType<typeof normalizedUnityCatalogSearch>
): boolean {
  const candidate = normalizedUnityCatalogSearch(value);
  return candidate.words.includes(query.words) || candidate.compact.includes(query.compact);
}

async function browsePages(
  first: () => Promise<BrowseResponse>,
  next: (token: string, page: number) => Promise<BrowseResponse>,
  maxPages: number
): Promise<{ items: BrowseItem[]; response: BrowseResponse; more: boolean }> {
  let response = await first();
  let items: BrowseItem[] = [];
  let page = 1;
  const tokens = new Set<string>();
  while (response.status === 'ok') {
    items = [...new Map([...items, ...response.items].map((item) => [item.id, item])).values()];
    if (!response.next_page_token || page >= maxPages || tokens.has(response.next_page_token)) {
      return { items, response, more: Boolean(response.next_page_token) };
    }
    tokens.add(response.next_page_token);
    page += 1;
    response = await next(response.next_page_token, page);
  }
  return { items, response, more: false };
}

export async function searchUnityCatalogAssets(
  options: BrowseCallOptions,
  rawQuery: string
): Promise<UnityCatalogSearchResponse> {
  const query = normalizedUnityCatalogSearch(rawQuery);
  if (query.compact.length < 2) return { status: 'ok', items: [], more_results: false };
  const catalogs = await browsePages(
    () => listCatalogs({ ...options, page: 1 }),
    (pageToken, page) => listCatalogs({ ...options, pageToken, page }),
    BROWSE_PAGE_LIMIT
  );
  if (catalogs.response.status !== 'ok') {
    return {
      status: catalogs.response.status,
      items: [],
      detail: catalogs.response.detail,
      more_results: false,
    };
  }

  const results: UnityCatalogSearchItem[] = catalogs.items
    .filter((item) => matchesUnityCatalogSearch(item.id, query))
    .map((item) => ({ resource_type: 'catalog', value: item.id, label: item.label }));
  const orderedCatalogs = [...catalogs.items].sort(
    (a, b) => Number(matchesUnityCatalogSearch(b.id, query)) - Number(matchesUnityCatalogSearch(a.id, query))
  );
  const scannedCatalogs = orderedCatalogs.slice(0, UC_SEARCH_CATALOG_SCAN_LIMIT);
  let more = catalogs.more || orderedCatalogs.length > scannedCatalogs.length;
  const schemaLists = await Promise.all(
    scannedCatalogs.map(async (catalog) => {
      const listed = await browsePages(
        () => listSchemas({ ...options, catalog: catalog.id, page: 1 }),
        (pageToken, page) => listSchemas({ ...options, catalog: catalog.id, pageToken, page }),
        2
      );
      return { catalog: catalog.id, ...listed };
    })
  );
  const schemas: Array<{ catalog: string; item: BrowseItem; value: string }> = [];
  for (const listed of schemaLists) {
    more ||= listed.more || listed.response.status !== 'ok';
    for (const item of listed.items) {
      const value = item.secondary || `${listed.catalog}.${item.id}`;
      schemas.push({ catalog: listed.catalog, item, value });
      if (matchesUnityCatalogSearch(value, query)) {
        results.push({ resource_type: 'schema', value, label: item.label });
      }
    }
  }

  const orderedSchemas = [...schemas].sort(
    (a, b) => Number(matchesUnityCatalogSearch(b.value, query)) - Number(matchesUnityCatalogSearch(a.value, query))
  );
  const scannedSchemas = orderedSchemas.slice(0, UC_SEARCH_SCHEMA_SCAN_LIMIT);
  more ||= orderedSchemas.length > scannedSchemas.length;
  const tableLists = await Promise.all(
    scannedSchemas.map(async ({ catalog, item }) => {
      const listed = await browsePages(
        () => listTables({ ...options, catalog, schema: item.id, page: 1 }),
        (pageToken, page) => listTables({ ...options, catalog, schema: item.id, pageToken, page }),
        1
      );
      return listed;
    })
  );
  for (const listed of tableLists) {
    more ||= listed.more || listed.response.status !== 'ok';
    for (const item of listed.items) {
      if (matchesUnityCatalogSearch(item.id, query)) {
        results.push({
          resource_type: 'table',
          value: item.id,
          label: item.label,
          asset_type: /view/i.test(item.secondary) ? 'view' : 'table',
        });
      }
    }
  }

  const deduped = [
    ...new Map(results.map((item) => [`${item.resource_type}:${item.value.toLocaleLowerCase()}`, item])).values(),
  ];
  return {
    status: 'ok',
    items: deduped.slice(0, UC_SEARCH_RESULT_LIMIT),
    more_results: more || deduped.length > UC_SEARCH_RESULT_LIMIT,
  };
}

export async function listWarehouses(options: BrowseCallOptions & { pageToken?: string }): Promise<BrowseResponse> {
  const apiPath = '/api/2.0/sql/warehouses';
  const parts = [`page_size=${BROWSE_PAGE_SIZE}`];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  return listWithGuard('warehouses', apiPath, `${apiPath}?${parts.join('&')}`, options, warehouseItems);
}

export async function listGenieSpaces(options: BrowseCallOptions & { pageToken?: string }): Promise<BrowseResponse> {
  const apiPath = '/api/2.0/genie/spaces';
  const parts = [`page_size=${BROWSE_PAGE_SIZE}`];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  return listWithGuard('genie-spaces', apiPath, `${apiPath}?${parts.join('&')}`, options, genieItems);
}

/**
 * List the model serving endpoints the signed-in user can see.
 *
 * On the `serving.serving-endpoints` scope, which this app already declares for
 * the orchestrator endpoint check, so this list adds no consent risk. The list
 * API has answered without a page token every time it has been read here; the
 * token is passed through anyway rather than assumed absent.
 */
export async function listServingEndpoints(
  options: BrowseCallOptions & { pageToken?: string }
): Promise<BrowseResponse> {
  const apiPath = '/api/2.0/serving-endpoints';
  const parts: string[] = [];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  const query = parts.length ? `?${parts.join('&')}` : '';
  return listWithGuard('serving-endpoints', apiPath, `${apiPath}${query}`, options, servingEndpointItems);
}

/**
 * List one workspace directory for notebook browsing.
 *
 * `path` is required. The route defaults it to the signed-in user's home when
 * the client omits it. There is no page token; open a directory via its path.
 */
export async function listNotebooks(options: BrowseCallOptions & { path: string }): Promise<BrowseResponse> {
  const path = options.path.trim();
  if (!path) {
    return failed('notebooks', 'A workspace path is required to list notebooks.');
  }
  const apiPath = '/api/2.0/workspace/list';
  const query = `path=${encodeURIComponent(path)}`;
  return listWithGuard('notebooks', apiPath, `${apiPath}?${query}`, options, notebookItems, path);
}

export type NotebookPathValidation =
  | { ok: true; path: string }
  | { ok: false; status: 400 | 403 | 404 | 503; detail: string };

/**
 * Confirm a selected workspace path is a notebook the signed-in user can read.
 *
 * `get-status` distinguishes notebooks from directories. `export` is the
 * permission check: metadata visibility alone does not establish that the
 * caller may read the notebook itself. The source is discarded.
 */
export async function validateNotebookPath(
  pathInput: string,
  options: BrowseCallOptions
): Promise<NotebookPathValidation> {
  const path = pathInput.trim();
  if (!path.startsWith('/') || path.length > 1024) {
    return { ok: false, status: 400, detail: 'Choose an absolute workspace notebook path.' };
  }
  const apiPaths = ['/api/2.0/workspace/get-status', '/api/2.0/workspace/export'] as const;
  for (const apiPath of apiPaths) {
    const missingScope = browseBlockedByScope({
      apiPath,
      token: options.token,
      declaredScopes: options.declaredScopes,
    });
    if (missingScope) {
      return {
        ok: false,
        status: 403,
        detail: `Your sign-in does not carry ${missingScope}, so this notebook cannot be validated.`,
      };
    }
    const suffix = apiPath.endsWith('/export')
      ? `path=${encodeURIComponent(path)}&format=SOURCE`
      : `path=${encodeURIComponent(path)}`;
    const answer = await workspaceGet(`${apiPath}?${suffix}`, options);
    if (answer.kind !== 'http') {
      return {
        ok: false,
        status: 503,
        detail:
          answer.kind === 'timeout'
            ? 'The workspace did not answer before notebook validation timed out.'
            : 'The workspace could not be reached to validate this notebook.',
      };
    }
    if (answer.status === 404 || text(answer.body.error_code) === 'RESOURCE_DOES_NOT_EXIST') {
      return { ok: false, status: 404, detail: 'No workspace notebook exists at that path.' };
    }
    if (answer.status === 401 || answer.status === 403) {
      return {
        ok: false,
        status: 403,
        detail: 'Your sign-in may not read that workspace notebook.',
      };
    }
    if (answer.status < 200 || answer.status >= 300) {
      return {
        ok: false,
        status: 503,
        detail: `The workspace refused notebook validation with HTTP ${answer.status}.`,
      };
    }
    if (apiPath.endsWith('/get-status') && text(answer.body.object_type).toUpperCase() !== 'NOTEBOOK') {
      return { ok: false, status: 400, detail: 'Choose a notebook, not a workspace folder.' };
    }
  }
  return { ok: true, path };
}

function volumeItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.volumes) ? body.volumes : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const fullName = text(record.full_name) || text(record.name);
    if (!fullName) continue;
    const short = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
    items.push({
      id: short,
      label: short,
      secondary: text(record.volume_type) || fullName,
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

/**
 * List Unity Catalog volumes under a catalog.schema.
 *
 * Apps has no volumes browse scope (`catalog.volumes` is rejected). The call
 * still goes out when the sign-in already carries catalog browse: the same
 * unity-catalog token family opens catalogs and schemas, and a volume list that
 * then 403s is reported as a grant problem rather than as "browsing unavailable".
 * Pre-blocked only when catalog.schemas:read itself is missing, because that is
 * the permission that got the reader into this schema in the first place.
 */
export async function listVolumes(
  options: BrowseCallOptions & { catalog: string; schema: string; pageToken?: string }
): Promise<BrowseResponse> {
  const catalog = options.catalog.trim();
  const schema = options.schema.trim();
  const page = options.page ?? (options.pageToken ? 2 : 1);
  if (!Number.isInteger(page) || page < 1 || page > BROWSE_PAGE_LIMIT) {
    return failed(
      'volumes',
      `Resource discovery is limited to ${BROWSE_PAGE_LIMIT} pages per list.`,
      'page cap reached'
    );
  }
  if (!catalog || !schema) {
    return failed('volumes', 'A catalog and schema are required to list volumes.');
  }
  const blocked = browseBlockedByScope({
    apiPath: '/api/2.1/unity-catalog/schemas',
    token: options.token,
    declaredScopes: options.declaredScopes,
  });
  if (blocked) return unavailable('volumes', blocked);

  const apiPath = '/api/2.1/unity-catalog/volumes';
  const query =
    `catalog_name=${encodeURIComponent(catalog)}` +
    `&schema_name=${encodeURIComponent(schema)}` +
    `&${pageQuery(options.pageToken)}`;
  // No volumes Apps scope to map: skip browseBlockedByScope for the volumes
  // path itself and interpret the answer (a scope-worded 403 still becomes
  // unavailable via interpretBrowseAnswer).
  if (!options.host) {
    return failed('volumes', 'This app was given no workspace host, so it does not know where to browse.');
  }
  if (!options.token) {
    return failed('volumes', 'This request carried no signed-in user token, so browsing as you is not possible.');
  }
  const answer = await workspaceGet(`${apiPath}?${query}`, options);
  return interpretBrowseAnswer({
    kind: 'volumes',
    apiPath,
    answer,
    itemsFromBody: volumeItems,
    tokenScopes: scopesFromToken(options.token),
    page,
  });
}

function vectorSearchEndpointItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.endpoints) ? body.endpoints : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    if (!name) continue;
    const status = record.endpoint_status;
    const state = status && typeof status === 'object' ? text((status as Record<string, unknown>).state) : '';
    const count = typeof record.num_indexes === 'number' ? `${record.num_indexes} indexes` : '';
    items.push({
      id: name,
      label: name,
      secondary: [state, count].filter(Boolean).join(', '),
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function vectorSearchIndexItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.vector_indexes)
    ? body.vector_indexes
    : Array.isArray(body.indexes)
      ? body.indexes
      : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    if (!name) continue;
    const short = name.includes('.') ? name.split('.').pop()! : name;
    items.push({
      id: name,
      label: short,
      secondary: text(record.index_type) || text(record.endpoint_name),
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

export async function listVectorSearchEndpoints(
  options: BrowseCallOptions & { pageToken?: string }
): Promise<BrowseResponse> {
  const apiPath = '/api/2.0/vector-search/endpoints';
  const parts: string[] = [];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  const query = parts.length ? `?${parts.join('&')}` : '';
  return listWithGuard('vector-search-endpoints', apiPath, `${apiPath}${query}`, options, vectorSearchEndpointItems);
}

export async function listVectorSearchIndexes(
  options: BrowseCallOptions & { endpoint: string; pageToken?: string }
): Promise<BrowseResponse> {
  const endpoint = options.endpoint.trim();
  if (!endpoint) {
    return failed('vector-search-indexes', 'A Vector Search endpoint name is required to list indexes.');
  }
  const apiPath = '/api/2.0/vector-search/indexes';
  const parts = [`endpoint_name=${encodeURIComponent(endpoint)}`];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  return listWithGuard(
    'vector-search-indexes',
    apiPath,
    `${apiPath}?${parts.join('&')}`,
    options,
    vectorSearchIndexItems
  );
}

function lakebaseProjectItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.projects) ? body.projects : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    if (!name) continue;
    const status = record.status;
    const display = status && typeof status === 'object' ? text((status as Record<string, unknown>).display_name) : '';
    const short = name.startsWith('projects/') ? name.slice('projects/'.length) : name;
    items.push({
      id: name,
      label: display || short,
      secondary: display && display !== short ? short : '',
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function lakebaseBranchItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.branches) ? body.branches : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    if (!name) continue;
    const short = name.includes('/branches/') ? name.slice(name.lastIndexOf('/branches/') + '/branches/'.length) : name;
    const status = record.status;
    const state = status && typeof status === 'object' ? text((status as Record<string, unknown>).state) : '';
    items.push({
      id: name,
      label: short,
      secondary: state,
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

function lakebaseDatabaseItems(body: Record<string, unknown>) {
  const rows = Array.isArray(body.databases) ? body.databases : [];
  const items: BrowseItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    if (!name) continue;
    const short = name.includes('/databases/')
      ? name.slice(name.lastIndexOf('/databases/') + '/databases/'.length)
      : name;
    items.push({
      id: name,
      label: short,
      secondary: name,
      expandable: false,
    });
  }
  return { items, next_page_token: text(body.next_page_token) };
}

/** Ensure a Lakebase parent name is the full `projects/...` form. */
export function lakebaseProjectParent(project: string): string {
  const trimmed = project.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('projects/') ? trimmed : `projects/${trimmed}`;
}

export async function listLakebaseProjects(
  options: BrowseCallOptions & { pageToken?: string }
): Promise<BrowseResponse> {
  const apiPath = '/api/2.0/postgres/projects';
  const parts = [`page_size=${BROWSE_PAGE_SIZE}`];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  return listWithGuard('lakebase-projects', apiPath, `${apiPath}?${parts.join('&')}`, options, lakebaseProjectItems);
}

export async function listLakebaseBranches(
  options: BrowseCallOptions & { project: string; pageToken?: string }
): Promise<BrowseResponse> {
  const parent = lakebaseProjectParent(options.project);
  if (!parent) {
    return failed('lakebase-branches', 'A Lakebase project is required to list branches.');
  }
  const apiPath = `/api/2.0/postgres/${parent}/branches`;
  const parts = [`page_size=${BROWSE_PAGE_SIZE}`];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  return listWithGuard(
    'lakebase-branches',
    // Scope map keys the family, not every parent path.
    '/api/2.0/postgres/projects',
    `${apiPath}?${parts.join('&')}`,
    options,
    lakebaseBranchItems
  );
}

export async function listLakebaseDatabases(
  options: BrowseCallOptions & { branch: string; pageToken?: string }
): Promise<BrowseResponse> {
  const branch = options.branch.trim();
  if (!branch) {
    return failed('lakebase-databases', 'A Lakebase branch is required to list databases.');
  }
  const parent = branch.startsWith('projects/') ? branch : '';
  if (!parent || !parent.includes('/branches/')) {
    return failed(
      'lakebase-databases',
      'A full branch resource name (projects/.../branches/...) is required to list databases.'
    );
  }
  const apiPath = `/api/2.0/postgres/${parent}/databases`;
  const parts = [`page_size=${BROWSE_PAGE_SIZE}`];
  if (options.pageToken) parts.push(`page_token=${encodeURIComponent(options.pageToken)}`);
  return listWithGuard(
    'lakebase-databases',
    '/api/2.0/postgres/projects',
    `${apiPath}?${parts.join('&')}`,
    options,
    lakebaseDatabaseItems
  );
}

/**
 * MLflow experiment browse cannot run on a forwarded Apps token.
 *
 * Databricks Apps rejects every MLflow family name (`mlflow`,
 * `mlflow.experiments:read`, `experiments`, …). See experiment-probe.ts. This
 * returns the settled unavailable outcome without calling the workspace, so the
 * picker falls back to typing rather than flashing a red failure.
 */
export function listExperiments(
  _options: BrowseCallOptions & { pageToken?: string } = {
    host: '',
    token: '',
  }
): Promise<BrowseResponse> {
  return Promise.resolve(unavailableNoAppsScope('experiments', 'MLflow'));
}

/** User-scoped request context shared by every browse route. */
export function browseRequestContext(input: {
  token: string | null;
  host?: string;
  principal?: string;
  signal?: AbortSignal;
  page?: number;
}): BrowseCallOptions {
  return {
    host: normalizeWorkspaceHost(input.host ?? process.env.DATABRICKS_HOST ?? ''),
    token: input.token?.trim() ?? '',
    principal: input.principal?.trim().toLocaleLowerCase(),
    signal: input.signal,
    page: input.page,
  };
}

/**
 * Discover addable connection categories through the signed-in user's token.
 *
 * Only the five independent roots are read. Catalog/schema/table/volume and
 * Vector endpoint/index children are deliberately not enumerated here: opening
 * a type merely needs to know that its root is browseable, and the picker loads
 * each child only after the user selects its parent. No service-principal
 * fallback is permitted here.
 */
export async function discoverConnectionTypes(options: BrowseCallOptions): Promise<ConnectionTypesResponse> {
  const roots = await Promise.all([
    listCatalogs(options),
    listWarehouses(options),
    listGenieSpaces(options),
    listServingEndpoints(options),
    listVectorSearchEndpoints(options),
  ]);
  const catalogs = roots[0];
  const vectorEndpoints = roots[4];
  const byKind = new Map(roots.map((response) => [response.kind, response]));
  const definitions: ConnectionTypeAvailability[] = [
    { id: 'catalog', label: 'Catalog', rootKind: 'catalogs' },
    { id: 'schema', label: 'Schema', rootKind: 'catalogs' },
    { id: 'table', label: 'Table or view', rootKind: 'catalogs' },
    { id: 'volume', label: 'Volume', rootKind: 'catalogs' },
    { id: 'sql-warehouse', label: 'SQL warehouse', rootKind: 'warehouses' },
    { id: 'genie-space', label: 'Genie space', rootKind: 'genie-spaces' },
    { id: 'serving-endpoint', label: 'Serving endpoint', rootKind: 'serving-endpoints' },
    {
      id: 'vector-search-endpoint',
      label: 'Vector Search endpoint',
      rootKind: 'vector-search-endpoints',
    },
    {
      id: 'vector-search-index',
      label: 'Vector Search index',
      rootKind: 'vector-search-endpoints',
    },
  ];
  const available = definitions.filter((definition) => {
    if (definition.id === 'schema' || definition.id === 'table' || definition.id === 'volume') {
      return catalogs.status === 'ok' && catalogs.items.length > 0;
    }
    if (definition.id === 'vector-search-index') {
      return vectorEndpoints.status === 'ok' && vectorEndpoints.items.length > 0;
    }
    const response = byKind.get(definition.rootKind);
    return response?.status === 'ok' && response.items.length > 0;
  });
  const unavailable = roots
    .filter((response) => response.status !== 'ok' || response.items.length === 0)
    .map((response) => ({
      rootKind: response.kind,
      status:
        response.status === 'unavailable'
          ? ('denied' as const)
          : response.status === 'failed'
            ? ('failed' as const)
            : ('empty' as const),
      detail: response.status === 'ok' ? 'No visible resources were returned.' : response.detail,
    }));
  return {
    available,
    unavailable,
    discovery: {
      mode: 'lazy',
      complete: false,
      incomplete_reason: 'children_not_enumerated',
      root_calls: roots.length,
      concurrency_limit: DISCOVERY_MAX_CONCURRENCY,
    },
  };
}
