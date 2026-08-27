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
const QUERY_HISTORY_PAGE_SIZE = 999;
const MAX_PAGES_PER_STATUS = 100;

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
    status: ActiveQueryStatus;
    pageToken?: string;
    maxResults: number;
  }): Promise<QueryHistoryPage>;
  cancelStatement(statementId: string): Promise<void>;
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

export interface WarehouseCancellationResult {
  matched: number;
  cancel_requested: number;
  already_finished_or_raced: number;
  refused: number;
  failed: number;
  details: WarehouseCancellationDetail[];
}

export interface CancelAstrolabeWarehouseQueriesInput {
  warehouseId: string;
  scope: WarehouseCancellationScope;
  transport: WarehouseCancellationTransport;
  sleep?: (milliseconds: number) => Promise<void>;
  sweepDelayMs?: number;
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

async function scanPass(input: {
  warehouseId: string;
  scope: WarehouseCancellationScope;
  transport: WarehouseCancellationTransport;
}): Promise<Map<string, ActiveQueryStatus>> {
  const candidates = new Map<string, ActiveQueryStatus>();
  for (const requestedStatus of ACTIVE_QUERY_STATUSES) {
    let pageToken: string | undefined;
    const usedTokens = new Set<string>();
    for (let page = 0; page < MAX_PAGES_PER_STATUS; page += 1) {
      const response = await input.transport.listQueries({
        warehouseId: input.warehouseId,
        status: requestedStatus,
        pageToken,
        maxResults: QUERY_HISTORY_PAGE_SIZE,
      });
      for (const row of Array.isArray(response.res) ? response.res : []) {
        const queryId = stringValue(row.query_id);
        const activeStatus = returnedActiveStatus(row, requestedStatus);
        if (!queryId || !activeStatus) continue;
        if (row.warehouse_id !== undefined && row.warehouse_id !== input.warehouseId) continue;
        if (matchesScope(row, input.scope)) candidates.set(queryId, activeStatus);
      }

      const nextPageToken = stringValue(response.next_page_token);
      if (!nextPageToken) {
        if (response.has_next_page) {
          throw new Error('Query History reported another page without a page token.');
        }
        break;
      }
      if (usedTokens.has(nextPageToken)) {
        throw new Error('Query History repeated a page token.');
      }
      usedTokens.add(nextPageToken);
      pageToken = nextPageToken;
      if (page === MAX_PAGES_PER_STATUS - 1) {
        throw new Error(`Query History exceeded ${MAX_PAGES_PER_STATUS} pages for one status.`);
      }
    }
  }
  return candidates;
}

/**
 * Cancel the finite set of attributable statements visible in two Query
 * History passes. Queries that begin after the second pass are outside this
 * one-shot sweep.
 */
export async function cancelAstrolabeWarehouseQueries(
  input: CancelAstrolabeWarehouseQueriesInput
): Promise<WarehouseCancellationResult> {
  const warehouseId = input.warehouseId.trim();
  if (!warehouseId) throw new Error('A configured SQL warehouse ID is required.');

  const sleep = input.sleep ?? defaultSleep;
  const sweepDelayMs = Math.max(0, input.sweepDelayMs ?? DEFAULT_SWEEP_DELAY_MS);
  const matched = new Set<string>();
  const attempted = new Set<string>();
  const details: WarehouseCancellationDetail[] = [];

  for (let pass = 0; pass < 2; pass += 1) {
    const candidates = await scanPass({
      warehouseId,
      scope: input.scope,
      transport: input.transport,
    });
    for (const [queryId, queryStatus] of candidates) {
      matched.add(queryId);
      if (attempted.has(queryId)) continue;
      attempted.add(queryId);
      try {
        await input.transport.cancelStatement(queryId);
        details.push({ query_id: queryId, query_status: queryStatus, outcome: 'cancel_requested' });
      } catch (error) {
        const classified = classifyCancellationError(error);
        details.push({
          query_id: queryId,
          query_status: queryStatus,
          outcome: classified.outcome,
          ...(classified.providerStatus === undefined ? {} : { provider_status: classified.providerStatus }),
        });
      }
    }
    if (pass === 0) await sleep(sweepDelayMs);
  }

  const count = (outcome: CancellationOutcome) => details.filter((detail) => detail.outcome === outcome).length;
  return {
    matched: matched.size,
    cancel_requested: count('cancel_requested'),
    already_finished_or_raced: count('already_finished_or_raced'),
    refused: count('refused'),
    failed: count('failed'),
    details,
  };
}

interface LowLevelApiRequest {
  path: string;
  method: 'GET' | 'POST';
  headers: Headers;
  raw: false;
  query?: {
    filter_by?: { warehouse_ids: string[]; statuses: ActiveQueryStatus[] };
    include_metrics?: boolean;
    max_results?: number;
    page_token?: string;
  };
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
    async listQueries({ warehouseId, status, pageToken, maxResults }) {
      const response = await client.request({
        path: '/api/2.0/sql/history/queries',
        method: 'GET',
        headers: new Headers({ Accept: 'application/json' }),
        raw: false,
        query: {
          filter_by: { warehouse_ids: [warehouseId], statuses: [status] },
          include_metrics: false,
          max_results: maxResults,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      return queryHistoryPage(response);
    },
    async cancelStatement(statementId) {
      await client.request({
        path: `/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`,
        method: 'POST',
        headers: new Headers(),
        raw: false,
      });
    },
  };
}

/**
 * Production factory. WorkspaceClient is imported only here; unit tests inject
 * the transport or low-level client and never create credentials or live calls.
 */
export async function createWorkspaceWarehouseCancellationTransport(input: {
  host?: string;
  token?: string;
} = {}): Promise<WarehouseCancellationTransport> {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  const client = input.token
    ? new WorkspaceClient({
        host: input.host,
        token: input.token,
        authType: 'pat',
      })
    : new WorkspaceClient({});
  return createDatabricksWarehouseCancellationTransport({
    request: (options) => client.apiClient.request(options),
  });
}
