import { APP_SCHEMA } from '../../shared/app-schema';
import type { PreflightCheck } from '../routes/insights-routes';
import {
  GRANT_SCRIPT_COMMAND,
  GRANT_HOOK_PATH,
  GRANT_SCRIPT_WHY,
} from '../../shared/setup-remedies';
import { POOL_ENV, STATEMENT_TIMEOUT_CODE, statementTimeoutMs, statementTimeoutSql } from './lakebase-pool';

/**
 * Lakebase reads, and the honest reporting of what happened to them.
 *
 *   - the read succeeded and returned rows            -> stored data
 *   - the read succeeded and returned nothing         -> the store is genuinely empty
 *   - the read failed                                 -> the store is unavailable
 */

/** One checked-out connection, narrowed to what the read funnel needs of it. */
interface PooledConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface LakebaseReader {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    /**
     * The pool behind `query`, when there is a real one.
     *
     * Optional because most tests hand this module a `query` and nothing else,
     * and because the only thing reads need it for is the statement timeout,
     * which a test does not. Absent, {@link readStored} falls back to `query`
     * and behaves exactly as it did before the timeout existed.
     */
    pool?: {
      connect(): Promise<PooledConnection>;
    };
  };
}

export type StoredRead =
  | { available: true; rows: Record<string, unknown>[] }
  | { available: false; error: string; code: string };

/** Whether the store answers. Says nothing about whether it holds anything. */
export type LakebaseState = 'unknown' | 'ok' | 'unavailable';

/**
 * Whether the store holds anything. Orthogonal to {@link LakebaseState}: a
 * perfectly healthy database that has been emptied is `ok` and `empty`, and
 * conflating that with `unavailable` is what sent this investigation chasing a
 * connection failure that never happened.
 */
export type LakebaseContent = 'unknown' | 'populated' | 'empty';

/**
 * How much of the store a read actually exercised.
 */
export type ReadDepth = 'connection' | 'schema';

/**
 * Whether the store refused the app rather than failed to answer it.
 *
 * A third axis, orthogonal to both {@link LakebaseState} and
 * {@link LakebaseContent}. A missing GRANT and a stopped Lakebase endpoint both
 * end in `state: 'unavailable'` and both put seeded figures on screen, but
 * their prognoses are opposite: an endpoint that is down comes back on its own,
 * a grant that was never made does not.
 *
 * `denied` is the state a first deploy is in before
 * `scripts/grant-app-db-access.mjs` has been run. That script cannot run before
 * the app exists, so it cannot be part of the bundle.
 */
export type LakebaseAccess = 'unknown' | 'ok' | 'denied';

export interface LakebaseHealth {
  state: LakebaseState;
  /** When the current state began. */
  since: string;
  /**
   * Last time a read of any kind succeeded, or null if none ever has. Includes
   * reads too shallow to end an outage, see `connection_ok_since_failure`,
   * which is what tells the two apart.
   */
  last_ok_at: string | null;
  last_checked_at: string | null;
  consecutive_failures: number;
  last_error: { message: string; code: string; route: string; at: string; depth: ReadDepth } | null;
  /**
   * Set when the endpoint answered a bare connection check while schema reads
   * are still failing. Names the difference between "Lakebase is down" and
   * "the app cannot read the schema it owns", which have different remedies.
   */
  connection_ok_since_failure: boolean;
  /** Whether reads that succeeded found any stored records. */
  content: LakebaseContent;
  /** Routes whose last successful read matched nothing, for `content: 'empty'`. */
  empty_routes: string[];
  /**
   * Whether the store is refusing the app's credential on the schema it owns.
   *
   * Never inferred from `state`. Set only when Postgres says so in the one way
   * that cannot be mistaken for anything else, see {@link GRANT_DENIED_CODES}.
   */
  access: LakebaseAccess;
}

const health = {
  state: 'unknown' as LakebaseState,
  since: Date.now(),
  lastOkAt: null as number | null,
  lastCheckedAt: null as number | null,
  consecutiveFailures: 0,
  lastError: null as { message: string; code: string; route: string; at: number; depth: ReadDepth } | null,
  connectionOkSinceFailure: false,
  access: 'unknown' as LakebaseAccess,
  /**
   * Per route rather than one global flag, because routes read different
   * tables: an empty `conversations` and a populated `benchmark_runs` is a
   * real state, and a single flag would flap between them request by request.
   */
  contentByRoute: new Map<string, 'populated' | 'empty'>(),
};

/**
 * Exported for tests, which need each case to start from a clean slate.
 *
 * Stops the watchdog too. A timer left running from a previous case would go
 * on writing to the state this just cleared, which is the kind of thing that
 * makes one test fail because of another.
 */
export function resetLakebaseHealth() {
  stopLakebaseWatchdog();
  health.state = 'unknown';
  health.since = Date.now();
  health.lastOkAt = null;
  health.lastCheckedAt = null;
  health.consecutiveFailures = 0;
  health.lastError = null;
  health.connectionOkSinceFailure = false;
  health.access = 'unknown';
  health.contentByRoute.clear();
}

/** Empty only when every route that has read successfully found nothing. */
function contentState(): LakebaseContent {
  const seen = [...health.contentByRoute.values()];
  if (seen.length === 0) return 'unknown';
  return seen.some((value) => value === 'populated') ? 'populated' : 'empty';
}

function emptyRoutes(): string[] {
  return [...health.contentByRoute.entries()].filter(([, value]) => value === 'empty').map(([route]) => route);
}

