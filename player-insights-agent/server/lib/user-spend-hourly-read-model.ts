import { appTable } from '../../shared/app-schema';
import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { UserSpendQuality } from '../../shared/user-spend-contract';
import type {
  UserSpendReadModelComponent,
  UserSpendReadModelPage,
  UserSpendReadModelStore,
  UserSpendSummaryRow,
} from './user-spend-read-model';
import { USER_SPEND_CALCULATION_VERSION, USER_SPEND_DAILY_TABLE, USER_SPEND_STALE_MS } from './user-spend-read-model';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
export const USER_SPEND_HOURLY_RETENTION_DAYS = 8;
export const USER_SPEND_HOURLY_OVERLAP_HOURS = 48;
export const USER_SPEND_HOURLY_REFRESH_INTERVAL_MS = 15 * 60 * 1_000;
export const USER_SPEND_HOURLY_LEASE_MS = 10 * 60 * 1_000;

export const USER_SPEND_HOURLY_TABLE = appTable('user_spend_hourly');
export const USER_SPEND_HOURLY_REFRESH_TABLE = appTable('user_spend_hourly_refresh_state');

export const USER_SPEND_HOURLY_READ_MODEL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${USER_SPEND_HOURLY_TABLE} (
     app_scope TEXT NOT NULL,
     user_key TEXT NOT NULL,
     display_email TEXT NOT NULL,
     activity_hour TIMESTAMPTZ NOT NULL,
     calculation_version INTEGER NOT NULL,
     submitted_questions INTEGER NOT NULL DEFAULT 0 CHECK (submitted_questions >= 0),
     completed_questions INTEGER NOT NULL DEFAULT 0 CHECK (completed_questions >= 0),
     run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
     active_minutes INTEGER NOT NULL DEFAULT 0 CHECK (active_minutes >= 0),
     total_tokens BIGINT,
     token_covered_runs INTEGER,
     token_covered_questions INTEGER,
     spend_usd NUMERIC(30,12),
     spend_dbu NUMERIC(30,12),
     app_spend_usd NUMERIC(30,12),
     app_spend_dbu NUMERIC(30,12),
     spend_usd_quality TEXT NOT NULL DEFAULT 'unavailable'
       CHECK (spend_usd_quality IN ('allocated', 'partial', 'unavailable')),
     spend_dbu_quality TEXT NOT NULL DEFAULT 'unavailable'
       CHECK (spend_dbu_quality IN ('allocated', 'partial', 'unavailable')),
     components JSONB NOT NULL DEFAULT '{}'::jsonb,
     billing_basis_day DATE,
     source_through TIMESTAMPTZ,
     computed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (app_scope, user_key, activity_hour, calculation_version),
     CHECK (lower(user_key) = user_key),
     CHECK (jsonb_typeof(components) = 'object')
   )`,
  `CREATE INDEX IF NOT EXISTS user_spend_hourly_hour_scope_idx
     ON ${USER_SPEND_HOURLY_TABLE} (activity_hour, app_scope, calculation_version)`,
  `CREATE TABLE IF NOT EXISTS ${USER_SPEND_HOURLY_REFRESH_TABLE} (
     app_scope TEXT NOT NULL,
     calculation_version INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('idle', 'refreshing', 'ready', 'failed')),
     watermark_hour TIMESTAMPTZ,
     source_through TIMESTAMPTZ,
     billing_basis_through DATE,
     lease_owner TEXT,
     lease_expires_at TIMESTAMPTZ,
     started_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     error_class TEXT,
     error_at TIMESTAMPTZ,
     rows_upserted BIGINT NOT NULL DEFAULT 0,
     PRIMARY KEY (app_scope, calculation_version)
   )`,
];

export const READ_USER_SPEND_HOURLY_SOURCE_QUERY = `WITH evidence AS (
  SELECT lower(c.user_email) AS user_key, m.created_at AS occurred_at,
         1::int AS questions, 0::int AS completed, 0::int AS runs,
         0::int AS active_minutes, NULL::bigint AS total_tokens,
         0::int AS token_covered_runs, NULL::text AS token_question_id
  FROM ${appTable('messages')} m
  JOIN ${appTable('conversations')} c ON c.id = m.conversation_id
  WHERE m.role = 'user' AND m.created_at >= $3::timestamptz AND m.created_at < $4::timestamptz
  UNION ALL
  SELECT lower(r.user_email), COALESCE(r.completed_at, r.created_at),
         0, CASE WHEN r.state = 'SUCCEEDED' THEN 1 ELSE 0 END, 1, 0,
         CASE
           WHEN COALESCE(m.response_json->'trace'->>'total_tokens', '') ~ '^[0-9]+$'
             THEN (m.response_json->'trace'->>'total_tokens')::bigint
           WHEN COALESCE(m.response_json->'trace'->>'prompt_tokens', '') ~ '^[0-9]+$'
            AND COALESCE(m.response_json->'trace'->>'completion_tokens', '') ~ '^[0-9]+$'
             THEN (m.response_json->'trace'->>'prompt_tokens')::bigint
                + (m.response_json->'trace'->>'completion_tokens')::bigint
           ELSE NULL
         END,
         CASE WHEN COALESCE(m.response_json->'trace'->>'total_tokens', '') ~ '^[0-9]+$'
                    OR (COALESCE(m.response_json->'trace'->>'prompt_tokens', '') ~ '^[0-9]+$'
                    AND COALESCE(m.response_json->'trace'->>'completion_tokens', '') ~ '^[0-9]+$')
              THEN 1 ELSE 0 END,
         CASE WHEN COALESCE(m.response_json->'trace'->>'total_tokens', '') ~ '^[0-9]+$'
                    OR (COALESCE(m.response_json->'trace'->>'prompt_tokens', '') ~ '^[0-9]+$'
                    AND COALESCE(m.response_json->'trace'->>'completion_tokens', '') ~ '^[0-9]+$')
              THEN r.turn_id ELSE NULL END
  FROM ${appTable('runs')} r
  LEFT JOIN ${appTable('messages')} m ON m.id = r.terminal_message_id
  WHERE COALESCE(r.completed_at, r.created_at) >= $3::timestamptz
    AND COALESCE(r.completed_at, r.created_at) < $4::timestamptz
  UNION ALL
  SELECT lower(a.user_email), a.active_minute, 0, 0, 0, 1, NULL::bigint, 0::int, NULL::text
  FROM ${appTable('app_activity_minutes')} a
  WHERE a.active_minute >= $3::timestamptz AND a.active_minute < $4::timestamptz
),
hourly AS (
  SELECT user_key, date_trunc('hour', occurred_at) AS activity_hour,
         SUM(questions)::int AS submitted_questions,
         SUM(completed)::int AS completed_questions,
         SUM(runs)::int AS run_count,
         SUM(active_minutes)::int AS active_minutes,
         CASE WHEN COUNT(total_tokens) > 0 THEN SUM(total_tokens)::bigint ELSE NULL END AS total_tokens,
         SUM(token_covered_runs)::int AS token_covered_runs,
         COUNT(DISTINCT token_question_id)::int AS token_covered_questions,
         MAX(occurred_at) AS source_through
  FROM evidence
  WHERE user_key <> ''
  GROUP BY user_key, date_trunc('hour', occurred_at)
)
SELECT hourly.*, basis.display_email, basis.activity_date AS billing_basis_day,
       basis.submitted_questions AS basis_questions,
       basis.completed_questions AS basis_completed,
       basis.active_minutes AS basis_active_minutes,
       basis.spend_usd AS basis_spend_usd, basis.spend_dbu AS basis_spend_dbu,
       basis.components AS basis_components
