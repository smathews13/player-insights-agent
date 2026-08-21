/**
 * Reads Databricks OAuth token scope names against Apps `user_api_scopes`.
 *
 * The two APIs use different names for the same permission. Apps accepts fine-
 * grained names such as `catalog.tables:read`, while the forwarded OAuth token
 * commonly reports the coarse `unity-catalog` family. This is the one shared
 * translation used by both server-side refusal diagnosis and the Astrolabe
 * sign-in UI.
 */
const OAUTH_FAMILY_BY_SCOPE: Readonly<Record<string, string>> = {
  'catalog.catalogs:read': 'unity-catalog',
  'catalog.schemas:read': 'unity-catalog',
  'catalog.tables:read': 'unity-catalog',
  'vectorsearch.vector-search-indexes:read': 'vector-search',
  'vectorsearch.vector-search-endpoints:read': 'vector-search',
  'workspace.workspace:read': 'workspace',
  'serving.serving-endpoints': 'model-serving',
  'dashboards.genie': 'genie',
  sql: 'sql',
  postgres: 'postgres',
};

/** The CLI's catch-all scope, which carries every workspace API permission. */
const ALL_APIS_SCOPE = 'all-apis';

/** Whether a token's declared scopes carry one Apps user API scope. */
export function tokenCarriesScope(held: readonly string[], scope: string): boolean {
  if (held.includes(ALL_APIS_SCOPE)) return true;
  if (!scope) return false;
  return held.includes(scope) || held.includes(OAUTH_FAMILY_BY_SCOPE[scope] ?? scope);
}

/**
 * Standard OIDC scopes carry no workspace API meaning. They are known rather
 * than unknown vocabulary for the three-valued absence check below.
 */
const INERT_TOKEN_SCOPES: ReadonlySet<string> = new Set([
  'openid',
  'profile',
  'email',
  'offline_access',
  ALL_APIS_SCOPE,
]);

/** The meaningful words in a scope name, used to spot an unknown alias. */
function scopeStems(scope: string): Set<string> {
  return new Set(
    scope
      .split(/[.:\-_/]+/)
      .map((word) => word.toLowerCase())
      .filter((word) => word.length > 2 && !['read', 'write', 'api', 'apis', 'all'].includes(word))
  );
}

/**
 * Whether the token carries `scope`, or null when an unfamiliar token spelling
 * means absence cannot be proved safely.
 */
export function tokenScopeVerdict(held: readonly string[], scope: string): boolean | null {
  if (tokenCarriesScope(held, scope)) return true;
  if (!scope) return null;

  const known = new Set<string>([
    ...Object.keys(OAUTH_FAMILY_BY_SCOPE),
    ...Object.values(OAUTH_FAMILY_BY_SCOPE),
  ]);
  const stems = scopeStems(scope);
  const familyStems = scopeStems(OAUTH_FAMILY_BY_SCOPE[scope] ?? '');
  for (const stem of familyStems) stems.add(stem);

  for (const name of held) {
    if (known.has(name) || INERT_TOKEN_SCOPES.has(name)) continue;
    for (const stem of scopeStems(name)) {
      if (stems.has(stem)) return null;
    }
  }
  return false;
}
