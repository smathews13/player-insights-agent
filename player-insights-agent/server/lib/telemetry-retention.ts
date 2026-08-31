import { appTable } from '../../shared/app-schema';

/** Raw telemetry remains queryable for exactly this moving window. */
export const RAW_TELEMETRY_RETENTION_DAYS = 90;
/** A single run cannot monopolize Lakebase while catching up an old deployment. */
export const MAX_ROLLUP_DAYS_PER_RUN = 31;
export const MAX_DELETE_BATCHES_PER_RUN = 20;
export const DELETE_BATCH_SIZE = 1_000;
export const TELEMETRY_HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export const RAW_REQUEST_LATENCY_TABLE = appTable('request_latencies');
export const RAW_APP_ACTIVITY_TABLE = appTable('app_activity_minutes');
export const REQUEST_LATENCY_ROLLUP_TABLE = appTable('request_latency_daily_rollups');
export const APP_ACTIVITY_ROLLUP_TABLE = appTable('app_activity_daily_rollups');
export const TELEMETRY_ROLLUP_DAYS_TABLE = appTable('telemetry_rollup_days');
export const TELEMETRY_HOUSEKEEPING_STATE_TABLE = appTable('telemetry_housekeeping_state');

/**
 * Daily, de-identified request distributions.
 *
 * The three arrays are aligned and ordered by the original timestamp. Keeping
 * microsecond offsets and every duration is intentional: PostgreSQL has no
 * built-in mergeable exact quantile state. A count/sum/max rollup could not
 * reproduce percentile_cont, and an unlabelled histogram would turn an
 * approximation into a measured-looking p95. The row identity and exact HTTP
 * status are discarded; the sufficient distribution remains mergeable and
 * preserves the existing exact percentile definition.
 */
export const REQUEST_LATENCY_ROLLUP_DDL = `CREATE TABLE IF NOT EXISTS ${REQUEST_LATENCY_ROLLUP_TABLE} (
  day DATE NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  recorded_offsets_us BIGINT[] NOT NULL,
  durations_ms DOUBLE PRECISION[] NOT NULL,
  error_flags BOOLEAN[] NOT NULL,
  request_count INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  first_request_at TIMESTAMPTZ NOT NULL,
  last_request_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (day, method, route),
  CHECK (cardinality(recorded_offsets_us) = cardinality(durations_ms)),
  CHECK (cardinality(durations_ms) = cardinality(error_flags)),
  CHECK (request_count = cardinality(durations_ms))
)`;

/**
 * One array per UTC day, with slot 1 representing 00:00 UTC.
 *
 * Minute counts retain enough information to re-bucket exactly into any IANA
 * timezone later, including half-hour offsets and 23/25-hour DST days, without
 * retaining the signed-in identities from the raw heartbeat table.
 */
export const APP_ACTIVITY_ROLLUP_DDL = `CREATE TABLE IF NOT EXISTS ${APP_ACTIVITY_ROLLUP_TABLE} (
  day DATE PRIMARY KEY,
  minute_counts INTEGER[] NOT NULL,
  active_minutes INTEGER NOT NULL,
  first_active_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  CHECK (cardinality(minute_counts) = 1440),
  CHECK (active_minutes >= 0)
)`;

/** A day is deletable only after this durable completion marker commits. */
export const TELEMETRY_ROLLUP_DAYS_DDL = `CREATE TABLE IF NOT EXISTS ${TELEMETRY_ROLLUP_DAYS_TABLE} (
  day DATE PRIMARY KEY,
  request_latency_complete BOOLEAN NOT NULL,
  app_activity_complete BOOLEAN NOT NULL,
  request_latency_rows BIGINT NOT NULL,
  app_activity_rows BIGINT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL
)`;

/** Prevent a second replica from repeating a successful daily pass. */
export const TELEMETRY_HOUSEKEEPING_STATE_DDL = `CREATE TABLE IF NOT EXISTS ${TELEMETRY_HOUSEKEEPING_STATE_TABLE} (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_completed_day DATE,
  completed_at TIMESTAMPTZ
)`;

