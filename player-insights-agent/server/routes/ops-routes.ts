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
import type { Application, Request, Response } from 'express';
import {
  buildCostStatement,
  buildTiles,
  readComponentRows,
  RANGE_ROW,
  type CostIdentifiers,
  type CostRange,
  type StatementParameter,
} from '../lib/ops-billing';
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
import { classifyDenial, forwardedUserToken, UNKNOWN_PRINCIPAL } from './access-verification';
import {
  ANSWER_PATH_ENDPOINT_IDS,
  declaredTables,
  probeConnections,
  SERVING_ENDPOINT_KIND,
} from '../lib/dependency-probes';
import { appEnvironment, readStoredSettings, resourceStates } from '../lib/app-settings';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { isFailureCode } from '../lib/run-failure-codes';
import { userEmail, type InsightsAppKit } from './insights-routes';
import { opsDayRange, SPAN_PERCENTILE_FLOOR } from '../../shared/ops-contract';
import type {
  AppMeasurement,
  DependencyResult,
  HealthDependency,
  OpsCostPayload,
  OpsHealthPayload,
  OpsLatencyPayload,
  OpsTrafficPayload,
  PlatformReading,
  TrafficBar,
} from '../../shared/ops-contract';

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

/**
 * The range, as whole days, ending on the last COMPLETE day.
 *
 * THE ARITHMETIC IS `opsDayRange`, IN THE SHARED CONTRACT, and it is shared for a
 * reason worth keeping in front of whoever edits this next. The page prints the
 * dates it is showing figures for; if it derived them with its own copy of this
 * rule, the printed window and the queried window could drift apart, and a
 * printed date that is not the queried date is worse than no date at all because
 * a reader would then be checking the figure against a lie.
 *
 * The parameters are `from` and `to`, and ONLY those. The range control's word --
 * `range=24h`, `range=30d` -- is a client-side control state and never reaches
 * here: the page resolves it to two timestamps first, the way Monitoring always
 * has. This function used to be all there was, which meant a page sending only
 * the word got the fallback window and three of the four options silently
 * returned the last seven days.
 */
export function opsRange(req: Request, now = Date.now()): CostRange {
  return opsDayRange(queryText(req, 'from'), queryText(req, 'to'), now);
}

/** The half-open timestamp bounds a Lakebase or telemetry read uses for that range. */
function instantsFor(range: CostRange): { from: string; to: string } {
  return { from: `${range.from}T00:00:00Z`, to: `${range.to}T23:59:59Z` };
}

/**
 * The exact activity window the browser asked for, including today.
 *
 * Cost intentionally ends on the last complete day because billing arrives
 * late. Traffic and latency are app-owned operational records and must not
 * inherit that lag: doing so made a new customer deployment say no questions
 * had been asked while people were actively using it.
 */
