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
export type StoredRailRating = 'unrated' | 'up' | 'down';

export interface RunLabelOverrideRow {
  status: StoredRailOutcome | null;
  rating: StoredRailRating | null;
}

const OUTCOMES = new Set<string>(['complete', 'partial', 'failed']);
const RATINGS = new Set<string>(['unrated', 'up', 'down']);

function asOutcome(value: unknown): StoredRailOutcome | null {
  return typeof value === 'string' && OUTCOMES.has(value) ? (value as StoredRailOutcome) : null;
}

function asRating(value: unknown): StoredRailRating | null {
  return typeof value === 'string' && RATINGS.has(value) ? (value as StoredRailRating) : null;
}

export function overlayFromRow(row: Record<string, unknown> | undefined): RunLabelOverrideRow | null {
  if (!row) return null;
  return { status: asOutcome(row.status), rating: asRating(row.rating) };
}

export function applyOverlayToRunRow(
  row: Record<string, unknown>,
  overlay: RunLabelOverrideRow | null
): Record<string, unknown> {
  if (!overlay) return row;
  const next = { ...row };
  if (overlay.status) next.status = overlay.status;
  if (overlay.rating === 'unrated') next.rating = null;
  else if (overlay.rating === 'up') next.rating = 5;
  else if (overlay.rating === 'down') next.rating = 2;
  return next;
}

export async function readRunLabelOverride(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  runId: string
): Promise<RunLabelOverrideRow | null> {
  const result = await query(`SELECT status, rating FROM ${RUN_LABEL_OVERRIDES_TABLE} WHERE run_id = $1`, [runId]);
  return overlayFromRow(result.rows[0]);
}

export async function writeRunLabelOverride(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  input: { runId: string; actor: string; status?: StoredRailOutcome; rating?: StoredRailRating }
): Promise<RunLabelOverrideRow> {
  const current = await readRunLabelOverride(query, input.runId);
  const status = input.status ?? current?.status ?? null;
  const rating = input.rating ?? current?.rating ?? null;
  await query(
    `INSERT INTO ${RUN_LABEL_OVERRIDES_TABLE} (run_id, status, rating, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (run_id) DO UPDATE SET
       status = EXCLUDED.status,
       rating = EXCLUDED.rating,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [input.runId, status, rating, input.actor]
  );
  return { status, rating };
}
