import { appTable } from '../../shared/app-schema';
import {
  DEFAULT_BENCHMARK_SETTINGS,
  BenchmarkSettingsSchema,
  type BenchmarkSettings,
} from '../../shared/benchmark-settings';
import type { LakebaseReader } from './lakebase-store';

const KEY = 'effective';
export const BENCHMARK_SETTINGS_TABLE = appTable('benchmark_settings');
export const BENCHMARK_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS ${BENCHMARK_SETTINGS_TABLE} (
  id TEXT PRIMARY KEY,
  settings JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

let cache = new WeakMap<object, { value: BenchmarkSettings; at: number }>();
export const BENCHMARK_SETTINGS_TTL_MS = 15_000;

export function forgetBenchmarkSettings(): void {
  cache = new WeakMap();
}

export async function readBenchmarkSettings(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<BenchmarkSettings> {
  const now = options.now ?? Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < (options.maxAgeMs ?? BENCHMARK_SETTINGS_TTL_MS)) return cached.value;
  try {
    const result = await client.lakebase.query(`SELECT settings FROM ${BENCHMARK_SETTINGS_TABLE} WHERE id = $1`, [KEY]);
    const raw = result?.rows?.[0]?.settings;
    const parsed = raw === undefined ? DEFAULT_BENCHMARK_SETTINGS : BenchmarkSettingsSchema.parse(raw);
    cache.set(client, { value: parsed, at: now });
    return parsed;
  } catch (error) {
    console.warn('[benchmark-settings] Falling back to defaults:', (error as Error).message);
    return DEFAULT_BENCHMARK_SETTINGS;
  }
}

export async function writeBenchmarkSettings(
  client: LakebaseReader,
  settings: BenchmarkSettings,
  updatedBy: string
): Promise<BenchmarkSettings> {
  const parsed = BenchmarkSettingsSchema.parse(settings);
  await client.lakebase.query(
    `INSERT INTO ${BENCHMARK_SETTINGS_TABLE} (id, settings, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify(parsed), updatedBy]
  );
  forgetBenchmarkSettings();
  return parsed;
}
