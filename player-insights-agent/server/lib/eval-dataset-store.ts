import { appTable } from '../../shared/app-schema';
import {
  EMPTY_EVAL_DATASET,
  EvalDatasetSchema,
  parseEvalDataset,
  type EvalDataset,
} from '../../shared/eval-dataset';
import type { LakebaseReader } from './lakebase-store';

const KEY = 'effective';
export const EVAL_DATASET_TABLE = appTable('eval_dataset');
export const EVAL_DATASET_DDL = `CREATE TABLE IF NOT EXISTS ${EVAL_DATASET_TABLE} (
  id TEXT PRIMARY KEY,
  rows JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

let cache = new WeakMap<object, { value: EvalDataset; at: number }>();
export const EVAL_DATASET_TTL_MS = 15_000;

export function forgetEvalDataset(): void {
  cache = new WeakMap();
}

export async function readEvalDataset(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<EvalDataset> {
  const now = options.now ?? Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < (options.maxAgeMs ?? EVAL_DATASET_TTL_MS)) return cached.value;
  try {
    const result = await client.lakebase.query(`SELECT rows FROM ${EVAL_DATASET_TABLE} WHERE id = $1`, [KEY]);
    const raw = result?.rows?.[0]?.rows;
    const parsed = raw === undefined ? EMPTY_EVAL_DATASET : parseEvalDataset({ rows: raw });
    cache.set(client, { value: parsed, at: now });
    return parsed;
  } catch (error) {
    console.warn('[eval-dataset] Falling back to an empty set:', (error as Error).message);
    return EMPTY_EVAL_DATASET;
  }
}

export async function writeEvalDataset(
  client: LakebaseReader,
  dataset: EvalDataset,
  updatedBy: string
): Promise<EvalDataset> {
  const parsed = EvalDatasetSchema.parse(dataset);
  await client.lakebase.query(
    `INSERT INTO ${EVAL_DATASET_TABLE} (id, rows, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       rows = EXCLUDED.rows, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify(parsed.rows), updatedBy]
  );
  forgetEvalDataset();
  return parsed;
}
