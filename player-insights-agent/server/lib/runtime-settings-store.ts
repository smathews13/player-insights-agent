import { appTable } from '../../shared/app-schema';
import { DEFAULT_RUNTIME_SETTINGS, RuntimeSettingsSchema, type RuntimeSettings } from '../../shared/runtime-settings';
import type { LakebaseReader } from './lakebase-store';

const KEY = 'effective';
// Must follow APP_SCHEMA (var.lakebase_app_schema / PLAYER_INSIGHTS_APP_SCHEMA).
// Hardcoding player_insights.runtime_settings diverges from migrations.ts and
// silently misses the real table when a target uses a non-default schema.
export const RUNTIME_SETTINGS_TABLE = appTable('runtime_settings');
export const RUNTIME_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS ${RUNTIME_SETTINGS_TABLE} (
  id TEXT PRIMARY KEY,
  settings JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

let cache = new WeakMap<object, { value: RuntimeSettings; at: number }>();
export const RUNTIME_SETTINGS_TTL_MS = 15_000;

export function forgetRuntimeSettings(): void {
  cache = new WeakMap();
}

export async function readRuntimeSettings(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<RuntimeSettings> {
  const now = options.now ?? Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < (options.maxAgeMs ?? RUNTIME_SETTINGS_TTL_MS)) return cached.value;
  try {
    const result = await client.lakebase.query(`SELECT settings FROM ${RUNTIME_SETTINGS_TABLE} WHERE id = $1`, [KEY]);
    const raw = result?.rows?.[0]?.settings;
    const parsed = raw === undefined ? DEFAULT_RUNTIME_SETTINGS : RuntimeSettingsSchema.parse(raw);
    cache.set(client, { value: parsed, at: now });
    return parsed;
  } catch (error) {
    console.warn('[runtime-settings] Falling back to defaults:', (error as Error).message);
    return DEFAULT_RUNTIME_SETTINGS;
  }
}

export async function writeRuntimeSettings(
  client: LakebaseReader,
  settings: RuntimeSettings,
  updatedBy: string
): Promise<RuntimeSettings> {
  const parsed = RuntimeSettingsSchema.parse(settings);
  await client.lakebase.query(
    `INSERT INTO ${RUNTIME_SETTINGS_TABLE} (id, settings, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, JSON.stringify(parsed), updatedBy]
  );
  forgetRuntimeSettings();
  return parsed;
}
