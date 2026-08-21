/**
 * What the platform records about this app, and the four states of being able to read it.
 *
 * THREE TABLES, AND ALL THREE FILL. Setting a telemetry destination on a
 * Databricks App creates `otel_logs`, `otel_spans` and `otel_metrics`. The
 * figures below are read from `otel_logs`, which is the one the platform writes
 * directly; the other two are written by an OpenTelemetry SDK, and one runs.
 * `appkit` bundles the OpenTelemetry Node SDK with auto-instrumentation, so an
 * exporter is started by the framework whether or not anything in this source
 * initialises one.
 *
 * THIS FILE USED TO SAY THE OPPOSITE, in a paragraph asserting that
 * `otel_spans` and `otel_metrics` were "permanently empty on every deployment".
 * That was never measured; it was reasoned from the absence of an SDK in our own
 * source. Both tables have been filling since 2026-08-16. The claim is deleted
 * rather than inverted, because what belongs here is the read below, not a
 * second assertion waiting to go stale.
 *
 * A LATENCY PANEL IS A DECISION NOBODY HAS TAKEN, not a thing the data cannot
 * support. Per-route timing is computable from `otel_spans` today. Whether the
 * Ops page should carry it is a product question, and until it is answered there
 * is no query for it here.
 *
 * THE DESTINATION IS READ, NOT DERIVED. The tables land in a schema of their
 * own rather than beside the app's other tables, and that separation is
 * deliberate rather than incidental: the agent's table manifest grants the
 * served model read access to everything in the app's schema, so sign-in
 * records living there would let any user ask the agent who signed in. This
 * module therefore takes the schema from configuration and never assembles it
 * from the app's own catalog and schema.
 *
 * FOUR STATES, AND NONE OF THEM IS AN ERROR. Telemetry is off by default, it is
 * billed, and a deployment may reasonably leave it off. When it is on, each
 * admin still needs their own SELECT before they can read a row, so "the table
 * is there and you cannot read it" is an ordinary condition with a grant that
 * fixes it, handled with the same object, privilege and copyable statement the
 * cost block uses for billing. And because telemetry does not backfill, a
 * deployment that switches it on reads as empty until the next deploy starts
 * writing. That is a real, temporary condition with a date attached, not a hole
 * and not a failure.
 */

import { tableGrant, classifyDenial, type Remedy } from '../routes/access-verification';
import {
  SPAN_PERCENTILE_FLOOR,
  type AppMeasurement,
  type GrantRemedy,
  type RouteLatency,
  type TelemetryState,
} from '../../shared/ops-contract';
import { NO_EXPORTER_READING, type ExporterReading, type ExporterTable } from '../../shared/app-facts';

/**
 * The variable naming the catalog and schema telemetry writes into.
 *
 * In the `PLAYER_INSIGHTS_` family because `PLAYER_INSIGHTS_ADMIN_EMAILS` and
 * `PLAYER_INSIGHTS_EXPERIMENT_ID` established it, and a second prefix is a
 * second thing to search for when a value does not arrive.
 *
 * UNSET IS VALID AND MEANS OFF. There is no default, because a default would
 * point this at a schema somebody else owns.
 */
export const TELEMETRY_SCHEMA_ENV = 'PLAYER_INSIGHTS_TELEMETRY_SCHEMA';

/** The one table that fills without instrumentation. */
export const LOGS_TABLE = 'otel_logs';

/**
 * The two tables an OpenTelemetry exporter writes, which is what the Build
 * card's exporter row is a claim about.
 *
 * Counted rather than asserted. See {@link buildExporterStatement}.
 */
export const EXPORTER_TABLES = ['otel_spans', 'otel_metrics'] as const;

/**
 * The configured destination, or empty.
 *
 * Accepts `catalog.schema` and nothing else. A single part is not a schema and
 * a third part would be a table, and quietly repairing either would point the
 * queries below at something the deployer did not name.
 */
