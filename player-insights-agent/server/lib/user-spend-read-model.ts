import { appTable } from '../../shared/app-schema';
import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { OpsDayRange } from '../../shared/ops-contract';
import type { UserSpendQuality } from '../../shared/user-spend-contract';

const DAY_MS = 86_400_000;
const ADMIN_EMAILS_TABLE = appTable('admin_emails');
const SP_ASSIGNMENTS_TABLE = appTable('sp_assignments');
const SP_PERSONAS_TABLE = appTable('sp_personas');
const SP_PERSONA_DEFINITIONS_TABLE = appTable('sp_persona_definitions');

export const USER_SPEND_CALCULATION_VERSION = 1;
export const USER_SPEND_OVERLAP_DAYS = 7;
export const USER_SPEND_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
export const USER_SPEND_STALE_MS = 2 * 60 * 60 * 1_000;
export const USER_SPEND_REFRESH_BATCH_DAYS = 31;
export const USER_SPEND_LEASE_MS = 10 * 60 * 1_000;

export const USER_SPEND_DAILY_TABLE = appTable('user_spend_daily');
export const USER_SPEND_REFRESH_TABLE = appTable('user_spend_refresh_state');

/**
 * Long-lived, content-free serving rows. NUMERIC(30,12) retains tiny costs
 * without persisting JavaScript binary floats. The app scope and normalized
 * authenticated identity form the durable identity; no prompt, answer, SQL, or
 * trace payload is copied into this model.
 */
