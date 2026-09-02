import { appTable } from '../../shared/app-schema';
import {
  ExperimentalSettingsSchema,
  NO_EXPERIMENTS,
  type ExperimentalFeatures,
} from '../../shared/experimental-settings';
import type { LakebaseReader } from './lakebase-store';
import {
  readVersionedSettings,
  writeVersionedSettingsPatch,
  type VersionedSettings,
  type VersionedSettingsStore,
} from './versioned-settings-store';

const KEY = 'app-global';

export const EXPERIMENTAL_SETTINGS_TABLE = appTable('experimental_settings');

/** Retired browser pivot; mappings are always available in Identity now. */
export function withoutLegacySpIdentities(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { spIdentities: _retired, ...settings } = value as Record<string, unknown>;
  return settings;
}

const STORE: VersionedSettingsStore<ExperimentalFeatures> = {
  table: EXPERIMENTAL_SETTINGS_TABLE,
  key: KEY,
  defaults: { ...NO_EXPERIMENTS },
  prepare: withoutLegacySpIdentities,
  parse: (value) => ExperimentalSettingsSchema.parse(value),
};

let cache = new WeakMap<object, { document: VersionedSettings<ExperimentalFeatures>; at: number }>();
export const EXPERIMENTAL_SETTINGS_TTL_MS = 15_000;

export function forgetExperimentalSettings(): void {
  cache = new WeakMap();
}

export async function readExperimentalSettings(
  client: LakebaseReader,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<VersionedSettings<ExperimentalFeatures>> {
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? EXPERIMENTAL_SETTINGS_TTL_MS;
  const cached = cache.get(client);
  if (cached && maxAge > 0 && now - cached.at < maxAge) return cached.document;
  const document = await readVersionedSettings(client, STORE);
  cache.set(client, { document, at: now });
  return document;
}

export async function writeExperimentalSettings(
  client: LakebaseReader,
  patch: Partial<ExperimentalFeatures>,
  revision: number,
  updatedBy: string
): Promise<VersionedSettings<ExperimentalFeatures>> {
  const document = await writeVersionedSettingsPatch(client, STORE, patch, revision, updatedBy);
  forgetExperimentalSettings();
  return document;
}
