/**
 * The three Ops reads, and the reason there are three of them.
 *
 * THREE ROUTES, NOT ONE. Health, cost and traffic answer different questions
 * from different systems with different failure modes: a probe of the workspace,
 * a billing query on a warehouse, and a read of Lakebase. One route filling one
 * payload would make them one failure, and the failure they would share is the
 * worst one to share: billing is the slowest and least reliable of the three,
 * and it would hold up the block that says whether the warehouse is answering.
 * An admin opens Ops because something is wrong, so the block that diagnoses it
 * must not depend on the block that prices it.
 *
 * Each handler therefore catches its own failure and answers 200 with a reason
 * rather than throwing. A 500 gives the browser nothing to render but an error,
 * and the page's whole design is that a block which cannot answer says why in
 * the reader's words while the other two carry on.
 *
 * THESE ROUTES ARE ADMIN-ONLY BY CONSTRUCTION rather than by remembering.
 * `/api/ops` is in `ADMIN_ROUTE_PREFIXES`, so the guard registered by the admin
 * foundation refuses a consumer before any handler here runs. The guard is also
 * required as a dependency below, and nothing registers without it: a surface
 * that reports what a deployment costs and who it serves is not one to leave
 * open because a wiring change dropped a middleware.
 *
 * NOTHING HERE WIDENS WHAT ANYBODY MAY READ. The billing query runs on the
 * caller's own forwarded token, so an admin with no grant on
 * `system.billing.usage` is refused by Unity Catalog exactly as they would be in
 * a SQL editor, and the block reports that as a grant somebody makes rather than
 * as a failure. Being an admin opens the tab; it does not open the data.
 */

import { APP_SCHEMA } from '../../shared/app-schema';
import type { AppBillingTagState } from '../../shared/billing-tag';
import type { Application, Request, Response } from 'express';
import {
  buildCostStatement,
  buildCoverage,
  buildHonesty,
  buildQuestionAttribution,
  buildTiles,
  readComponentRows,
  readResourceActivityRows,
  splitBillingRows,
  type CostIdentifiers,
  type QuestionRunInput,
  type ResourceActivity,
  type StatementParameter,
  vectorIndexName,
} from '../lib/ops-billing';
import { resourceTagInventory } from '../lib/resource-tagging';
import { resolveSemanticIndexValue } from '../lib/semantic-index-name';
import {
  buildTelemetryStatement,
  grantFor,
  hasHistory,
  logsTable,
  noHistoryReason,
  offMeasurement,
  readTelemetryRows,
  stateFromFailure,
  telemetrySchema,
  uncheckedMeasurement,
} from '../lib/ops-telemetry';
import { classifyDenial, accessDependenciesFrom, UNKNOWN_PRINCIPAL } from './access-verification';
import { executionToken } from '../lib/execution-credential';
import { ANSWER_PATH_ENDPOINT_IDS, probeConnections, SERVING_ENDPOINT_KIND } from '../lib/dependency-probes';
import { appEnvironment, readStoredSettings, resourceStates, type ResourceState } from '../lib/app-settings';
import { normalizeWorkspaceHost, workspaceAppsUrl } from '../../shared/databricks-links';
import { readAppBillingTag } from '../lib/resource-tagging';
import { readOrchestratorReport } from './settings-routes';
import { isFailureCode } from '../lib/run-failure-codes';
import { readCostBudgets } from '../lib/cost-budgets-store';
import { sqlQueryTags } from '../lib/sql-query-tags';
import { isDataContractFallback, listDeclarableTablesInSchema, unionTableNames } from '../lib/declared-tables';
import { userEmail, type InsightsAppKit, type PreflightReport } from './insights-routes';
import { readRequestLatencyRows, REQUEST_LATENCY_QUERY, REQUEST_LATENCY_TABLE } from '../lib/request-latency';
import { ACTIVE_MINUTES_PER_DAY_QUERY, validIanaTimeZone } from '../lib/app-activity';
import { attributableCostBudgets } from '../../shared/cost-budgets';
import { classifiedRunStatusSql } from '../../shared/run-verdict';
import {
  createWorkspaceQueryHistoryTransport,
  EMPTY_WAREHOUSE_QUERY_ATTRIBUTION,
  readWarehouseQueryAttribution,
  type WarehouseQueryAttribution,
  type WarehouseQueryHistoryTransport,
} from '../lib/ops-query-history';
import { readRuntimeSettings } from '../lib/runtime-settings-store';
import type {
  AppMeasurement,
  DependencyResult,
  GrantRemedy,
  HealthDependency,
  OpsCostPayload,
  OpsHealthPayload,
  OpsLatencyPayload,
  OpsTrafficPayload,
  PlatformReading,
  TrafficBar,
} from '../../shared/ops-contract';
import { opsDayRange } from '../../shared/ops-contract';

/* ── Shared plumbing ─────────────────────────────────────────────────────── */

/** How long any one Ops statement is given before it is reported as unanswered. */
const STATEMENT_TIMEOUT_MS = 45_000;

/**
 * One query parameter, and only where it arrived as a single string.
 *
 * Express parses `?from[x]=1` into an object and `?from=a&from=b` into an array,
 * so a bare `String(req.query.from)` can produce `[object Object]` or silently
 * pick a value the caller did not mean. Both are treated as absent here, which
 * falls back to the default range rather than to something derived from a shape
 * nobody intended.
 */
function queryText(req: Request, name: string): string {
  const value = req.query[name];
  return typeof value === 'string' ? value.trim() : '';
}

interface StatementOutcome {
  ok: boolean;
  rows: unknown;
  message: string;
  status?: number;
}

/**
 * A stored value as text, without `String()` on something that is not one.
 *
 * `String(someObject)` is `'[object Object]'`, which is a non-empty string, so
 * every emptiness guard below it passes and every comparison fails. The same
 * reasoning as `app-settings.ts`, which learned it the hard way.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return '';
}

/** A count out of a row, where anything unreadable is zero rather than NaN. */
function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The shape of a SQL Statement Execution API response, narrowed to what is read. */
interface StatementResponse {
  message?: unknown;
  status?: { state?: unknown; error?: { message?: unknown } };
  result?: { data_array?: unknown };
}

/* ── Which workspace this is ─────────────────────────────────────────────── */

/**
 * The header every Databricks API response carries, naming the workspace.
 *
 * This is how the workspace id is learned, and the alternative is why. Genie
 * billing carries no identifier for the app that asked, so the workspace is the
 * only handle its tile has; nothing hands the container a workspace id; and a
 * literal in a tracked file is a real workspace id in a repository that gets
 * published to customers. Reading it off a response the app already makes costs
 * nothing, needs no new grant, and is correct in whatever workspace the app is
 * deployed into, including somebody else's.
 */
const ORG_ID_HEADER = 'x-databricks-org-id';

/**
 * Resolved once and kept for the life of the process.
 *
 * An app cannot move between workspaces without restarting, so a value read
 * once stays true, and re-reading it per request would put an HTTP call in
 * front of a block whose whole point is answering when things are failing.
 */
let knownWorkspaceId = '';

/** Remember the workspace from any response that named it. Free, so always taken. */
function noteWorkspaceId(response: { headers: Headers }): void {
  if (knownWorkspaceId) return;
  const seen = response.headers.get(ORG_ID_HEADER)?.trim();
  if (seen) knownWorkspaceId = seen;
}

/**
 * The workspace id, from the cache or from one cheap call.
 *
 * Returns '' rather than throwing when it cannot be established, and '' is
 * handled everywhere it is used: the Genie tile reports that this deployment
 * cannot identify its workspace and shows no figure. That is the honest
 * outcome, and it is better than the alternative of attributing somebody else's
 * Genie spend to this app.
 */
