import { appTable } from '../../shared/app-schema';
import {
  DEFAULT_RUNTIME_SETTINGS,
  parseStoredRuntimeSettings,
  type RuntimeSettings,
} from '../../shared/runtime-settings';
import type { LakebaseReader } from './lakebase-store';
import {
  readVersionedSettings,
  writeVersionedSettingsPatch,
  type VersionedSettings,
  type VersionedSettingsStore,
} from './versioned-settings-store';

const KEY = 'effective';
// Must follow APP_SCHEMA (var.lakebase_app_schema / PLAYER_INSIGHTS_APP_SCHEMA).
// Hardcoding player_insights.runtime_settings diverges from migrations.ts and
// silently misses the real table when a target uses a non-default schema.
export const RUNTIME_SETTINGS_TABLE = appTable('runtime_settings');
export const RUNTIME_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS ${RUNTIME_SETTINGS_TABLE} (
  id TEXT PRIMARY KEY,
  settings JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL
)`;

const STORE: VersionedSettingsStore<RuntimeSettings> = {
  table: RUNTIME_SETTINGS_TABLE,
  key: KEY,
  defaults: DEFAULT_RUNTIME_SETTINGS,
  parse: parseStoredRuntimeSettings,
};

let cache = new WeakMap<object, { document: VersionedSettings<RuntimeSettings>; at: number }>();
export const RUNTIME_SETTINGS_TTL_MS = 15_000;

export function forgetRuntimeSettings(): void {
  cache = new WeakMap();
}

export async function readRuntimeSettings(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<RuntimeSettings> {
  try {
    return (await readRuntimeSettingsDocument(client, options)).settings;
  } catch (error) {
    console.warn('[runtime-settings] Falling back to defaults:', (error as Error).message);
    return DEFAULT_RUNTIME_SETTINGS;
  }
}

/** Strict admin read: a failed durable read must not be rendered as defaults. */
export async function readRuntimeSettingsDocument(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<VersionedSettings<RuntimeSettings>> {
  const now = options.now ?? Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < (options.maxAgeMs ?? RUNTIME_SETTINGS_TTL_MS)) return cached.document;
  const document = await readVersionedSettings(client, STORE);
  cache.set(client, { document, at: now });
  return document;
}

export async function writeRuntimeSettingsPatch(
  client: LakebaseReader,
  patch: unknown,
  revision: number,
  updatedBy: string
): Promise<VersionedSettings<RuntimeSettings>> {
  const document = await writeVersionedSettingsPatch(client, STORE, patch, revision, updatedBy);
  forgetRuntimeSettings();
  return document;
}