function activityInstants(req: Request, now: number): { from: string; to: string } {
  const from = Date.parse(queryText(req, 'from'));
  const to = Date.parse(queryText(req, 'to'));
  if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }
  return {
    from: new Date(now - 7 * 86_400_000).toISOString(),
    to: new Date(now).toISOString(),
  };
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
      message:
        text(body.status?.error?.message) || `The statement ended in ${state || 'an unknown state'}.`,
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
async function readAppMeasurement(req: Request, range: CostRange, insightsHref: string): Promise<AppMeasurement> {
  const schema = telemetrySchema();
  if (!schema) return offMeasurement(insightsHref);

  const table = logsTable(schema);
  const base = offMeasurement(insightsHref);
  const workspace = host();
  const warehouse = warehouseId();
  const token = forwardedUserToken(req);
  const principal = userEmail(req) || UNKNOWN_PRINCIPAL;

  if (!workspace || !warehouse || !token) {
    return uncheckedMeasurement(
      insightsHref,
      'this app has no warehouse, workspace address or forwarded sign-in to read it with.'
    );
  }

  const instants = instantsFor(range);
  const outcome = await runStatement({
    host: workspace,
    token,
    warehouseId: warehouse,
    statement: buildTelemetryStatement(table),
    parameters: [
      { name: 'from_at', value: instants.from, type: 'STRING' },
      { name: 'to_at', value: instants.to, type: 'STRING' },
    ],
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
    // The range is passed in so the sentence can name the days it found nothing
    // in. Without them, "no rows in this range" is a claim a reader cannot
    // check against the window the page is showing.
    return {
      ...base,
      ...figures,
      telemetry: 'no-rows-yet',
      table,
      reason: noHistoryReason({ recordingSince: figures.recordingSince, from: range.from, to: range.to }),
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
  req: Request
): Promise<{ rows: HealthDependency[]; reason: string; checkedAt: string }> {
  try {
    const stored = await readStoredSettings(appkit).catch(() => new Map());
    const states = resourceStates({ report: null, environment: appEnvironment(), stored });
    const configured = Object.fromEntries(states.map((state) => [state.resource.id, state.configured]));
    const checks = await probeConnections({
      configured,
      tables: declaredTables([]),
      host: host(),
      token: forwardedUserToken(req),
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

/** Every question asked in the range, by the day it was asked. */
export const QUESTIONS_PER_DAY_QUERY = `
  SELECT to_char(date_trunc('day', m.created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
  FROM ${APP_SCHEMA}.messages m
  WHERE m.role = 'user' AND m.created_at >= $1 AND m.created_at < $2
  GROUP BY 1
  ORDER BY 1`;

/**
 * How runs ended, by state and code.
 *
 * REFUSALS AND FAILURES ARE DISJOINT BY CONSTRUCTION, not by discipline here. A
 * run's terminal state is decided from the LAYER of its terminal code by
 * `TERMINAL_STATE_BY_LAYER`, so a governance outcome cannot also be an
 * operational one and no run can appear on both charts. That is why nothing
 * below offers a total across the two: adding them would count runs that have
 * nothing in common because they happen to both be "not a success".
 */
export const RUN_OUTCOMES_QUERY = `
  SELECT r.state, COALESCE(r.terminal_code, '') AS terminal_code, COUNT(*)::int AS count
  FROM ${APP_SCHEMA}.runs r
  WHERE r.created_at >= $1 AND r.created_at < $2
  GROUP BY 1, 2`;

/** Tool-tagged stages, counted by the tool each one named. */
export const TOOL_CALLS_QUERY = `
  SELECT stage->>'name' AS tool, COUNT(*)::int AS count
  FROM ${APP_SCHEMA}.messages m,
       LATERAL jsonb_array_elements(m.response_json->'trace'->'stages') AS stage
  WHERE m.role = 'assistant'
    AND jsonb_typeof(m.response_json->'trace'->'stages') = 'array'
    AND m.created_at >= $1 AND m.created_at < $2
    AND stage->>'kind' = 'tool'
    AND COALESCE(stage->>'name', '') <> ''
  GROUP BY 1
  ORDER BY 2 DESC`;

/**
 * Answer latency from the app's own durable messages.
 *
 * This is deliberately not an OpenTelemetry query. Every successful answer
 * stores its measured `trace.totalMs` in Lakebase, so customer deployments that
 * leave billed telemetry off still have the operational timing they own.
 */
export const ANSWER_LATENCY_QUERY = `
  WITH bounds AS (
    SELECT $1::timestamptz AS from_at,
           $2::timestamptz AS to_at,
           $1::timestamptz + (($2::timestamptz - $1::timestamptz) / 2) AS split_at
  ),
  samples AS (
    SELECT m.created_at,
           (m.response_json->'trace'->>'totalMs')::double precision AS duration_ms,
           jsonb_path_exists(m.response_json->'trace', '$.stages[*] ? (@.status == "failed")') AS failed
    FROM ${APP_SCHEMA}.messages m, bounds b
    WHERE m.role = 'assistant'
      AND jsonb_typeof(m.response_json->'trace') = 'object'
      AND jsonb_typeof(m.response_json->'trace'->'totalMs') = 'number'
      AND m.created_at >= b.from_at AND m.created_at < b.to_at
  )
  SELECT
    COUNT(*) FILTER (WHERE s.created_at >= b.split_at)::int AS current_count,
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY s.duration_ms)
      FILTER (WHERE s.created_at >= b.split_at))::int AS current_p50_ms,
    ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms)
      FILTER (WHERE s.created_at >= b.split_at))::int AS current_p95_ms,
    ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY s.duration_ms)
      FILTER (WHERE s.created_at >= b.split_at))::int AS current_p99_ms,
    ROUND(MAX(s.duration_ms) FILTER (WHERE s.created_at >= b.split_at))::int AS slowest_ms,
    COUNT(*) FILTER (WHERE s.created_at >= b.split_at AND s.failed)::int AS error_count,
    MAX(s.created_at) FILTER (WHERE s.created_at >= b.split_at) AS last_answer_at,
    COUNT(*) FILTER (WHERE s.created_at < b.split_at)::int AS prior_count,
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY s.duration_ms)
      FILTER (WHERE s.created_at < b.split_at))::int AS prior_p50_ms,
    MIN(s.created_at) AS covered_from,
    MAX(s.created_at) AS covered_to
  FROM bounds b
  LEFT JOIN samples s ON TRUE
  GROUP BY b.split_at`;

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
  const named =
    charts.length === 1 ? charts[0] : `${charts.slice(0, -1).join(', ')} and ${charts[charts.length - 1]}`;
  const which = charts.length === 1 ? 'that chart is' : 'those charts are';
  return `${named} could not be read, so ${which} missing rather than empty: ${message || 'the store did not answer'}`;
}

/** Sort bars by count, then by key, so a redraw does not reshuffle equal bars. */
function toBars(counts: Map<string, number>): TrafficBar[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: causeLabel(key), count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
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
export const OPS_ROUTES = [
  '/api/ops/health',
  '/api/ops/cost',
  '/api/ops/traffic',
  '/api/ops/latency',
] as const;

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
}

/**
 * Register the reads in OPS_ROUTES, ONLY IF the admin guard covers every one.
 *
 * MUST be called after `setupInsightsRoutes`. Express applies middleware to what
 * is added afterwards and the guard is registered in there, so a call before it
 * would leave all three open. That ordering is why the coverage check below is
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
      const range = opsRange(req, clock());
      const workspace = host();
      const insightsHref = workspace ? `${workspace}/apps` : '';
      try {
        // Independent of each other as well as of the other blocks: a telemetry
        // grant nobody has made must not stop the dependency rows rendering.
        const [dependencies, appMeasurement, lakebase] = await Promise.all([
          readDependencies(appkit, req),
          readAppMeasurement(req, range, insightsHref).catch((error: Error) =>
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
      const range = opsRange(req, clock());
      const readAt = new Date(clock()).toISOString();
      const workspace = host();
      const warehouse = warehouseId();
      const token = forwardedUserToken(req);
      const ids: CostIdentifiers = {
        appName: (process.env.DATABRICKS_APP_NAME ?? '').trim(),
        endpointName: (process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '').trim(),
        warehouseId: warehouse,
        // Resolved by the client from the index probe on the health block, since
        // the app is never told its vector endpoint by configuration.
        vectorEndpoint: queryText(req, 'vectorEndpoint'),
        rebuildJobId: (process.env.PLAYER_INSIGHTS_INDEX_REBUILD_JOB_ID ?? '').trim(),
        // Read off a response header rather than taken from configuration.
        // Nothing hands the container a workspace id, and a literal in a tracked
        // file would be a real workspace id in a repository that is published.
        workspaceId: token ? await resolveWorkspaceId({ host: workspace, token }) : '',
        telemetryEnabled: Boolean(telemetrySchema()),
      };
      const empty = { grant: null, reason: '', currency: '', throughDay: range.to, readAt };

      if (!workspace || !warehouse || !token) {
        res.json({
          ...empty,
          state: 'no-warehouse',
          tiles: buildTiles(ids, range, []),
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
          tiles: buildTiles(ids, range, []),
        } satisfies OpsCostPayload);
        return;
      }

      try {
        const outcome = await runStatement({
          host: workspace,
          token,
          warehouseId: warehouse,
          statement: built.statement,
          parameters: built.parameters,
        });

        if (!outcome.ok) {
          const denial = classifyDenial(outcome.message, 'system.billing.usage');
          if (denial.kind === 'no-grant') {
            res.json({
              ...empty,
              state: 'no-grant',
              grant: grantFor(denial.object, userEmail(req) || UNKNOWN_PRINCIPAL, denial.permission),
              tiles: [],
              reason:
                `You do not have ${denial.permission} on ${denial.object}, so no spend was read. Billing ` +
                'runs under your own grants rather than this app\u2019s, so being an administrator here ' +
                'does not grant it.',
            } satisfies OpsCostPayload);
            return;
          }
          res.json({
            ...empty,
            state: 'unreadable',
            tiles: [],
            reason: `Billing could not be read, so nothing about spend was established. Databricks said: ${outcome.message}`,
          } satisfies OpsCostPayload);
          return;
        }

        const rows = readComponentRows(outcome.rows);
        const meta = rows.find((row) => row.component === RANGE_ROW);
        const componentRows = rows.filter((row) => row.component !== RANGE_ROW);

        // No rows at all is its OWN state and not a missing grant. The statement
        // succeeded, so the reader has the privilege; billing simply has nothing
        // for this range yet. Telling them to ask for a grant they already hold
        // is the confusion this distinction exists to prevent.
        if (componentRows.length === 0 && (!meta || meta.billedDays === 0)) {
          res.json({
            ...empty,
            state: 'no-rows',
            tiles: buildTiles(ids, range, []),
            currency: meta?.currency ?? '',
            throughDay: meta?.lastDay || range.to,
          } satisfies OpsCostPayload);
          return;
        }

        res.json({
          ...empty,
          state: 'ready',
          currency: meta?.currency ?? '',
          throughDay: meta?.lastDay || range.to,
          tiles: buildTiles(ids, range, componentRows),
        } satisfies OpsCostPayload);
      } catch (error) {
        res.json({
          ...empty,
          state: 'unreadable',
          tiles: [],
          reason: `Billing could not be read, so nothing about spend was established: ${(error as Error).message}`,
        } satisfies OpsCostPayload);
      }
    });

    /* ── Traffic ─────────────────────────────────────────────────────────── */

    app.get('/api/ops/traffic', async (req: Request, res: Response) => {
      const instants = activityInstants(req, clock());
      const readAt = new Date(clock()).toISOString();
      const bounds = [instants.from, instants.to];
      try {
        // Settled rather than awaited together: the run ledger is newer than the
        // messages table and a deployment that has not created it yet should
        // still get its questions chart rather than an empty block.
        const [questions, outcomes, tools] = await Promise.allSettled([
          appkit.lakebase.query(QUESTIONS_PER_DAY_QUERY, bounds),
          appkit.lakebase.query(RUN_OUTCOMES_QUERY, bounds),
          appkit.lakebase.query(TOOL_CALLS_QUERY, bounds),
        ]);

        const questionsPerDay =
          questions.status === 'fulfilled'
            ? questions.value.rows.map((row) => ({ day: text(row.day), count: count(row.count) }))
            : [];

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

        // Only when all three failed does the block itself report a reason,
        // because `reason` REPLACES the block: one read failing must leave the
        // two that answered on the page rather than substituting three empty
        // charts under one sentence blaming whichever query rejected first.
        //
        // But it must not leave them SILENTLY. An empty chart is a population
        // of nobody, and a read that was cut off did not measure a population
        // at all. So the partial case names its missing charts beside the ones
        // that answered, and only that case fills `unread`.
        const outstanding = [
          { done: questions, charts: 'Questions per day' },
          { done: outcomes, charts: 'Failures and refusals' },
          { done: tools, charts: 'Tool calls' },
        ].filter((read) => read.done.status === 'rejected');
        const rejected = outstanding.map((read) => read.done as PromiseRejectedResult);
        const payload: OpsTrafficPayload = {
          readAt,
          reason:
            rejected.length === 3
              ? `Nothing about traffic could be read: ${text((rejected[0].reason as Error)?.message) || 'the store did not answer'}`
              : '',
          unread:
            rejected.length > 0 && rejected.length < 3
              ? unreadNote(
                  outstanding.map((read) => read.charts),
                  text((rejected[0].reason as Error)?.message)
                )
              : '',
          questionsPerDay,
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
          failuresByCause: [],
          refusalsByCause: [],
          toolCalls: [],
          runsInRange: 0,
        };
        res.json(payload);
      }
    });

    /* ── Latency ─────────────────────────────────────────────────────────── */

    /** Answer timings from Lakebase, independent of billed app telemetry. */
    app.get('/api/ops/latency', async (req: Request, res: Response) => {
      const readAt = new Date(clock()).toISOString();
      const instants = activityInstants(req, clock());
      const base: OpsLatencyPayload = {
        readAt,
        state: 'no-rows',
        reason: '',
        grant: null,
        table: `${APP_SCHEMA}.messages`,
        routes: [],
        coveredFrom: '',
        coveredTo: '',
      };
      try {
        const result = await appkit.lakebase.query(ANSWER_LATENCY_QUERY, [instants.from, instants.to]);
        const row = result.rows[0] ?? {};
        const current = count(row.current_count);
        if (current === 0) {
          res.json({
            ...base,
            reason: 'No stored answer timings were recorded in this range.',
            coveredFrom: text(row.covered_from),
            coveredTo: text(row.covered_to),
          });
          return;
        }
        res.json({
          ...base,
          state: 'ready',
          routes: [
            {
              route: 'POST /api/insights/ask',
              spans: current,
              p50Ms: count(row.current_p50_ms),
              p95Ms: current >= SPAN_PERCENTILE_FLOOR ? count(row.current_p95_ms) : null,
              p99Ms: current >= SPAN_PERCENTILE_FLOOR ? count(row.current_p99_ms) : null,
              slowestMs: count(row.slowest_ms),
              errorCount: count(row.error_count),
              refusalCount: null,
              lastSpanAt: text(row.last_answer_at),
              priorSpans: count(row.prior_count),
              priorP50Ms: row.prior_p50_ms === null ? null : count(row.prior_p50_ms),
            },
          ],
          coveredFrom: text(row.covered_from),
          coveredTo: text(row.covered_to),
        } satisfies OpsLatencyPayload);
      } catch (error) {
        const payload: OpsLatencyPayload = {
          ...base,
          state: 'unreadable',
          reason: `No stored answer timings could be read: ${(error as Error).message}`,
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
