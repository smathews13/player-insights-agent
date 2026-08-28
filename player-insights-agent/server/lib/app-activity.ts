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
  SELECT to_char(date_trunc('day', active_minute), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
  FROM ${APP_ACTIVITY_TABLE}
  GROUP BY 1
  ORDER BY 1`;

export async function recordAppActivityMinute(store: LakebaseReader, user: string): Promise<void> {
  await store.lakebase.query(RECORD_APP_ACTIVITY_QUERY, [user]);
}