export function lakebaseHealth(): LakebaseHealth {
  return {
    state: health.state,
    since: new Date(health.since).toISOString(),
    last_ok_at: health.lastOkAt === null ? null : new Date(health.lastOkAt).toISOString(),
    last_checked_at: health.lastCheckedAt === null ? null : new Date(health.lastCheckedAt).toISOString(),
    consecutive_failures: health.consecutiveFailures,
    last_error:
      health.lastError === null ? null : { ...health.lastError, at: new Date(health.lastError.at).toISOString() },
    connection_ok_since_failure: health.connectionOkSinceFailure,
    content: contentState(),
    empty_routes: emptyRoutes(),
    access: health.access,
  };
}

export function isLakebaseUnavailable() {
  return health.state === 'unavailable';
}

function seconds(from: number) {
  return Math.round((Date.now() - from) / 1000);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : 'none';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Failures worth one immediate retry.
 *
 * A pooled connection whose credential has expired, or that the server closed
 * underneath us, fails the moment it is used again. Retrying takes a different
 * connection from the pool, and when the pool has none idle it opens a new one,
 * which runs the token callback and mints a fresh credential. So the retry both
 * routes around a dead connection and is the path that recovers from an expired
 * one, rather than leaving the app to serve fabricated rows until it restarts.
 */
const RETRYABLE_CODES = new Set([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '28000', // invalid_authorization_specification
  '28P01', // invalid_password: an expired Lakebase OAuth credential lands here
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const RETRYABLE_TEXT = [
  'connection terminated',
  'connection ended',
  'timeout exceeded when trying to connect',
  'server closed the connection',
  'terminating connection',
  'password authentication failed',
  'token',
  'expired',
];

function isRetryable(error: unknown): boolean {
  // Before the code and text checks, not after. A cancelled statement is the one
  // failure a retry makes worse: it doubles the load that produced it and
  // doubles the wait the caller sits through before hearing the same answer.
  if (isStatementTimeout(error)) return false;
  if (RETRYABLE_CODES.has(errorCode(error))) return true;
  const message = errorMessage(error).toLowerCase();
  return RETRYABLE_TEXT.some((fragment) => message.includes(fragment));
}

/** Whether Postgres cancelled this statement on the deployment's timeout. */
function isStatementTimeout(error: unknown): boolean {
  return errorCode(error) === STATEMENT_TIMEOUT_CODE;
}

/**
 * Whether the app is still creating the schema it reads.
 *
 * True for the second or two after boot, because the schema pass no longer
 * blocks the app from serving. In that window a read of a table that does not
 * exist yet fails with `undefined_table`, which is ALSO one of the three codes a
 * missing GRANT produces, and the two have opposite prognoses: one clears itself
 * within a second, the other needs a script run by hand. Diagnosing the first as
 * the second would put the grant remedy in the log of a perfectly healthy first
 * deploy, which is how a remedy stops being read.
 */
let schemaPending = false;

/** Set by the boot path around the schema pass. */
export function markSchemaPending(pending: boolean) {
  schemaPending = pending;
}

/**
 * The three ways Postgres says "you were never granted this".
 *
 * Only three, and by SQLSTATE rather than message text: a connection failure and
 * a dropped table are both easy to describe in words containing "denied" or
 * "does not exist", so matching on prose fires this on an outage and points the
 * deployer at privileges while their endpoint is stopped.
 *
 *   42501  insufficient_privilege (the grant on the schema or table is missing.
 *   3F000  invalid_schema_name   ), `player_insights` is not visible to this
 *                                   role, which is what a missing USAGE looks
 *                                   like from the outside as well as a schema
 *                                   that genuinely was never created.
 *   42P01  undefined_table       , likewise for a table inside it.
 *
 * The last two are included because the grant script creates the schema and its
 * objects as well as granting on them: a deployment that never ran it fails on
 * whichever of the three Postgres checks first, and which one that is depends on
 * the role's search_path. Reporting only one of the three would make the message
 * naming the remedy appear intermittently.
 */
export const GRANT_DENIED_CODES = new Set(['42501', '3F000', '42P01']);

/**
 * The one 42501 that is not this condition.
 *
 * `ALTER TABLE ${APP_SCHEMA}.messages ADD COLUMN IF NOT EXISTS ...` is
 * refused at every boot of a database whose tables are owned by the developer
 * who first created them, because Postgres checks ownership before it decides
 * the statement is a no-op, and it reports that refusal as `must be owner of
 * table messages`, SQLSTATE 42501, the very same code a missing grant produces.
 * Nothing is wrong when it happens and nothing the grant script does would stop
 * it.
 */
const OWNERSHIP_REFUSAL = /must be owner of/i;

/**
 * Whether this failure is the app being refused rather than the store being down.
 *
 * Depth matters as much as the code. A privilege error on a read that never
 * touched `player_insights` is not this condition (it is a database the app
 * cannot use at all, which the grant script does not fix), so only a schema
 * read can raise it.
 */
export function isGrantDenied(error: unknown, depth: ReadDepth): boolean {
  return (depth === 'schema' &&
    GRANT_DENIED_CODES.has(errorCode(error)) &&
    !OWNERSHIP_REFUSAL.test(errorMessage(error))
  );
}

/**
 * The same question asked of a schema statement rather than of a read.
 *
 * `applySchema` holds failures it has already caught rather than live errors,
 * and it is the earliest place this condition can be seen, so it needs the
 * classification too, through this function rather than through its own copy
 * of the rule, because the ownership carve-out above is exactly the sort of
 * detail that gets applied in one of two places and not the other.
 */
export function isGrantDenialFailure(failure: { code: string; message: string }): boolean {
  return GRANT_DENIED_CODES.has(failure.code) && !OWNERSHIP_REFUSAL.test(failure.message);
}

/**
 * What the logs, the Sources page, and the banner all say to fix it.
 *
 * Built from `shared/setup-remedies.ts`, so every surface points to the
 * target-aware release hook rather than asking an operator to reconstruct its
 * five derived inputs.
 */
export const GRANT_DENIED_LOG_REMEDY =
  `Re-run the canonical app release, or after a Lakebase reattach run:\n` +
  `${GRANT_SCRIPT_COMMAND}\n${GRANT_SCRIPT_WHY}`;

/**
 * Anything qualified with the app's schema needs privileges a bare connection
 * does not. Matching the SQL is deliberate: it classifies whatever a caller
 * actually sent rather than trusting a caller to describe itself honestly, so
 * a future probe cannot claim to be a real read by passing an argument.
 */
const SCHEMA_QUALIFIED = new RegExp(`\\b${APP_SCHEMA}\\s*\\.`, 'i');

function readDepth(sql: string): ReadDepth {
  return SCHEMA_QUALIFIED.test(sql) ? 'schema' : 'connection';
}

/**
 * Whether a success is strong enough to end the current outage.
 *
 * A read can only clear an outage it would itself have caught. When the store
 * went down on a schema read (a lost grant on `player_insights` raises 42501
 * there), a bare connection check succeeding says nothing about whether that
 * read works now, because it never needed the privilege in the first place.
 *
 * Accepting the weaker evidence is what turned a permanent permissions failure
 * into what looked like an intermittent network one: the state flipped back on
 * every probe and out again on the next request, and the log filled with
 * RECOVERED lines a minute apart while no read was in fact succeeding.
 */
function clearsOutage(depth: ReadDepth): boolean {
  if (health.lastError === null) return true;
  return health.lastError.depth !== 'schema' || depth === 'schema';
}

function markOk(route: string, depth: ReadDepth) {
  health.lastCheckedAt = Date.now();
  health.lastOkAt = health.lastCheckedAt;

  if (health.state === 'ok') {
    health.consecutiveFailures = 0;
    return;
  }

  if (health.state === 'unavailable' && !clearsOutage(depth)) {
    // Not a recovery, so nothing describing the outage is reset: neither the
    // state nor the failure count, which together are the only record that
    // reads were failing for as long as they were.
    if (!health.connectionOkSinceFailure) {
      health.connectionOkSinceFailure = true;
      console.error(`[lakebase] STILL UNAVAILABLE, but the endpoint answers: ${route} succeeded without reading through ` +
          `the ${APP_SCHEMA} schema, while the failing read (${health.lastError?.route}, code ` +
          `${health.lastError?.code}) does. The connection and the credential are fine, so this is a ` +
          `privilege or schema problem and waiting will not fix it, run scripts/grant-app-db-access.mjs.`
      );
    }
    return;
  }

  const previous = health.state;
  const outageSeconds = seconds(health.since);
  health.state = 'ok';
  health.since = Date.now();
  health.consecutiveFailures = 0;
  health.connectionOkSinceFailure = false;
  // Only a schema read can clear a denial, and `clearsOutage` above has already
  // established that this one is strong enough to end whatever the outage was.
  // A bare connection check must not retract a grant diagnosis it never tested.
  if (depth === 'schema') health.access = 'ok';
  if (previous === 'unavailable') {
    console.warn(`[lakebase] RECOVERED: reads are succeeding again on ${route} after ${outageSeconds}s unavailable. ` +
        `Every response during the outage declared itself unavailable rather than carrying rows.`
    );
  }
}

function markUnavailable(route: string, error: unknown, depth: ReadDepth) {
  const message = errorMessage(error);
  const code = errorCode(error);
  // Not a denial while the app is still creating the schema. Postgres cannot
  // tell "you may not read this table" from "this table does not exist yet"
  // apart in its SQLSTATE, and for the second or two after boot the second one
  // is the likely reading. Recording `access: 'denied'` here would also outlive
  // the window: it is never retracted by anything but a successful schema read,
  // so one early request would leave the Sources page telling a healthy
  // deployment to run the grant script.
  const denied = isGrantDenied(error, depth) && !schemaPending;
  health.lastCheckedAt = Date.now();
  health.consecutiveFailures += 1;
  health.lastError = { message, code, route, at: Date.now(), depth };
  // Set before the transition check, so a denial discovered on the second or
  // hundredth consecutive failure is still recorded. A store that first went
  // down for an unrelated reason and is now refusing the grant would otherwise
  // keep the earlier, wrong diagnosis for as long as it stayed down.
  if (denied) health.access = 'denied';
  if (health.state !== 'unavailable') {
    const healthyFor =
      health.lastOkAt === null ? 'never succeeded since boot' : `healthy for ${seconds(health.lastOkAt)}s`;
    health.state = 'unavailable';
    health.since = Date.now();
    health.connectionOkSinceFailure = false;
    if (denied) {
      // Its own sentence, not a suffix on the one below. "STORAGE UNAVAILABLE"
      // alone is read as an outage and an outage is read as something that will
      // pass, so a deployer who has simply not run the grant script waits,
      // retries, and eventually restarts the app, none of which can work.
      // Postgres has said which of the two this is; the log has to say it too,
      // early, because the front of the line is as far as anyone reads. The
      // STORAGE UNAVAILABLE token is kept on the front of it because it is
      // still true and because it is what existing log searches and alerts
      // match on. A diagnosis that arrives by making the old line disappear
      // is one nobody is watching for.
      console.error(`[lakebase] STORAGE UNAVAILABLE, SCHEMA GRANTS MISSING: ${route} was REFUSED by Postgres (code ${code}): ${message}. ` +
          `Previously ${healthyFor}. This is not an outage and waiting will not fix it: the endpoint ` +
          `answered and then declined the read, so the app's Postgres role has no privilege on the ` +
          `${APP_SCHEMA} schema. Conversation storage is therefore unavailable and every route that ` +
          `reads it reports itself unavailable. ${GRANT_DENIED_LOG_REMEDY}`
      );
      return;
    }
    if (schemaPending && GRANT_DENIED_CODES.has(code)) {
      // Warn rather than error, and no remedy: this is the expected shape of a
      // request that arrived in the moment between the app starting to answer
      // and the schema pass finishing, and it resolves itself.
      console.warn(`[lakebase] READ BEFORE SCHEMA: ${route} could not read the store yet (code ${code}): ${message}. ` +
          `The schema pass is still running -- the app starts answering before it finishes, on purpose -- so ` +
          `the table this read wants may not exist yet. This is NOT the missing-grant condition and needs no ` +
          `script; it clears when the pass completes. If it is still appearing after that, it is real.`
      );
      return;
    }
    if (isStatementTimeout(error)) {
      // Its own sentence, because every other line in this family describes a
      // store that would not answer, and this one describes a store that was
      // still working when we gave up on it. The remedy is a query or an index,
      // not the endpoint, and the response carries the failure rather than an
      // empty list precisely so nobody reads a cancelled read as "no matches".
      console.error(`[lakebase] STATEMENT CANCELLED ON TIMEOUT: ${route} ran past the configured statement timeout ` +
          `and Postgres cancelled it (code ${code}): ${message}. Previously ${healthyFor}. This is NOT an ` +
          `empty result and NOT an outage: the store was answering. The route reports itself unavailable so ` +
          `no screen can show a cancelled read as a store holding nothing. Either the query needs an index ` +
          `or the window asked for more than this deployment's timeout allows.`
      );
      return;
    }
    console.error(`[lakebase] STORAGE UNAVAILABLE: ${route} failed (code ${code}): ${message}. ` +
        `Previously ${healthyFor}. Stored conversations, runs and benchmarks cannot be read; ` +
        `every route that reads them reports itself unavailable rather than substituting rows.`
    );
    return;
  }
  console.error(`[lakebase] still ${denied ? 'refused' : 'unavailable'} (failure ${health.consecutiveFailures}, ` +
      `${seconds(health.since)}s): ${route} failed (code ${code}): ${message}`
  );
}

/**
 * Connections that have already been told the statement timeout.
 *
 * A pool hands the same client object back for a reused connection, so the
 * `SET` costs one extra round trip per PHYSICAL connection ever opened, not one
 * per query. A `WeakSet` because a connection the pool has discarded should be
 * collectable, and because the next connection to replace it has to be set
 * again: the setting is session state and dies with the session, which is also
 * what makes a credential rotation self-healing here rather than silently
 * dropping the timeout.
 */
const sessionsWithTimeout = new WeakSet<PooledConnection>();

/**
 * Run one statement with the deployment's statement timeout in force.
 *
 * The timeout has to be a session setting rather than pool configuration
 * because AppKit discards `statement_timeout` from the pool config it is given
 * — see the note at the top of `lakebase-pool.ts`, which is a bug that
 * type-checks. `SET` also cannot be sent alongside a parameterised statement in
 * one batch (Postgres's extended protocol refuses multi-statement prepares), so
 * it is issued on a checked-out connection and remembered.
 *
 * Falls back to the plain pooled `query` when there is no pool to check out of
 * or no timeout configured. That fallback is why a test with a fake `query`
 * still works.
 *
 * A session setting outlives the read that made it, which is the hazard
 * {@link withoutReadTimeout} exists to close: statements issued outside this
 * funnel would otherwise inherit a READ's budget once something had read on
 * their connection, and a migration cancelled on a read's timer is a deployment
 * broken for a reason nothing on it names.
 */
async function runStatement(client: LakebaseReader,
  sql: string,
  params: unknown[]
): Promise<{ rows: Record<string, unknown>[] }> {
  const pool = client.lakebase.pool;
  const applyTimeout = statementTimeoutSql();
  if (applyTimeout === null || typeof pool?.connect !== 'function') {
    return client.lakebase.query(sql, params);
  }
  const connection = await pool.connect();
  try {
    if (!sessionsWithTimeout.has(connection)) {
      await connection.query(applyTimeout);
      // After the statement succeeded, never before. Recording it first would
      // mark a connection as protected because we tried.
      sessionsWithTimeout.add(connection);
    }
    return await connection.query(sql, params);
  } finally {
    connection.release();
  }
}

/**
 * Run work that is NOT a read on a connection the read timeout does not govern.
 *
 * ── WHY THIS IS NEEDED AT ALL ──
 *
 * The timeout above has to be a session setting, and a session setting belongs
 * to the CONNECTION rather than to the read that made it. The pool then hands
 * that connection to whoever asks next. While the schema pass ran to completion
 * before the app served anything, nobody had read yet and nothing inherited it.
 * Non-blocking startup ended that: the pass is fired and not awaited, the
 * watchdog begins probing at once, and from then on a migration can be issued on
 * a connection some earlier read set a thirty-second limit on.
 *
 * Thirty seconds is generous for a read and is not obviously enough for a
 * migration. `CREATE INDEX` takes an ACCESS EXCLUSIVE lock and waits for the
 * reads already touching the table to finish, and `statement_timeout` counts
 * that wait: the queue and the build share one budget. Cancelled, it reports
 * itself as a failed statement and the deployment carries on without the index,
 * with nothing anywhere saying a read's timer was what stopped it.
 *
 * ── WHAT THIS DOES, AND THE PART THAT MATTERS MOST ──
 *
 * Lifts the limit on one checked-out connection, runs the caller's work on that
 * connection, and PUTS THE LIMIT BACK before returning it to the pool. The
 * restoring half is the one that must not be dropped: a connection released
 * unlimited would make every subsequent read on it unbounded, which is the fault
 * the timeout was added to fix, reintroduced by its own repair and invisible
 * until something hangs.
 *
 * When the restore itself fails the connection is released anyway, having first
 * been forgotten by `sessionsWithTimeout`, so the next read re-applies it rather
 * than trusting a `SET` that did not land.
 *
 * Falls back to the plain pooled `query` where there is no pool or no timeout
 * configured, which is what keeps every test that hands this module a bare
 * `query` working.
 */
export async function withoutReadTimeout<T>(client: LakebaseReader,
  run: (query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>
): Promise<T> {
  const pool = client.lakebase.pool;
  const restore = statementTimeoutSql();
  if (restore === null || typeof pool?.connect !== 'function') {
    return run((sql, params) => client.lakebase.query(sql, params));
  }
  // A checkout that fails must not swallow the work. `applySchema` reports what
  // it attempted STATEMENT BY STATEMENT, and a throw from here would replace
  // twenty individual failures with one, leaving the surfaces that read those
  // failures to conclude the schema is fine. So the pool's own `query` is used
  // instead: the timeout may or may not be in force on whatever connection it
  // picks, which is exactly where this stood before, and the alternative is
  // worse than the fault being fixed.
  let connection: PooledConnection;
  try {
    connection = await pool.connect();
  } catch (error) {
    console.warn(`[lakebase] no connection could be reserved to lift the read timeout: ` +
        `${(error as Error).message}. Continuing on the pool, where a long statement may still be cancelled.`
    );
    return run((sql, params) => client.lakebase.query(sql, params));
  }
  // Forgotten first, so that every path out of here either restores the setting
  // or leaves the next read to apply it. Nothing may assume it is in force.
  sessionsWithTimeout.delete(connection);
  try {
    await connection.query('SET statement_timeout = 0');
    return await run((sql, params) => connection.query(sql, params));
  } finally {
    try {
      await connection.query(restore);
      sessionsWithTimeout.add(connection);
    } catch (error) {
      console.warn(`[lakebase] the read timeout could not be restored on a connection lent to a migration: ` +
          `${(error as Error).message}. It is being returned unmarked, so the next read sets it again.`
      );
    }
    connection.release();
  }
}

/**
 * Read stored rows, reporting whether the store answered at all.
 *
 * Never returns zero rows to mean "unavailable". That conflation is what let a
 * database outage reach the browser dressed up as a demo dataset. A statement
 * the timeout cancelled is the newest member of that family and the most
 * dangerous one, because a query that was going to be right is indistinguishable
 * from one that found nothing unless the failure is carried: it comes back
 * `available: false`, which every caller already answers with a 503 rather than
 * with an empty list.
 */
export async function readStored(client: LakebaseReader,
  route: string,
  sql: string,
  params: unknown[] = []
): Promise<StoredRead> {
  const depth = readDepth(sql);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await runStatement(client, sql, params);
      if (attempt > 1) {
        console.warn(`[lakebase] ${route} succeeded on retry after a transient connection failure.`);
      }
      markOk(route, depth);
      return { available: true, rows: result.rows };
    } catch (error) {
      lastError = error;
      if (attempt === 1 && isRetryable(error)) {
        console.warn(`[lakebase] ${route} failed with a retryable error (code ${errorCode(error)}): ` +
            `${errorMessage(error)}. Retrying once on a fresh connection.`
        );
        continue;
      }
      break;
    }
  }
  markUnavailable(route, lastError, depth);
  return { available: false, error: errorMessage(lastError), code: errorCode(lastError) };
}

/**
 * Why a response could not carry the rows the caller asked about.
 *
 * `storage_empty` was a third value, for a response carrying seeded rows
 * because the store held none. Nothing is seeded now, so that response is an
 * empty list from a store that answered, which is not a degradation and
 * declares no reason.
 */
export type SubstitutionReason = 'storage_unavailable' | 'storage_grants_missing';

/**
 * What the rows in a response actually are.
 *
 * Both values matter. `none` is the one that had to be added: a response that
 * carries no rows because nobody could read any is not `lakebase`, and calling
 * it that says the store answered and had nothing, which is the exact
 * conflation this module was written to end.
 *
 * A third value, `representative`, used to name a response carrying seeded rows
 * on a labelled demo deployment. No deployment holds any, so no response can be
 * that, and the browser no longer has a badge for it either.
 */
export type DataOrigin = 'lakebase' | 'none';

export interface Substitution {
  reason: SubstitutionReason | null;
  origin: DataOrigin;
}

/**
 * Decide what a read route answers with, and make the choice audible.
 *
 * There is no seeded stand-in to fall back to on any deployment, so the two
 * empty responses this can produce are never the same claim: an unreadable
 * store produces no rows AND says the rows are missing rather than absent,
 * while a store that answered and holds nothing reports itself as `lakebase`
 * with no degraded reason. Collapsing the two is the conflation every caller
 * here exists to prevent.
 */
export function chooseRows(route: string,
  read: StoredRead
): {
  rows: Record<string, unknown>[];
  substitution: Substitution;
} {
  // Read from the health state rather than from `read.code`, because a
  // `StoredRead` carries the code but not the depth, and the depth is half of
  // what makes a privilege error this condition rather than a database the app
  // cannot use at all. `markUnavailable` has already made that judgement with
  // both facts in hand; second-guessing it here from one of them is how the
  // two would come to disagree.
  const denied = health.access === 'denied';
  if (!read.available) {
    const reason: SubstitutionReason = denied ? 'storage_grants_missing' : 'storage_unavailable';
    const cause =
      `The store ${denied ? 'refused the read' : 'is unavailable'}. ` +
      `Last error (code ${read.code}): ${read.error}` +
      (denied ? ` ${GRANT_DENIED_LOG_REMEDY}` : '');
    console.error(`[lakebase] NO ROWS SERVED on ${route}: the app shows no seeded data, so the response is ` +
        `empty and declares itself unavailable. It is NOT a report that the store holds nothing. ${cause}`
    );
    return { rows: [], substitution: { reason, origin: 'none' } };
  }
  if (read.rows.length === 0) {
    // Logged on the transition, not on every request. An outage deserves a line
    // per response because it is urgent and usually brief; an empty store is a
    // steady state that would otherwise emit a warning for every page load and
    // bury the events worth reading.
    if (health.contentByRoute.get(route) !== 'empty') {
      console.warn(`[lakebase] STORE EMPTY on ${route}: the read succeeded, so Lakebase is reachable and the ` +
          `connection is fine. It simply holds no matching records, and this response carries no rows at ` +
          `all. Normal on a fresh deployment, where asking a question populates it. If records were ` +
          `written earlier, they have since been deleted, or the app is reading a different database, ` +
          `branch or schema than it wrote to.`
      );
    }
    health.contentByRoute.set(route, 'empty');
    // The store answered. That is the fact worth carrying, and it is why this is
    // `lakebase` with no degraded reason: an empty list from a healthy store is
    // a correct answer, not a degradation, and badging it as one teaches a
    // reader to discount the badge on the responses that are.
    return { rows: [], substitution: { reason: null, origin: 'lakebase' } };
  }
  if (health.contentByRoute.get(route) === 'empty') {
    console.warn(`[lakebase] ${route} is returning stored records again; the store is no longer empty.`);
  }
  health.contentByRoute.set(route, 'populated');
  return { rows: read.rows, substitution: { reason: null, origin: 'lakebase' } };
}

/**
 * The substitution a route reports when it answered without consulting
 * {@link chooseRows}, for the write and refusal paths.
 *
 * A named constructor rather than an object literal at each call site, because
 * `origin` was added later and a literal missing it would silently mean
 * whatever the type default was.
 */
export function noSubstitution(reason: SubstitutionReason | null = null): Substitution {
  return { reason, origin: reason === null ? 'lakebase' : 'none' };
}

/**
 * Response headers so the browser can be as honest as the logs are.
 *
 * A header rather than a body field because these routes return bare arrays,
 * and wrapping them in an envelope would change the shape every caller reads.
 */
export function markResponse(res: { setHeader(name: string, value: string): void }, substitution: Substitution) {
  res.setHeader('X-PIA-Storage', health.state);
  res.setHeader('X-PIA-Data-Origin', substitution.origin);
  if (substitution.reason) res.setHeader('X-PIA-Degraded-Reason', substitution.reason);
}

/**
 * A dependency the app owns and can therefore check itself.
 */
export function lakebaseStorageCheck(): PreflightCheck {
  const snapshot = lakebaseHealth();
  const database = process.env.PGDATABASE ?? '(unset)';
  const endpoint = process.env.LAKEBASE_ENDPOINT ?? '';
  const name = endpoint || database;
  if (snapshot.state === 'unavailable') {
    const error = snapshot.last_error;
    if (snapshot.access === 'denied') {
      // Its own branch rather than a sentence appended to the one below,
      // because almost every word of that one is wrong here. The store is not
      // unreachable, nothing is going to recover, and the remedy is not "check
      // the endpoint is running". It is a script the deployer has to run once
      // by hand and, on a first deploy, has never run. The generic wording sent
      // people to the Lakebase console to look at an endpoint that was healthy.
      return {
        id: 'lakebase-storage',
        kind: 'postgres',
        name,
        label: `Lakebase storage · ${database}`,
        status: 'failed',
        detail:
          `Postgres is answering and REFUSING the app's reads of the ${APP_SCHEMA} schema, so ` +
          `conversation storage is unavailable and the conversations, runs and benchmarks in the app ` +
          `cannot be listed at all. This is a privilege or schema ` +
          `problem, not an outage that will pass: the app's Postgres role has no grant on the schema, ` +
          `which is the state a deployment is in until ${GRANT_HOOK_PATH} has completed. ` +
          `Refused since ${snapshot.since}` +
          (snapshot.last_ok_at
            ? `; last successful read ${snapshot.last_ok_at}, so the grant existed and was lost.`
            : '; no read has ever succeeded, so the grant has most likely never been made.'),
        checked_with: error ? `${error.route} (code ${error.code})` : 'app Lakebase pool',
        duration_ms: 0,
        error: error ? error.message : `Postgres refused a read of the ${APP_SCHEMA} schema.`,
        remedy: {
          kind: 'cli',
          statement: GRANT_SCRIPT_COMMAND,
          // The variables are IN the statement, each with a `<value>` placeholder,
          // so listing them again is restating it. What a reader cannot get from
          // the statement is that the obvious move does not work: told the app
          // cannot read its database, a deployer redeploys.
          guidance: 'A redeploy will not do this: the grant can only be made after the app exists, by hand, once.',
        },
      };
    }
    return {
      id: 'lakebase-storage',
      kind: 'postgres',
      name,
      label: `Lakebase storage · ${database}`,
      status: 'failed',
      detail:
        `The app cannot read its own Postgres store, so conversations, runs and benchmarks cannot be ` +
        `listed and every surface that reads them reports itself unavailable. ` +
        `Unavailable since ${snapshot.since}` +
        (snapshot.last_ok_at ? `; last successful read ${snapshot.last_ok_at}.` : '; no read has ever succeeded.') +
        (snapshot.connection_ok_since_failure
          ? ' The endpoint has answered a bare connection check since then, so the network and the credential ' +
            'are fine and this is a privilege or schema problem rather than an outage that will pass.'
          : ''),
      checked_with: error ? `${error.route} (code ${error.code})` : 'app Lakebase pool',
      duration_ms: 0,
      error: error ? error.message : 'The Lakebase pool is not answering reads.',
      remedy: {
        kind: 'cli',
        // Was a hand-rolled `node scripts/grant-app-db-access.mjs` with none of
        // the five required variables, so the statement as printed could only
        // fail. The shared constant is the invocation that runs.
        statement: GRANT_SCRIPT_COMMAND,
        guidance: '',
      },
    };
  }
  if (snapshot.state === 'ok') {
    // Reachable stays `ok` whatever it turns out to hold, because nothing is
    // broken and reporting a failure here would train people to ignore this
    // row. What it holds is carried in the detail and the remedy, which are
    // what someone reads when they are working out why the figures look
    // invented.
    const base = {
      id: 'lakebase-storage',
      kind: 'postgres',
      name,
      label: `Lakebase storage · ${database}`,
      status: 'ok' as const,
      checked_with: 'app Lakebase pool',
      duration_ms: 0,
      error: '',
    };
    const counts =
      `SELECT (SELECT count(*) FROM ${APP_SCHEMA}.conversations) AS conversations,\n` +
      `       (SELECT count(*) FROM ${APP_SCHEMA}.messages) AS messages,\n` +
      `       (SELECT count(*) FROM ${APP_SCHEMA}.benchmark_runs) AS benchmark_runs;`;

    if (snapshot.content === 'populated') {
      return {
        ...base,
        detail:
          `The app read its Postgres store successfully at ${snapshot.last_ok_at}, and it returned stored records.`,
        remedy: null,
      };
    }
    if (snapshot.content === 'empty') {
      return {
        ...base,
        detail:
          `The app read its Postgres store successfully at ${snapshot.last_ok_at}, and it holds no stored ` +
          `records (${snapshot.empty_routes.join(', ')} matched nothing). The connection is healthy; the ` +
          `lists on screen are empty because there is nothing in them yet, which is what a fresh ` +
          `deployment looks like and is not a fault.`,
        remedy: {
          kind: 'sql',
          statement: counts,
          guidance: '',
        },
      };
    }
    return {
      ...base,
      detail:
        `The app reached its Postgres store successfully at ${snapshot.last_ok_at}, so the connection, the ` +
        `credential and its privileges on the ${APP_SCHEMA} schema are all good. Nothing has read content ` +
        `out of it yet (the watchdog probe deliberately does not count), so whether it holds any stored ` +
        `records is not known. Open Conversations or Run Explorer and this row will say which.`,
      remedy: {
        kind: 'sql',
        statement: counts,
        guidance: '',
      },
    };
  }
  return {
    id: 'lakebase-storage',
    kind: 'postgres',
    name,
    label: `Lakebase storage · ${database}`,
    status: 'unverified',
    detail: 'The app has not read its Postgres store since it started, so its state is unknown.',
    checked_with: 'app Lakebase pool',
    duration_ms: 0,
    error: '',
    remedy: null,
  };
}

/** The route label the watchdog reads under, so its lines are attributable. */
export const WATCHDOG_ROUTE = 'watchdog probe';

/**
 * What the watchdog reads.
 *
 * It deliberately says nothing about content. Exactly one row comes back,
 * empty tables included, and it never reaches {@link chooseRows}: a probe that
 * guessed at content is what put "it returned stored records" on the Sources
 * page before a single record had been read.
 */
export const WATCHDOG_PROBE_SQL =
  `SELECT (SELECT 1 FROM ${APP_SCHEMA}.conversations LIMIT 1) AS conversations,` +
  ` (SELECT 1 FROM ${APP_SCHEMA}.messages LIMIT 1) AS messages,` +
  ` (SELECT 1 FROM ${APP_SCHEMA}.benchmark_runs LIMIT 1) AS benchmark_runs`;

/** How often the probe runs when nothing says otherwise. */
export const WATCHDOG_DEFAULT_INTERVAL_MS = 60_000;

/**
 * The floor of last resort, for when there is no read timeout to derive one
 * from.
 *
 * Every tick is a real query on a real connection. Five seconds is already far
 * more often than anything here needs; below that the probe starts competing
 * with the requests it exists to protect, and a typo of `500` for `500000` would
 * do exactly that on a deployment nobody is watching.
 *
 * It is no longer the floor itself. See {@link watchdogFloorMs}.
 */
export const WATCHDOG_MIN_INTERVAL_MS = 5_000;

/**
 * How close together two probes may be, derived from how long one can live.
 *
 * NOT A NUMBER CHOSEN BESIDE THE READ TIMEOUT, because that is what let the two
 * be set into conflict. A five-second floor under a thirty-second timeout meant
 * a deployment slow enough to sit near its read limit started a probe every five
 * seconds against probes that took thirty to die: six outstanding at once, each
 * holding one of ten pooled connections, and the thing that exists to notice the
 * store struggling becomes most of what it is struggling with. Neither value's
 * own reasoning was wrong. They were wrong about each other, and nothing
 * compared them.
 *
 * A probe is a read, so it cannot outlive the read timeout. Spacing ticks by at
 * least that means a tick cannot land on a probe that is still out, and there is
 * one number rather than two.
 *
 * With the timeout switched off there is no lifetime to derive anything from, so
 * the absolute floor above is what is left. It cannot bound an unlimited probe,
 * which is why {@link startLakebaseWatchdog} also refuses to start one while
 * another is running -- a guarantee that holds however this is configured.
 */
export function watchdogFloorMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(WATCHDOG_MIN_INTERVAL_MS, statementTimeoutMs(env));
}

export const WATCHDOG_INTERVAL_ENV = 'PLAYER_INSIGHTS_LAKEBASE_WATCHDOG_MS';

/**
 * How often to probe, from the environment.
 *
 * Configurable because the right answer depends on the deployment rather than on
 * this code. A demo left running overnight wants a slow pulse and does not want a
 * query a minute in its billing; a workspace where the credential goes stale
 * wants a fast one, since keeping a connection warm is half of what the probe is
 * for. Neither is a reason to edit and redeploy the app.
 *
 * A value that is not a positive number falls back to the default rather than
 * disabling the probe, and it says so: an unreadable interval is a typo, and
 * silently switching off the only thing that dates an outage would be the worst
 * available reading of one. To turn it off, don't start it.
 */
export function watchdogIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const floor = watchdogFloorMs(env);
  const raw = env[WATCHDOG_INTERVAL_ENV]?.trim();
  // The default is held to the floor as well. A deployment that lengthened its
  // read timeout past a minute and never touched this variable would otherwise
  // be left with the same conflict, arrived at by leaving something alone.
  if (!raw) return Math.max(WATCHDOG_DEFAULT_INTERVAL_MS, floor);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[lakebase] ${WATCHDOG_INTERVAL_ENV} is "${raw}", which is not a number of milliseconds. Probing every ` +
        `${WATCHDOG_DEFAULT_INTERVAL_MS}ms instead. The watchdog is what dates an outage, so it is not switched off.`
    );
    return Math.max(WATCHDOG_DEFAULT_INTERVAL_MS, floor);
  }
  if (parsed < floor) {
    console.warn(
      `[lakebase] ${WATCHDOG_INTERVAL_ENV} is ${parsed}ms, below the ${floor}ms floor, which is this ` +
        `deployment's read timeout (${POOL_ENV.statementTimeoutMs}). Every tick is a real read and is ` +
        'cancelled by that same limit, so probing faster than it stacks probes on the connection pool the ' +
        'app serves requests from.'
    );
    return floor;
  }
  return parsed;
}