export function telemetrySchema(raw: string | undefined = process.env[TELEMETRY_SCHEMA_ENV]): string {
  const candidate = (raw ?? '').trim().replace(/^`|`$/g, '');
  if (!candidate) return '';
  const parts = candidate.split('.').filter((part) => part.length > 0);
  if (parts.length !== 2) {
    console.warn(
      `[ops] ${TELEMETRY_SCHEMA_ENV} is ${JSON.stringify(candidate)}, which is not a catalog and schema. ` +
        'App telemetry is being reported as not configured rather than guessed at.'
    );
    return '';
  }
  return parts.join('.');
}

/** The fully qualified `otel_logs` table for a destination, or empty. */
export function logsTable(schema: string): string {
  return schema ? `${schema}.${LOGS_TABLE}` : '';
}

/** The app's existing grant shape, narrowed to what the contract carries. */
export function grantFor(table: string, principal: string, permission = 'SELECT'): GrantRemedy {
  const remedy: Remedy = tableGrant(table, principal);
  return { object: table, privilege: permission, statement: remedy.statement };
}

/**
 * What the app reports before anything has been read.
 *
 * Every field explicitly empty rather than absent, so a caller that returns
 * this straight to the browser produces the same shape as one that read rows.
 */
export function offMeasurement(insightsHref: string): AppMeasurement {
  return {
    telemetry: 'not-enabled',
    variable: TELEMETRY_SCHEMA_ENV,
    table: '',
    grant: null,
    insightsHref,
    requestsPerHour: [],
    lastServedAt: '',
    recordingSince: '',
    signInsPerDay: [],
    errors: { count: 0, recent: [] },
    reason:
      'App telemetry is not switched on for this deployment, so nothing is recording what the app ' +
      `served. It is configuration rather than code: set ${TELEMETRY_SCHEMA_ENV} to a catalog and ` +
      'schema and redeploy, and the platform begins writing from that deploy onward.',
  };
}

/**
 * What to report when the block fell over before it could look.
 *
 * THE REASON THIS EXISTS is that `offMeasurement` was being used as a
 * convenient empty payload by callers that had not established anything, and
 * its `telemetry: 'not-enabled'` is not an empty value: it is the claim that
 * this deployment has not switched telemetry on, which the page renders as "App
 * telemetry is off". A deployment with a destination configured, whose read
 * threw, was therefore told its configuration did not exist -- and the remedy on
 * screen was to set a variable that was already set.
 *
 * So OFF IS NOW A READING OF THE VARIABLE AND NOTHING ELSE. If a destination is
 * configured, this reports the table and says what actually happened; only a
 * genuinely unset variable, which is the customer-target case, reports off.
 * Never use `offMeasurement` as a base for a state you have not established.
 *
 * AND THE STATE IS 'unreadable', for the same reason spelled one level up. This
 * used to report 'no-rows-yet', which is the same category of mistake in a
 * smaller font: every caller here is a path that gave up before it looked, and
 * "the table is empty" is a finding none of them made.
 */
export function uncheckedMeasurement(insightsHref: string, note: string): AppMeasurement {
  const schema = telemetrySchema();
  if (!schema) return offMeasurement(insightsHref);
  const table = logsTable(schema);
  return {
    ...offMeasurement(insightsHref),
    telemetry: 'unreadable',
    table,
    reason: `App telemetry is switched on and writing to ${table}, and ${note} So nothing about what this app served was established here, which is unchecked rather than empty.`,
  };
}

/**
 * The words for a destination that is set, readable, and empty for this window.
 *
 * TWO DIFFERENT FACTS USED TO SHARE ONE SENTENCE, and the one it told was the
 * rarer of them. "It has no rows yet" is true of a table nothing has ever
 * written to. It is false, and misleading, of the case that actually occurs:
 * telemetry switched on today, the table filling as the page is read, and every
 * row of it outside the window the page is showing -- because the Ops range ends
 * on the last COMPLETE day, so a deployment cannot see its own first day until
 * tomorrow. A reader told "no rows yet" about that goes to check the bundle,
 * which is the one place the fault is not.
 *
 * So the recorded start is read (see `first-recorded` in
 * {@link buildTelemetryStatement}) and the two cases are named apart. Neither
 * invents activity: the first says nothing has been written, the second says
 * something has and points at when, without claiming to know what it was.
 */
export function noHistoryReason(): string {
  return 'No app requests have been recorded yet.';
}

