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
 */
import { APPLY_ENV_VARS } from '../../shared/apply-declaration';
import { qualifyDataContractTables } from '../../shared/data-contract';
import type { PreflightConfiguration } from '../routes/insights-routes';

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

/**
 * Configuration entries from the app container, never from a serving invoke.
 *
 * `source` is `app-environment` on purpose: these values were written into the
 * app at release, they were not measured inside the endpoint, and Connections
 * must not present them as an artifact reading.
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
        source: 'app-environment',
        mutability: 'model-version',
        baked: false,
        required: false,
      });
    }
  }
  return entries;
}