/**
 * At most one watchdog runs at a time.
 */
let stopActiveWatchdog: (() => void) | null = null;

/** Stop the running watchdog, if there is one. Safe to call when there is not. */
export function stopLakebaseWatchdog() {
  stopActiveWatchdog?.();
}

/**
 * Probe the store on a timer.
 *
 * Without this, an outage is only discovered by whoever happens to load a page
 * next, and a recovery is never noticed at all. Dating the transition is most
 * of the value: the incident that prompted this module could not be placed in
 * time from the app's own logs, and the window had to be recovered afterwards
 * from Postgres autovacuum timestamps. It doubles as the thing that keeps a
 * fresh credential minted: an idle pool closes its connections, so the probe's
 * next read opens a new one and exercises the token callback rather than
 * letting the first real user request discover that the credential went stale.
 */
export function startLakebaseWatchdog(client: LakebaseReader, intervalMs = watchdogIntervalMs()) {
  stopLakebaseWatchdog();
  // AT MOST ONE PROBE AT A TIME, whatever the interval. The floor derived in
  // `watchdogFloorMs` keeps ticks further apart than a probe can live, but only
  // while there is a read timeout to derive it from: switched off, a probe on a
  // hung connection outlasts any interval, and every tick would add another one
  // holding another connection out of the pool the app serves requests from.
  // Skipping is also the honest reading -- a probe still out has already
  // established what the next one would ask.
  let probing = false;
  let skipping = false;
  const timer = setInterval(() => {
    if (probing) {
      if (!skipping) {
        skipping = true;
        console.warn(`[lakebase] the watchdog probe has not answered within its ${intervalMs}ms interval, so this ` +
            'tick is skipped rather than started alongside it. The store is slower than the probe schedule ' +
            'assumes; the probe already running will report what it finds.'
        );
      }
      return;
    }
    probing = true;
    skipping = false;
    void readStored(client, WATCHDOG_ROUTE, WATCHDOG_PROBE_SQL).finally(() => {
      probing = false;
    });
  }, intervalMs);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (stopActiveWatchdog === stop) stopActiveWatchdog = null;
  };
  stopActiveWatchdog = stop;
  return stop;
}