/**
 * Which of the four states a failed read means.
 *
 * A refusal that names a privilege is a grant somebody makes; anything else is
 * left as an unreadable table with the platform's own words, because guessing
 * between "no grant" and "no table" would send an admin to ask for a privilege
 * they may already hold on a table that does not exist.
 */
export function stateFromFailure(message: string, table: string): {
  state: Extract<TelemetryState, 'no-grant' | 'unreadable'>;
  permission: string;
  object: string;
} {
  const denial = classifyDenial(message, table);
  if (denial.kind === 'no-grant') {
    return { state: 'no-grant', permission: denial.permission, object: denial.object };
  }
  return { state: 'unreadable', permission: '', object: table };
}

/* ── The reads, which are all one table ──────────────────────────────────── */

/**
 * One attribute out of `otel_logs.attributes`, as a string.
 *
 * `attributes` IS A `VARIANT`, NOT A `MAP`, and that distinction cost this page
 * every figure it draws. Map subscripting (`attributes['event.name']`) does not
 * merely return null against a variant: Databricks refuses to plan the query at
 * all, with `INVALID_EXTRACT_BASE_FIELD_TYPE ... Need a complex type [STRUCT,
 * ARRAY, MAP] but got "VARIANT"`. Because everything below is one statement
 * joined by `UNION ALL`, that single unplannable branch failed the whole read,
 * so a deployment with rows in the table reported no history at all.
 *
 * The key is bracketed inside the path rather than written as `$.event.name`,
 * because these keys contain dots of their own: a dotted path would look for a
 * nested object named `event` holding a `name`, and find nothing.
 *
 * Every attribute read on this page goes through here, so there is one place to
 * be wrong about the extraction syntax rather than one per branch.
 */
function attribute(key: string): string {
  return `variant_get(attributes, '$["${key}"]', 'string')`;
}

/**
 * The platform's own name for an authentication event, and the one reason among
 * them that is a person signing in.
 *
 * WRITTEN BY DATABRICKS, NOT BY THIS SERVER. Nothing in this app emits these;
 * they arrive because the app has a telemetry destination. So the names are the
 * platform's to change, and they are pinned here as constants rather than
 * pattern-matched, because the previous match (`LIKE '%sign%in%'`) was written
 * against a guess at what a sign-in event would be called and would never have
 * matched `app.auth` even once the extraction above was fixed.
 *
 * `app.auth.reason` is one of `user_login`, `refresh_session` or `api_access`.
 * ONLY THE FIRST IS A SIGN-IN. A refreshed session is the same sign-in still
 * being honoured, and an authenticated API call is one request out of however
 * many a page makes, so counting either would report a number many times the
 * count of people who signed in and label it sign-ins.
 */
export const AUTH_EVENT = 'app.auth';
export const SIGN_IN_REASON = 'user_login';

/**
 * The one `app.log_source` that is this app running, out of the several the
 * platform writes into the same table.
 *
 * `otel_logs` IS NOT A REQUEST LOG, and on this deployment it is mostly not even
 * the app. The platform tags every line with `app.log_source`, and the values
 * seen are `BUILD`, `APP` and `SYSTEM`: `BUILD` is the output of `npm run build`
 * during a deploy, and it dwarfs everything else -- 1203 of 1319 lines on the
 * first day telemetry was on, 608 of them inside a single hour. Counting the
 * table unfiltered therefore reported a deployment as 661 requests in an hour
 * during which the app served nobody, and dated "most recent request" to a line
 * of somebody's build output.
 *
 * So the figures about what the app DID are taken from `APP` alone. That is
 * still a count of log lines rather than of requests, and it is not labelled as
 * anything else; what it is not is a deploy's build transcript wearing the word
 * "requests".
 *
 * SIGN-INS ARE DELIBERATELY NOT FILTERED BY THIS. The `app.auth` rows carry no
 * `app.log_source` at all, so this predicate would discard every one of them
 * and report a deployment somebody had signed into as having no sign-ins. They
 * are selected by their event name instead, from the unfiltered rows.
 */
export const APP_LOG_SOURCE = 'APP';