export const APP_ACTIVITY_RETENTION_INDEX_DDL = `CREATE INDEX IF NOT EXISTS app_activity_minutes_active_idx
  ON ${RAW_APP_ACTIVITY_TABLE} (active_minute)`;
export const RUNS_CREATED_AT_INDEX_DDL = `CREATE INDEX IF NOT EXISTS runs_created_at_idx
  ON ${appTable('runs')} (created_at)`;

export const TELEMETRY_ROLLUP_MIGRATION_DDL: readonly string[] = [
  REQUEST_LATENCY_ROLLUP_DDL,
  APP_ACTIVITY_ROLLUP_DDL,
  TELEMETRY_ROLLUP_DAYS_DDL,
  TELEMETRY_HOUSEKEEPING_STATE_DDL,
  APP_ACTIVITY_RETENTION_INDEX_DDL,
  RUNS_CREATED_AT_INDEX_DDL,
];

/** Stable two-key PostgreSQL advisory lock namespace for telemetry retention. */
export const TELEMETRY_ADVISORY_LOCK_KEYS = [0x504941, 0x54454c] as const;

export const CLAIM_TELEMETRY_LOCK_QUERY = 'SELECT pg_try_advisory_lock($1, $2) AS acquired';
export const RELEASE_TELEMETRY_LOCK_QUERY = 'SELECT pg_advisory_unlock($1, $2) AS released';

export const LAST_HOUSEKEEPING_DAY_QUERY = `SELECT last_completed_day
  FROM ${TELEMETRY_HOUSEKEEPING_STATE_TABLE}
  WHERE singleton = TRUE`;

/**
 * Fill the calendar continuously from the first observed telemetry day.
 * Zero-traffic days still receive a marker, which is how a later query can tell
 * a measured zero from a missing rollup.
 */
export const PENDING_ROLLUP_DAYS_QUERY = `WITH first_day AS (
  SELECT LEAST(
    (SELECT MIN((recorded_at AT TIME ZONE 'UTC')::date) FROM ${RAW_REQUEST_LATENCY_TABLE}),
    (SELECT MIN((active_minute AT TIME ZONE 'UTC')::date) FROM ${RAW_APP_ACTIVITY_TABLE}),
    (SELECT MIN(day) FROM ${TELEMETRY_ROLLUP_DAYS_TABLE})
  ) AS day
),
calendar AS (
  SELECT generate_series(
    (SELECT day FROM first_day),
    (NOW() AT TIME ZONE 'UTC')::date - 1,
    INTERVAL '1 day'
  )::date AS day
)
SELECT calendar.day
FROM calendar
LEFT JOIN ${TELEMETRY_ROLLUP_DAYS_TABLE} rolled USING (day)
WHERE rolled.day IS NULL
ORDER BY calendar.day
LIMIT $1`;

export const ROLLUP_REQUEST_LATENCY_DAY_QUERY = `INSERT INTO ${REQUEST_LATENCY_ROLLUP_TABLE}
  (day, method, route, recorded_offsets_us, durations_ms, error_flags,
   request_count, error_count, first_request_at, last_request_at)
SELECT $1::date,
       method,
       route,
       array_agg(
         ROUND(EXTRACT(EPOCH FROM (recorded_at - ($1::date::timestamp AT TIME ZONE 'UTC'))) * 1000000)::bigint
         ORDER BY recorded_at, id
       ),
       array_agg(duration_ms ORDER BY recorded_at, id),
       array_agg(status_code >= 500 ORDER BY recorded_at, id),
       COUNT(*)::int,
       COUNT(*) FILTER (WHERE status_code >= 500)::int,
       MIN(recorded_at),
       MAX(recorded_at)
FROM ${RAW_REQUEST_LATENCY_TABLE}
WHERE recorded_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
  AND recorded_at < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')
GROUP BY method, route
ON CONFLICT (day, method, route) DO UPDATE SET
  recorded_offsets_us = EXCLUDED.recorded_offsets_us,
  durations_ms = EXCLUDED.durations_ms,
  error_flags = EXCLUDED.error_flags,
  request_count = EXCLUDED.request_count,
  error_count = EXCLUDED.error_count,
  first_request_at = EXCLUDED.first_request_at,
  last_request_at = EXCLUDED.last_request_at`;