FROM hourly
LEFT JOIN LATERAL (
  SELECT daily.display_email, daily.activity_date, daily.submitted_questions,
         daily.completed_questions, daily.active_minutes, daily.spend_usd,
         daily.spend_dbu, daily.components
  FROM ${USER_SPEND_DAILY_TABLE} daily
  WHERE daily.app_scope = $1 AND daily.calculation_version = $2
    AND daily.user_key = hourly.user_key
    AND daily.activity_date <= (hourly.activity_hour AT TIME ZONE 'UTC')::date
  ORDER BY daily.activity_date DESC
  LIMIT 1
) basis ON TRUE
ORDER BY hourly.activity_hour, hourly.user_key`;

export const UPSERT_USER_SPEND_HOUR_QUERY = `INSERT INTO ${USER_SPEND_HOURLY_TABLE} (
  app_scope, user_key, display_email, activity_hour, calculation_version,
  submitted_questions, completed_questions, run_count, active_minutes, total_tokens,
  token_covered_runs, token_covered_questions,
  spend_usd, spend_dbu, app_spend_usd, app_spend_dbu,
  spend_usd_quality, spend_dbu_quality, components, billing_basis_day,
  source_through, computed_at, updated_at
) VALUES (
  $1, lower($2), $3, $4::timestamptz, $5,
  $6, $7, $8, $9, $10, $11, $12, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
  $17, $18, $19::jsonb, $20::date, $21::timestamptz, $22::timestamptz, NOW()
)
ON CONFLICT (app_scope, user_key, activity_hour, calculation_version) DO UPDATE SET
  display_email = EXCLUDED.display_email,
  submitted_questions = EXCLUDED.submitted_questions,
  completed_questions = EXCLUDED.completed_questions,
  run_count = EXCLUDED.run_count,
  active_minutes = EXCLUDED.active_minutes,
  total_tokens = EXCLUDED.total_tokens,
  token_covered_runs = EXCLUDED.token_covered_runs,
  token_covered_questions = EXCLUDED.token_covered_questions,
  spend_usd = COALESCE(EXCLUDED.spend_usd, ${USER_SPEND_HOURLY_TABLE}.spend_usd),
  spend_dbu = COALESCE(EXCLUDED.spend_dbu, ${USER_SPEND_HOURLY_TABLE}.spend_dbu),
  app_spend_usd = COALESCE(EXCLUDED.app_spend_usd, ${USER_SPEND_HOURLY_TABLE}.app_spend_usd),
  app_spend_dbu = COALESCE(EXCLUDED.app_spend_dbu, ${USER_SPEND_HOURLY_TABLE}.app_spend_dbu),
  spend_usd_quality = CASE WHEN EXCLUDED.spend_usd IS NULL
    THEN ${USER_SPEND_HOURLY_TABLE}.spend_usd_quality ELSE EXCLUDED.spend_usd_quality END,
  spend_dbu_quality = CASE WHEN EXCLUDED.spend_dbu IS NULL
    THEN ${USER_SPEND_HOURLY_TABLE}.spend_dbu_quality ELSE EXCLUDED.spend_dbu_quality END,
  components = ${USER_SPEND_HOURLY_TABLE}.components || EXCLUDED.components,
  billing_basis_day = EXCLUDED.billing_basis_day,
  source_through = EXCLUDED.source_through,
  computed_at = EXCLUDED.computed_at,
  updated_at = NOW()`;

export interface RollingHourWindow {
  from: string;
  to: string;
}

export function rollingCompleteHours(
  from: string | undefined,
  to: string | undefined,
  now = Date.now()
): RollingHourWindow {
  const requestedTo = Date.parse(to ?? '');
  const end = Math.floor(Math.min(Number.isFinite(requestedTo) ? requestedTo : now, now) / HOUR_MS) * HOUR_MS;
  const requestedFrom = Date.parse(from ?? '');
  const startCandidate = Number.isFinite(requestedFrom) ? Math.floor(requestedFrom / HOUR_MS) * HOUR_MS : end - DAY_MS;
  const start = Math.max(end - DAY_MS, Math.min(startCandidate, end - HOUR_MS));
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stamp(value: unknown): string | null {
  const raw = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : '';
  return Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

function day(value: unknown): string | null {
  const valueStamp = stamp(value);
  if (valueStamp) return valueStamp.slice(0, 10);
  const raw = typeof value === 'string' ? value.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function decimal(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : value.toFixed(12);
}

function safeErrorClass(error: unknown): string {
  const named = error instanceof Error ? error.name : 'Error';
  return named.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 't' || value === 1;
}

function scaledComponents(value: unknown, weight: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([id, raw]) => {
      const component = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const usd = nullableNumber(component.usd);
      const dbu = nullableNumber(component.dbu);
      return [
        id,
        {
          ...component,
          usd: decimal(usd === null ? null : usd * weight),
          dbu: decimal(dbu === null ? null : dbu * weight),
          usdQuality: usd === null ? 'unavailable' : 'partial',
          dbuQuality: dbu === null ? 'unavailable' : 'partial',
          reason: 'Estimated from exact hourly activity and the finest complete daily billing basis.',
        },
      ];
    })
  );
}

interface MaterializedHour {
  userKey: string;
  displayEmail: string;
  activityHour: string;
  questions: number;
  completed: number;
  runs: number;
  activeMinutes: number;
  totalTokens: number | null;
  tokenCoveredRuns: number | null;
  tokenCoveredQuestions: number | null;
  spendUsd: number | null;
  spendDbu: number | null;
  appSpendUsd: number | null;
  appSpendDbu: number | null;
  usdQuality: 'partial' | 'unavailable';
  dbuQuality: 'partial' | 'unavailable';
  components: Record<string, unknown>;
  basisDay: string | null;
  sourceThrough: string;
}

export function materializeUserSpendHours(rows: readonly Record<string, unknown>[]): MaterializedHour[] {
  const result = rows.flatMap((row): MaterializedHour[] => {
    const activityHour = stamp(row.activity_hour);
    const sourceThrough = stamp(row.source_through);
    const userKey = typeof row.user_key === 'string' ? row.user_key.trim().toLowerCase() : '';
    if (!activityHour || !sourceThrough || !userKey) return [];
    const questions = number(row.submitted_questions);
    const completed = number(row.completed_questions);
    const runs = number(row.run_count);
    const activeMinutes = number(row.active_minutes);
    const hourlyEvidence = Math.max(1, questions + completed + activeMinutes);
    const dailyEvidence = Math.max(
      1,
      number(row.basis_questions) + number(row.basis_completed) + number(row.basis_active_minutes)
    );
    const basisDay = day(row.billing_basis_day);
    const sameDay = basisDay === activityHour.slice(0, 10);
    const weight = sameDay ? Math.min(1, hourlyEvidence / dailyEvidence) : hourlyEvidence / dailyEvidence;
    const basisUsd = nullableNumber(row.basis_spend_usd);
    const basisDbu = nullableNumber(row.basis_spend_dbu);
    return [
      {
        userKey,
        displayEmail:
          typeof row.display_email === 'string' && row.display_email.trim()
            ? row.display_email.trim().toLowerCase()
            : userKey,
        activityHour,
        questions,
        completed,
        runs,
        activeMinutes,
        totalTokens: nullableNumber(row.total_tokens),
        tokenCoveredRuns: nullableNumber(row.token_covered_runs),
        tokenCoveredQuestions: nullableNumber(row.token_covered_questions),
        spendUsd: basisUsd === null ? null : basisUsd * weight,
        spendDbu: basisDbu === null ? null : basisDbu * weight,
        appSpendUsd: null,
        appSpendDbu: null,
        usdQuality: basisUsd === null ? 'unavailable' : 'partial',
        dbuQuality: basisDbu === null ? 'unavailable' : 'partial',
        components: scaledComponents(row.basis_components, weight),
        basisDay,
        sourceThrough,
      },
    ];
  });
  const totals = new Map<string, { usd: number; dbu: number; usdKnown: boolean; dbuKnown: boolean }>();
  for (const row of result) {
    const current = totals.get(row.activityHour) ?? { usd: 0, dbu: 0, usdKnown: false, dbuKnown: false };
    if (row.spendUsd !== null) {
      current.usd += row.spendUsd;
      current.usdKnown = true;
    }
    if (row.spendDbu !== null) {
      current.dbu += row.spendDbu;
      current.dbuKnown = true;
    }
    totals.set(row.activityHour, current);
  }
  for (const row of result) {
    const total = totals.get(row.activityHour);
    row.appSpendUsd = total?.usdKnown ? total.usd : null;
    row.appSpendDbu = total?.dbuKnown ? total.dbu : null;
  }
  return result;
}

let activeRefresh: Promise<void> | null = null;

export function runUserSpendHourlyRefresh(
  store: UserSpendReadModelStore,
  options: {
    appScope?: string;
    calculationVersion?: number;
    from?: string;
    to?: string;
    now?: number;
    retentionDays?: number;
  } = {}
): Promise<void> {
  if (activeRefresh) return activeRefresh;
  const run = (async () => {
    const now = options.now ?? Date.now();
    const appScope = (options.appScope ?? process.env.DATABRICKS_APP_NAME ?? '').trim() || 'player-insights';
    const version = options.calculationVersion ?? USER_SPEND_CALCULATION_VERSION;
    const to = rollingCompleteHours(undefined, options.to, now).to;
    const defaultFrom = new Date(Date.parse(to) - USER_SPEND_HOURLY_OVERLAP_HOURS * HOUR_MS).toISOString();
    const requestedFrom = Date.parse(options.from ?? defaultFrom);
    const from = new Date(
      Math.min(
        Date.parse(to) - HOUR_MS,
        Math.floor((Number.isFinite(requestedFrom) ? requestedFrom : Date.parse(defaultFrom)) / HOUR_MS) * HOUR_MS
      )
    ).toISOString();
    const owner = `${process.pid}:${now}:${Math.random().toString(36).slice(2, 10)}`;
    const connection = await store.pool?.connect();
    if (!connection) throw new Error('Hourly user spend refresh requires a pinned Lakebase connection.');
    let locked = false;
    try {
      const lock = await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [
        `${appScope}:user-spend-hourly:${version}`,
      ]);
      locked = bool(lock.rows[0]?.acquired);
      if (!locked) return;
      await connection.query(
        `INSERT INTO ${USER_SPEND_HOURLY_REFRESH_TABLE} (app_scope, calculation_version, status)
         VALUES ($1, $2, 'idle') ON CONFLICT (app_scope, calculation_version) DO NOTHING`,
        [appScope, version]
      );
      const lease = await connection.query(
        `UPDATE ${USER_SPEND_HOURLY_REFRESH_TABLE}
         SET status = 'refreshing', lease_owner = $3,
             lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
             started_at = NOW(), error_class = NULL, error_at = NULL
         WHERE app_scope = $1 AND calculation_version = $2
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW() OR lease_owner = $3)
         RETURNING watermark_hour`,
        [appScope, version, owner, USER_SPEND_HOURLY_LEASE_MS]
      );
      if (lease.rows.length === 0) return;
      const source = await connection.query(READ_USER_SPEND_HOURLY_SOURCE_QUERY, [appScope, version, from, to]);
      const rows = materializeUserSpendHours(source.rows);
      await connection.query('BEGIN');
      try {
        if (rows.every((row) => row.spendUsd !== null && row.spendDbu !== null)) {
          await connection.query(
            `DELETE FROM ${USER_SPEND_HOURLY_TABLE}
             WHERE app_scope = $1 AND calculation_version = $2
               AND activity_hour >= $3::timestamptz AND activity_hour < $4::timestamptz`,
            [appScope, version, from, to]
          );
        }
        for (const row of rows) {
          await connection.query(UPSERT_USER_SPEND_HOUR_QUERY, [
            appScope,
            row.userKey,
            row.displayEmail,
            row.activityHour,
            version,
            row.questions,
            row.completed,
            row.runs,
            row.activeMinutes,
            row.totalTokens,
            row.tokenCoveredRuns,
            row.tokenCoveredQuestions,
            decimal(row.spendUsd),
            decimal(row.spendDbu),
            decimal(row.appSpendUsd),
            decimal(row.appSpendDbu),
            row.usdQuality,
            row.dbuQuality,
            JSON.stringify(row.components),
            row.basisDay,
            row.sourceThrough,
            new Date(now).toISOString(),
          ]);
        }
        const sourceTimes = rows.map((row) => row.sourceThrough).sort();
        const basisDays = rows.flatMap((row) => (row.basisDay ? [row.basisDay] : [])).sort();
        const sourceThrough = sourceTimes[sourceTimes.length - 1] ?? null;
        const basisThrough = basisDays[basisDays.length - 1] ?? null;
        await connection.query(
          `UPDATE ${USER_SPEND_HOURLY_REFRESH_TABLE}
           SET status = 'ready', watermark_hour = $4::timestamptz,
               source_through = $5::timestamptz, billing_basis_through = $6::date,
               completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL,
               rows_upserted = rows_upserted + $7
           WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,
          [appScope, version, owner, to, sourceThrough, basisThrough, rows.length]
        );
        const retentionDays = Math.max(
          2,
          Math.min(31, Math.trunc(options.retentionDays ?? USER_SPEND_HOURLY_RETENTION_DAYS))
        );
        await connection.query(
          `DELETE FROM ${USER_SPEND_HOURLY_TABLE}
           WHERE app_scope = $1 AND calculation_version = $2
             AND activity_hour < $3::timestamptz`,
          [appScope, version, new Date(Date.parse(to) - retentionDays * DAY_MS).toISOString()]
        );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await connection
        .query(
          `UPDATE ${USER_SPEND_HOURLY_REFRESH_TABLE}
           SET status = 'failed', error_class = $4, error_at = NOW(),
               lease_owner = NULL, lease_expires_at = NULL
           WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,
          [appScope, version, owner, safeErrorClass(error)]
        )
        .catch(() => undefined);
      throw error;
    } finally {
      if (locked) {
        await connection
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`${appScope}:user-spend-hourly:${version}`])
          .catch(() => undefined);
      }
      connection.release();
    }
  })();
  activeRefresh = run.finally(() => {
    activeRefresh = null;
  });
  return activeRefresh;
}

export const READ_USER_SPEND_HOURLY_SUMMARY_QUERY = `WITH base AS (
  SELECT * FROM ${USER_SPEND_HOURLY_TABLE}
  WHERE app_scope = $1 AND calculation_version = $2
    AND activity_hour >= $3::timestamptz AND activity_hour < $4::timestamptz
),
aggregated AS (
  SELECT user_key, MIN(display_email) AS display_email,
         SUM(submitted_questions)::bigint AS submitted_questions,
         SUM(completed_questions)::bigint AS completed_questions,
         SUM(run_count)::bigint AS run_count,
         SUM(active_minutes)::bigint AS active_minutes,
         SUM(total_tokens)::numeric AS total_tokens,
         SUM(token_covered_runs)::bigint AS token_covered_runs,
         SUM(token_covered_questions)::bigint AS token_covered_questions,
         COUNT(DISTINCT activity_hour) FILTER (WHERE spend_usd IS NOT NULL)::int AS spend_usd_covered_hours,
         COUNT(DISTINCT activity_hour) FILTER (WHERE spend_dbu IS NOT NULL)::int AS spend_dbu_covered_hours,
         MAX(source_through) AS source_through, MAX(computed_at) AS computed_at,
         SUM(spend_usd) AS spend_usd, SUM(spend_dbu) AS spend_dbu,
         CASE WHEN COUNT(spend_usd) = 0 THEN 'unavailable' ELSE 'partial' END AS spend_usd_quality,
         CASE WHEN COUNT(spend_dbu) = 0 THEN 'unavailable' ELSE 'partial' END AS spend_dbu_quality
  FROM base GROUP BY user_key
),
hourly_app AS (
  SELECT activity_hour, MAX(app_spend_usd) AS app_spend_usd, MAX(app_spend_dbu) AS app_spend_dbu
  FROM base GROUP BY activity_hour
),
app_totals AS (
  SELECT SUM(app_spend_usd) AS app_spend_usd, SUM(app_spend_dbu) AS app_spend_dbu FROM hourly_app
),
identity_population AS (
  SELECT roster.user_key, roster.display_email, roster.app_role, roster.identity_updated_at
  FROM (
    SELECT DISTINCT ON (lower(email))
           lower(email) AS user_key, lower(email) AS display_email,
           CASE WHEN role IN ('super_admin', 'admin', 'consumer') THEN role ELSE 'admin' END AS app_role,
           added_at AS identity_updated_at
    FROM ${appTable('admin_emails')}
    ORDER BY lower(email), added_at DESC
  ) roster
  WHERE $13::boolean
    AND ($5::boolean OR roster.user_key = lower($6))
  UNION ALL
  SELECT aggregated.user_key, aggregated.display_email, 'consumer', NULL::timestamptz
  FROM aggregated
  WHERE NOT $13::boolean AND aggregated.user_key = lower($6)
),
identity_revision AS (
  SELECT GREATEST(
    (SELECT MAX(added_at) FROM ${appTable('admin_emails')}),
    (SELECT MAX(updated_at) FROM ${appTable('sp_assignments')}),
    (SELECT MAX(updated_at) FROM ${appTable('sp_personas')}),
    (SELECT MAX(updated_at) FROM ${appTable('sp_persona_definitions')})
  ) AS revision
),
filtered AS (
  SELECT identity_population.user_key, identity_population.display_email,
         COALESCE(aggregated.submitted_questions, 0) AS submitted_questions,
         COALESCE(aggregated.completed_questions, 0) AS completed_questions,
         COALESCE(aggregated.run_count, 0) AS run_count,
         COALESCE(aggregated.active_minutes, 0) AS active_minutes,
         aggregated.total_tokens, aggregated.token_covered_runs, aggregated.token_covered_questions,
         COALESCE(aggregated.spend_usd_covered_hours, 0) AS spend_usd_covered_hours,
         COALESCE(aggregated.spend_dbu_covered_hours, 0) AS spend_dbu_covered_hours,
         aggregated.source_through, aggregated.computed_at,
         aggregated.spend_usd, aggregated.spend_dbu,
         COALESCE(aggregated.spend_usd_quality, 'unavailable') AS spend_usd_quality,
         COALESCE(aggregated.spend_dbu_quality, 'unavailable') AS spend_dbu_quality,
         app_totals.*, identity_population.app_role,
         assignment.persona_id, COALESCE(definition.display_name, persona.display_name) AS persona_name,
         identity_revision.revision AS identity_updated_at,
         COUNT(*) OVER ()::int AS total_users
  FROM identity_population
  LEFT JOIN aggregated ON aggregated.user_key = identity_population.user_key
  CROSS JOIN app_totals
  CROSS JOIN identity_revision
  LEFT JOIN ${appTable('sp_assignments')} assignment ON lower(assignment.email) = identity_population.user_key
  LEFT JOIN ${appTable('sp_personas')} persona ON persona.id = assignment.persona_id
  LEFT JOIN ${appTable('sp_persona_definitions')} definition ON definition.id = assignment.persona_id
  WHERE ($7 = '' OR identity_population.display_email LIKE ('%' || lower($7) || '%'))
    AND ($8 = '' OR identity_population.app_role = $8)
    AND ($9 = '' OR assignment.persona_id = $9)
)
SELECT filtered.*, refresh.status AS refresh_status,
       refresh.source_through AS refresh_source_through,
       refresh.billing_basis_through, refresh.completed_at AS refresh_completed_at
FROM filtered
LEFT JOIN ${USER_SPEND_HOURLY_REFRESH_TABLE} refresh
  ON refresh.app_scope = $1 AND refresh.calculation_version = $2
ORDER BY CASE WHEN $10 = 'DBU' THEN spend_dbu ELSE spend_usd END DESC NULLS LAST, user_key ASC
LIMIT $11 OFFSET $12`;

export const READ_USER_SPEND_HOURLY_COMPONENTS_QUERY = `SELECT component.key AS component_id,
       MIN(component.value->>'label') AS label,
       SUM((component.value->>'usd')::numeric) FILTER (WHERE component.value->>'usd' IS NOT NULL) AS spend_usd,
       SUM((component.value->>'dbu')::numeric) FILTER (WHERE component.value->>'dbu' IS NOT NULL) AS spend_dbu,
       CASE WHEN COUNT(*) FILTER (WHERE component.value->>'usd' IS NOT NULL) = 0 THEN 'unavailable' ELSE 'partial' END
         AS spend_usd_quality,
       CASE WHEN COUNT(*) FILTER (WHERE component.value->>'dbu' IS NOT NULL) = 0 THEN 'unavailable' ELSE 'partial' END
         AS spend_dbu_quality,
       'Estimated from exact hourly activity and the finest complete daily billing basis.' AS reason
FROM ${USER_SPEND_HOURLY_TABLE} hourly
CROSS JOIN LATERAL jsonb_each(hourly.components) component
WHERE hourly.app_scope = $1 AND hourly.calculation_version = $2
  AND hourly.user_key = lower($3)
  AND hourly.activity_hour >= $4::timestamptz AND hourly.activity_hour < $5::timestamptz
GROUP BY component.key ORDER BY component.key`;

function quality(value: unknown): UserSpendQuality {
  return value === 'partial' || value === 'allocated' ? value : 'unavailable';
}

export async function readUserSpendHourlyPage(
  store: UserSpendReadModelStore,
  input: {
    appScope?: string;
    calculationVersion?: number;
    window: RollingHourWindow;
    principal: string;
    allowBrowse: boolean;
    search?: string;
    role?: string;
    persona?: string;
    unit: CostBudgetUnit;
    limit?: number;
    offset?: number;
    staleMs?: number;
    now?: number;
    rosterOnly?: boolean;
  }
): Promise<UserSpendReadModelPage> {
  const appScope = (input.appScope ?? process.env.DATABRICKS_APP_NAME ?? '').trim() || 'player-insights';
  const version = input.calculationVersion ?? USER_SPEND_CALCULATION_VERSION;
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const result = await store.query(READ_USER_SPEND_HOURLY_SUMMARY_QUERY, [
    appScope,
    version,
    input.window.from,
    input.window.to,
    input.allowBrowse,
    input.principal.trim().toLowerCase(),
    (input.search ?? '').trim().slice(0, 120),
    (input.role ?? '').trim(),
    (input.persona ?? '').trim(),
    input.unit,
    limit,
    offset,
    input.rosterOnly ?? input.allowBrowse,
  ]);
  const first = result.rows[0];
  const metadata =
    first ??
    (
      await store.query(
        `SELECT status AS refresh_status, source_through AS refresh_source_through,
                billing_basis_through, completed_at AS refresh_completed_at,
                GREATEST(
                  (SELECT MAX(added_at) FROM ${appTable('admin_emails')}),
                  (SELECT MAX(updated_at) FROM ${appTable('sp_assignments')}),
                  (SELECT MAX(updated_at) FROM ${appTable('sp_personas')}),
                  (SELECT MAX(updated_at) FROM ${appTable('sp_persona_definitions')})
                ) AS identity_updated_at
         FROM ${USER_SPEND_HOURLY_REFRESH_TABLE}
         WHERE app_scope = $1 AND calculation_version = $2`,
        [appScope, version]
      )
    ).rows[0];
  const computedAt = stamp(metadata?.refresh_completed_at) ?? stamp(metadata?.computed_at);
  const sourceThrough = stamp(metadata?.refresh_source_through) ?? stamp(metadata?.source_through);
  const billingCompleteThrough = day(metadata?.billing_basis_through);
  const now = input.now ?? Date.now();
  const rows: UserSpendSummaryRow[] = result.rows.map((row) => ({
    email: typeof row.display_email === 'string' ? row.display_email : '',
    questions: number(row.submitted_questions),
    completedQuestions: number(row.completed_questions),
    runs: number(row.run_count),
    activeMinutes: number(row.active_minutes),
    totalTokens: nullableNumber(row.total_tokens),
    tokenCoveredRuns: nullableNumber(row.token_covered_runs),
    tokenCoveredQuestions: nullableNumber(row.token_covered_questions),
    coveredDays: Math.max(
      Math.ceil(number(row.spend_usd_covered_hours) / 24),
      Math.ceil(number(row.spend_dbu_covered_hours) / 24)
    ),
    spendUsdCoveredDays: Math.ceil(number(row.spend_usd_covered_hours) / 24),
    spendDbuCoveredDays: Math.ceil(number(row.spend_dbu_covered_hours) / 24),
    spendUsd: nullableNumber(row.spend_usd),
    spendDbu: nullableNumber(row.spend_dbu),
    spendUsdQuality: quality(row.spend_usd_quality),
    spendDbuQuality: quality(row.spend_dbu_quality),
    appSpendUsd: nullableNumber(row.app_spend_usd),
    appSpendDbu: nullableNumber(row.app_spend_dbu),
    activityComplete: true,
    billingComplete: false,
    role:
      row.app_role === 'super_admin' || row.app_role === 'admin' || row.app_role === 'consumer'
        ? row.app_role
        : 'consumer',
    persona:
      typeof row.persona_id === 'string' && row.persona_id && typeof row.persona_name === 'string'
        ? { id: row.persona_id, name: row.persona_name }
        : null,
    sourceThrough: stamp(row.source_through),
    computedAt: stamp(row.computed_at),
    identityRevision: stamp(row.identity_updated_at),
  }));
  return {
    available: Boolean(first || computedAt),
    rows,
    total: number(first?.total_users),
    identityRevision: stamp(first?.identity_updated_at) ?? stamp(metadata?.identity_updated_at) ?? '',
    freshness: {
      computedAt,
      sourceThrough,
      billingCompleteThrough,
      isRefreshing: metadata?.refresh_status === 'refreshing',
      isStale:
        computedAt === null || now - Date.parse(computedAt) > Math.max(60_000, input.staleMs ?? USER_SPEND_STALE_MS),
      calculationVersion: version,
    },
  };
}

export async function readUserSpendHourlyComponents(
  store: UserSpendReadModelStore,
  input: {
    appScope?: string;
    calculationVersion?: number;
    email: string;
    window: RollingHourWindow;
  }
): Promise<UserSpendReadModelComponent[]> {
  const appScope = (input.appScope ?? process.env.DATABRICKS_APP_NAME ?? '').trim() || 'player-insights';
  const version = input.calculationVersion ?? USER_SPEND_CALCULATION_VERSION;
  const result = await store.query(READ_USER_SPEND_HOURLY_COMPONENTS_QUERY, [
    appScope,
    version,
    input.email.trim().toLowerCase(),
    input.window.from,
    input.window.to,
  ]);
  return result.rows.map((row) => ({
    id: typeof row.component_id === 'string' ? row.component_id : '',
    label: typeof row.label === 'string' ? row.label : typeof row.component_id === 'string' ? row.component_id : '',
    usd: { amount: nullableNumber(row.spend_usd), quality: quality(row.spend_usd_quality) },
    dbu: { amount: nullableNumber(row.spend_dbu), quality: quality(row.spend_dbu_quality) },
    reason: typeof row.reason === 'string' ? row.reason : '',
  }));
}

let stopActiveScheduler: (() => void) | null = null;

export function startUserSpendHourlyScheduler(
  store: UserSpendReadModelStore,
  options: { intervalMs?: number; jitterMs?: number } = {}
): () => void {
  stopActiveScheduler?.();
  let stopped = false;
  const run = () => {
    if (stopped) return;
    void runUserSpendHourlyRefresh(store).catch((error: Error) => {
      console.warn(`[user-spend-hourly] refresh failed (${safeErrorClass(error)}); last successful rows remain.`);
    });
  };
  const warm = setTimeout(run, Math.floor(Math.random() * (Math.max(0, options.jitterMs ?? 30_000) + 1)));
  warm.unref?.();
  const timer = setInterval(run, Math.max(60_000, options.intervalMs ?? USER_SPEND_HOURLY_REFRESH_INTERVAL_MS));
  timer.unref?.();
  const stop = () => {
    stopped = true;
    clearTimeout(warm);
    clearInterval(timer);
    process.off('beforeExit', stop);
    if (stopActiveScheduler === stop) stopActiveScheduler = null;
  };
  process.once('beforeExit', stop);
  stopActiveScheduler = stop;
  return stop;
}

export function stopUserSpendHourlyScheduler(): void {
  stopActiveScheduler?.();
}