/**
 * Requests per hour, when the app last answered, sign-ins per day, errors, and
 * the first line the table ever recorded.
 *
 * One statement rather than five, because a warehouse charges for every second
 * it is awake and five round trips would cost a reader five wake-ups to fill
 * one block. The results are stacked with a `kind` column and separated on the
 * way back, which is why every value column is a string: the shapes differ and
 * a union has to agree on types.
 *
 * THE COST OF STACKING THEM is that any one branch that will not plan takes the
 * others with it. See `attribute` above for the time that happened.
 *
 * Sign-ins are read out of `attributes` rather than matched in the body text,
 * because a body match would count any line that happened to mention signing
 * in.
 *
 * `first-recorded` IS THE ONE BRANCH THAT IGNORES THE RANGE, and it is here so
 * that an empty window can say which of two things it is. The Ops range ends on
 * the last COMPLETE day, so telemetry switched on this morning has every one of
 * its rows outside the default window: the page then said "no telemetry history
 * yet" about a table that was filling as it was read. Knowing when the table
 * actually starts is what lets the empty state name the difference between
 * "nothing has ever been recorded" and "recording began after the days shown".
 */
export function buildTelemetryStatement(table: string): string {
  return `WITH scoped AS (
  SELECT time, severity_text, body, attributes
  FROM ${table}
), served AS (
  SELECT time, severity_text, body
  FROM scoped
  WHERE ${attribute('app.log_source')} = '${APP_LOG_SOURCE}'
)
SELECT 'request-hour' AS kind,
       date_format(date_trunc('HOUR', time), 'yyyy-MM-dd HH:00') AS bucket,
       CAST(COUNT(*) AS STRING) AS value,
       '' AS detail
FROM served
GROUP BY 1, 2
UNION ALL
SELECT 'last-served', '', CAST(MAX(time) AS STRING), '' FROM served
UNION ALL
SELECT 'sign-in-day',
       date_format(date_trunc('DAY', time), 'yyyy-MM-dd'),
       CAST(COUNT(*) AS STRING),
       ''
FROM scoped
WHERE ${attribute('event.name')} = '${AUTH_EVENT}'
  AND ${attribute(`${AUTH_EVENT}.reason`)} = '${SIGN_IN_REASON}'
GROUP BY 1, 2
UNION ALL
SELECT 'error-count', '', CAST(COUNT(*) AS STRING), ''
FROM served
WHERE upper(severity_text) = 'ERROR'
UNION ALL
SELECT 'error-line', CAST(time AS STRING), '', substring(body, 1, 400)
FROM served
WHERE upper(severity_text) = 'ERROR'
UNION ALL
SELECT 'first-recorded', '', CAST(MIN(time) AS STRING), '' FROM ${table}
ORDER BY 1, 2`;
}

/** How many recent error lines the block shows. The spec's "most recent few". */
export const RECENT_ERROR_LIMIT = 5;

/**
 * Separate the stacked rows back into the figures.
 *
 * A count of zero errors is a real answer and stays zero. An absent
 * `last-served` stays empty rather than becoming the start of the range, which
 * would claim the app answered at a time nothing recorded.
 */
export function readTelemetryRows(dataArray: unknown): Omit<
  AppMeasurement,
  'telemetry' | 'variable' | 'table' | 'grant' | 'insightsHref' | 'reason'
> {
  const requestsPerHour: Array<{ hour: string; count: number }> = [];
  const signInsPerDay: Array<{ day: string; count: number }> = [];
  const recent: Array<{ at: string; body: string }> = [];
  let lastServedAt = '';
  let recordingSince = '';
  let count = 0;

  if (Array.isArray(dataArray)) {
    for (const raw of dataArray) {
      if (!Array.isArray(raw) || raw.length < 4) continue;
      const [kind, bucket, value, detail] = raw as (string | null)[];
      if (kind === 'request-hour' && bucket) {
        requestsPerHour.push({ hour: bucket, count: Number(value ?? 0) });
      } else if (kind === 'sign-in-day' && bucket) {
        signInsPerDay.push({ day: bucket, count: Number(value ?? 0) });
      } else if (kind === 'last-served' && value) {
        lastServedAt = value;
      } else if (kind === 'first-recorded' && value) {
        recordingSince = value;
      } else if (kind === 'error-count') {
        count = Number(value ?? 0);
      } else if (kind === 'error-line' && bucket) {
        recent.push({ at: bucket, body: detail ?? '' });
      }
    }
  }

  // Newest first, then trimmed. Trimming before sorting would keep whichever
  // five the warehouse happened to return.
  recent.sort((left, right) => right.at.localeCompare(left.at));

  return {
    requestsPerHour,
    signInsPerDay,
    lastServedAt,
    recordingSince,
    errors: { count, recent: recent.slice(0, RECENT_ERROR_LIMIT) },
  };
}