export const ROLLUP_APP_ACTIVITY_DAY_QUERY = `WITH minute_totals AS (
  SELECT date_trunc('minute', active_minute) AS minute, COUNT(*)::int AS count
  FROM ${RAW_APP_ACTIVITY_TABLE}
  WHERE active_minute >= ($1::date::timestamp AT TIME ZONE 'UTC')
    AND active_minute < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')
  GROUP BY 1
),
minutes AS (
  SELECT generate_series(
    ($1::date::timestamp AT TIME ZONE 'UTC'),
    (($1::date + 1)::timestamp AT TIME ZONE 'UTC') - INTERVAL '1 minute',
    INTERVAL '1 minute'
  ) AS minute
)
INSERT INTO ${APP_ACTIVITY_ROLLUP_TABLE}
  (day, minute_counts, active_minutes, first_active_at, last_active_at)
SELECT $1::date,
       array_agg(COALESCE(t.count, 0) ORDER BY m.minute),
       COALESCE(SUM(t.count), 0)::int,
       MIN(m.minute) FILTER (WHERE COALESCE(t.count, 0) > 0),
       MAX(m.minute) FILTER (WHERE COALESCE(t.count, 0) > 0)
FROM minutes m
LEFT JOIN minute_totals t USING (minute)
ON CONFLICT (day) DO UPDATE SET
  minute_counts = EXCLUDED.minute_counts,
  active_minutes = EXCLUDED.active_minutes,
  first_active_at = EXCLUDED.first_active_at,
  last_active_at = EXCLUDED.last_active_at`;

export const MARK_ROLLUP_DAY_QUERY = `INSERT INTO ${TELEMETRY_ROLLUP_DAYS_TABLE}
  (day, request_latency_complete, app_activity_complete,
   request_latency_rows, app_activity_rows, completed_at)
SELECT $1::date,
       TRUE,
       TRUE,
       (SELECT COUNT(*) FROM ${RAW_REQUEST_LATENCY_TABLE}
         WHERE recorded_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
           AND recorded_at < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')),
       (SELECT COUNT(*) FROM ${RAW_APP_ACTIVITY_TABLE}
         WHERE active_minute >= ($1::date::timestamp AT TIME ZONE 'UTC')
           AND active_minute < (($1::date + 1)::timestamp AT TIME ZONE 'UTC')),
       NOW()
ON CONFLICT (day) DO UPDATE SET
  request_latency_complete = EXCLUDED.request_latency_complete,
  app_activity_complete = EXCLUDED.app_activity_complete,
  request_latency_rows = EXCLUDED.request_latency_rows,
  app_activity_rows = EXCLUDED.app_activity_rows,
  completed_at = EXCLUDED.completed_at`;

/**
 * Bounded deletes prove the corresponding UTC day committed before touching
 * raw data. The moving instant is exact: 89-day rows remain, 90-day boundary
 * rows remain, and rows older than 90 days become eligible.
 */
export const DELETE_REQUEST_LATENCY_BATCH_QUERY = `WITH expired AS (
  SELECT raw.id
  FROM ${RAW_REQUEST_LATENCY_TABLE} raw
  WHERE raw.recorded_at < NOW() - INTERVAL '${RAW_TELEMETRY_RETENTION_DAYS} days'
    AND EXISTS (
      SELECT 1
      FROM ${TELEMETRY_ROLLUP_DAYS_TABLE} rolled
      WHERE rolled.day = (raw.recorded_at AT TIME ZONE 'UTC')::date
        AND rolled.request_latency_complete
    )
  ORDER BY raw.recorded_at, raw.id
  LIMIT $1
)
DELETE FROM ${RAW_REQUEST_LATENCY_TABLE} raw
USING expired
WHERE raw.id = expired.id
RETURNING raw.id`;

