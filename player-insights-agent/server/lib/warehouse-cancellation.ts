/**
 * A bounded, query-scoped cancellation sweep for Astrolabe SQL.
 *
 * This module deliberately has no warehouse lifecycle operation. It reads Query
 * History, proves ownership from query tags and identity, and sends cancellation
 * only to Statement Execution's per-statement endpoint.
 */

export const ACTIVE_QUERY_STATUSES = ['QUEUED', 'STARTED', 'COMPILING', 'COMPILED', 'RUNNING'] as const;
export type ActiveQueryStatus = (typeof ACTIVE_QUERY_STATUSES)[number];

const ACTIVE_STATUS_SET = new Set<string>(ACTIVE_QUERY_STATUSES);
const DEFAULT_SWEEP_DELAY_MS = 500;
const QUERY_HISTORY_PAGE_SIZE = 100;
export const MAX_CANCELLATION_HISTORY_PAGES = 8;
export const CANCELLATION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;
export const CANCELLATION_DEADLINE_MS = 10_000;

export interface QueryHistoryRow {
  query_id?: string;
  status?: string;
  warehouse_id?: string;
  executed_as_user_name?: string;
  user_name?: string;
  query_tags?: unknown;
  /** Query History returns this, but cancellation must never expose it. */
  query_text?: unknown;
  [key: string]: unknown;
}

export interface QueryHistoryPage {
  res?: QueryHistoryRow[];
  next_page_token?: string;
  has_next_page?: boolean;
}

export interface WarehouseCancellationTransport {
  listQueries(input: {
    warehouseId: string;
    /** Compatibility hint for injected transports; the API request uses statuses. */
    status: ActiveQueryStatus;
    statuses?: readonly ActiveQueryStatus[];
    startTimeMs?: number;
    endTimeMs?: number;
    pageToken?: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<QueryHistoryPage>;
  cancelStatement(statementId: string, signal?: AbortSignal): Promise<void>;
}

type OwnerSelector = { runId: string; correlationId?: string } | { runId?: string; correlationId: string };

export type WarehouseCancellationScope = ({ mode: 'owner'; signedInEmail: string } & OwnerSelector) | { mode: 'admin' };

export type CancellationOutcome = 'cancel_requested' | 'already_finished_or_raced' | 'refused' | 'failed';

export interface WarehouseCancellationDetail {
  query_id: string;
  query_status: ActiveQueryStatus;
  outcome: CancellationOutcome;
  /** Present only when the transport exposes an HTTP status. */
  provider_status?: number;
}

export interface WarehouseCancellationCoverage {
  complete: boolean;
  queriedRange: { from: string; to: string } | null;
  rowsRead: number;
  pagesRead: number;
  passesRead: number;
  maxPages: number;
  reason:
    | 'not-run'
    | 'complete'
    | 'page-cap'
    | 'repeated-page-token'
    | 'missing-page-token'
    | 'deadline'
    | 'caller-abort'
    | 'transport-error';
}

export interface WarehouseCancellationResult {
  matched: number;
  cancel_requested: number;
  already_finished_or_raced: number;
  refused: number;
  failed: number;
  details: WarehouseCancellationDetail[];
  /** Optional only for legacy injected no-op fixtures. New sweeps always return it. */
  coverage?: WarehouseCancellationCoverage;
}

export interface CancelAstrolabeWarehouseQueriesInput {
  warehouseId: string;
  scope: WarehouseCancellationScope;
  transport: WarehouseCancellationTransport;
  sleep?: (milliseconds: number) => Promise<void>;
  sweepDelayMs?: number;
  signal?: AbortSignal;
  deadlineMs?: number;
  maxPages?: number;
  now?: () => number;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Query History has returned query tags in both array and object-map forms.
 * Conflicting duplicate array keys fail closed instead of letting order choose
 * which application or owner tag wins.
 */
export function parseQueryTags(value: unknown): ReadonlyMap<string, string> {
  const tags = new Map<string, string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const key = stringValue(record.key);
      const tagValue = stringValue(record.value);
      if (!key || !tagValue) continue;
      const existing = tags.get(key);
      if (existing !== undefined && existing !== tagValue) return new Map();
      tags.set(key, tagValue);
    }
    return tags;
  }
  if (!value || typeof value !== 'object') return tags;
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    const tagValue = stringValue(candidate);
    if (tagValue !== undefined) tags.set(key, tagValue);
  }
  return tags;
}