/**
 * Whether anything was recorded at all, which decides empty from filled.
 *
 * An error count on its own does not make a range non-empty: a table with
 * nothing but a startup error in it has still recorded no requests, and saying
 * "reading" would put an empty requests chart under a heading claiming rows.
 *
 * NOR DOES `recordingSince`, and it must never be added below. It is read
 * without the range filter precisely so that an empty window can explain itself,
 * so a table whose every row predates the window would otherwise count as
 * history for a window it has nothing in -- which is the confusion it was added
 * to end, restated as a bug.
 */
export function hasHistory(
  figures: ReturnType<typeof readTelemetryRows>
): boolean {
  return (
    figures.requestsPerHour.length > 0 ||
    figures.signInsPerDay.length > 0 ||
    Boolean(figures.lastServedAt)
  );
}

/* ── The exporter, counted rather than assumed ───────────────────────────── */

/**
 * How many rows the exporter has written, and over what span.
 *
 * ONE STATEMENT FOR BOTH TABLES, for the reason the read above is one
 * statement: a warehouse charges for being awake, and this exists to settle a
 * single yes-or-no question.
 *
 * NO RANGE FILTER, DELIBERATELY. Every other read on this page is bounded by
 * the window the Ops range names. This one is not, because the question it
 * answers is "is anything exporting at all", and a window that happened to
 * exclude the rows would answer it wrongly in exactly the direction this whole
 * change exists to stop. `MIN` and `MAX` come back with the counts so the
 * caller can state the span the rows actually cover instead of implying the
 * table goes back as far as the app does -- telemetry does not backfill, and on
 * this deployment it reaches back hours rather than months.
 *
 * `time` IS THE COLUMN ON BOTH, not `start_time`. Verified against the live
 * tables; `start_time` does not resolve and takes the whole statement with it.
 */
export function buildExporterStatement(schema: string): string {
  const branches = EXPORTER_TABLES.map(
    (name) => `SELECT '${name}' AS name,
       CAST(COUNT(*) AS STRING) AS rows,
       CAST(MIN(time) AS STRING) AS first_at,
       CAST(MAX(time) AS STRING) AS last_at
FROM ${schema}.${name}`
  );
  return `${branches.join('\nUNION ALL\n')}\nORDER BY 1`;
}

function rowText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The stacked counts, separated back into a reading.
 *
 * A TABLE THAT COUNTED ZERO IS STILL A MEASUREMENT and is kept in `tables`, so
 * the row can say which of the two is silent rather than collapsing "spans but
 * no metrics" into one word. The state is `exporting` when anything at all was
 * written, because one row is enough to disprove the claim this replaces.
 *
 * Never called for a failed read -- see {@link exporterFailure}. A count that
 * did not happen is not a count of zero.
 */
export function readExporterRows(dataArray: unknown, schema: string): ExporterReading {
  const tables: ExporterTable[] = [];
  if (Array.isArray(dataArray)) {
    for (const raw of dataArray) {
      if (!Array.isArray(raw) || raw.length < 4) continue;
      const [name, rows, firstAt, lastAt] = raw as (string | null)[];
      const table = rowText(name);
      if (!table) continue;
      tables.push({
        table,
        rows: Number(rows ?? 0) || 0,
        firstAt: rowText(firstAt),
        lastAt: rowText(lastAt),
      });
    }
  }
  const written = tables.reduce((total, entry) => total + entry.rows, 0);
  return {
    state: tables.length === 0 ? 'unreadable' : written > 0 ? 'exporting' : 'silent',
    tables,
    error:
      tables.length === 0
        ? 'The warehouse answered the count with no rows at all, so nothing was established.'
        : '',
    schema,
  };
}