export const USER_SPEND_READ_MODEL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${USER_SPEND_DAILY_TABLE} (
     app_scope TEXT NOT NULL,
     user_key TEXT NOT NULL,
     display_email TEXT NOT NULL,
     activity_date DATE NOT NULL,
     calculation_version INTEGER NOT NULL,
     submitted_questions INTEGER NOT NULL DEFAULT 0 CHECK (submitted_questions >= 0),
     completed_questions INTEGER NOT NULL DEFAULT 0 CHECK (completed_questions >= 0),
     run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
     active_minutes INTEGER NOT NULL DEFAULT 0 CHECK (active_minutes >= 0),
     prompt_tokens BIGINT,
     completion_tokens BIGINT,
     total_tokens BIGINT,
     token_covered_runs INTEGER,
     token_covered_questions INTEGER,
     spend_usd NUMERIC(30,12),
     spend_dbu NUMERIC(30,12),
     app_spend_usd NUMERIC(30,12),
     app_spend_dbu NUMERIC(30,12),
     spend_usd_quality TEXT NOT NULL DEFAULT 'unavailable'
       CHECK (spend_usd_quality IN ('direct', 'joined', 'allocated', 'unattributed', 'unavailable', 'partial')),
     spend_dbu_quality TEXT NOT NULL DEFAULT 'unavailable'
       CHECK (spend_dbu_quality IN ('direct', 'joined', 'allocated', 'unattributed', 'unavailable', 'partial')),
     components JSONB NOT NULL DEFAULT '{}'::jsonb,
     activity_complete BOOLEAN NOT NULL DEFAULT FALSE,
     billing_complete BOOLEAN NOT NULL DEFAULT FALSE,
     source_through TIMESTAMPTZ,
     computed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (app_scope, user_key, activity_date, calculation_version),
     CHECK (lower(user_key) = user_key),
     CHECK (jsonb_typeof(components) = 'object')
   )`,
  `CREATE INDEX IF NOT EXISTS user_spend_daily_date_scope_idx
     ON ${USER_SPEND_DAILY_TABLE} (activity_date, app_scope, calculation_version)`,
  `CREATE TABLE IF NOT EXISTS ${USER_SPEND_REFRESH_TABLE} (
     app_scope TEXT NOT NULL,
     calculation_version INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('idle', 'refreshing', 'ready', 'failed')),
     watermark_day DATE,
     overlap_from_day DATE,
     source_through TIMESTAMPTZ,
     billing_complete_through DATE,
     lease_owner TEXT,
     lease_expires_at TIMESTAMPTZ,
     started_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     error_class TEXT,
     error_at TIMESTAMPTZ,
     rows_upserted BIGINT NOT NULL DEFAULT 0,
     users_upserted BIGINT NOT NULL DEFAULT 0,
     days_upserted BIGINT NOT NULL DEFAULT 0,
     PRIMARY KEY (app_scope, calculation_version)
   )`,
];

export interface UserSpendDailyRow {
  appScope: string;
  userKey: string;
  displayEmail: string;
  activityDate: string;
  calculationVersion: number;
  submittedQuestions: number;
  completedQuestions: number;
  runCount: number;
  activeMinutes: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  tokenCoveredRuns?: number | null;
  tokenCoveredQuestions?: number | null;
  spendUsd: string | number | null;
  spendDbu: string | number | null;
  appSpendUsd: string | number | null;
  appSpendDbu: string | number | null;
  spendUsdQuality: UserSpendQuality;
  spendDbuQuality: UserSpendQuality;
  /**
   * Keyed by stable component id. Values use decimal strings:
   * `{label, usd, dbu, usdQuality, dbuQuality, reason}`. A measured free Genie
   * row stores USD "0" while keeping charged/promotional DBUs separate.
   */
  components: Record<string, unknown>;
  activityComplete: boolean;
  billingComplete: boolean;
  sourceThrough: string | null;
  computedAt: string;
}

export interface UserSpendRefreshBatch {
  rows: UserSpendDailyRow[];
  sourceThrough: string | null;
  billingCompleteThrough: string | null;
}

export interface UserSpendRefreshSource {
  firstAvailableDay(signal: AbortSignal): Promise<string | null>;
  /**
   * One warehouse/system-billing read for the whole bounded day batch. A source
   * must return every affected user; calling once per user is forbidden.
   */
  loadRange(range: OpsDayRange, signal: AbortSignal): Promise<UserSpendRefreshBatch>;
}

interface ReadModelConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface UserSpendReadModelStore {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  pool?: { connect(): Promise<ReadModelConnection> };
}

export interface UserSpendRefreshResult {
  acquired: boolean;
  refreshed: boolean;
  from: string | null;
  to: string | null;
  rows: number;
  users: number;
  days: number;
}

export interface UserSpendReadModelDiagnostics {
  refreshes: number;
  failures: number;
  lockContention: number;
  rowsUpserted: number;
  lastDurationMs: number | null;
}

const diagnostics = {
  refreshes: 0,
  failures: 0,
  lockContention: 0,
  rowsUpserted: 0,
  lastDurationMs: null as number | null,
};

export function userSpendReadModelDiagnostics(): UserSpendReadModelDiagnostics {
  return { ...diagnostics };
}

function day(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return '';
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
}

function addDays(value: string, amount: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + amount * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1);
}

function decimal(value: string | number | null): string | null {
  if (value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed.toFixed(12);
}

function safeErrorClass(error: unknown): string {
  const named = error instanceof Error ? error.name : 'Error';
  return named.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 't' || value === 1;
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function stamp(value: unknown): string | null {
  const raw = value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : '';
  return Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

async function transaction<T>(connection: ReadModelConnection, work: () => Promise<T>): Promise<T> {
  await connection.query('BEGIN');
  try {
    const result = await work();
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export const UPSERT_USER_SPEND_DAY_QUERY = `INSERT INTO ${USER_SPEND_DAILY_TABLE} (
  app_scope, user_key, display_email, activity_date, calculation_version,
  submitted_questions, completed_questions, run_count, active_minutes,
  prompt_tokens, completion_tokens, total_tokens, token_covered_runs, token_covered_questions, spend_usd, spend_dbu,
  app_spend_usd, app_spend_dbu,
  spend_usd_quality, spend_dbu_quality,
  components, activity_complete, billing_complete, source_through, computed_at, updated_at
) VALUES (
  $1, lower($2), $3, $4::date, $5,
  $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::numeric, $16::numeric,
  $17::numeric, $18::numeric, $19, $20, $21::jsonb, $22, $23, $24::timestamptz, $25::timestamptz, NOW()
)
ON CONFLICT (app_scope, user_key, activity_date, calculation_version) DO UPDATE SET
  display_email = EXCLUDED.display_email,
  submitted_questions = EXCLUDED.submitted_questions,
  completed_questions = EXCLUDED.completed_questions,
  run_count = EXCLUDED.run_count,
  active_minutes = EXCLUDED.active_minutes,
  prompt_tokens = EXCLUDED.prompt_tokens,
  completion_tokens = EXCLUDED.completion_tokens,
  total_tokens = EXCLUDED.total_tokens,
  token_covered_runs = EXCLUDED.token_covered_runs,
  token_covered_questions = EXCLUDED.token_covered_questions,
  spend_usd = EXCLUDED.spend_usd,
  spend_dbu = EXCLUDED.spend_dbu,
  app_spend_usd = EXCLUDED.app_spend_usd,
  app_spend_dbu = EXCLUDED.app_spend_dbu,
  spend_usd_quality = EXCLUDED.spend_usd_quality,
  spend_dbu_quality = EXCLUDED.spend_dbu_quality,
  components = EXCLUDED.components,
  activity_complete = EXCLUDED.activity_complete,
  billing_complete = EXCLUDED.billing_complete,
  source_through = EXCLUDED.source_through,
  computed_at = EXCLUDED.computed_at,
  updated_at = NOW()`;

const activeRefreshes = new WeakMap<object, Promise<UserSpendRefreshResult>>();

/**
 * Refresh a continuous range with one source call per bounded batch. Each
 * batch's replace and watermark commit together, so readers see either the old
 * complete batch or the new complete batch, never a half-refreshed window.
 */
export function runUserSpendReadModelRefresh(
  store: UserSpendReadModelStore,
  source: UserSpendRefreshSource,
  options: {
    appScope?: string;
    calculationVersion?: number;
    overlapDays?: number;
    batchDays?: number;
    leaseMs?: number;
    fromDay?: string;
    throughDay?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    now?: () => number;
  } = {}
): Promise<UserSpendRefreshResult> {
  const active = activeRefreshes.get(store);
  if (active) return active;
  const run = (async (): Promise<UserSpendRefreshResult> => {
    const started = options.now?.() ?? Date.now();
    const appScope = (options.appScope ?? process.env.DATABRICKS_APP_NAME ?? '').trim() || 'player-insights';
    const version = options.calculationVersion ?? USER_SPEND_CALCULATION_VERSION;
    const owner = `${process.pid}:${started}:${Math.random().toString(36).slice(2, 10)}`;
    const connection = await store.pool?.connect();
    if (!connection) {
      throw new Error('User spend refresh requires a pinned Lakebase connection for its lock and transactions.');
    }
    const controller = new AbortController();
    const parentAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) parentAbort();
    else options.signal?.addEventListener('abort', parentAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('User spend refresh deadline reached.')),
      Math.max(1_000, options.timeoutMs ?? 120_000)
    );
    timeout.unref?.();
    let locked = false;
    try {
      const lock = await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [
        `${appScope}:user-spend:${version}`,
      ]);
      locked = bool(lock.rows[0]?.acquired);
      if (!locked) {
        diagnostics.lockContention += 1;
        return { acquired: false, refreshed: false, from: null, to: null, rows: 0, users: 0, days: 0 };
      }
      await connection.query(
        `INSERT INTO ${USER_SPEND_REFRESH_TABLE} (app_scope, calculation_version, status)
         VALUES ($1, $2, 'idle')
         ON CONFLICT (app_scope, calculation_version) DO NOTHING`,
        [appScope, version]
      );
      const lease = await connection.query(
        `UPDATE ${USER_SPEND_REFRESH_TABLE}
         SET status = 'refreshing', lease_owner = $3,
             lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
             started_at = NOW(), error_class = NULL, error_at = NULL
         WHERE app_scope = $1 AND calculation_version = $2
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW() OR lease_owner = $3)
         RETURNING watermark_day`,
        [appScope, version, owner, Math.max(30_000, options.leaseMs ?? USER_SPEND_LEASE_MS)]
      );
      if (lease.rows.length === 0) {
        diagnostics.lockContention += 1;
        return { acquired: false, refreshed: false, from: null, to: null, rows: 0, users: 0, days: 0 };
      }
      const through = day(options.throughDay) || addDays(new Date(started).toISOString().slice(0, 10), -1);
      const watermark = day(lease.rows[0]?.watermark_day);
      const overlap = Math.max(1, Math.min(31, Math.trunc(options.overlapDays ?? USER_SPEND_OVERLAP_DAYS)));
      const requestedFrom = day(options.fromDay);
      const earliest =
        requestedFrom ||
        (watermark ? addDays(watermark, -(overlap - 1)) : day(await source.firstAvailableDay(controller.signal)));
      if (!earliest || earliest > through) {
        await connection.query(
          `UPDATE ${USER_SPEND_REFRESH_TABLE}
           SET status = 'ready', lease_owner = NULL, lease_expires_at = NULL,
               completed_at = NOW()
           WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,
          [appScope, version, owner]
        );
        return { acquired: true, refreshed: false, from: earliest || null, to: through, rows: 0, users: 0, days: 0 };
      }
      const batchDays = Math.max(1, Math.min(62, Math.trunc(options.batchDays ?? USER_SPEND_REFRESH_BATCH_DAYS)));
      let rows = 0;
      const users = new Set<string>();
      const refreshedDays = new Set<string>();
      let latestSourceThrough: string | null = null;
      let completeThrough: string | null = null;
      for (let from = earliest; from <= through; from = addDays(from, batchDays)) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const to = [addDays(from, batchDays - 1), through].sort()[0];
        const batch = await source.loadRange({ from, to }, controller.signal);
        const validRows = batch.rows.filter(
          (row) =>
            row.appScope === appScope &&
            row.calculationVersion === version &&
            row.userKey.trim() &&
            row.activityDate >= from &&
            row.activityDate <= to
        );
        await transaction(connection, async () => {
          await connection.query(
            `DELETE FROM ${USER_SPEND_DAILY_TABLE}
             WHERE app_scope = $1 AND calculation_version = $2
               AND activity_date BETWEEN $3::date AND $4::date`,
            [appScope, version, from, to]
          );
          for (const row of validRows) {
            const userKey = row.userKey.trim().toLowerCase();
            await connection.query(UPSERT_USER_SPEND_DAY_QUERY, [
              appScope,
              userKey,
              row.displayEmail.trim().toLowerCase(),
              row.activityDate,
              version,
              integer(row.submittedQuestions),
              integer(row.completedQuestions),
              integer(row.runCount),
              integer(row.activeMinutes),
              row.promptTokens,
              row.completionTokens,
              row.totalTokens,
              row.tokenCoveredRuns ?? null,
              row.tokenCoveredQuestions ?? null,
              decimal(row.spendUsd),
              decimal(row.spendDbu),
              decimal(row.appSpendUsd),
              decimal(row.appSpendDbu),
              row.spendUsdQuality,
              row.spendDbuQuality,
              JSON.stringify(row.components ?? {}),
              row.activityComplete,
              row.billingComplete,
              row.sourceThrough,
              row.computedAt,
            ]);
            users.add(userKey);
            refreshedDays.add(row.activityDate);
          }
          await connection.query(
            `UPDATE ${USER_SPEND_REFRESH_TABLE}
             SET watermark_day = $4::date, overlap_from_day = $5::date,
                 source_through = $6::timestamptz,
                 billing_complete_through = $7::date,
                 lease_expires_at = NOW() + ($8::bigint * INTERVAL '1 millisecond'),
                 rows_upserted = rows_upserted + $9,
                 users_upserted = users_upserted + $10,
                 days_upserted = days_upserted + $11
             WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,
            [
              appScope,
              version,
              owner,
              to,
              earliest,
              batch.sourceThrough,
              batch.billingCompleteThrough,
              Math.max(30_000, options.leaseMs ?? USER_SPEND_LEASE_MS),
              validRows.length,
              new Set(validRows.map((row) => row.userKey.toLowerCase())).size,
              daysBetween(from, to),
            ]
          );
        });
        rows += validRows.length;
        latestSourceThrough = batch.sourceThrough ?? latestSourceThrough;
        completeThrough = batch.billingCompleteThrough ?? completeThrough;
      }
      await connection.query(
        `UPDATE ${USER_SPEND_REFRESH_TABLE}
         SET status = 'ready', source_through = COALESCE($4::timestamptz, source_through),
             billing_complete_through = COALESCE($5::date, billing_complete_through),
             completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL
         WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,
        [appScope, version, owner, latestSourceThrough, completeThrough]
      );
      diagnostics.refreshes += 1;
      diagnostics.rowsUpserted += rows;
      diagnostics.lastDurationMs = (options.now?.() ?? Date.now()) - started;
      console.log(
        `[user-spend-read-model] refreshed ${rows} rows for ${users.size} users across ${refreshedDays.size} represented days in ${diagnostics.lastDurationMs}ms`
      );
      return {
        acquired: true,
        refreshed: true,
        from: earliest,
        to: through,
        rows,
        users: users.size,
        days: refreshedDays.size,
      };
    } catch (error) {
      diagnostics.failures += 1;
      diagnostics.lastDurationMs = (options.now?.() ?? Date.now()) - started;
      await connection
        .query(
          `UPDATE ${USER_SPEND_REFRESH_TABLE}
           SET status = 'failed', error_class = $4, error_at = NOW(),
               lease_owner = NULL, lease_expires_at = NULL
           WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,
          [appScope, version, owner, safeErrorClass(error)]
        )
        .catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', parentAbort);
      if (locked) {
        await connection
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`${appScope}:user-spend:${version}`])
          .catch(() => undefined);
      }
      connection.release();
    }
  })();
  const tracked = run.finally(() => activeRefreshes.delete(store));
  activeRefreshes.set(store, tracked);
  return tracked;
}

export const READ_USER_SPEND_SUMMARY_QUERY = `WITH base AS (
  SELECT *
  FROM ${USER_SPEND_DAILY_TABLE}
  WHERE app_scope = $1
    AND calculation_version = $2
    AND activity_date BETWEEN $3::date AND $4::date
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
         MAX(source_through) AS source_through,
         MAX(computed_at) AS computed_at,
         COUNT(*) FILTER (WHERE billing_complete)::int AS covered_days,
         BOOL_AND(activity_complete) AS activity_complete,
         BOOL_AND(billing_complete) AS billing_complete,
         CASE WHEN BOOL_AND(billing_complete) AND COUNT(spend_usd) = COUNT(*)
              THEN SUM(spend_usd) ELSE NULL END AS spend_usd,
         CASE WHEN BOOL_AND(billing_complete) AND COUNT(spend_dbu) = COUNT(*)
              THEN SUM(spend_dbu) ELSE NULL END AS spend_dbu,
         CASE
           WHEN NOT BOOL_AND(billing_complete) OR COUNT(spend_usd) <> COUNT(*) THEN 'unavailable'
           WHEN BOOL_OR(spend_usd_quality = 'partial') THEN 'partial'
           WHEN BOOL_OR(spend_usd_quality = 'allocated') THEN 'allocated'
           WHEN BOOL_OR(spend_usd_quality = 'joined') THEN 'joined'
           ELSE MIN(spend_usd_quality)
         END AS spend_usd_quality,
         CASE
           WHEN NOT BOOL_AND(billing_complete) OR COUNT(spend_dbu) <> COUNT(*) THEN 'unavailable'
           WHEN BOOL_OR(spend_dbu_quality = 'partial') THEN 'partial'
           WHEN BOOL_OR(spend_dbu_quality = 'allocated') THEN 'allocated'
           WHEN BOOL_OR(spend_dbu_quality = 'joined') THEN 'joined'
           ELSE MIN(spend_dbu_quality)
         END AS spend_dbu_quality
  FROM base
  GROUP BY user_key
),
daily_app AS (
  SELECT activity_date,
         MAX(app_spend_usd) AS app_spend_usd,
         MAX(app_spend_dbu) AS app_spend_dbu,
         BOOL_OR(billing_complete) AS billing_complete
  FROM base
  GROUP BY activity_date
),
app_totals AS (
  SELECT CASE WHEN BOOL_AND(billing_complete) AND COUNT(app_spend_usd) = COUNT(*)
              THEN SUM(app_spend_usd) ELSE NULL END AS app_spend_usd,
         CASE WHEN BOOL_AND(billing_complete) AND COUNT(app_spend_dbu) = COUNT(*)
              THEN SUM(app_spend_dbu) ELSE NULL END AS app_spend_dbu,
         COUNT(*) FILTER (WHERE billing_complete)::int AS app_covered_days
  FROM daily_app
),
identity_population AS (
  SELECT roster.user_key, roster.display_email, roster.app_role, roster.identity_updated_at
  FROM (
    SELECT DISTINCT ON (lower(email))
           lower(email) AS user_key,
           lower(email) AS display_email,
           CASE WHEN role IN ('super_admin', 'admin', 'consumer') THEN role ELSE 'admin' END AS app_role,
           added_at AS identity_updated_at
    FROM ${ADMIN_EMAILS_TABLE}
    ORDER BY lower(email), added_at DESC
  ) roster
  WHERE $5::boolean AND $13::boolean
  UNION ALL
  SELECT aggregated.user_key, aggregated.display_email, 'consumer', NULL::timestamptz
  FROM aggregated
  WHERE NOT $13::boolean AND aggregated.user_key = lower($6)
),
identity_revision AS (
  SELECT GREATEST(
    (SELECT MAX(added_at) FROM ${ADMIN_EMAILS_TABLE}),
    (SELECT MAX(updated_at) FROM ${SP_ASSIGNMENTS_TABLE}),
    (SELECT MAX(updated_at) FROM ${SP_PERSONAS_TABLE}),
    (SELECT MAX(updated_at) FROM ${SP_PERSONA_DEFINITIONS_TABLE})
  ) AS revision
),
filtered AS (
  SELECT identity_population.user_key, identity_population.display_email,
         COALESCE(aggregated.submitted_questions, 0) AS submitted_questions,
         COALESCE(aggregated.completed_questions, 0) AS completed_questions,
         COALESCE(aggregated.run_count, 0) AS run_count,
         COALESCE(aggregated.active_minutes, 0) AS active_minutes,
         aggregated.total_tokens, aggregated.token_covered_runs, aggregated.token_covered_questions,
         aggregated.source_through, aggregated.computed_at,
         COALESCE(aggregated.covered_days, 0) AS covered_days,
         COALESCE(aggregated.activity_complete, FALSE) AS activity_complete,
         COALESCE(aggregated.billing_complete, FALSE) AS billing_complete,
         aggregated.spend_usd, aggregated.spend_dbu,
         COALESCE(aggregated.spend_usd_quality, 'unavailable') AS spend_usd_quality,
         COALESCE(aggregated.spend_dbu_quality, 'unavailable') AS spend_dbu_quality,
         app_totals.*,
         identity_population.app_role,
         assignment.persona_id,
         COALESCE(definition.display_name, persona.display_name) AS persona_name,
         identity_revision.revision AS identity_updated_at,
         COUNT(*) OVER ()::int AS total_users
  FROM identity_population
  LEFT JOIN aggregated ON aggregated.user_key = identity_population.user_key
  CROSS JOIN app_totals
  CROSS JOIN identity_revision
  LEFT JOIN ${SP_ASSIGNMENTS_TABLE} assignment ON lower(assignment.email) = identity_population.user_key
  LEFT JOIN ${SP_PERSONAS_TABLE} persona ON persona.id = assignment.persona_id
  LEFT JOIN ${SP_PERSONA_DEFINITIONS_TABLE} definition ON definition.id = assignment.persona_id
  WHERE ($7 = '' OR identity_population.display_email LIKE ('%' || lower($7) || '%'))
    AND ($8 = '' OR identity_population.app_role = $8)
    AND ($9 = '' OR assignment.persona_id = $9)
)
SELECT filtered.*, refresh.status AS refresh_status,
       refresh.source_through AS refresh_source_through,
       refresh.billing_complete_through,
       refresh.completed_at AS refresh_completed_at
FROM filtered
LEFT JOIN ${USER_SPEND_REFRESH_TABLE} refresh
  ON refresh.app_scope = $1 AND refresh.calculation_version = $2
ORDER BY
  CASE WHEN $10 = 'DBU' THEN spend_dbu ELSE spend_usd END DESC NULLS LAST,
  user_key ASC
LIMIT $11 OFFSET $12`;

export interface UserSpendSummaryRow {
  email: string;
  questions: number;
  completedQuestions: number;
  runs: number;
  activeMinutes: number;
  totalTokens: number | null;
  tokenCoveredRuns: number | null;
  tokenCoveredQuestions: number | null;
  coveredDays: number;
  spendUsd: number | null;
  spendDbu: number | null;
  spendUsdQuality: UserSpendQuality;
  spendDbuQuality: UserSpendQuality;
  appSpendUsd: number | null;
  appSpendDbu: number | null;
  activityComplete: boolean;
  billingComplete: boolean;
  role: 'super_admin' | 'admin' | 'consumer';
  persona: { id: string; name: string } | null;
  sourceThrough: string | null;
  computedAt: string | null;
  identityRevision: string | null;
}

export interface UserSpendReadModelPage {
  available: boolean;
  rows: UserSpendSummaryRow[];
  total: number;
  identityRevision: string;
  freshness: {
    computedAt: string | null;
    sourceThrough: string | null;
    billingCompleteThrough: string | null;
    isRefreshing: boolean;
    isStale: boolean;
    calculationVersion: number;
  };
}

export const READ_USER_SPEND_COMPONENTS_QUERY = `SELECT component.key AS component_id,
       MIN(component.value->>'label') AS label,
       CASE WHEN BOOL_AND(component.value ? 'usd' AND component.value->>'usd' IS NOT NULL)
            THEN SUM((component.value->>'usd')::numeric) ELSE NULL END AS spend_usd,
       CASE WHEN BOOL_AND(component.value ? 'dbu' AND component.value->>'dbu' IS NOT NULL)
            THEN SUM((component.value->>'dbu')::numeric) ELSE NULL END AS spend_dbu,
       CASE WHEN BOOL_OR(component.value->>'usdQuality' = 'partial') THEN 'partial'
            WHEN BOOL_OR(component.value->>'usdQuality' = 'allocated') THEN 'allocated'
            WHEN BOOL_OR(component.value->>'usdQuality' = 'joined') THEN 'joined'
            ELSE MIN(component.value->>'usdQuality') END AS spend_usd_quality,
       CASE WHEN BOOL_OR(component.value->>'dbuQuality' = 'partial') THEN 'partial'
            WHEN BOOL_OR(component.value->>'dbuQuality' = 'allocated') THEN 'allocated'
            WHEN BOOL_OR(component.value->>'dbuQuality' = 'joined') THEN 'joined'
            ELSE MIN(component.value->>'dbuQuality') END AS spend_dbu_quality,
       MIN(COALESCE(component.value->>'reason', '')) AS reason
FROM ${USER_SPEND_DAILY_TABLE} daily
CROSS JOIN LATERAL jsonb_each(daily.components) component
WHERE daily.app_scope = $1
  AND daily.calculation_version = $2
  AND daily.user_key = lower($3)
  AND daily.activity_date BETWEEN $4::date AND $5::date
GROUP BY component.key
ORDER BY component.key`;

export const READ_USER_SPEND_REFRESH_STATE_QUERY = `SELECT status AS refresh_status,
       source_through AS refresh_source_through,
       billing_complete_through,
       completed_at AS refresh_completed_at,
       GREATEST(
         (SELECT MAX(added_at) FROM ${ADMIN_EMAILS_TABLE}),
         (SELECT MAX(updated_at) FROM ${SP_ASSIGNMENTS_TABLE}),
         (SELECT MAX(updated_at) FROM ${SP_PERSONAS_TABLE}),
         (SELECT MAX(updated_at) FROM ${SP_PERSONA_DEFINITIONS_TABLE})
       ) AS identity_updated_at
FROM ${USER_SPEND_REFRESH_TABLE}
WHERE app_scope = $1 AND calculation_version = $2`;

export interface UserSpendReadModelComponent {
  id: string;
  label: string;
  usd: { amount: number | null; quality: UserSpendQuality };
  dbu: { amount: number | null; quality: UserSpendQuality };
  reason: string;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quality(value: unknown): UserSpendQuality {
  return value === 'direct' ||
    value === 'joined' ||
    value === 'allocated' ||
    value === 'unattributed' ||
    value === 'partial'
    ? value
    : 'unavailable';
}

export async function readUserSpendReadModelPage(
  store: UserSpendReadModelStore,
  input: {
    appScope?: string;
    calculationVersion?: number;
    range: OpsDayRange;
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
  const version = input.calculationVersion ?? USER_SPEND_CALCULATION_VERSION;
  const appScope = (input.appScope ?? process.env.DATABRICKS_APP_NAME ?? '').trim() || 'player-insights';
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const result = await store.query(READ_USER_SPEND_SUMMARY_QUERY, [
    appScope,
    version,
    input.range.from,
    input.range.to,
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
  const metadata = first ?? (await store.query(READ_USER_SPEND_REFRESH_STATE_QUERY, [appScope, version])).rows[0];
  const computedAt = stamp(metadata?.refresh_completed_at) ?? stamp(metadata?.computed_at);
  const sourceThrough = stamp(metadata?.refresh_source_through) ?? stamp(metadata?.source_through);
  const billingCompleteThrough = day(metadata?.billing_complete_through) || null;
  const coveredThrough =
    billingCompleteThrough && billingCompleteThrough < input.range.to ? billingCompleteThrough : input.range.to;
  const coveredDays =
    billingCompleteThrough && coveredThrough >= input.range.from ? daysBetween(input.range.from, coveredThrough) : 0;
  const staleMs = Math.max(60_000, input.staleMs ?? USER_SPEND_STALE_MS);
  const now = input.now ?? Date.now();
  return {
    available: Boolean(first || computedAt),
    rows: result.rows.map((row) => ({
      email: typeof row.display_email === 'string' ? row.display_email : '',
      questions: integer(row.submitted_questions),
      completedQuestions: integer(row.completed_questions),
      runs: integer(row.run_count),
      activeMinutes: integer(row.active_minutes),
      totalTokens: nullableNumber(row.total_tokens),
      tokenCoveredRuns: nullableNumber(row.token_covered_runs),
      tokenCoveredQuestions: nullableNumber(row.token_covered_questions),
      coveredDays,
      spendUsd: nullableNumber(row.spend_usd),
      spendDbu: nullableNumber(row.spend_dbu),
      spendUsdQuality: quality(row.spend_usd_quality),
      spendDbuQuality: quality(row.spend_dbu_quality),
      appSpendUsd: nullableNumber(row.app_spend_usd),
      appSpendDbu: nullableNumber(row.app_spend_dbu),
      activityComplete: bool(row.activity_complete),
      billingComplete: bool(row.billing_complete),
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
    })),
    total: integer(first?.total_users),
    identityRevision: stamp(first?.identity_updated_at) ?? stamp(metadata?.identity_updated_at) ?? '',
    freshness: {
      computedAt,
      sourceThrough,
      billingCompleteThrough,
      isRefreshing: metadata?.refresh_status === 'refreshing',
      isStale: computedAt === null || now - Date.parse(computedAt) > staleMs,
      calculationVersion: version,
    },
  };
}

export async function readUserSpendReadModelComponents(
  store: UserSpendReadModelStore,
  input: {
    appScope?: string;
    calculationVersion?: number;
    email: string;
    range: OpsDayRange;
  }
): Promise<UserSpendReadModelComponent[]> {
  const appScope = (input.appScope ?? process.env.DATABRICKS_APP_NAME ?? '').trim() || 'player-insights';
  const version = input.calculationVersion ?? USER_SPEND_CALCULATION_VERSION;
  const result = await store.query(READ_USER_SPEND_COMPONENTS_QUERY, [
    appScope,
    version,
    input.email.trim().toLowerCase(),
    input.range.from,
    input.range.to,
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

export function startUserSpendReadModelScheduler(
  store: UserSpendReadModelStore,
  source: UserSpendRefreshSource,
  options: { intervalMs?: number; jitterMs?: number } = {}
): () => void {
  stopActiveScheduler?.();
  let stopped = false;
  const run = () => {
    if (stopped) return;
    void runUserSpendReadModelRefresh(store, source).catch((error: Error) => {
      console.warn(`[user-spend-read-model] refresh failed (${safeErrorClass(error)}); last successful rows remain.`);
    });
  };
  const jitter = Math.max(0, Math.min(60_000, options.jitterMs ?? 30_000));
  const warm = setTimeout(run, Math.floor(Math.random() * (jitter + 1)));
  warm.unref?.();
  const timer = setInterval(run, Math.max(60_000, options.intervalMs ?? USER_SPEND_REFRESH_INTERVAL_MS));
  timer.unref?.();
  const stop = () => {
    stopped = true;
    clearTimeout(warm);
    clearInterval(timer);
    if (stopActiveScheduler === stop) stopActiveScheduler = null;
  };
  stopActiveScheduler = stop;
  return stop;
}

export function stopUserSpendReadModelScheduler(): void {
  stopActiveScheduler?.();
}
