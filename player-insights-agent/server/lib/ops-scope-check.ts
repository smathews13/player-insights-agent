import { createHash, randomUUID } from 'node:crypto';
import type {
  OpsScopeAsset,
  OpsScopeAssetType,
  OpsScopeFilter,
  OpsScopePage,
  OpsScopePrincipal,
  OpsScopeStatus,
} from '../../shared/ops-scope-contract';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { discoveryLimiter } from './discovery-control';

const UPSTREAM_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 50;
const MAX_LIST_CALLS_PER_PRINCIPAL = 6;
const MAX_RESULTS_PER_SESSION = 1_000;
const UPSTREAM_CALL_TIMEOUT_MS = 3_000;
const SESSION_TTL_MS = 60_000;
const MAX_SESSIONS = 64;
const PROBE_CONCURRENCY = 6;

interface NamedRow {
  name?: unknown;
  full_name?: unknown;
}

interface InventoryPage {
  rows: NamedRow[];
  next: string;
}

interface Candidate {
  asset: string;
  type: OpsScopeAssetType;
  userSeen: boolean;
  appSeen: boolean;
}

interface PrincipalScanner {
  principal: 'user' | 'app';
  token: string;
  availability: OpsScopePrincipal['availability'];
  catalogToken: string;
  catalogsDone: boolean;
  catalogs: string[];
  catalogIndex: number;
  schemaToken: string;
  schemas: string[];
  schemaIndex: number;
  tableToken: string;
  pending: Candidate[];
  done: boolean;
}

interface ScopeSession {
  id: string;
  key: string;
  query: string;
  filter: OpsScopeFilter;
  host: string;
  user: PrincipalScanner;
  app: PrincipalScanner;
  pending: Map<string, Candidate>;
  emitted: Set<string>;
  emittedCount: number;
  expiresAt: number;
}

interface ScopeReadOptions {
  host: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const sessions = new Map<string, ScopeSession>();
let cachedAppCredential: { key: string; host: string; token: string; expiresAt: number } | null = null;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('base64url').slice(0, 16);
}

function abortReason(signal: AbortSignal): unknown {
  return (signal as { readonly reason?: unknown }).reason;
}

function abortError(signal: AbortSignal): Error {
  const reason = abortReason(signal);
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError');
}

function candidateKey(candidate: Pick<Candidate, 'type' | 'asset'>): string {
  return `${candidate.type}\u0000${candidate.asset}`;
}

function scanner(principal: PrincipalScanner['principal'], token: string): PrincipalScanner {
  return {
    principal,
    token,
    availability: token ? 'available' : 'unavailable',
    catalogToken: '',
    catalogsDone: false,
    catalogs: [],
    catalogIndex: 0,
    schemaToken: '',
    schemas: [],
    schemaIndex: 0,
    tableToken: '',
    pending: [],
    done: !token,
  };
}

async function boundedFetch(url: string, token: string, options: ScopeReadOptions): Promise<Response> {
  if (options.signal.aborted) throw abortError(options.signal);
  const controller = new AbortController();
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    const reason = abortError(options.signal);
    controller.abort(reason);
    rejectAbort?.(reason);
  };
  options.signal.addEventListener('abort', abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      discoveryLimiter.run(options.signal, () =>
        (options.fetchImpl ?? fetch)(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new DOMException('Timed out', 'TimeoutError'));
          reject(new DOMException('Timed out', 'TimeoutError'));
        }, options.timeoutMs ?? UPSTREAM_CALL_TIMEOUT_MS);
      }),
      aborted,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal.removeEventListener('abort', abort);
  }
}

async function listPage(
  path: string,
  key: 'catalogs' | 'schemas' | 'tables',
  params: Record<string, string>,
  token: string,
  options: ScopeReadOptions
): Promise<InventoryPage> {
  const query = new URLSearchParams({ max_results: String(UPSTREAM_PAGE_SIZE), ...params });
  const response = await boundedFetch(`${options.host}${path}?${query.toString()}`, token, options);
  if (!response.ok) throw new Error('scope_principal_unavailable');
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    rows: Array.isArray(body[key]) ? (body[key] as NamedRow[]) : [],
    next: text(body.next_page_token),
  };
}

function matches(candidate: Candidate, query: string, filter: OpsScopeFilter): boolean {
  if (filter !== 'all' && candidate.type.toLowerCase() !== filter) return false;
  return !query || candidate.asset.toLowerCase().includes(query);
}

function remember(scannerState: PrincipalScanner, candidate: Candidate, query: string, filter: OpsScopeFilter): void {
  if (matches(candidate, query, filter)) scannerState.pending.push(candidate);
}