/** A read that did not complete, carrying the platform's words rather than a zero. */
export function exporterFailure(message: string, schema: string): ExporterReading {
  return {
    state: 'unreadable',
    tables: [],
    error: message.trim() || 'the count did not complete',
    schema,
  };
}

/**
 * The span the counted rows actually cover, as a sentence fragment.
 *
 * THE POINT OF THIS IS THE WORD "SINCE". Telemetry does not backfill: the
 * platform starts writing at the deploy that switches it on. A row saying
 * "5,469 spans" beside an app that has been up for months invites the reading
 * that those are all the spans there have ever been, and on this deployment
 * that window is about twenty hours. Naming the first stamp is what stops the
 * figure being read as a complete history.
 */
export function exporterCoverage(reading: ExporterReading): string {
  const stamps = reading.tables.map((entry) => entry.firstAt).filter(Boolean).sort();
  const latest = reading.tables.map((entry) => entry.lastAt).filter(Boolean).sort();
  if (stamps.length === 0) return '';
  const last = latest[latest.length - 1];
  return last ? `${stamps[0]} to ${last}` : `since ${stamps[0]}`;
}

/** The warehouse the count runs on, or '' when the container was told of none. */
export const WAREHOUSE_ENV = 'DATABRICKS_SQL_WAREHOUSE_ID';

/** How long a count stands before another is taken. */
export const EXPORTER_CACHE_MS = 5 * 60 * 1000;

/** A count of the exporter's tables. Injected, so nothing here holds a client. */
export type ExporterReader = () => Promise<ExporterReading>;

/**
 * Count the exporter's tables on the app's own credentials.
 *
 * AS THE APPLICATION, NOT AS THE READER, which is the opposite of the Ops
 * telemetry block above and deliberate. That block reads on the forwarded
 * sign-in because its figures are the reader's to be denied; this one answers
 * "is this deployment exporting", a fact about the deployment, for a card on a
 * consumer-visible route where most readers hold no grant on the telemetry
 * schema. Reading it as the app is what keeps the row from saying "unreadable"
 * to everyone who is not an admin.
 *
 * Never throws. Every failure becomes an `unreadable` reading carrying the
 * message, because the row's contract is that it shows what happened.
 */
export const workspaceExporterReader: ExporterReader = async () => {
  const schema = telemetrySchema();
  if (!schema) return { ...NO_EXPORTER_READING };
  const warehouse = (process.env[WAREHOUSE_ENV] ?? '').trim();
  if (!warehouse) {
    return exporterFailure(`No ${WAREHOUSE_ENV} is set, so there is nothing to run the count on.`, schema);
  }
  try {
    const { WorkspaceClient } = await import('@databricks/sdk-experimental');
    const client = new WorkspaceClient({});
    const body = (await client.apiClient.request({
      path: '/api/2.0/sql/statements',
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      // `payload`, which is what the SDK's request options call it. Spelled
      // `body` this shipped a POST with no statement in it, and the count came
      // back as an unreadable table -- the exporter row reporting a read failure
      // it had caused itself.
      payload: {
        warehouse_id: warehouse,
        statement: buildExporterStatement(schema),
        wait_timeout: '30s',
        on_wait_timeout: 'CANCEL',
        format: 'JSON_ARRAY',
        disposition: 'INLINE',
      },
      raw: false,
    })) as {
      status?: { state?: string; error?: { message?: string } };
      result?: { data_array?: unknown };
    };
    const state = rowText(body?.status?.state);
    if (state !== 'SUCCEEDED') {
      return exporterFailure(
        rowText(body?.status?.error?.message) || `the count ended in ${state || 'an unknown state'}`,
        schema
      );
    }
    return readExporterRows(body?.result?.data_array ?? [], schema);
  } catch (error) {
    return exporterFailure((error as Error)?.message ?? 'the count did not complete', schema);
  }
};

let cached: { at: number; reading: ExporterReading } | null = null;