function sameEmail(left: string | undefined, right: string): boolean {
  return left?.trim().toLocaleLowerCase('en-US') === right.trim().toLocaleLowerCase('en-US');
}

function matchesScope(row: QueryHistoryRow, scope: WarehouseCancellationScope): boolean {
  const tags = parseQueryTags(row.query_tags);
  if (tags.get('application') !== 'Astrolabe') return false;
  if (scope.mode === 'admin') return true;

  // Executed-as is authoritative when present. Falling back to user_name keeps
  // compatibility with older Query History rows without allowing a submitter
  // to stand in for a different execution identity.
  const executionUser = stringValue(row.executed_as_user_name) ?? stringValue(row.user_name);
  if (!sameEmail(executionUser, scope.signedInEmail)) return false;
  return (
    (scope.runId !== undefined && tags.get('run_id') === scope.runId) ||
    (scope.correlationId !== undefined && tags.get('correlation_id') === scope.correlationId)
  );
}

function returnedActiveStatus(row: QueryHistoryRow, requested: ActiveQueryStatus): ActiveQueryStatus | undefined {
  const status = stringValue(row.status);
  if (status === undefined) return requested;
  return ACTIVE_STATUS_SET.has(status) ? (status as ActiveQueryStatus) : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const direct = record.statusCode ?? record.status;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const response = record.response;
  if (response && typeof response === 'object') {
    const nested = (response as Record<string, unknown>).status;
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  }
  return undefined;
}

function errorWording(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const record = error as Record<string, unknown>;
  const pieces = [record.message, record.error_code, record.errorCode];
  const response = record.response;
  if (response && typeof response === 'object') {
    const nested = response as Record<string, unknown>;
    pieces.push(nested.message, nested.error_code, nested.errorCode);
  }
  return pieces.filter((piece): piece is string => typeof piece === 'string').join(' ');
}

