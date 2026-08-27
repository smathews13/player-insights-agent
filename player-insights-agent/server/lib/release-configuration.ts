/**
 * What this app release was wired to, without asking the live agent.
 *
 * The serving endpoint used to be sent a fake question (`preflight`) so it
 * would echo its baked configuration. That created ~1ms MLflow traces, burned
 * serving capacity, and told operators nothing about Unity Catalog grants.
 *
 * The table list a release may read is generated at log time from
 * `agent/preflight.py` and written into the app container as
 * `PLAYER_INSIGHTS_DECLARED_MANIFEST` (or catalog + schema, which qualifies the
 * committed data contract). Connections and the access gate probe Unity Catalog
 * for that list as the signed-in user.
 *
 * The six-name data contract is a fallback, not the live declaration: a schema
 * enumeration at log time is usually longer. When the container has only the
 * fallback, later readers may fill gaps from the served model version's baked
 * `model_config` or from a Unity Catalog listing of the same schema.
 */
import { APPLY_ENV_VARS } from '../../shared/apply-declaration';
import { qualifyDataContractTables } from '../../shared/data-contract';
import type { PreflightConfiguration } from '../routes/insights-routes';
import { isDataContractFallback } from './declared-tables';
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

function entryValue(entry: PreflightConfiguration | undefined): unknown {
  return entry?.value;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return splitList(value);
  return [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return String(value).trim() === '';
}

/**
 * Configuration entries from the app container, never from a serving invoke.
 *
 * `source` is `app-environment` on purpose for values the release wrote into
 * the app. The committed data-contract table list is tagged `data-contract`
 * so later recovery can tell "we only have the six fallback names" from "the
 * container was given this list".
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
        resolveSemanticIndexValue(
          raw,
          text(env, 'PLAYER_INSIGHTS_CATALOG'),
          text(env, 'PLAYER_INSIGHTS_SCHEMA')
        ) || raw;
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
  const hasManifest = entries.some(
    (entry) => entry.key === 'declared_manifest' && Array.isArray(entry.value) && entry.value.length > 0
  );
  if (!hasManifest) {
    const qualified = qualifyDataContractTables(text(env, 'PLAYER_INSIGHTS_CATALOG'), text(env, 'PLAYER_INSIGHTS_SCHEMA'));
    if (qualified.length > 0) {
      entries.push({
        key: 'declared_manifest',
        env_var: 'PLAYER_INSIGHTS_DECLARED_MANIFEST',
        value: qualified,
        source: 'data-contract',
        mutability: 'model-version',
        baked: false,
        required: false,
      });
    }
  }
  return entries;
}

function catalogSchemaOf(entries: readonly PreflightConfiguration[]): { catalog: string; schema: string } {
  return {
    catalog: asString(entryValue(entries.find((entry) => entry.key === 'catalog'))),
    schema: asString(entryValue(entries.find((entry) => entry.key === 'schema'))),
  };
}

function isDataContractManifest(entry: PreflightConfiguration, catalog: string, schema: string): boolean {
  if (entry.source === 'data-contract') return true;
  return isDataContractFallback(asStringList(entry.value), catalog, schema);
}

/**
 * Fill gaps in the app-container configuration from the served model version.
 *
 * Env and an explicit declared manifest win. A data-contract fallback is
 * replaced when the artifact has a longer (or just different non-empty) list.
 * `true` for the semantic index is replaced by a resolved three-level name.
 */
export function mergeReleaseConfiguration(
  fromEnv: readonly PreflightConfiguration[],
  fromBaked: readonly PreflightConfiguration[]
): PreflightConfiguration[] {
  const byKey = new Map(fromEnv.map((entry) => [entry.key, entry]));
  const { catalog, schema } = catalogSchemaOf(fromEnv);
  for (const baked of fromBaked) {
    const existing = byKey.get(baked.key);
    if (!existing || isEmptyValue(existing.value)) {
      byKey.set(baked.key, baked);
      continue;
    }
    if (baked.key === 'declared_manifest' && isDataContractManifest(existing, catalog, schema)) {
      const bakedList = asStringList(baked.value);
      if (bakedList.length > asStringList(existing.value).length) {
        byKey.set(baked.key, baked);
      }
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