export async function resolveWorkspaceId(input: {
  host: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (knownWorkspaceId) return knownWorkspaceId;
  if (!input.host || !input.token) return '';
  const call = input.fetchImpl ?? fetch;
  try {
    // SCIM `Me` because every token that can reach the workspace can read
    // itself, so this resolves for any caller rather than only for a workspace
    // admin. The body is discarded; only the header is wanted.
    const response = await call(`${input.host}/api/2.0/preview/scim/v2/Me`, {
      headers: { authorization: `Bearer ${input.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    noteWorkspaceId(response);
  } catch (error) {
    console.warn(
      `[ops] The workspace id could not be resolved (${(error as Error).message}), so Genie spend cannot ` +
        'be narrowed to this workspace and its tile says so rather than showing a figure.'
    );
  }
  return knownWorkspaceId;
}

/** For tests, which must not inherit a workspace id from an earlier case. */
export function forgetWorkspaceId(): void {
  knownWorkspaceId = '';
}

/**
 * The endpoint serving a Vector Search index, or ''.
 *
 * Only the index payload names it. A failure here is not a cost failure: the
 * tile can still open the index, and spend stays blank rather than guessed.
 */
async function lookupVectorEndpoint(input: {
  host: string;
  token: string;
  index: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (!input.host || !input.token || !input.index) return '';
  const call = input.fetchImpl ?? fetch;
  try {
    const response = await call(`${input.host}/api/2.0/vector-search/indexes/${encodeURIComponent(input.index)}`, {
      headers: { authorization: `Bearer ${input.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return '';
    const body = (await response.json()) as { endpoint_name?: unknown };
    return typeof body.endpoint_name === 'string' ? body.endpoint_name.trim() : '';
  } catch {
    return '';
  }
}

/** The identifier Connections shows for a resource, not a second guess. */
function shownConnectionValue(state: ResourceState): string {
  return (state.intended ?? (state.configured || state.actual)).trim();
}

/** Resource names in current model configuration may be scalars or descriptor objects. */
export function configuredResourceName(value: unknown, keys: readonly string[]): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = text(record[key]).trim();
    if (candidate) return candidate;
  }
  return '';
}

/**
 * The Genie spaces and Vector Search names Connections already lists.
 *
 * Cost used to ask the live agent for those ids. It now reads the same release
 * configuration Connections uses, so a missing ping cannot empty the tiles.
 */
async function costIdentifiersFor(
  appkit: InsightsAppKit,
  req: Request,
  extras: {
    workspaceId: string;
    warehouse: string;
    fetchImpl?: typeof fetch;
    readAppBillingTag?: (appName: string) => Promise<AppBillingTagState>;
    readReport?: () => Promise<{ report: PreflightReport | null }>;
  }
): Promise<{ ids: CostIdentifiers; report: PreflightReport | null }> {
  const appName = (process.env.DATABRICKS_APP_NAME ?? '').trim();
  const [{ report }, stored, appBillingTag] = await Promise.all([
    (extras.readReport ?? readOrchestratorReport)(),
    readStoredSettings(appkit).catch(() => new Map()),
    (extras.readAppBillingTag ?? readAppBillingTag)(appName),
  ]);
  const states = resourceStates({ report, environment: appEnvironment(), stored });
  const configured = Object.fromEntries(states.map((state) => [state.resource.id, shownConnectionValue(state)]));
  const configuration = [...(report?.configuration ?? [])];
  for (const [key, value] of [
    ['data_genie_space_id', configured['genie-data']],
    ['dictionary_genie_space_id', configured['genie-dictionary']],
  ] as const) {
    if (!value || configuration.some((entry) => entry.key === key)) continue;
    configuration.push({
      key,
      value,
      env_var: '',
      source: 'connections',
      mutability: '',
      baked: false,
      required: false,
    });
  }
  const configuredGenie = accessDependenciesFrom({ configuration, env: process.env }).genieSpaces;
  const dataGenie = configuredGenie.find((space) => space.role === 'Data Genie space');
  const dictionaryGenie = configuredGenie.find((space) => space.role === 'Dictionary Genie space');
  const semanticEntry = report?.configuration.find((entry) => entry.key === 'semantic_index');
  const semanticCheck = report?.checks.find((check) => check.id === 'semantic-index');
  const endpointCheck = report?.checks.find((check) => check.id === 'semantic-index-endpoint');
  const semanticValue =
    text(configured['semantic-index']) ||
    configuredResourceName(semanticEntry?.value, ['index_name', 'full_name', 'name', 'value']) ||
    text(semanticEntry?.value);
  const vectorIndex = vectorIndexName(
    resolveSemanticIndexValue(semanticValue, text(configured.catalog), text(configured.schema)) ||
      semanticCheck?.name ||
      (process.env.PLAYER_INSIGHTS_SEMANTIC_INDEX ?? '')
  );
  let vectorEndpoint =
    queryText(req, 'vectorEndpoint') ||
    configured['semantic-index-endpoint'] ||
    endpointCheck?.name ||
    configuredResourceName(semanticEntry?.value, ['endpoint_name', 'endpoint']);
  if (!vectorEndpoint && vectorIndex) {
    vectorEndpoint = await lookupVectorEndpoint({
      host: host(),
      token: executionToken(req) ?? '',
      index: vectorIndex,
      fetchImpl: extras.fetchImpl,
    });
  }
  return {
    report,
    ids: {
      appName,
      endpointName: (process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '').trim(),
      warehouseId: extras.warehouse,
      vectorEndpoint,
      vectorIndex,
      genieSpaces: [
        {
          id: dataGenie?.id || '',
          label: 'Data Genie',
          tool: 'data_genie',
          tileId: 'genie:data',
        },
        {
          id: dictionaryGenie?.id || '',
          label: 'Dictionary Genie',
          tool: 'dictionary_genie',
          tileId: 'genie:dictionary',
        },
      ],
      workspaceId: extras.workspaceId,
      telemetryEnabled: Boolean(telemetrySchema()),
      appBillingTag,
    },
  };
}

/**
 * Run one statement as the caller and hand back rows or a message.
 *
 * Deliberately not the access-verification runner, which answers only whether a
 * statement succeeded. These blocks need the rows. Every failure path returns a
 * message rather than throwing, because a block reporting its own reason is the
 * design and an exception here would take the other two blocks' route with it if
 * anybody ever merged them.
 */
async function runStatement(input: {
  host: string;
  token: string;
  warehouseId: string;
  statement: string;
  parameters?: StatementParameter[];
  fetchImpl?: typeof fetch;
}): Promise<StatementOutcome> {
  const call = input.fetchImpl ?? fetch;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await call(`${input.host}/api/2.0/sql/statements`, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        warehouse_id: input.warehouseId,
        statement: input.statement,
        query_tags: sqlQueryTags({
          surface: 'ops',
          tool: 'ops_query',
          operation: 'diagnostics',
        }),
        ...(input.parameters?.length ? { parameters: input.parameters } : {}),
        wait_timeout: '30s',
        on_wait_timeout: 'CANCEL',
        format: 'JSON_ARRAY',
        disposition: 'INLINE',
      }),
      signal: AbortSignal.timeout(STATEMENT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
    return {
      ok: false,
      rows: null,
      message: timedOut
        ? `The SQL warehouse did not answer within ${STATEMENT_TIMEOUT_MS} ms, so nothing was read.`
        : `The SQL warehouse could not be reached: ${(error as Error).message}`,
    };
  }
  // Taken from whatever response arrives, so a deployment that has run one
  // statement never needs the extra call in `resolveWorkspaceId`.
  noteWorkspaceId(response);
  const body = (await response.json().catch(() => ({}))) as StatementResponse;
  if (!response.ok) {
    return {
      ok: false,
      rows: null,
      status: response.status,
      message: text(body.message) || `Databricks answered HTTP ${response.status} with no message body.`,
    };
  }
  const state = text(body.status?.state);
  if (state !== 'SUCCEEDED') {
    return {
      ok: false,
      rows: null,
      message: text(body.status?.error?.message) || `The statement ended in ${state || 'an unknown state'}.`,
    };
  }
  return { ok: true, rows: body.result?.data_array ?? [], message: '' };
}

/** Where this app is, or '' when the container was told nothing. */
function host(): string {
  return normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
}

function warehouseId(): string {
  return (process.env.DATABRICKS_SQL_WAREHOUSE_ID ?? '').trim();
}

function billingGrant(principal: string): GrantRemedy {
  const usage = grantFor('system.billing.usage', principal);
  const prices = grantFor('system.billing.list_prices', principal);
  return {
    object: 'system.billing',
    privilege: 'SELECT',
    statement: `${usage.statement}\n${prices.statement}`,
  };
}

/* ── Health ──────────────────────────────────────────────────────────────── */

/**
 * A probe's three-way status, in the design's words rather than the probe's.
 *
 * `unverified` becomes "not checked" and never "did not answer". A probe that
 * did not run has said NOTHING about its dependency, and rendering that as a
 * failure invents an outage; rendering it as success invents a check. This is
 * the mapping the whole block turns on.
 */
export function resultFor(status: string): DependencyResult {
  if (status === 'ok') return 'answered';
  if (status === 'failed') return 'did-not-answer';
  return 'not-checked';
}

/**
 * What the endpoint pill may state, from the probe rows this check produced.
 *
 * RESOLVED BY KIND, NEVER BY A LITERAL ID. The rows are keyed by probe id, and
 * this pill has now been wrong twice over which id to ask for: first the KIND
 * that all the endpoint probes share, which no row is keyed by, and then
 * `llm-endpoint`, which is only configured where the orchestrator's own report
 * is in hand. The health route deliberately has no report, so that id was absent
 * on every live deployment and the pill reported an endpoint serving at full
 * traffic as unchecked. Both times the lookup failed silently, because a `find`
 * that matches nothing looks exactly like a probe that did not run.
 *
 * So the rows are filtered on `kind` and on the answer-path list that the probe
 * table itself derives, and `ops-serving-endpoint.test.ts` builds a deployment's
 * configuration the way the route does and fails if that leaves nothing to read.
 *
 * Three outcomes and not two, and a failure outranks a success. Any answer-path
 * endpoint that did not answer is a question that could not be served, whatever
 * the others say; only if none failed and one answered is the endpoint ready. NO
 * ROW, OR ONLY ROWS THAT NEVER RAN, REPORTS NEITHER -- nothing here may turn a
 * probe's silence into a verdict in either direction, which is the same rule
 * `resultFor` keeps one block up.
 */
export function servingEndpointReading(rows: readonly HealthDependency[]): {
  endpointState: string;
  endpointRead: boolean;
  /**
   * The rows this reading was actually taken from.
   *
   * Carried so the table can put the reading in those rows' Result column and
   * nowhere else. Matching on kind at the far end would hand the answer path's
   * verdict to a judge endpoint the reading never looked at.
   */
  endpointRows: string[];
} {
  const endpoints = rows.filter(
    (row) => row.kind === SERVING_ENDPOINT_KIND && ANSWER_PATH_ENDPOINT_IDS.includes(row.id)
  );
  const endpointRows = endpoints.map((row) => row.id);
  if (endpoints.some((row) => row.result === 'did-not-answer')) {
    return { endpointState: 'Did not answer', endpointRead: true, endpointRows };
  }
  if (endpoints.some((row) => row.result === 'answered')) {
    return { endpointState: 'Ready', endpointRead: true, endpointRows };
  }
  return { endpointState: '', endpointRead: false, endpointRows };
}

/**
 * Whether the app can read its own store, as one platform reading.
 *
 * A READ THROUGH THE APP'S OWN SCHEMA rather than a bare connection probe, which
 * is the same choice `/api/settings` makes for the same reason: the failure that
 * matters here is a lost grant on `player_insights`, and a connection-level check
 * passes straight through one.
 *
 * "Connected" is what a successful read establishes. A failure is reported as not
 * answering rather than as disconnected, because this one statement cannot tell a
 * dropped pool from a revoked grant, and the row's note carries the database's own
 * words for which it was.
 */
export async function lakebaseReading(appkit: InsightsAppKit): Promise<PlatformReading> {
  const base: Omit<PlatformReading, 'state' | 'reason'> = {
    id: 'lakebase',
    label: 'Lakebase',
    read: true,
    rows: [],
  };
  try {
    await appkit.lakebase.query(`SELECT 1 FROM ${APP_SCHEMA}.deployment_settings LIMIT 1`);
    return { ...base, state: 'Connected', reason: '' };
  } catch (error) {
    return { ...base, state: 'Not answering', reason: (error as Error).message };
  }
}

/**
 * What the platform says about itself, which is not what PIA probed.
 *
 * Readings established differently, and the difference is the point of having
 * them at all. "The endpoint is ready" is the serving endpoint's own state. "The
 * app is running" is true by construction: this handler is answering, so the
 * container is up. Lakebase's is a read, and it arrives here already taken.
 *
 * A state and nothing else. Each of these carried a sentence of its own
 * provenance, and the pills are three words wide: the sentence was longer than
 * the reading it qualified, it said the same thing on every check, and the one
 * for an unread endpoint was on screen for weeks explaining a bug. None is an
 * availability percentage and the link below the block goes to the platform
 * record, which is what a reader wanting one should read instead.
 */
export function platformReadings(
  input: { endpointState: string; endpointRead: boolean; endpointRows?: readonly string[] },
  extra: readonly PlatformReading[] = []
): PlatformReading[] {
  return [
    {
      id: 'endpoint',
      label: 'Serving endpoint',
      state: input.endpointRead ? input.endpointState : '',
      read: input.endpointRead,
      rows: [...(input.endpointRows ?? [])],
      reason: '',
    },
    // No rows: the app is not one of the dependencies this deployment probes, so
    // the table gives this reading a line of its own rather than leaving the one
    // resource every reader is standing in off the list.
    { id: 'app', label: 'App', state: 'Running', read: true, rows: [], reason: '' },
    ...extra,
  ];
}

/**
 * The app half of health, from the one telemetry table that fills by itself.
 *
 * Four outcomes and each says what it is. Nothing here reports an availability
 * percentage or a per-route latency: the first lives on the Insights tab, and
 * the second has its own block and its own route, so neither can fail with this
 * one. This used to say latency lived "in spans this deployment does not
 * write", which was never measured and is false -- appkit runs an exporter, and
 * `otel_spans` has been filling since 2026-08-16.
 */
async function readAppMeasurement(req: Request, insightsHref: string): Promise<AppMeasurement> {
  const schema = telemetrySchema();
  if (!schema) return offMeasurement(insightsHref);

  const table = logsTable(schema);
  const base = offMeasurement(insightsHref);
  const workspace = host();
  const warehouse = warehouseId();
  const token = executionToken(req);
  const principal = userEmail(req) || UNKNOWN_PRINCIPAL;

  if (!workspace || !warehouse || !token) {
    return uncheckedMeasurement(
      insightsHref,
      'this app has no warehouse, workspace address or forwarded sign-in to read it with.'
    );
  }

  const outcome = await runStatement({
    host: workspace,
    token,
    warehouseId: warehouse,
    statement: buildTelemetryStatement(table),
    parameters: [],
  });

  if (!outcome.ok) {
    const classified = stateFromFailure(outcome.message, table);
    if (classified.state === 'no-grant') {
      return {
        ...base,
        telemetry: 'no-grant',
        table,
        grant: grantFor(classified.object, principal, classified.permission),
        reason:
          `App telemetry is switched on and writing to ${table}, and you do not have ` +
          `${classified.permission} on ${classified.object}. Every admin needs their own grant; being ` +
          'an administrator of this app does not grant it. Run the statement below, or ask whoever ' +
          'owns that schema to.',
      };
    }
    // 'unreadable' rather than 'no-rows-yet'. A read that failed has established
    // nothing about whether the table is empty, and this branch reported it as an
    // empty table for long enough that a broken query read on the page as the
    // platform not writing anything.
    return {
      ...base,
      telemetry: 'unreadable',
      table,
      reason: `${table} could not be read, so nothing about what this app served was established. Databricks said: ${outcome.message}`,
    };
  }

  const figures = readTelemetryRows(outcome.rows);
  if (!hasHistory(figures)) {
    return {
      ...base,
      ...figures,
      telemetry: 'no-rows-yet',
      table,
      reason: noHistoryReason(),
    };
  }
  return { ...base, ...figures, telemetry: 'reading', table, reason: '' };
}

/**
 * The dependency rows, from the probes the Connections page already runs.
 *
 * The same probe path rather than a second one, so a dependency cannot be
 * healthy on one page and failing on the other. Every failure lands on an empty
 * list with a reason rather than throwing, which renders as "not checked": the
 * true statement when the probes did not run.
 */
async function readDependencies(
  appkit: InsightsAppKit,
  req: Request,
  fetchImpl?: typeof fetch
): Promise<{ rows: HealthDependency[]; reason: string; checkedAt: string }> {
  try {
    const [{ report }, stored] = await Promise.all([
      readOrchestratorReport(),
      readStoredSettings(appkit).catch(() => new Map()),
    ]);
    const states = resourceStates({ report, environment: appEnvironment(), stored });
    const configured = Object.fromEntries(states.map((state) => [state.resource.id, state.configured]));
    const configuration = report?.configuration ?? [];
    let tables = accessDependenciesFrom({ configuration, env: process.env }).tables;
    const catalog = configured.catalog ?? '';
    const schema = configured.schema ?? '';
    const manifest = configuration.find((entry) => entry.key === 'declared_manifest');
    if (manifest?.source === 'data-contract' || isDataContractFallback(tables, catalog, schema)) {
      const denylistEntry = configuration.find((entry) => entry.key === 'catalog_denylist');
      const denylist = Array.isArray(denylistEntry?.value)
        ? denylistEntry.value.map((item) => String(item).trim()).filter(Boolean)
        : typeof denylistEntry?.value === 'string'
          ? denylistEntry.value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean)
          : [];
      const listed = await listDeclarableTablesInSchema({
        catalog,
        schema,
        host: host(),
        token: executionToken(req) ?? '',
        denylist,
        fetchImpl,
      });
      if (listed.length > tables.length) tables = unionTableNames(tables, listed);
    }
    const checks = await probeConnections({
      configured,
      tables,
      host: host(),
      token: executionToken(req),
      principal: userEmail(req) || '',
    });
    const checkedAt = new Date().toISOString();
    // Which of these probes has a row on Connections to land on. Built from the
    // same `resourceStates` list that page draws, so a resource renamed there
    // stops being linked here rather than producing a link to nothing.
    const documented = new Set(states.map((state) => state.resource.id));
    return {
      checkedAt,
      reason: '',
      rows: checks.map((check) => ({
        id: check.id,
        // The probe's own kind, carried so the platform pills can resolve
        // themselves by what a probe IS rather than by one of its ids.
        kind: check.kind,
        connectionsId: documented.has(check.id) ? check.id : '',
        label: check.label,
        name: check.name,
        result: resultFor(check.status),
        lastCheckedAt: check.status === 'unverified' ? '' : checkedAt,
        // The probe's own words, not a restatement. A reason rewritten here is a
        // reason that drifts from the one Connections shows for the same probe.
        reason: check.status === 'ok' ? '' : check.detail || check.error || '',
      })),
    };
  } catch (error) {
    return {
      rows: [],
      checkedAt: '',
      reason: `The dependency probes could not be run, so nothing was checked: ${(error as Error).message}`,
    };
  }
}

/* ── Traffic ─────────────────────────────────────────────────────────────── */

/** Every recorded question, by the Runtime calendar day it was asked. */
export const QUESTIONS_PER_DAY_QUERY = `
  SELECT to_char(date_trunc('day', m.created_at AT TIME ZONE $1), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
  FROM ${APP_SCHEMA}.messages m
  WHERE m.role = 'user'
  GROUP BY 1
  ORDER BY 1`;

/** Signed-in people who stored at least one user question on each Runtime calendar day. */
export const DISTINCT_ASKERS_PER_DAY_QUERY = `
  SELECT to_char(date_trunc('day', m.created_at AT TIME ZONE $1), 'YYYY-MM-DD') AS day,
         COUNT(DISTINCT lower(c.user_email))::int AS count
  FROM ${APP_SCHEMA}.messages m
  JOIN ${APP_SCHEMA}.conversations c ON c.id = m.conversation_id
  WHERE m.role = 'user'
  GROUP BY 1
  ORDER BY 1`;

const OPS_ANSWER_STATUS_SQL = classifiedRunStatusSql({
  trace: "m.response_json->'trace'",
  payload: 'm.response_json',
  caveats: "m.response_json->'caveats'",
});

/**
 * How runs ended, from both durable ledger state and stored-answer evidence.
 *
 * The rail and Run Explorer have always been able to classify answers stored
 * before the ledger existed, and can classify a failed answer whose durable run
 * itself reached SUCCEEDED. Reading only runs.state made those visible failures
 * disappear from Ops. The trace/message joins below use terminal message first
 * and trace id second, then add only answers with no matching ledger row.
 */
export const RUN_OUTCOMES_QUERY = `
  WITH answers AS (
    SELECT m.id,
           COALESCE(NULLIF(m.trace_id, ''), NULLIF(m.response_json->'trace'->>'id', '')) AS trace_id,
           ${OPS_ANSWER_STATUS_SQL} AS answer_status
    FROM ${APP_SCHEMA}.messages m
    WHERE m.role = 'assistant'
      AND jsonb_typeof(m.response_json->'trace') = 'object'
  ),
  ledger_events AS (
    SELECT r.run_id AS event_id,
           CASE
             WHEN r.state = 'REFUSED' THEN 'REFUSED'
             WHEN r.state IN ('FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED') THEN r.state
             WHEN a.answer_status = 'failed' THEN 'FAILED'
             ELSE r.state
           END AS state,
           CASE
             WHEN COALESCE(r.terminal_code, '') <> '' THEN r.terminal_code
             WHEN a.answer_status = 'failed' THEN 'NO_VALID_EVIDENCE'
             ELSE ''
           END AS terminal_code
    FROM ${APP_SCHEMA}.runs r
    LEFT JOIN LATERAL (
      SELECT answer_status
      FROM answers a
      WHERE a.id = r.terminal_message_id
         OR (COALESCE(r.trace_id, '') <> '' AND a.trace_id = r.trace_id)
      ORDER BY (a.id = r.terminal_message_id) DESC
      LIMIT 1
    ) a ON TRUE
  ),
  legacy_answer_events AS (
    SELECT a.id AS event_id,
           CASE WHEN a.answer_status = 'failed' THEN 'FAILED' ELSE 'SUCCEEDED' END AS state,
           CASE WHEN a.answer_status = 'failed' THEN 'NO_VALID_EVIDENCE' ELSE '' END AS terminal_code
    FROM answers a
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${APP_SCHEMA}.runs r
      WHERE r.terminal_message_id = a.id
         OR (COALESCE(r.trace_id, '') <> '' AND r.trace_id = a.trace_id)
    )
  ),
  events AS (
    SELECT * FROM ledger_events
    UNION ALL
    SELECT * FROM legacy_answer_events
  )
  SELECT state, terminal_code, COUNT(*)::int AS count
  FROM events
  GROUP BY 1, 2`;

/** Tool-tagged stages, counted by the tool each one named. */
export const TOOL_CALLS_QUERY = `
  SELECT stage->>'name' AS tool, COUNT(*)::int AS count
  FROM ${APP_SCHEMA}.messages m,
       LATERAL jsonb_array_elements(m.response_json->'trace'->'stages') AS stage
  WHERE m.role = 'assistant'
    AND jsonb_typeof(m.response_json->'trace'->'stages') = 'array'
    AND stage->>'kind' = 'tool'
    AND COALESCE(stage->>'name', '') <> ''
  GROUP BY 1
  ORDER BY 2 DESC`;

/** The terminal states that mean something broke, as opposed to something was declined. */
const FAILURE_STATES = new Set(['FAILED', 'DEADLINE_EXCEEDED', 'PERSISTENCE_FAILED']);

/**
 * A cause's label, which is the terminal code itself.
 *
 * Deliberately not the taxonomy's `uiMessage`. That is a sentence written for
 * somebody who cannot fix the system, and it is the wrong text for a chart an
 * administrator reads: they want the token that appears in the Run Explorer, in
 * the logs and in the deep link, so that a bar they click matches the rows they
 * land on. Prettifying it here would put a phrase on the chart that appears
 * nowhere else they could search for.
 *
 * A code the taxonomy does not define is still shown, unchanged, because the
 * run really did end that way and hiding it would shrink a chart to the causes
 * this build happens to know about.
 */
export function causeLabel(code: string): string {
  if (!code) return 'No cause recorded';
  if (!isFailureCode(code)) {
    console.warn(
      `[ops] A run ended with terminal code ${code}, which this build\u2019s failure taxonomy does not ` +
        'define. It is charted as recorded rather than dropped.'
    );
  }
  return code;
}

/**
 * The one line that stands beside the charts that did answer.
 *
 * NAMED BY WHAT A READER SEES, which is why the labels here are chart titles
 * rather than query names. The person reading it is looking at a chart that is
 * empty and needs to know that particular chart is not a measurement -- telling
 * them `RUN_OUTCOMES_QUERY` rejected asks them to know which chart that draws.
 *
 * The store's own words are carried through, because on this deployment the
 * ordinary cause is now a statement cut off at the read limit, and a reader who
 * cannot tell that from a missing table goes looking in the wrong place.
 */
function unreadNote(charts: string[], message: string): string {
  const named = charts.length === 1 ? charts[0] : `${charts.slice(0, -1).join(', ')} and ${charts[charts.length - 1]}`;
  const which = charts.length === 1 ? 'that chart is' : 'those charts are';
  return `${named} could not be read, so ${which} missing rather than empty: ${message || 'the store did not answer'}`;
}

/** Sort bars by count, then by key, so a redraw does not reshuffle equal bars. */
function toBars(counts: Map<string, number>): TrafficBar[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: causeLabel(key), count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

/* ── Per-question cost attribution ───────────────────────────────────────── */

/**
 * Completed runs and the token denominator that apportions endpoint spend.
 *
 * The window functions run before the display limit, so the newest hundred rows
 * are allocated against ALL recorded tokens in the range rather than against
 * whichever rows happened to fit on screen. The final assistant message is the
 * run ledger's `terminal_message_id`; this is the same authority Run Explorer
 * uses and avoids pairing a question with a proposed plan from the same turn.
 */
export const QUESTION_COST_RUNS_QUERY = `
  WITH completed AS (
    SELECT r.run_id, COALESCE(r.correlation_id, '') AS correlation_id,
           COALESCE(r.trace_id, '') AS trace_id, r.completed_at,
           CASE
             WHEN COALESCE(m.response_json->'trace'->>'total_tokens', '') ~ '^[0-9]+$'
               THEN (m.response_json->'trace'->>'total_tokens')::bigint
             WHEN COALESCE(m.response_json->'trace'->>'prompt_tokens', '') ~ '^[0-9]+$'
              AND COALESCE(m.response_json->'trace'->>'completion_tokens', '') ~ '^[0-9]+$'
               THEN (m.response_json->'trace'->>'prompt_tokens')::bigint
                  + (m.response_json->'trace'->>'completion_tokens')::bigint
             ELSE NULL
           END AS total_tokens
    FROM ${APP_SCHEMA}.runs r
    LEFT JOIN ${APP_SCHEMA}.messages m ON m.id = r.terminal_message_id
    WHERE r.completed_at >= $1::date
      AND r.completed_at < ($2::date + INTERVAL '1 day')
  ),
  counted AS (
    SELECT *,
           COUNT(*) OVER ()::int AS runs_in_range,
           COUNT(*) FILTER (WHERE total_tokens IS NOT NULL AND total_tokens > 0) OVER ()::int AS token_covered_runs,
           COALESCE(SUM(total_tokens) FILTER (WHERE total_tokens IS NOT NULL AND total_tokens > 0) OVER (), 0)::bigint AS total_recorded_tokens
    FROM completed
  )
  SELECT run_id, correlation_id, trace_id, completed_at, total_tokens,
         runs_in_range, token_covered_runs, total_recorded_tokens
  FROM counted
  ORDER BY completed_at DESC
  LIMIT 100`;

const QUESTION_COST_LIMIT = 100;

/**
 * Resource-scoped request counts from Astrolabe's own persisted traces.
 *
 * Current traces report exact call counts in `trace.resource_calls`. Older
 * traces recorded the Genie space id once per run in `trace.genie_spaces`; that
 * is still direct evidence that the configured space was called, so count one
 * observed call for those runs without pretending to know retries.
 */
export const RESOURCE_ACTIVITY_QUERY = `
  WITH completed AS (
    SELECT m.response_json->'trace' AS trace
    FROM ${APP_SCHEMA}.runs r
    JOIN ${APP_SCHEMA}.messages m ON m.id = r.terminal_message_id
    WHERE r.completed_at >= $1::date
      AND r.completed_at < ($2::date + INTERVAL '1 day')
      AND jsonb_typeof(m.response_json->'trace') = 'object'
  ),
  configured(tile_id, tool, resource_id) AS (
    VALUES
      ('genie:data', 'data_genie', $3::text),
      ('genie:dictionary', 'dictionary_genie', $4::text),
      ('vector-search', 'search_semantics', $5::text)
  ),
  observed AS (
    SELECT CASE
             WHEN stage->>'id' ~ '(^|-)dictionary_genie$' THEN 'dictionary_genie'
             WHEN stage->>'id' ~ '(^|-)data_genie$' THEN 'data_genie'
             WHEN stage->>'id' ~ '(^|-)search_semantics$' THEN 'search_semantics'
           END AS tool,
           SUM(CASE WHEN COALESCE(stage->>'calls', '') ~ '^[0-9]+$'
                    THEN (stage->>'calls')::bigint ELSE 1 END)::bigint AS calls
    FROM completed,
         LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(trace->'stages') = 'array'
                THEN trace->'stages' ELSE '[]'::jsonb END
         ) AS stage
    WHERE stage->>'id' ~ '(^|-)(data_genie|dictionary_genie|search_semantics)$'
    GROUP BY 1
  ),
  attributed AS (
    SELECT resource->>'tool' AS tool,
           resource->>'id' AS resource_id,
           SUM(CASE WHEN COALESCE(resource->>'calls', '') ~ '^[0-9]+$'
                    THEN (resource->>'calls')::bigint ELSE 0 END)::bigint AS calls
    FROM completed,
         LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(trace->'resource_calls') = 'array'
                THEN trace->'resource_calls' ELSE '[]'::jsonb END
         ) AS resource
    WHERE resource->>'tool' IN ('data_genie', 'dictionary_genie', 'search_semantics')
    GROUP BY 1, 2
  ),
  legacy_genie AS (
    SELECT c.tile_id, COUNT(*)::bigint AS calls
    FROM completed
    JOIN configured c ON c.tool IN ('data_genie', 'dictionary_genie')
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(trace->'genie_spaces') = 'array'
             THEN trace->'genie_spaces' ELSE '[]'::jsonb END
      ) AS space
      WHERE space->>'id' = c.resource_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(trace->'resource_calls') = 'array'
               THEN trace->'resource_calls' ELSE '[]'::jsonb END
        ) AS resource
        WHERE resource->>'tool' = c.tool
          AND resource->>'id' = c.resource_id
      )
    GROUP BY c.tile_id
  )
  SELECT c.tile_id,
         (COALESCE(a.calls, 0) + COALESCE(l.calls, 0))::bigint AS astrolabe_calls,
         GREATEST(
           COALESCE(o.calls, 0),
           COALESCE(a.calls, 0) + COALESCE(l.calls, 0)
         )::bigint AS observed_calls
  FROM configured c
  LEFT JOIN attributed a ON a.tool = c.tool AND a.resource_id = c.resource_id
  LEFT JOIN legacy_genie l ON l.tile_id = c.tile_id
  LEFT JOIN observed o ON o.tool = c.tool
  ORDER BY c.tile_id`;

async function resourceActivityAttribution(
  appkit: InsightsAppKit,
  ids: CostIdentifiers,
  range: { from: string; to: string }
): Promise<ResourceActivity[]> {
  try {
    const result = await appkit.lakebase.query(RESOURCE_ACTIVITY_QUERY, [
      range.from,
      range.to,
      ids.genieSpaces.find((space) => space.tileId === 'genie:data')?.id ?? '',
      ids.genieSpaces.find((space) => space.tileId === 'genie:dictionary')?.id ?? '',
      ids.vectorIndex,
    ]);
    return readResourceActivityRows(result.rows);
  } catch (error) {
    console.warn(`[ops] Resource-scoped usage counts could not be read: ${(error as Error).message}`);
    return [];
  }
}

function questionRun(row: Record<string, unknown>): QuestionRunInput {
  const nullableNumber = (value: unknown): number | null => {
    const parsed = Number(text(value));
    return text(value) !== '' && Number.isFinite(parsed) ? parsed : null;
  };
  return {
    runId: text(row.run_id),
    correlationId: text(row.correlation_id),
    traceId: text(row.trace_id),
    completedAt: text(row.completed_at),
    totalTokens: nullableNumber(row.total_tokens),
    runsInRange: count(row.runs_in_range),
    tokenCoveredRuns: count(row.token_covered_runs),
    totalRecordedTokens: count(row.total_recorded_tokens),
  };
}

function lagDays(rangeEnd: string, newestBillingDay: string): number | null {
  const end = Date.parse(`${rangeEnd}T00:00:00Z`);
  const newest = Date.parse(`${newestBillingDay}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(newest)) return null;
  return Math.max(0, Math.round((end - newest) / 86_400_000));
}

async function warehouseQueryAttribution(input: {
  host: string;
  token: string;
  warehouseId: string;
  range: { from: string; to: string };
  transport?: WarehouseQueryHistoryTransport;
}): Promise<WarehouseQueryAttribution> {
  const startTimeMs = Date.parse(`${input.range.from}T00:00:00Z`);
  const endTimeMs = Date.parse(`${input.range.to}T00:00:00Z`) + 86_400_000 - 1;
  if (
    !input.host ||
    !input.token ||
    !input.warehouseId ||
    !Number.isFinite(startTimeMs) ||
    !Number.isFinite(endTimeMs)
  ) {
    return { ...EMPTY_WAREHOUSE_QUERY_ATTRIBUTION };
  }
  try {
    const transport =
      input.transport ??
      (await createWorkspaceQueryHistoryTransport({
        host: input.host,
        token: input.token,
      }));
    return await readWarehouseQueryAttribution({
      warehouseId: input.warehouseId,
      startTimeMs,
      endTimeMs,
      transport,
    });
  } catch (error) {
    console.warn(`[ops] Query History attribution was withheld: ${(error as Error).message}`);
    return { ...EMPTY_WAREHOUSE_QUERY_ATTRIBUTION };
  }
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

/**
 * Every path this file serves, so the guard's coverage can be checked against it.
 *
 * A route added below and not added here is served without ever being checked
 * against the guard, which is how `/api/ops/latency` shipped: the prefix in
 * ADMIN_ROUTE_PREFIXES happened to cover it, so nothing was exposed, but the
 * coverage check that is supposed to prove that had no opinion about it. The
 * prefix is the protection; this list is what notices when a path falls outside
 * one. Keep it in step with the registrations.
 */
export const OPS_ROUTES = ['/api/ops/health', '/api/ops/cost', '/api/ops/traffic', '/api/ops/latency'] as const;

export interface OpsDeps {
  /**
   * The admin guard's own view of which paths it covers.
   *
   * `isAdminRoute` from lib/admin-roles.ts, required rather than convenient. The
   * guard is one `app.use` registered by the insights routes, and it decides
   * whether to refuse by testing the path against its own prefix list. The list
   * and the routes live in different files, so a path the list does not name is
   * served to everybody and nothing fails anywhere. Every path above is checked
   * before any is registered, and none is registered if one is not covered.
   *
   * Not a second copy of the middleware: resolving a role reads the stored admin
   * list, so applying the guard again per route would double a database read on
   * every request for no additional protection.
   */
  isAdminRoute: (path: string) => boolean;
  now?: () => number;
  /** Injected by tests, so a case can drive the range without moving the clock. */
  fetchImpl?: typeof fetch;
  /**
   * Injected by tests so Cost does not call the Apps tag API. Production reads
   * the live assignment.
   */
  readAppBillingTag?: (appName: string) => Promise<AppBillingTagState>;
  /** Injected by route tests so recovered report resources are deterministic. */
  readOrchestratorReport?: () => Promise<{ report: PreflightReport | null }>;
  /** Injected by tests; production uses the forwarded user token through the Workspace SDK. */
  queryHistoryTransport?: WarehouseQueryHistoryTransport;
}

/**
 * Register the reads in OPS_ROUTES, ONLY IF the admin guard covers every one.
 *
 * MUST be called after `setupInsightsRoutes`. Express applies middleware to what
 * is added afterwards and the guard is registered in there, so a call before it
 * would leave all Ops routes open. That ordering is why the coverage check below is
 * not the whole of the protection, and why this note is here as well as in
 * server.ts.
 */
export function setupOpsRoutes(appkit: InsightsAppKit, deps: OpsDeps) {
  if (typeof deps?.isAdminRoute !== 'function') {
    console.error(
      '[ops] NOT REGISTERED: no admin-route predicate was supplied, so there is no way to confirm these ' +
        'paths are guarded. They report what this deployment costs and how much of it people use. ' +
        'Pass isAdminRoute.'
    );
    return;
  }
  const uncovered = OPS_ROUTES.filter((path) => !deps.isAdminRoute(path));
  if (uncovered.length > 0) {
    // Loud, and nothing registered. A 404 on Ops is a page somebody reports in a
    // minute; an unguarded one is a disclosure nobody notices.
    console.error(
      `[ops] NOT REGISTERED: the admin guard does not cover ${uncovered.join(', ')}. Add the prefix to ` +
        'ADMIN_ROUTE_PREFIXES in lib/admin-roles.ts. Registering these unguarded would report this ' +
        'deployment\u2019s spend and traffic to any signed-in reader.'
    );
    return;
  }
  const clock = deps.now ?? Date.now;

  appkit.server.extend((app: Application) => {
    /* ── Health ──────────────────────────────────────────────────────────── */

    app.get('/api/ops/health', async (req: Request, res: Response) => {
      const workspace = host();
      // `?o=` is what makes the Apps list land for a reader signed in to more
      // than one workspace. The id is resolved rather than configured, since
      // nothing hands the container one, and '' simply omits the parameter.
      const appsToken = executionToken(req);
      const appsWorkspaceId = appsToken
        ? await resolveWorkspaceId({ host: workspace, token: appsToken }).catch(() => '')
        : '';
      const insightsHref = workspaceAppsUrl(workspace, appsWorkspaceId);
      try {
        // Independent of each other as well as of the other blocks: a telemetry
        // grant nobody has made must not stop the dependency rows rendering.
        const [dependencies, appMeasurement, lakebase] = await Promise.all([
          readDependencies(appkit, req, deps.fetchImpl),
          readAppMeasurement(req, insightsHref).catch((error: Error) =>
            uncheckedMeasurement(insightsHref, `reading it threw: ${error.message}.`)
          ),
          lakebaseReading(appkit),
        ]);
        const payload: OpsHealthPayload = {
          checkedAt: dependencies.checkedAt,
          dependencies: dependencies.rows,
          platform: platformReadings(servingEndpointReading(dependencies.rows), [lakebase]),
          app: appMeasurement,
          reason: dependencies.reason,
        };
        res.json(payload);
      } catch (error) {
        const payload: OpsHealthPayload = {
          checkedAt: '',
          dependencies: [],
          platform: [],
          // Not `offMeasurement`. This block failing says nothing whatever about
          // whether telemetry is configured, and reporting off here told a
          // deployment that had switched it on to go and switch it on.
          app: uncheckedMeasurement(insightsHref, `the health block itself failed: ${(error as Error).message}.`),
          reason: `This block could not be read, so nothing here was checked: ${(error as Error).message}`,
        };
        res.json(payload);
      }
    });

    /* ── Cost ────────────────────────────────────────────────────────────── */

    app.get('/api/ops/cost', async (req: Request, res: Response) => {
      const readAt = new Date(clock()).toISOString();
      const range = opsDayRange(queryText(req, 'from'), queryText(req, 'to'), clock());
      const workspace = host();
      const warehouse = warehouseId();
      const token = executionToken(req);
      const workspaceId = token ? await resolveWorkspaceId({ host: workspace, token, fetchImpl: deps.fetchImpl }) : '';
      const resolved = await costIdentifiersFor(appkit, req, {
        workspaceId,
        warehouse,
        fetchImpl: deps.fetchImpl,
        readAppBillingTag: deps.readAppBillingTag,
        readReport: deps.readOrchestratorReport,
      });
      const ids = resolved.ids;
      const [storedBudgets, resourceActivity] = await Promise.all([
        readCostBudgets(appkit),
        resourceActivityAttribution(appkit, ids, range),
      ]);
      const costBudgets = attributableCostBudgets(storedBudgets.budgets);
      const empty = {
        grant: null,
        reason: '',
        currency: '',
        throughDay: '',
        range,
        billingLagDays: null,
        readAt,
        perQuestion: {
          runs: [],
          runsInRange: 0,
          tokenCoveredRuns: 0,
          totalRecordedTokens: 0,
          limited: false,
          reason: '',
        },
        budgets: costBudgets,
        budgetsReadable: storedBudgets.readable,
      };

      if (!workspace || !warehouse || !token) {
        res.json({
          ...empty,
          state: 'no-warehouse',
          tiles: buildTiles(ids, [], EMPTY_WAREHOUSE_QUERY_ATTRIBUTION, resourceActivity),
          reason:
            'Billing could not be read because this app has no SQL warehouse, no workspace address, ' +
            'or no forwarded sign-in to read it with. Nothing about spend was established.',
        } satisfies OpsCostPayload);
        return;
      }

      const built = buildCostStatement(ids, range);
      if (!built) {
        res.json({
          ...empty,
          state: 'ready',
          tiles: buildTiles(ids, [], EMPTY_WAREHOUSE_QUERY_ATTRIBUTION, resourceActivity),
        } satisfies OpsCostPayload);
        return;
      }

      try {
        const [outcome, queryAttribution] = await Promise.all([
          runStatement({
            host: workspace,
            token,
            warehouseId: warehouse,
            statement: built.statement,
            parameters: built.parameters,
            fetchImpl: deps.fetchImpl,
          }),
          warehouseQueryAttribution({
            host: workspace,
            token,
            warehouseId: warehouse,
            range,
            transport: deps.queryHistoryTransport,
          }),
        ]);
        const inventoryCount = resourceTagInventory({ environment: process.env, report: resolved.report }).length;

        if (!outcome.ok) {
          const denial = classifyDenial(outcome.message, 'system.billing.usage');
          if (denial.kind === 'no-grant') {
            res.json({
              ...empty,
              state: 'no-grant',
              grant: billingGrant(userEmail(req) || UNKNOWN_PRINCIPAL),
              tiles: buildTiles(ids, [], queryAttribution, resourceActivity),
              reason:
                `You do not have ${denial.permission} on ${denial.object}, so no spend was read. Billing ` +
                'runs under your own grants rather than this app\u2019s, so being an administrator here ' +
                'does not grant it. SELECT is needed on both system.billing.usage and system.billing.list_prices.',
            } satisfies OpsCostPayload);
            return;
          }
          res.json({
            ...empty,
            state: 'unreadable',
            tiles: buildTiles(ids, [], queryAttribution, resourceActivity),
            reason: `Billing could not be read, so nothing about spend was established. Databricks said: ${outcome.message}`,
          } satisfies OpsCostPayload);
          return;
        }

        const split = splitBillingRows(readComponentRows(outcome.rows));
        const coverage = buildCoverage({
          inventoryCount,
          coverageRows: split.coverage,
          propagationRows: split.propagation,
          range,
          meta: split.meta,
          appBillingTag: ids.appBillingTag,
        });
        const unpropagated = coverage.propagation.filter((row) => row.status === 'unpropagated');
        const delayed = coverage.propagation.some((row) => row.status === 'delayed');

        // No exact component rows is its OWN state and not a missing grant.
        if (split.components.length === 0 && (!split.meta || split.meta.billedDays === 0)) {
          const tiles = buildTiles(ids, [], queryAttribution, resourceActivity);
          const reason = unpropagated.length
            ? 'Matching usage exists without the Astrolabe tag, but exact resource attribution remains available.'
            : delayed
              ? 'No exact tracked-resource billing rows yet. Later days may still be filling.'
              : 'No billing rows matched an exact tracked resource.';
          res.json({
            ...empty,
            state: 'no-rows',
            tiles,
            currency: split.meta?.currency ?? '',
            throughDay: split.meta?.lastDay || '',
            billingLagDays: lagDays(range.to, split.meta?.lastDay || ''),
            coverage,
            honesty: buildHonesty(range, split.meta, tiles),
            reason,
          } satisfies OpsCostPayload);
          return;
        }

        const tiles = buildTiles(ids, split.components, queryAttribution, resourceActivity);
        let perQuestion: OpsCostPayload['perQuestion'] = {
          ...empty.perQuestion,
          reason: 'Per-question attribution could not be read from the run ledger.',
        };
        try {
          const result = await appkit.lakebase.query(QUESTION_COST_RUNS_QUERY, [range.from, range.to]);
          perQuestion = buildQuestionAttribution(
            result.rows.map((row) => questionRun(row)),
            tiles,
            QUESTION_COST_LIMIT
          );
        } catch (error) {
          perQuestion.reason = `Per-question attribution could not be read from the run ledger: ${(error as Error).message}`;
        }

        res.json({
          ...empty,
          state: 'ready',
          currency: split.meta?.currency ?? tiles.find((tile) => tile.pricing?.currency)?.pricing?.currency ?? '',
          throughDay: split.meta?.lastDay || '',
          billingLagDays: lagDays(range.to, split.meta?.lastDay || ''),
          tiles,
          perQuestion,
          coverage,
          honesty: buildHonesty(range, split.meta, tiles),
        } satisfies OpsCostPayload);
      } catch (error) {
        res.json({
          ...empty,
          state: 'unreadable',
          tiles: buildTiles(ids, [], EMPTY_WAREHOUSE_QUERY_ATTRIBUTION, resourceActivity),
          reason: `Billing could not be read, so nothing about spend was established: ${(error as Error).message}`,
        } satisfies OpsCostPayload);
      }
    });

    /* ── Traffic ─────────────────────────────────────────────────────────── */

    app.get('/api/ops/traffic', async (req: Request, res: Response) => {
      const readAt = new Date(clock()).toISOString();
      try {
        const runtime = await readRuntimeSettings(appkit);
        const activeMinutesTimeZone =
          validIanaTimeZone(runtime.behavior.timezone) || validIanaTimeZone(queryText(req, 'timeZone')) || 'UTC';
        // Settled rather than awaited together: the run ledger is newer than the
        // messages table and a deployment that has not created it yet should
        // still get its questions chart rather than an empty block.
        const [questions, askers, activeMinutes, outcomes, tools] = await Promise.allSettled([
          appkit.lakebase.query(QUESTIONS_PER_DAY_QUERY, [activeMinutesTimeZone]),
          appkit.lakebase.query(DISTINCT_ASKERS_PER_DAY_QUERY, [activeMinutesTimeZone]),
          appkit.lakebase.query(ACTIVE_MINUTES_PER_DAY_QUERY, [activeMinutesTimeZone]),
          appkit.lakebase.query(RUN_OUTCOMES_QUERY),
          appkit.lakebase.query(TOOL_CALLS_QUERY),
        ]);

        const questionsPerDay =
          questions.status === 'fulfilled'
            ? questions.value.rows.map((row) => ({ day: text(row.day), count: count(row.count) }))
            : [];
        const distinctAskersPerDay =
          askers.status === 'fulfilled'
            ? askers.value.rows.map((row) => ({ day: text(row.day), count: count(row.count) }))
            : [];
        const activeMinutesPerDay =
          activeMinutes.status === 'fulfilled'
            ? activeMinutes.value.rows
                .filter((row) => Boolean(text(row.day)))
                .map((row) => ({ day: text(row.day), count: count(row.count) }))
            : [];
        const activityBounds = activeMinutes.status === 'fulfilled' ? activeMinutes.value.rows[0] : undefined;

        const failures = new Map<string, number>();
        const refusals = new Map<string, number>();
        let runsInRange = 0;
        if (outcomes.status === 'fulfilled') {
          for (const row of outcomes.value.rows) {
            const state = text(row.state);
            const code = text(row.terminal_code);
            const runs = count(row.count);
            runsInRange += runs;
            if (state === 'REFUSED') {
              refusals.set(code, (refusals.get(code) ?? 0) + runs);
            } else if (FAILURE_STATES.has(state)) {
              failures.set(code, (failures.get(code) ?? 0) + runs);
            }
          }
        }

        const toolCalls =
          tools.status === 'fulfilled'
            ? tools.value.rows.map((row) => ({
                key: text(row.tool),
                label: text(row.tool),
                count: count(row.count),
              }))
            : [];

        // Only when every read failed does the block itself report a reason,
        // because `reason` REPLACES the block: one read failing must leave the
        // reads that answered on the page rather than substituting empty charts
        // under one sentence blaming whichever query rejected first.
        //
        // But it must not leave them SILENTLY. An empty chart is a population
        // of nobody, and a read that was cut off did not measure a population
        // at all. So the partial case names its missing charts beside the ones
        // that answered, and only that case fills `unread`.
        const outstanding = [
          { done: questions, charts: 'Questions per day' },
          { done: askers, charts: 'Distinct askers per day' },
          { done: activeMinutes, charts: 'Recorded active app minutes per day' },
          { done: outcomes, charts: 'Failures and refusals' },
          { done: tools, charts: 'Tool calls' },
        ].filter((read) => read.done.status === 'rejected');
        const rejected = outstanding.map((read) => read.done as PromiseRejectedResult);
        const readCount = 5;
        const payload: OpsTrafficPayload = {
          readAt,
          reason:
            rejected.length === readCount
              ? `Nothing about traffic could be read: ${text((rejected[0].reason as Error)?.message) || 'the store did not answer'}`
              : '',
          unread:
            rejected.length > 0 && rejected.length < readCount
              ? unreadNote(
                  outstanding.map((read) => read.charts),
                  text((rejected[0].reason as Error)?.message)
                )
              : '',
          questionsPerDay,
          distinctAskersPerDay,
          activeMinutesPerDay,
          activeMinutesTimeZone,
          activeMinutesRecordedFrom: text(activityBounds?.recorded_from),
          activeMinutesRecordedThrough: text(activityBounds?.recorded_through),
          failuresByCause: toBars(failures),
          refusalsByCause: toBars(refusals),
          toolCalls,
          runsInRange,
        };
        res.json(payload);
      } catch (error) {
        const payload: OpsTrafficPayload = {
          readAt,
          reason: `Nothing about traffic could be read: ${(error as Error).message}`,
          unread: '',
          questionsPerDay: [],
          distinctAskersPerDay: [],
          activeMinutesPerDay: [],
          activeMinutesTimeZone: 'UTC',
          activeMinutesRecordedFrom: '',
          activeMinutesRecordedThrough: '',
          failuresByCause: [],
          refusalsByCause: [],
          toolCalls: [],
          runsInRange: 0,
        };
        res.json(payload);
      }
    });

    /* ── Latency ─────────────────────────────────────────────────────────── */

    /** Per-route request timings from Lakebase, independent of billed app telemetry. */
    app.get('/api/ops/latency', async (_req: Request, res: Response) => {
      const readAt = new Date(clock()).toISOString();
      const base: OpsLatencyPayload = {
        readAt,
        state: 'no-rows',
        reason: '',
        grant: null,
        table: REQUEST_LATENCY_TABLE,
        routes: [],
        coveredFrom: '',
        coveredTo: '',
      };
      try {
        const result = await appkit.lakebase.query(REQUEST_LATENCY_QUERY);
        const measured = readRequestLatencyRows(result.rows);
        if (measured.routes.length === 0) {
          res.json({
            ...base,
            reason:
              'No API request timings have been recorded. Recording starts with this release and does not backfill.',
            coveredFrom: measured.coveredFrom,
            coveredTo: measured.coveredTo,
          });
          return;
        }
        res.json({
          ...base,
          state: 'ready',
          routes: measured.routes,
          coveredFrom: measured.coveredFrom,
          coveredTo: measured.coveredTo,
        } satisfies OpsLatencyPayload);
      } catch (error) {
        const payload: OpsLatencyPayload = {
          ...base,
          state: 'unreadable',
          reason: `No stored API request timings could be read: ${(error as Error).message}`,
        };
        res.json(payload);
      }
    });
  });

  // Said out loud, to match `setupMonitoringRoutes`, and the asymmetry is why
  // this line exists. Both functions fail loudly and both used to succeed in
  // silence -- except that Monitoring announced itself. A reader comparing the
  // two in a boot log therefore saw Monitoring register and Ops apparently not,
  // and spent a while checking whether the Ops pages were even up. The silence
  // was the success path. Now they read the same way.
  console.log("[ops] Registered the Ops read routes. The admin guard's prefix list covers all of them.");
}

/*
 * `countQuestions` WAS HERE, AND IT WENT WITH THE FIGURE IT FED.
 *
 * It totalled the questions in the range so the cost block could divide spend by
 * them. Nothing else ever called it. The division is gone -- see the note on
 * `OpsCostPayload` -- so the count was a Lakebase round trip on every read of
 * the cost block whose only product was a denominator nobody used.
 *
 * The query it ran is still here: `QUESTIONS_PER_DAY_QUERY` draws the questions
 * chart on the traffic block, which is a count per day of something counted per
 * day, and is the honest use of it.
 */