/**
 * The reading, at most one count every {@link EXPORTER_CACHE_MS}.
 *
 * CACHED BECAUSE OF WHERE IT IS READ. This feeds `/api/settings`, which is
 * deliberately consumer-visible and is fetched on every open of the Connections
 * tab. An uncached count would wake a warehouse per reader to answer a question
 * whose answer changes on the scale of a deploy. The tables are append-only, so
 * a reading a few minutes old is still a true statement about whether the
 * exporter is running.
 *
 * A FAILED READ IS CACHED TOO, and that is on purpose: an outage that makes the
 * count fail would otherwise have every reader retry it.
 */
export async function readExporter(
  input: { read?: ExporterReader; now?: number; cacheMs?: number } = {}
): Promise<ExporterReading> {
  const now = input.now ?? Date.now();
  const ttl = input.cacheMs ?? EXPORTER_CACHE_MS;
  if (cached && now - cached.at < ttl) return cached.reading;
  const reading = await (input.read ?? workspaceExporterReader)();
  cached = { at: now, reading };
  return reading;
}

/** Drop the cached count. For tests, and for nothing else. */
export function forgetExporterReading(): void {
  cached = null;
}

/* ── Per-route latency, out of the spans ─────────────────────────────────── */

/** The table server spans land in. */
export const SPANS_TABLE = 'otel_spans';

/** The fully qualified `otel_spans` table for a destination, or empty. */
export function spansTable(schema: string): string {
  return schema ? `${schema}.${SPANS_TABLE}` : '';
}

/**
 * The span kind that is this app answering a request.
 *
 * `SPAN_KIND_SERVER` and nothing else. The same trace carries client spans for
 * the calls the app makes outward and internal spans for work inside it;
 * counting those as route latency would report the time this app spent waiting
 * on Databricks as the time a reader spent waiting on this app.
 */
export const SERVER_SPAN_KIND = 'SPAN_KIND_SERVER';

/**
 * Count, percentiles, slowest, errors and prior-half median per route, plus the
 * span of what is actually there.
 *
 * NO RANGE FILTER, for the same reason the exporter count has none and against
 * the convention of every other Ops read. Telemetry does not backfill, so this
 * table starts at the deploy that switched it on -- about twenty hours here --
 * while the Ops range ends on the last COMPLETE day. Filtered to that range,
 * this block would report no latency at all on a deployment measurably serving
 * traffic, which is precisely the false absence the rest of this work exists to
 * remove. The `covered` branch reports the real extent instead, so the panel can
 * name the window the figures come from rather than the one that was asked for.
 *
 * THE COVERED WINDOW IS SPLIT IN HALF BY TIME, and the later half is "current".
 * Trend against baseline compares each route's current median to its own median
 * in the earlier half. A route that only appears in one half has no prior, and
 * the client refuses a verdict rather than inventing one.
 *
 * ERRORS ARE HTTP ≥500 FROM SPAN ATTRIBUTES, not refusals. Refusals are run
 * outcomes in the app store; the payload leaves `refusalCount` null so the two
 * can never be summed here. Attributes rather than `status.code`, because Apps
 * telemetry is known to carry `attributes` (the logs path already reads it) and
 * a missing `status` STRUCT would take the whole block down.
 *
 * DURATION IS COMPUTED, NOT STORED. OpenTelemetry writes start and end as
 * nanoseconds since the epoch; the difference is the span. Divided to
 * milliseconds here so nothing downstream has to know the unit.
 *
 * `percentile_approx` rather than an exact percentile: the exact form sorts the
 * whole group, and this runs over every span in the table by design.
 */