function classifyCancellationError(error: unknown): {
  outcome: Exclude<CancellationOutcome, 'cancel_requested'>;
  providerStatus?: number;
} {
  const providerStatus = errorStatus(error);
  const wording = errorWording(error);
  const alreadyFinished =
    providerStatus === 409 ||
    /\bnot(?: currently)? running\b|\bnot in (?:an? )?(?:running|active) state\b|\bno longer (?:running|active)\b|\balready (?:finished|completed|canceled|cancelled)\b/i.test(
      wording
    );
  if (alreadyFinished) return { outcome: 'already_finished_or_raced', providerStatus };
  if (providerStatus === 401 || providerStatus === 403) return { outcome: 'refused', providerStatus };
  return { outcome: 'failed', providerStatus };
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

class CancellationDeadlineError extends Error {
  constructor() {
    super('SQL cancellation lookup deadline reached.');
    this.name = 'CancellationDeadlineError';
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('SQL cancellation lookup aborted.');
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function scanPass(input: {
  warehouseId: string;
  scope: WarehouseCancellationScope;
  transport: WarehouseCancellationTransport;
  startTimeMs: number;
  endTimeMs: number;
  signal: AbortSignal;
  coverage: WarehouseCancellationCoverage;
}): Promise<Map<string, ActiveQueryStatus>> {
  const candidates = new Map<string, ActiveQueryStatus>();
  if (input.coverage.pagesRead >= input.coverage.maxPages) {
    input.coverage.complete = false;
    input.coverage.reason = 'page-cap';
    return candidates;
  }
  let pageToken: string | undefined;
  const usedTokens = new Set<string>();
  while (input.coverage.pagesRead < input.coverage.maxPages) {
    let response: QueryHistoryPage;
    try {
      response = await abortable(
        input.transport.listQueries({
          warehouseId: input.warehouseId,
          status: 'RUNNING',
          statuses: ACTIVE_QUERY_STATUSES,
          startTimeMs: input.startTimeMs,
          endTimeMs: input.endTimeMs,
          pageToken,
          maxResults: QUERY_HISTORY_PAGE_SIZE,
          signal: input.signal,
        }),
        input.signal
      );
    } catch {
      input.coverage.complete = false;
      input.coverage.reason = input.signal.aborted
        ? input.signal.reason instanceof CancellationDeadlineError
          ? 'deadline'
          : 'caller-abort'
        : 'transport-error';
      break;
    }
    input.coverage.pagesRead += 1;
    const rows = Array.isArray(response.res) ? response.res : [];
    input.coverage.rowsRead += rows.length;
    for (const row of rows) {
      const queryId = stringValue(row.query_id);
      const activeStatus = returnedActiveStatus(row, 'RUNNING');
      if (!queryId || !activeStatus) continue;
      if (row.warehouse_id !== undefined && row.warehouse_id !== input.warehouseId) continue;
      // Exact application and owner/run/correlation tags are tested before the
      // row is retained; unrelated history is discarded with the page.
      if (matchesScope(row, input.scope)) candidates.set(queryId, activeStatus);
    }

    const nextPageToken = stringValue(response.next_page_token);
    if (!nextPageToken) {
      if (response.has_next_page) {
        input.coverage.complete = false;
        input.coverage.reason = 'missing-page-token';
      }
      break;
    }
    if (usedTokens.has(nextPageToken)) {
      input.coverage.complete = false;
      input.coverage.reason = 'repeated-page-token';
      break;
    }
    usedTokens.add(nextPageToken);
    pageToken = nextPageToken;
    if (input.coverage.pagesRead >= input.coverage.maxPages) {
      input.coverage.complete = false;
      input.coverage.reason = 'page-cap';
      break;
    }
  }
  return candidates;
}

/**
 * Cancel the finite attributable statements visible in two Query
 * History passes. Queries that begin after the second pass are outside this
 * one-shot sweep.
 */
export async function cancelAstrolabeWarehouseQueries(
  input: CancelAstrolabeWarehouseQueriesInput
): Promise<WarehouseCancellationResult & { coverage: WarehouseCancellationCoverage }> {
  const warehouseId = input.warehouseId.trim();
  if (!warehouseId) throw new Error('A configured SQL warehouse ID is required.');

  const sleep = input.sleep ?? defaultSleep;
  const sweepDelayMs = Math.max(0, input.sweepDelayMs ?? DEFAULT_SWEEP_DELAY_MS);
  const now = input.now?.() ?? Date.now();
  const maxPages = Math.max(
    1,
    Math.min(MAX_CANCELLATION_HISTORY_PAGES, Math.floor(input.maxPages ?? MAX_CANCELLATION_HISTORY_PAGES))
  );
  const deadlineMs = Math.max(1, Math.min(CANCELLATION_DEADLINE_MS, input.deadlineMs ?? CANCELLATION_DEADLINE_MS));
  const controller = new AbortController();
  const parentAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) parentAbort();
  else input.signal?.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new CancellationDeadlineError()), deadlineMs);
  timer.unref?.();
  const coverage: WarehouseCancellationCoverage = {
    complete: true,
    queriedRange: {
      from: new Date(now - CANCELLATION_LOOKBACK_MS).toISOString(),
      to: new Date(now).toISOString(),
    },
    rowsRead: 0,
    pagesRead: 0,
    passesRead: 0,
    maxPages,
    reason: 'complete',
  };
  const matched = new Set<string>();
  const attempted = new Set<string>();
  const details: WarehouseCancellationDetail[] = [];

  try {
    for (let pass = 0; pass < 2 && coverage.complete && !controller.signal.aborted; pass += 1) {
      const candidates = await scanPass({
        warehouseId,
        scope: input.scope,
        transport: input.transport,
        startTimeMs: now - CANCELLATION_LOOKBACK_MS,
        endTimeMs: now,
        signal: controller.signal,
        coverage,
      });
      coverage.passesRead += 1;
      for (const queryId of candidates.keys()) matched.add(queryId);
      for (const [queryId, queryStatus] of candidates) {
        if (attempted.has(queryId)) continue;
        attempted.add(queryId);
        try {
          await abortable(input.transport.cancelStatement(queryId, controller.signal), controller.signal);
          details.push({ query_id: queryId, query_status: queryStatus, outcome: 'cancel_requested' });
        } catch (error) {
          if (controller.signal.aborted) {
            coverage.complete = false;
            coverage.reason =
              controller.signal.reason instanceof CancellationDeadlineError ? 'deadline' : 'caller-abort';
            break;
          }
          const classified = classifyCancellationError(error);
          details.push({
            query_id: queryId,
            query_status: queryStatus,
            outcome: classified.outcome,
            ...(classified.providerStatus === undefined ? {} : { provider_status: classified.providerStatus }),
          });
        }
      }
      if (pass === 0 && coverage.complete) {
        try {
          await abortable(sleep(sweepDelayMs), controller.signal);
        } catch {
          coverage.complete = false;
          coverage.reason = controller.signal.reason instanceof CancellationDeadlineError ? 'deadline' : 'caller-abort';
        }
      }
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', parentAbort);
  }
  if (controller.signal.aborted && coverage.complete) {
    coverage.complete = false;
    coverage.reason = controller.signal.reason instanceof CancellationDeadlineError ? 'deadline' : 'caller-abort';
  }

  const count = (outcome: CancellationOutcome) => details.filter((detail) => detail.outcome === outcome).length;
  return {
    matched: matched.size,
    cancel_requested: count('cancel_requested'),
    already_finished_or_raced: count('already_finished_or_raced'),
    refused: count('refused'),
    failed: count('failed'),
    details,
    coverage,
  };
}

interface LowLevelApiRequest {
  path: string;
  method: 'GET' | 'POST';
  headers: Headers;
  raw: false;
  query?: {
    filter_by?: {
      warehouse_ids: string[];
      statuses: ActiveQueryStatus[];
      query_start_time_range: { start_time_ms: number; end_time_ms: number };
    };
    include_metrics?: boolean;
    max_results?: number;
    page_token?: string;
  };
  signal?: AbortSignal;
}

export interface DatabricksLowLevelApiClient {
  request(options: LowLevelApiRequest): Promise<unknown>;
}

function queryHistoryPage(value: unknown): QueryHistoryPage {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    res: Array.isArray(record.res) ? (record.res as QueryHistoryRow[]) : [],
    ...(typeof record.next_page_token === 'string' ? { next_page_token: record.next_page_token } : {}),
    ...(typeof record.has_next_page === 'boolean' ? { has_next_page: record.has_next_page } : {}),
  };
}

