export { validIanaTimeZone } from '../../shared/timezone';
import type { LakebaseReader } from './lakebase-store';
import { APP_ACTIVITY_ROLLUP_TABLE, RAW_APP_ACTIVITY_TABLE, TELEMETRY_ROLLUP_DAYS_TABLE } from './telemetry-retention';

export const APP_ACTIVITY_TABLE = RAW_APP_ACTIVITY_TABLE;

/**
 * First-party activity at the smallest honest grain the client can observe.
 *
 * The primary key makes retries and multiple tabs idempotent. There is no
 * content, route, token, session id, or secret: only the authenticated user and
 * the UTC minute in which the app was visible.
 */
export const APP_ACTIVITY_DDL = `CREATE TABLE IF NOT EXISTS ${APP_ACTIVITY_TABLE} (
  user_email TEXT NOT NULL,
  active_minute TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_email, active_minute)
)`;

export const RECORD_APP_ACTIVITY_QUERY = `INSERT INTO ${APP_ACTIVITY_TABLE} (user_email, active_minute)
VALUES (lower($1), date_trunc('minute', now()))
ON CONFLICT (user_email, active_minute) DO NOTHING`;

export const ACTIVE_MINUTES_PER_DAY_QUERY = `
  WITH requested AS (
    SELECT $2::date AS from_day, $3::date AS to_day
  ),
  rolled_activity AS (
    SELECT (rollup.day::timestamp AT TIME ZONE 'UTC')
             + (slot - 1) * INTERVAL '1 minute' AS active_minute,
           rollup.minute_counts[slot]::bigint AS count
    FROM ${APP_ACTIVITY_ROLLUP_TABLE} rollup
    CROSS JOIN generate_subscripts(rollup.minute_counts, 1) slot
    CROSS JOIN requested requested
    WHERE rollup.day BETWEEN requested.from_day - 1 AND requested.to_day + 1
      AND rollup.minute_counts[slot] > 0
  ),
  raw_activity AS (
    SELECT raw.active_minute, 1::bigint AS count
    FROM ${APP_ACTIVITY_TABLE} raw
    CROSS JOIN requested requested
    WHERE raw.active_minute >= ((requested.from_day - 1)::timestamp AT TIME ZONE 'UTC')
      AND raw.active_minute < ((requested.to_day + 2)::timestamp AT TIME ZONE 'UTC')
      AND NOT EXISTS (
        SELECT 1
        FROM ${TELEMETRY_ROLLUP_DAYS_TABLE} rolled
        WHERE rolled.day = (raw.active_minute AT TIME ZONE 'UTC')::date
          AND rolled.app_activity_complete
      )
  ),
  activity AS (
    SELECT active_minute, count FROM rolled_activity
    UNION ALL
    SELECT active_minute, count FROM raw_activity
  ),
  localized AS (
    SELECT active_minute,
           count,
           active_minute AT TIME ZONE $1 AS local_minute
    FROM activity
  ),
  per_day AS (
    SELECT to_char(date_trunc('day', local_minute), 'YYYY-MM-DD') AS day, SUM(count)::int AS count
    FROM localized
    CROSS JOIN requested requested
    WHERE local_minute::date BETWEEN requested.from_day AND requested.to_day
    GROUP BY 1
  ),
  bound_rows AS (
    SELECT first_active_at AS recorded_from, last_active_at AS recorded_through
    FROM ${APP_ACTIVITY_ROLLUP_TABLE}
    WHERE first_active_at IS NOT NULL
    UNION ALL
    SELECT MIN(active_minute), MAX(active_minute)
    FROM ${APP_ACTIVITY_TABLE}
  ),
  bounds AS (
    SELECT MIN(recorded_from) AS recorded_from, MAX(recorded_through) AS recorded_through
    FROM bound_rows
  ),
  available_days AS (
    SELECT rolled.day
    FROM ${TELEMETRY_ROLLUP_DAYS_TABLE} rolled
    CROSS JOIN requested requested
    WHERE rolled.app_activity_complete
      AND rolled.day BETWEEN requested.from_day - 1 AND requested.to_day + 1
    UNION
    SELECT (raw.active_minute AT TIME ZONE 'UTC')::date
    FROM ${APP_ACTIVITY_TABLE} raw
    CROSS JOIN requested requested
    WHERE raw.active_minute >= ((requested.from_day - 1)::timestamp AT TIME ZONE 'UTC')
      AND raw.active_minute < ((requested.to_day + 2)::timestamp AT TIME ZONE 'UTC')
  ),
  observed_days AS (
    SELECT MIN(day) AS first_day, MAX(day) AS last_day FROM available_days
  ),
  missing AS (
    SELECT COUNT(*)::int AS missing_days
    FROM observed_days observed
    CROSS JOIN LATERAL generate_series(
      observed.first_day,
      observed.last_day,
      INTERVAL '1 day'
    ) expected(day)
    LEFT JOIN available_days available ON available.day = expected.day::date
    WHERE available.day IS NULL
  ),
  coverage AS (
    SELECT CASE
             WHEN observed.first_day IS NULL THEN 'unavailable'
             WHEN missing.missing_days > 0 THEN 'partial'
             ELSE 'complete'
           END AS state,
           missing.missing_days
    FROM observed_days observed CROSS JOIN missing
  )
  SELECT per_day.day,
         per_day.count,
         bounds.recorded_from,
         bounds.recorded_through,
         coverage.state AS coverage_state,
         coverage.missing_days
  FROM bounds
  CROSS JOIN coverage
  LEFT JOIN per_day ON TRUE
  ORDER BY per_day.day`;

export async function recordAppActivityMinute(store: LakebaseReader, user: string): Promise<void> {
  await store.lakebase.query(RECORD_APP_ACTIVITY_QUERY, [user]);
}
