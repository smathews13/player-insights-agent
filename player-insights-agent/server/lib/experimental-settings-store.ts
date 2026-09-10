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
  cache.set(client, { document, at: Date.now() });
  return document;
}

/**
 * Resolve the routing toggle for a new ask.
 *
 * A successful read is authoritative. During a transient Lakebase failure, keep
 * the last state this process actually read or wrote so an enabled Gateway never
 * silently falls back to direct. A cold process with no state preserves the
 * schema's default-off behavior.
 */
export async function readAiGatewayEnabled(client: LakebaseReader): Promise<boolean> {
  try {
    return (await readExperimentalSettings(client, { maxAgeMs: 0 })).settings.aiGateway;
  } catch (error) {
    const remembered = cache.get(client);
    if (remembered) return remembered.document.settings.aiGateway;
    console.warn(
      '[experimental-settings] AI Gateway state could not be read; using the default-off state:',
      (error as Error).message
    );
    return false;
  }
}

/**
 * Resolve the managed Genie MCP deployment switch for a new ask.
 *
 * Unlike Gateway routing, this capability fails closed on every unreadable
 * settings snapshot. It grants an additional data transport to administrators,
 * so remembered process state must never keep it enabled through a store outage.
 */
export async function readGenieMcpEnabled(client: LakebaseReader): Promise<boolean> {
  try {
    return (await readExperimentalSettings(client, { maxAgeMs: 0 })).settings.genieCodeMcp === true;
  } catch (error) {
    console.warn(
      '[experimental-settings] Genie MCP state could not be read; disabling managed MCP for this ask:',
      (error as Error).message
    );
    return false;
  }
}
