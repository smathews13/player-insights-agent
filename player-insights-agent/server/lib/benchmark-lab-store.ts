import { appTable } from '../../shared/app-schema';
import {
  EMPTY_LAB_STATE,
  LabStateSchema,
  parseLabState,
  type LabState,
} from '../../shared/benchmark-lab-v3';
import type { LakebaseReader } from './lakebase-store';

const KEY = 'effective';
export const BENCHMARK_LAB_TABLE = appTable('benchmark_lab');
export const BENCHMARK_LAB_DDL = `CREATE TABLE IF NOT EXISTS ${BENCHMARK_LAB_TABLE} (
  id TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

let cache = new WeakMap<object, { value: LabState; at: number }>();
export const BENCHMARK_LAB_TTL_MS = 5_000;

export function forgetLabState(): void {
  cache = new WeakMap();
}

export async function readLabState(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<LabState> {
  const now = options.now ?? Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < (options.maxAgeMs ?? BENCHMARK_LAB_TTL_MS)) return cached.value;
  try {
    const result = await client.lakebase.query(`SELECT state FROM ${BENCHMARK_LAB_TABLE} WHERE id = $1`, [KEY]);
    const raw = result?.rows?.[0]?.state;
    const parsed = raw === undefined ? EMPTY_LAB_STATE : parseLabState(raw);
    cache.set(client, { value: parsed, at: now });
    return parsed;
  } catch (error) {
    console.warn('[benchmark-lab] Falling back to empty lab state:', (error as Error).message);
    return EMPTY_LAB_STATE;
  }
}

export async function writeLabState(
  client: LakebaseReader,
  state: LabState,
  updatedBy: string
): Promise<LabState> {
  const parsed = LabStateSchema.parse(state);
  await client.lakebase.query(
    `INSERT INTO ${BENCHMARK_LAB_TABLE} (id, state, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       state = EXCLUDED.state, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify(parsed), updatedBy]
  );
  forgetLabState();
  return parsed;
}

export async function patchLabState(
  client: LakebaseReader,
  patch: Partial<LabState>,
  updatedBy: string
): Promise<LabState> {
  const current = await readLabState(client, { maxAgeMs: 0 });
  return writeLabState(client, { ...current, ...patch }, updatedBy);
}
