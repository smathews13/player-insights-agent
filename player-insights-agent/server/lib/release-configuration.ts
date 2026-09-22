/**
 * What this app release was wired to, without asking the live agent.
 *
 * The serving endpoint used to be sent a fake question (`preflight`) so it
 * would echo its baked configuration. That created ~1ms MLflow traces, burned
 * serving capacity, and told operators nothing about Unity Catalog grants.
 *
 * The table list a release may read is generated at log time from
 * `agent/preflight.py` and written into the app container as
 * `PLAYER_INSIGHTS_DECLARED_MANIFEST`. Connections and the access gate probe
 * Unity Catalog for that exact list as the signed-in user. Catalog and schema
 * names never imply that any hard-coded table exists.
 */
import { APPLY_ENV_VARS } from '../../shared/apply-declaration';
import type { PreflightConfiguration } from '../routes/insights-routes';
import { resolveSemanticIndexValue } from './semantic-index-name';

const EXTRA_ENV: Record<string, string> = {
  declared_manifest: 'PLAYER_INSIGHTS_DECLARED_MANIFEST',
  tables: 'PLAYER_INSIGHTS_TABLES',
  data_genie_space_title: 'PLAYER_INSIGHTS_DATA_GENIE_TITLE',
  dictionary_genie_space_title: 'PLAYER_INSIGHTS_DICTIONARY_GENIE_TITLE',
  semantic_index: 'PLAYER_INSIGHTS_SEMANTIC_INDEX',
  build_sha: 'PLAYER_INSIGHTS_BUILD_SHA',
  manifest_source: 'PLAYER_INSIGHTS_MANIFEST_SOURCE',
};

const LIST_KEYS = new Set(['catalog_allowlist', 'catalog_denylist', 'declared_manifest', 'tables']);

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function text(env: Record<string, string | undefined>, name: string): string {
  return (env[name] ?? '').trim();
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).trim();
  }
  if (typeof value === 'object') return JSON.stringify(value).trim();
  return '';
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).trim() === '';
  }
  // A non-array object is never blank (it stringified to a truthy value before).
  return false;
}

/**
 * Configuration entries from the app container, never from a serving invoke.
 *
 * `source` is `app-environment` on purpose for values the release wrote into
 * the app. A table list is emitted only when the release actually supplied one:
 * catalog and schema names are scope, not evidence that any particular table
 * exists.
 */
export function configurationFromRelease(
  env: Record<string, string | undefined> = process.env
): PreflightConfiguration[] {
  const mapping = { ...APPLY_ENV_VARS, ...EXTRA_ENV };
  const entries: PreflightConfiguration[] = [];
  for (const [key, envVar] of Object.entries(mapping)) {
    let raw = text(env, envVar);
    if (!raw && key === 'warehouse_id') raw = text(env, 'DATABRICKS_SQL_WAREHOUSE_ID');
    if (!raw) continue;
    if (key === 'semantic_index') {
      raw =
        resolveSemanticIndexValue(raw, text(env, 'PLAYER_INSIGHTS_CATALOG'), text(env, 'PLAYER_INSIGHTS_SCHEMA')) ||
        raw;
    }
    entries.push({
      key,
      env_var: envVar,
      value: LIST_KEYS.has(key) ? splitList(raw) : raw,
      source: 'app-environment',
      mutability: 'model-version',
      baked: false,
      required: false,
    });
  }
  return entries;
}

/**
 * Fill gaps in the app-container configuration from the served model version.
 *
 * Env and an explicit declared manifest win.
 * `true` for the semantic index is replaced by a resolved three-level name.
 */
export function mergeReleaseConfiguration(
  fromEnv: readonly PreflightConfiguration[],
  fromBaked: readonly PreflightConfiguration[]
): PreflightConfiguration[] {
  const byKey = new Map(fromEnv.map((entry) => [entry.key, entry]));
  for (const baked of fromBaked) {
    const existing = byKey.get(baked.key);
    if (!existing || isEmptyValue(existing.value)) {
      byKey.set(baked.key, baked);
      continue;
    }
    if (baked.key === 'semantic_index') {
      const existingName = asString(existing.value);
      const bakedName = asString(baked.value);
      if (!existingName.includes('.') && bakedName.includes('.')) {
        byKey.set(baked.key, baked);
      }
    }
  }
  return [...byKey.values()];
}

/** App-container configuration, with baked model_config filling only the gaps. */
export function configurationForSettings(
  env: Record<string, string | undefined> = process.env,
  baked: readonly PreflightConfiguration[] = []
): PreflightConfiguration[] {
  return mergeReleaseConfiguration(configurationFromRelease(env), baked);
}
