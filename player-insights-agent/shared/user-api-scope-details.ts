/**
 * Human-readable Databricks descriptions for scopes shown by Astrolabe.
 *
 * Keep this metadata independent of any one page: the Ops Identity table and
 * Connections scope findings describe the same permissions and should not grow
 * separate copies that drift. Unknown scopes still get a truthful explanation
 * rather than falling back to the scope name itself.
 */
export const PLATFORM_DEFAULT_USER_API_SCOPES = [
  'iam.access-control:read',
  'iam.current-user:read',
] as const;

export const USER_API_SCOPE_DETAILS: Readonly<Record<string, string>> = {
  'catalog.catalogs:read': 'Allows the app to read catalogs in Unity Catalog.',
  'catalog.schemas:read': 'Allows the app to read schemas in Unity Catalog.',
  'catalog.tables:read': 'Allows the app to read tables in Unity Catalog.',
  'dashboards.genie': 'Allows the app to manage Genie spaces in Databricks.',
  'iam.access-control:read':
    'Allows the app to read your access control settings and permissions.',
  'iam.current-user:read': 'Allows the app to read your basic identity information.',
  'model-serving': 'Allows the app to access Databricks Model Serving.',
  postgres: 'Allows the app to read Lakebase projects, branches, and databases.',
  'serving.serving-endpoints':
    'Allows the app to manage model serving endpoints in Databricks.',
  sql: 'Allows the app to execute SQL and manage SQL-related resources in Databricks.',
  'vectorsearch.vector-search-endpoints:read':
    'Allows the app to read Vector Search endpoints.',
  'vectorsearch.vector-search-indexes:read':
    'Allows the app to read Vector Search indexes.',
  'workspace.workspace:read':
    'Allows the app to read workspace objects (folders, notebooks, and files).',
};

export function userApiScopeDetail(scope: string): string {
  return (
    USER_API_SCOPE_DETAILS[scope] ??
    'Allows the app to use this Databricks permission.'
  );
}

export function isPlatformDefaultUserApiScope(scope: string): boolean {
  return (PLATFORM_DEFAULT_USER_API_SCOPES as readonly string[]).includes(scope);
}