export const DELETE_APP_ACTIVITY_BATCH_QUERY = `WITH expired AS (
  SELECT raw.user_email, raw.active_minute
  FROM ${RAW_APP_ACTIVITY_TABLE} raw
  WHERE raw.active_minute < NOW() - INTERVAL '${RAW_TELEMETRY_RETENTION_DAYS} days'
    AND EXISTS (
      SELECT 1
      FROM ${TELEMETRY_ROLLUP_DAYS_TABLE} rolled
      WHERE rolled.day = (raw.active_minute AT TIME ZONE 'UTC')::date
        AND rolled.app_activity_complete
    )
  ORDER BY raw.active_minute, raw.user_email
  LIMIT $1
)
DELETE FROM ${RAW_APP_ACTIVITY_TABLE} raw
USING expired
WHERE raw.user_email = expired.user_email
  AND raw.active_minute = expired.active_minute
RETURNING raw.user_email`;

export const MARK_HOUSEKEEPING_COMPLETE_QUERY = `INSERT INTO ${TELEMETRY_HOUSEKEEPING_STATE_TABLE}
  (singleton, last_completed_day, completed_at)
VALUES (TRUE, (NOW() AT TIME ZONE 'UTC')::date, NOW())
ON CONFLICT (singleton) DO UPDATE SET
  last_completed_day = EXCLUDED.last_completed_day,
  completed_at = EXCLUDED.completed_at`;

interface RetentionConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface TelemetryRetentionStore {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  pool?: { connect(): Promise<RetentionConnection> };
}

export interface TelemetryHousekeepingResult {
  acquired: boolean;
  alreadyCompleted: boolean;
  rolledDays: string[];
  deletedRequestLatencies: number;
  deletedActivityMinutes: number;
}