export function buildLatencyStatement(table: string): string {
  const httpStatus = `try_cast(coalesce(
    variant_get(attributes, '$["http.status_code"]', 'string'),
    variant_get(attributes, '$["http.response.status_code"]', 'string')
  ) AS INT)`;
  return `WITH served AS (
  SELECT name,
         (end_time_unix_nano - start_time_unix_nano) / 1e6 AS ms,
         time,
         CASE WHEN ${httpStatus} >= 500 THEN 1 ELSE 0 END AS is_error
  FROM ${table}
  WHERE kind = '${SERVER_SPAN_KIND}'
    AND end_time_unix_nano >= start_time_unix_nano
),
bounds AS (
  SELECT MIN(time) AS t0, MAX(time) AS t1 FROM served
),
marked AS (
  SELECT s.*,
         CASE
           WHEN b.t0 IS NULL OR b.t1 IS NULL OR b.t0 = b.t1 THEN 'current'
           WHEN s.time < b.t0 + (b.t1 - b.t0) / 2 THEN 'prior'
           ELSE 'current'
         END AS half
  FROM served s CROSS JOIN bounds b
)
SELECT 'route' AS kind,
       name AS label,
       CAST(SUM(CASE WHEN half = 'current' THEN 1 ELSE 0 END) AS STRING) AS spans,
       CAST(percentile_approx(CASE WHEN half = 'current' THEN ms END, 0.5) AS STRING) AS p50,
       CAST(percentile_approx(CASE WHEN half = 'current' THEN ms END, 0.95) AS STRING) AS p95,
       CAST(percentile_approx(CASE WHEN half = 'current' THEN ms END, 0.99) AS STRING) AS p99,
       CAST(MAX(CASE WHEN half = 'current' THEN ms END) AS STRING) AS slowest,
       CAST(SUM(CASE WHEN half = 'current' THEN is_error ELSE 0 END) AS STRING) AS errors,
       CAST(MAX(CASE WHEN half = 'current' THEN time END) AS STRING) AS last_at,
       CAST(SUM(CASE WHEN half = 'prior' THEN 1 ELSE 0 END) AS STRING) AS prior_spans,
       CAST(percentile_approx(CASE WHEN half = 'prior' THEN ms END, 0.5) AS STRING) AS prior_p50
FROM marked
GROUP BY name
HAVING SUM(CASE WHEN half = 'current' THEN 1 ELSE 0 END) > 0
UNION ALL
SELECT 'covered', '', CAST(MIN(time) AS STRING), CAST(MAX(time) AS STRING), '', '', '', '', '', '', ''
FROM served
ORDER BY 1`;
}

/**
 * The stacked rows, separated into routes and the window they cover.
 *
 * HIGH-PERCENTILE FLOORS ARE APPLIED HERE rather than in the panel, so that a
 * second surface reading this payload cannot print a percentile this one
 * withheld. A withheld p95 or p99 is `null`, never a zero and never the p50
 * repeated: both of those are numbers a reader would compare against a real
 * percentile. The slowest span stays on the row so a thin sample still has a
 * labelled extreme.
 *
 * Sorted slowest first by current p50, because the reason anybody opens this
 * block is to find what is slow.
 */
export function readLatencyRows(dataArray: unknown): {
  routes: RouteLatency[];
  coveredFrom: string;
  coveredTo: string;
} {
  const routes: RouteLatency[] = [];
  let coveredFrom = '';
  let coveredTo = '';

  if (Array.isArray(dataArray)) {
    for (const raw of dataArray) {
      if (!Array.isArray(raw) || raw.length < 5) continue;
      const [
        kind,
        label,
        spans,
        p50,
        p95,
        p99,
        slowest,
        errors,
        lastAt,
        priorSpans,
        priorP50,
      ] = raw as (string | null)[];
      if (kind === 'covered') {
        coveredFrom = rowText(spans);
        coveredTo = rowText(p50);
        continue;
      }
      if (kind !== 'route') continue;
      const route = rowText(label);
      if (!route) continue;
      const counted = Number(spans ?? 0) || 0;
      if (counted <= 0) continue;
      const priorCounted = Number(priorSpans ?? 0) || 0;
      routes.push({
        route,
        spans: counted,
        p50Ms: Number(p50 ?? 0) || 0,
        p95Ms: counted >= SPAN_PERCENTILE_FLOOR ? Number(p95 ?? 0) || 0 : null,
        p99Ms: counted >= SPAN_PERCENTILE_FLOOR ? Number(p99 ?? 0) || 0 : null,
        slowestMs: Number(slowest ?? p50 ?? 0) || 0,
        errorCount: Number(errors ?? 0) || 0,
        // Refusals are not on the span. See RouteLatency.refusalCount.
        refusalCount: null,
        lastSpanAt: rowText(lastAt),
        priorSpans: priorCounted,
        priorP50Ms: priorCounted > 0 ? Number(priorP50 ?? 0) || 0 : null,
      });
    }
  }

  routes.sort((left, right) => right.p50Ms - left.p50Ms);
  return { routes, coveredFrom, coveredTo };
}
