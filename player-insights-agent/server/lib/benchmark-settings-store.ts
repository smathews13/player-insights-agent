import { appTable } from '../../shared/app-schema';
import {
  DEFAULT_BENCHMARK_SETTINGS,
  parseStoredBenchmarkSettings,
  type BenchmarkSettings,
} from '../../shared/benchmark-settings';
import type { LakebaseReader } from './lakebase-store';
import {
  readVersionedSettings,
  writeVersionedSettingsPatch,
  type VersionedSettings,
  type VersionedSettingsStore,
} from './versioned-settings-store';

const KEY = 'effective';
export const BENCHMARK_SETTINGS_TABLE = appTable('benchmark_settings');
export const BENCHMARK_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS ${BENCHMARK_SETTINGS_TABLE} (
  id TEXT PRIMARY KEY,
  settings JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

const STORE: VersionedSettingsStore<BenchmarkSettings> = {
  table: BENCHMARK_SETTINGS_TABLE,
  key: KEY,
  defaults: DEFAULT_BENCHMARK_SETTINGS,
  parse: parseStoredBenchmarkSettings,
};

let cache = new WeakMap<object, { document: VersionedSettings<BenchmarkSettings>; at: number }>();
export const BENCHMARK_SETTINGS_TTL_MS = 15_000;

export function forgetBenchmarkSettings(): void {
  cache = new WeakMap();
}

export async function readBenchmarkSettings(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<BenchmarkSettings> {
  try {
    return (await readBenchmarkSettingsDocument(client, options)).settings;
  } catch (error) {
    console.warn('[benchmark-settings] Falling back to defaults:', (error as Error).message);
    return DEFAULT_BENCHMARK_SETTINGS;
  }
}

/** Strict Settings read: an unavailable row is not interchangeable with defaults. */
export async function readBenchmarkSettingsDocument(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<VersionedSettings<BenchmarkSettings>> {
  const now = options.now ?? Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < (options.maxAgeMs ?? BENCHMARK_SETTINGS_TTL_MS)) return cached.document;
  const document = await readVersionedSettings(client, STORE);
  cache.set(client, { document, at: now });
  return document;
}

export async function writeBenchmarkSettingsPatch(
  client: LakebaseReader,
  patch: unknown,
  revision: number,
  updatedBy: string
): Promise<VersionedSettings<BenchmarkSettings>> {
  const document = await writeVersionedSettingsPatch(client, STORE, patch, revision, updatedBy);
  forgetBenchmarkSettings();
  return document;
}