/** Adapt the SDK's low-level API client without leaking it into sweep logic. */
export function createDatabricksWarehouseCancellationTransport(
  client: DatabricksLowLevelApiClient
): WarehouseCancellationTransport {
  return {
    async listQueries({ warehouseId, status, statuses, startTimeMs, endTimeMs, pageToken, maxResults, signal }) {
      const end = endTimeMs ?? Date.now();
      const response = await client.request({
        path: '/api/2.0/sql/history/queries',
        method: 'GET',
        headers: new Headers({ Accept: 'application/json' }),
        raw: false,
        query: {
          filter_by: {
            warehouse_ids: [warehouseId],
            statuses: [...(statuses ?? [status])],
            query_start_time_range: {
              start_time_ms: startTimeMs ?? end - CANCELLATION_LOOKBACK_MS,
              end_time_ms: end,
            },
          },
          include_metrics: false,
          max_results: maxResults,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
        ...(signal ? { signal } : {}),
      });
      return queryHistoryPage(response);
    },
    async cancelStatement(statementId, signal) {
      await client.request({
        path: `/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`,
        method: 'POST',
        headers: new Headers(),
        raw: false,
        ...(signal ? { signal } : {}),
      });
    },
  };
}

/**
 * Production factory. WorkspaceClient is imported only here; unit tests inject
 * the transport or low-level client and never create credentials or live calls.
 */
export async function createWorkspaceWarehouseCancellationTransport(
  input: {
    host?: string;
    token?: string;
  } = {}
): Promise<WarehouseCancellationTransport> {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  const client = input.token
    ? new WorkspaceClient({
        host: input.host,
        token: input.token,
        authType: 'pat',
      })
    : new WorkspaceClient({});
  return createDatabricksWarehouseCancellationTransport({
    // The experimental SDK runtime forwards AbortSignal although its public
    // low-level request type has not declared the field yet.
    request: (options) => client.apiClient.request(options as never),
  });
}