function dayText(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function truthy(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}

async function inTransaction(connection: RetentionConnection, work: () => Promise<void>): Promise<void> {
  await connection.query('BEGIN');
  try {
    await work();
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function deleteBatches(
  connection: RetentionConnection,
  statement: string,
  limit: number,
  maxBatches: number
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    let rows = 0;
    await inTransaction(connection, async () => {
      const result = await connection.query(statement, [limit]);
      rows = result.rows.length;
    });
    deleted += rows;
    if (rows < limit) break;
  }
  return deleted;
}

const activeHousekeeping = new WeakMap<object, Promise<TelemetryHousekeepingResult>>();

/**
 * Roll complete UTC days, then delete only raw rows whose day is durable.
 *
 * A session advisory lock prevents overlap across replicas. Transactions are
 * deliberately per day and per delete batch: a crash cannot expose a partial
 * day's rollup, and a large backlog cannot hold one transaction for the whole
 * pass. The successful-day marker is written last, so a failure is retryable
 * the same day; committed rollups are idempotently skipped or replaced.
 */
export function runTelemetryHousekeeping(
  lakebase: TelemetryRetentionStore,
  options: {
    maxRollupDays?: number;
    deleteBatchSize?: number;
    maxDeleteBatches?: number;
  } = {}
): Promise<TelemetryHousekeepingResult> {
  const active = activeHousekeeping.get(lakebase);
  if (active) return active;
  const run = async (): Promise<TelemetryHousekeepingResult> => {
    const connection = await lakebase.pool?.connect();
    if (!connection) {
      throw new Error(
        'Telemetry housekeeping requires the Lakebase pool so its lock and transactions share one connection.'
      );
    }
    let acquired = false;
    try {
      const lock = await connection.query(CLAIM_TELEMETRY_LOCK_QUERY, [...TELEMETRY_ADVISORY_LOCK_KEYS]);
      acquired = truthy(lock.rows[0]?.acquired);
      if (!acquired) {
        return {
          acquired: false,
          alreadyCompleted: false,
          rolledDays: [],
          deletedRequestLatencies: 0,
          deletedActivityMinutes: 0,
        };
      }

      const completed = await connection.query(LAST_HOUSEKEEPING_DAY_QUERY);
      const today = await connection.query(`SELECT (NOW() AT TIME ZONE 'UTC')::date AS day`);
      if (dayText(completed.rows[0]?.last_completed_day) === dayText(today.rows[0]?.day)) {
        return {
          acquired: true,
          alreadyCompleted: true,
          rolledDays: [],
          deletedRequestLatencies: 0,
          deletedActivityMinutes: 0,
        };
      }

      const maxRollupDays = Math.max(
        1,
        Math.min(MAX_ROLLUP_DAYS_PER_RUN, Math.trunc(options.maxRollupDays ?? MAX_ROLLUP_DAYS_PER_RUN))
      );
      const candidates = await connection.query(PENDING_ROLLUP_DAYS_QUERY, [maxRollupDays]);
      const rolledDays: string[] = [];
      for (const row of candidates.rows) {
        const day = dayText(row.day);
        if (!day) continue;
        await inTransaction(connection, async () => {
          await connection.query(ROLLUP_REQUEST_LATENCY_DAY_QUERY, [day]);
          await connection.query(ROLLUP_APP_ACTIVITY_DAY_QUERY, [day]);
          await connection.query(MARK_ROLLUP_DAY_QUERY, [day]);
        });
        rolledDays.push(day);
      }

      const deleteBatchSize = Math.max(1, Math.min(10_000, Math.trunc(options.deleteBatchSize ?? DELETE_BATCH_SIZE)));
      const maxDeleteBatches = Math.max(
        1,
        Math.min(MAX_DELETE_BATCHES_PER_RUN, Math.trunc(options.maxDeleteBatches ?? MAX_DELETE_BATCHES_PER_RUN))
      );
      const deletedRequestLatencies = await deleteBatches(
        connection,
        DELETE_REQUEST_LATENCY_BATCH_QUERY,
        deleteBatchSize,
        maxDeleteBatches
      );
      const deletedActivityMinutes = await deleteBatches(
        connection,
        DELETE_APP_ACTIVITY_BATCH_QUERY,
        deleteBatchSize,
        maxDeleteBatches
      );
      await connection.query(MARK_HOUSEKEEPING_COMPLETE_QUERY);
      return {
        acquired: true,
        alreadyCompleted: false,
        rolledDays,
        deletedRequestLatencies,
        deletedActivityMinutes,
      };
    } finally {
      if (acquired) {
        await connection.query(RELEASE_TELEMETRY_LOCK_QUERY, [...TELEMETRY_ADVISORY_LOCK_KEYS]).catch(() => undefined);
      }
      connection.release();
    }
  };
  const started = run().finally(() => {
    activeHousekeeping.delete(lakebase);
  });
  activeHousekeeping.set(lakebase, started);
  return started;
}

let stopActiveScheduler: (() => void) | null = null;

/** Start one local scheduler; the database lock/state handles other replicas. */
export function startTelemetryHousekeeping(
  lakebase: TelemetryRetentionStore,
  intervalMs = TELEMETRY_HOUSEKEEPING_INTERVAL_MS
): () => void {
  stopActiveScheduler?.();
  const run = () => {
    void runTelemetryHousekeeping(lakebase).catch((error: Error) => {
      console.warn(`[telemetry-retention] Daily housekeeping did not complete and will retry: ${error.message}`);
    });
  };
  run();
  const timer = setInterval(run, Math.max(60_000, intervalMs));
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (stopActiveScheduler === stop) stopActiveScheduler = null;
  };
  stopActiveScheduler = stop;
  return stop;
}

export function stopTelemetryHousekeeping(): void {
  stopActiveScheduler?.();
}
