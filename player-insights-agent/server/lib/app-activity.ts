import { appTable } from '../../shared/app-schema';
import type { LakebaseReader } from './lakebase-store';

export const APP_ACTIVITY_TABLE = appTable('app_activity_minutes');

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
  WITH activity AS (
    SELECT active_minute, active_minute AT TIME ZONE $1 AS local_minute
    FROM ${APP_ACTIVITY_TABLE}
  ),
  per_day AS (
    SELECT to_char(date_trunc('day', local_minute), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
    FROM activity
    GROUP BY 1
  ),
  bounds AS (
    SELECT MIN(active_minute) AS recorded_from, MAX(active_minute) AS recorded_through
    FROM activity
  )
  SELECT per_day.day, per_day.count, bounds.recorded_from, bounds.recorded_through
  FROM bounds
  LEFT JOIN per_day ON TRUE
  ORDER BY per_day.day`;

export function validIanaTimeZone(value: string): string {
  const candidate = value.trim();
  if (!candidate) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return '';
  }
}

export async function recordAppActivityMinute(store: LakebaseReader, user: string): Promise<void> {
  await store.lakebase.query(RECORD_APP_ACTIVITY_QUERY, [user]);
}
