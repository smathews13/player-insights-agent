import { appTable } from '../../shared/app-schema';
import {
  EMPTY_EVAL_DATASET,
  EvalDatasetSchema,
  mergeEvalRows,
  parseEvalDataset,
  type EvalDataset,
} from '../../shared/eval-dataset';
import { parseGenieAccuracyRun, type GenieAccuracyRunView } from '../../shared/eval-genie-run';
import type { LakebaseReader } from './lakebase-store';

const KEY = 'effective';
export const EVAL_DATASET_TABLE = appTable('eval_dataset');
export const EVAL_DATASET_DDL = `CREATE TABLE IF NOT EXISTS ${EVAL_DATASET_TABLE} (
  id TEXT PRIMARY KEY,
  rows JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

export interface EvalDatasetEnvelope {
  dataset: EvalDataset;
  lastGenieRun: GenieAccuracyRunView | null;
}

function unwrapStored(raw: unknown): { rows: unknown; lastGenieRun?: unknown } {
  if (Array.isArray(raw)) return { rows: raw };
  if (raw && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)) {
    return raw as { rows: unknown; lastGenieRun?: unknown };
  }
  return { rows: [] };
}

let cache = new WeakMap<object, { value: EvalDatasetEnvelope; at: number }>();
export const EVAL_DATASET_TTL_MS = 15_000;

export function forgetEvalDataset(): void {
  cache = new WeakMap();
}

export async function readEvalDatasetEnvelope(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<EvalDatasetEnvelope> {
  const now = options.now ?? Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < (options.maxAgeMs ?? EVAL_DATASET_TTL_MS)) return cached.value;
  try {
    const result = await client.lakebase.query(`SELECT rows FROM ${EVAL_DATASET_TABLE} WHERE id = $1`, [KEY]);
    const raw = result?.rows?.[0]?.rows;
    if (raw === undefined) {
      const empty = { dataset: EMPTY_EVAL_DATASET, lastGenieRun: null };
      cache.set(client, { value: empty, at: now });
      return empty;
    }
    const blob = unwrapStored(raw);
    const envelope: EvalDatasetEnvelope = {
      dataset: parseEvalDataset({ rows: blob.rows }),
      lastGenieRun: parseGenieAccuracyRun(blob.lastGenieRun),
    };
    cache.set(client, { value: envelope, at: now });
    return envelope;
  } catch (error) {
    console.warn('[eval-dataset] Falling back to an empty set:', (error as Error).message);
    return { dataset: EMPTY_EVAL_DATASET, lastGenieRun: null };
  }
}

export async function readEvalDataset(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<EvalDataset> {
  return (await readEvalDatasetEnvelope(client, options)).dataset;
}

async function persistEnvelope(
  client: LakebaseReader,
  envelope: EvalDatasetEnvelope,
  updatedBy: string
): Promise<EvalDatasetEnvelope> {
  await client.lakebase.query(
    `INSERT INTO ${EVAL_DATASET_TABLE} (id, rows, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       rows = EXCLUDED.rows, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify({ rows: envelope.dataset.rows, lastGenieRun: envelope.lastGenieRun }), updatedBy]
  );
  forgetEvalDataset();
  return envelope;
}

export async function writeEvalDataset(
  client: LakebaseReader,
  dataset: EvalDataset,
  updatedBy: string
): Promise<EvalDataset> {
  const parsed = EvalDatasetSchema.parse(dataset);
  const current = await readEvalDatasetEnvelope(client, { maxAgeMs: 0 });
  const merged = EvalDatasetSchema.parse({ rows: mergeEvalRows(current.dataset.rows, parsed.rows) });
  const saved = await persistEnvelope(client, { dataset: merged, lastGenieRun: current.lastGenieRun }, updatedBy);
  return saved.dataset;
}

export async function writeLastGenieRun(
  client: LakebaseReader,
  run: GenieAccuracyRunView,
  updatedBy: string
): Promise<EvalDatasetEnvelope> {
  const current = await readEvalDatasetEnvelope(client, { maxAgeMs: 0 });
  return persistEnvelope(client, { dataset: current.dataset, lastGenieRun: run }, updatedBy);
}
