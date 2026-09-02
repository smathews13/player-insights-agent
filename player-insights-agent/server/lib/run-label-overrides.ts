/**
 * Administrator corrections of a run’s rail labels.
 *
 * Outcome is classified from the stored trace; this table does not change that
 * rule. It holds the words an admin chose afterwards, keyed by the run’s message
 * id, and the list applies them on read.
 */
import { APP_SCHEMA } from '../../shared/app-schema';

export const RUN_LABEL_OVERRIDES_TABLE = `${APP_SCHEMA}.run_label_overrides`;

export const RUN_LABEL_OVERRIDES_DDL = `CREATE TABLE IF NOT EXISTS ${RUN_LABEL_OVERRIDES_TABLE} (
         run_id TEXT PRIMARY KEY,
         status TEXT,
         rating TEXT,
         updated_by TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`;

export type StoredRailOutcome = 'complete' | 'partial' | 'failed';
export type StoredRailFeedback = 'none' | 'up' | 'down';

export interface RunLabelOverrideRow {
  status: StoredRailOutcome | null;
  feedback: StoredRailFeedback | null;
}

const OUTCOMES = new Set<string>(['complete', 'partial', 'failed']);
const FEEDBACK = new Set<string>(['unrated', 'none', 'up', 'down']);

function asOutcome(value: unknown): StoredRailOutcome | null {
  return typeof value === 'string' && OUTCOMES.has(value) ? (value as StoredRailOutcome) : null;
}

function asFeedback(value: unknown): StoredRailFeedback | null {
  if (value === 'unrated') return 'none';
  return typeof value === 'string' && FEEDBACK.has(value) ? (value as StoredRailFeedback) : null;
}

export function overlayFromRow(row: Record<string, unknown> | undefined): RunLabelOverrideRow | null {
  if (!row) return null;
  return { status: asOutcome(row.status), feedback: asFeedback(row.feedback ?? row.rating) };
}

export function applyOverlayToRunRow(
  row: Record<string, unknown>,
  overlay: RunLabelOverrideRow | null
): Record<string, unknown> {
  if (!overlay) return row;
  const next = { ...row };
  if (overlay.status) next.status = overlay.status;
  if (overlay.feedback === 'none') next.feedback = null;
  else if (overlay.feedback === 'up' || overlay.feedback === 'down') next.feedback = overlay.feedback;
  return next;
}

/** Join the overlay row so every list read can COALESCE it onto the classified verdict. */
export function overlayJoinSql(runIdExpr: string, alias = 'label_overlay'): string {
  return `LEFT JOIN ${RUN_LABEL_OVERRIDES_TABLE} ${alias} ON ${alias}.run_id = ${runIdExpr}`;
}

/** Overlay wins when present. Classification is the fallback, not a second wording. */
export function overlayStatusSql(classifiedSql: string, alias = 'label_overlay'): string {
  return `COALESCE(${alias}.status, ${classifiedSql})`;
}

export function overlayFeedbackSql(classifiedSql: string, alias = 'label_overlay'): string {
  return `CASE
         WHEN ${alias}.rating IN ('unrated', 'none') THEN NULL::text
         WHEN ${alias}.rating IN ('up', 'down') THEN ${alias}.rating
         ELSE (${classifiedSql})
       END`;
}

export async function readRunLabelOverride(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  runId: string
): Promise<RunLabelOverrideRow | null> {
  const result = await query(`SELECT status, rating AS feedback FROM ${RUN_LABEL_OVERRIDES_TABLE} WHERE run_id = $1`, [
    runId,
  ]);
  return overlayFromRow(result.rows[0]);
}

export async function writeRunLabelOverride(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  input: { runId: string; actor: string; status?: StoredRailOutcome; feedback?: StoredRailFeedback }
): Promise<RunLabelOverrideRow> {
  const current = await readRunLabelOverride(query, input.runId);
  const status = input.status ?? current?.status ?? null;
  const feedback = input.feedback ?? current?.feedback ?? null;
  const storedFeedback = feedback === 'none' ? 'unrated' : feedback;
  await query(
    `INSERT INTO ${RUN_LABEL_OVERRIDES_TABLE} (run_id, status, rating, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (run_id) DO UPDATE SET
       status = EXCLUDED.status,
       rating = EXCLUDED.rating,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [input.runId, status, storedFeedback, input.actor]
  );
  return { status, feedback };
}