async function scanCandidates(
  scannerState: PrincipalScanner,
  query: string,
  filter: OpsScopeFilter,
  target: number,
  options: ScopeReadOptions,
  maxCalls = MAX_LIST_CALLS_PER_PRINCIPAL
): Promise<Candidate[]> {
  const output: Candidate[] = [];
  let calls = 0;
  const seen = (asset: string, type: OpsScopeAssetType): Candidate => ({
    asset,
    type,
    userSeen: scannerState.principal === 'user',
    appSeen: scannerState.principal === 'app',
  });
  try {
    while (output.length < target && (!scannerState.done || scannerState.pending.length > 0)) {
      const pending = scannerState.pending.shift();
      if (pending) {
        output.push(pending);
        continue;
      }
      if (calls >= maxCalls) break;
      calls += 1;

      if (!scannerState.catalogsDone) {
        const page = await listPage(
          '/api/2.1/unity-catalog/catalogs',
          'catalogs',
          scannerState.catalogToken ? { page_token: scannerState.catalogToken } : {},
          scannerState.token,
          options
        );
        for (const row of page.rows) {
          const name = text(row.name);
          if (!name) continue;
          if (!scannerState.catalogs.includes(name)) scannerState.catalogs.push(name);
          remember(scannerState, seen(name, 'Catalog'), query, filter);
        }
        scannerState.catalogToken = page.next;
        scannerState.catalogsDone = !page.next;
        if (!page.next && (filter === 'catalog' || scannerState.catalogs.length === 0)) scannerState.done = true;
        continue;
      }

      if (scannerState.catalogIndex < scannerState.catalogs.length) {
        const catalog = scannerState.catalogs[scannerState.catalogIndex];
        const page = await listPage(
          '/api/2.1/unity-catalog/schemas',
          'schemas',
          {
            catalog_name: catalog,
            ...(scannerState.schemaToken ? { page_token: scannerState.schemaToken } : {}),
          },
          scannerState.token,
          options
        );
        for (const row of page.rows) {
          const shortName = text(row.name);
          const name = text(row.full_name) || (shortName ? `${catalog}.${shortName}` : '');
          if (!name) continue;
          if (!scannerState.schemas.includes(name)) scannerState.schemas.push(name);
          remember(scannerState, seen(name, 'Schema'), query, filter);
        }
        scannerState.schemaToken = page.next;
        if (!page.next) {
          scannerState.schemaToken = '';
          scannerState.catalogIndex += 1;
          if (scannerState.catalogIndex >= scannerState.catalogs.length && filter === 'schema') {
            scannerState.done = true;
          }
        }
        continue;
      }

      if (scannerState.schemaIndex < scannerState.schemas.length) {
        const fullName = scannerState.schemas[scannerState.schemaIndex];
        const separator = fullName.indexOf('.');
        const catalog = fullName.slice(0, separator);
        const schema = fullName.slice(separator + 1);
        const page = await listPage(
          '/api/2.1/unity-catalog/tables',
          'tables',
          {
            catalog_name: catalog,
            schema_name: schema,
            ...(scannerState.tableToken ? { page_token: scannerState.tableToken } : {}),
          },
          scannerState.token,
          options
        );
        for (const row of page.rows) {
          const shortName = text(row.name);
          const name = text(row.full_name) || (shortName ? `${fullName}.${shortName}` : '');
          if (name) remember(scannerState, seen(name, 'Table'), query, filter);
        }
        scannerState.tableToken = page.next;
        if (!page.next) {
          scannerState.tableToken = '';
          scannerState.schemaIndex += 1;
          if (scannerState.schemaIndex >= scannerState.schemas.length) scannerState.done = true;
        }
        continue;
      }

      scannerState.done = true;
    }
  } catch {
    scannerState.availability = 'unavailable';
    scannerState.done = true;
  }
  return output;
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await run(items[index]);
      }
    })
  );
  return output;
}

async function probe(
  candidate: Candidate,
  principal: PrincipalScanner,
  options: ScopeReadOptions
): Promise<OpsScopeStatus> {
  const alreadySeen = principal.principal === 'user' ? candidate.userSeen : candidate.appSeen;
  if (alreadySeen) return 'in';
  if (principal.availability === 'unavailable') return 'unavailable';
  const collection = candidate.type === 'Catalog' ? 'catalogs' : candidate.type === 'Schema' ? 'schemas' : 'tables';
  try {
    const response = await boundedFetch(
      `${options.host}/api/2.1/unity-catalog/${collection}/${encodeURIComponent(candidate.asset)}`,
      principal.token,
      options
    );
    if (response.ok) return 'in';
    if (response.status === 403 || response.status === 404) return 'out';
    principal.availability = 'unavailable';
    return 'unavailable';
  } catch {
    principal.availability = 'unavailable';
    return 'unavailable';
  }
}

function principal(label: string, provenance: OpsScopePrincipal['provenance'], state: PrincipalScanner) {
  return { label, provenance, availability: state.availability } satisfies OpsScopePrincipal;
}

function cleanSessions(now: number): void {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

async function appCredential(input: {
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  appToken?: () => Promise<{ host: string; token: string }>;
  timeoutMs?: number;
}): Promise<{ host: string; token: string } | null> {
  if (input.signal.aborted) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort?.(abortError(input.signal));
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([
      (input.appToken ?? (() => mintAppScopeToken(input.signal, { fetchImpl: input.fetchImpl })))(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new DOMException('Timed out', 'TimeoutError')),
          input.timeoutMs ?? UPSTREAM_CALL_TIMEOUT_MS
        );
      }),
      aborted,
    ]);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
    input.signal.removeEventListener('abort', abort);
  }
}

export async function readOpsScopesPage(input: {
  userToken: string;
  principal: string;
  signal: AbortSignal;
  query?: string;
  filter?: OpsScopeFilter;
  cursor?: string;
  limit?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  appToken?: () => Promise<{ host: string; token: string }>;
  host?: string;
  upstreamTimeoutMs?: number;
}): Promise<OpsScopePage> {
  const now = (input.now ?? Date.now)();
  const query = text(input.query).toLowerCase().slice(0, 120);
  const filter = input.filter ?? 'all';
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(input.limit ?? MAX_PAGE_SIZE)));
  const credential = await appCredential({ ...input, timeoutMs: input.upstreamTimeoutMs });
  const host = normalizeWorkspaceHost(credential?.host || input.host || process.env.DATABRICKS_HOST);
  if (!host) throw new Error('scope_check_unavailable');
  const key = `${input.principal.toLowerCase()}\u0000${tokenKey(input.userToken)}\u0000${tokenKey(credential?.token ?? '')}`;
  cleanSessions(now);

  let session = input.cursor ? sessions.get(input.cursor) : undefined;
  const firstPage = !session;
  if (input.cursor && (!session || session.key !== key || session.query !== query || session.filter !== filter)) {
    throw new Error('scope_cursor_expired');
  }
  if (!session) {
    session = {
      id: randomUUID(),
      key,
      query,
      filter,
      host,
      user: scanner('user', input.userToken),
      app: scanner('app', credential?.token ?? ''),
      pending: new Map(),
      emitted: new Set(),
      emittedCount: 0,
      expiresAt: now + SESSION_TTL_MS,
    };
    sessions.set(session.id, session);
  }
  session.expiresAt = now + SESSION_TTL_MS;
  const options = { host, signal: input.signal, fetchImpl: input.fetchImpl, timeoutMs: input.upstreamTimeoutMs };
  const room = Math.max(0, MAX_RESULTS_PER_SESSION - session.emittedCount);
  const pageLimit = Math.min(limit, room);

  if (session.pending.size === 0 && room > 0) {
    const listCallBudget = firstPage && filter === 'all' && !query ? 1 : MAX_LIST_CALLS_PER_PRINCIPAL;
    const [userRows, appRows] = await Promise.all([
      scanCandidates(session.user, query, filter, pageLimit, options, listCallBudget),
      scanCandidates(session.app, query, filter, pageLimit, options, listCallBudget),
    ]);
    for (const candidate of [...userRows, ...appRows]) {
      const id = candidateKey(candidate);
      if (session.emitted.has(id)) continue;
      const existing = session.pending.get(id);
      session.pending.set(
        id,
        existing
          ? {
              ...existing,
              userSeen: existing.userSeen || candidate.userSeen,
              appSeen: existing.appSeen || candidate.appSeen,
            }
          : candidate
      );
    }
  }

  const candidates = [...session.pending.values()].slice(0, pageLimit);
  for (const candidate of candidates) {
    const id = candidateKey(candidate);
    session.pending.delete(id);
    session.emitted.add(id);
  }
  const activeSession = session;
  const assets = await mapBounded(candidates, PROBE_CONCURRENCY, async (candidate): Promise<OpsScopeAsset> => {
    const [userScope, appScope] = await Promise.all([
      probe(candidate, activeSession.user, options),
      probe(candidate, activeSession.app, options),
    ]);
    return { asset: candidate.asset, type: candidate.type, userScope, appScope };
  });
  session.emittedCount += assets.length;
  const capped =
    session.emittedCount >= MAX_RESULTS_PER_SESSION &&
    (session.pending.size > 0 || !session.user.done || !session.app.done);
  const moreResults = session.pending.size > 0 || !session.user.done || !session.app.done;
  if (!moreResults) sessions.delete(session.id);

  return {
    checkedAt: new Date(now).toISOString(),
    assets,
    user: principal('Signed-in user', 'obo', session.user),
    app: principal('App service principal', 'app-service-principal', session.app),
    nextCursor: moreResults && !capped ? session.id : null,
    moreResults,
    capped,
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
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      (deps.fetchImpl ?? fetch)(`${host}/oidc/v1/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'all-apis',
        }),
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new DOMException('Timed out', 'TimeoutError'));
          reject(new DOMException('Timed out', 'TimeoutError'));
        }, UPSTREAM_CALL_TIMEOUT_MS);
      }),
    ]);
    if (!response.ok) throw new Error('app_scope_credential_unavailable');
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const token = text(body.access_token);
    if (!token) throw new Error('app_scope_credential_unavailable');
    const expiresIn =
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? Math.max(60, body.expires_in) : 3600;
    cachedAppCredential = { key: cacheKey, host, token, expiresAt: Date.now() + expiresIn * 1000 };
    return { host, token };
  } finally {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

export function forgetOpsScopeCache(): void {
  sessions.clear();
  cachedAppCredential = null;
}
