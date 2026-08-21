/**
 * OAuth scopes that improve Connections / Ops metadata probes and the
 * Connections pickers, but are not required for asks (Genie's SQL / serving
 * path).
 *
 * Always listed in the login gate and Identity card as Optional so a reader can
 * see the capability without treating a shortfall as a hard gate. As of
 * 2026-08-18 they are in the SHARED DEFAULT, so a customer/T2 deploy requests
 * them too (not just example); "optional" here means the login gate does not fail
 * when the workspace cannot issue one, NOT that the deploy declines to ask. A
 * deployment may still drop them from its own override, and the gate stays
 * neutral either way.
 *
 * The Vector Search browse pair joined this set on Sam's 2026-08-18 call, in the
 * shared default alongside catalog/workspace and optional for the login gate:
 * they let the Connections pickers enumerate VS endpoints and indexes, and
 * without them a reader types the name instead. This governs only the APP's
 * forwarded token. Ask-time semantic retrieval runs on the MODEL's own
 * downscoped token, whose UserAuthPolicy (agent/semantic_retrieval.py) still
 * requires Vector Search on a semantic deployment -- a different token, a
 * different validator, unaffected by this list. And the honest caveat that no
 * classification here can soften: Apps consent is all-or-nothing, so a workspace
 * that will not issue one of these fails the whole sign-in ahead of the app;
 * "optional" is about our gate's verdict, not the platform's issuance.
 *
 * `postgres` joined later the same day for Lakebase project/branch/database
 * browse on Connections. It is the Apps name for the Lakebase family (the bare
 * control-plane paths sit under `/api/2.0/postgres/`), and without it the
 * picker falls back to typing the full database resource name. It is NOT an
 * MLflow substitute: Apps still has no MLflow scope at all.
 */
export const WORKSPACE_READ_USER_API_SCOPE = 'workspace.workspace:read' as const;

export const OPTIONAL_USER_API_SCOPES = [
  'catalog.catalogs:read',
  'catalog.schemas:read',
  'catalog.tables:read',
  // Workspace object listing, for the Connections notebook picker. Optional on
  // the same terms as the three above: without it a reader types the path
  // instead, and no ask is affected. The name is the Apps API's, which refuses
  // the bare `workspace` the OAuth server advertises.
  WORKSPACE_READ_USER_API_SCOPE,
  // Vector Search browse, for the Connections VS endpoint/index pickers. In the
  // shared default and optional for the login gate on the same terms. The names
  // are the Apps API's, which refuses the bare `vector-search` the OAuth server
  // advertises.
  'vectorsearch.vector-search-indexes:read',
  'vectorsearch.vector-search-endpoints:read',
  // Lakebase (Postgres) control-plane browse: projects, branches, databases.
  // Apps accepts `postgres` (also used for OBO Lakebase queries). Without it
  // the Connections Lakebase picker stays a typed full resource name.
  'postgres',
] as const;

export type OptionalUserApiScope = (typeof OPTIONAL_USER_API_SCOPES)[number];

export function isOptionalUserApiScope(name: string): boolean {
  return (OPTIONAL_USER_API_SCOPES as readonly string[]).includes(name);
}

/** Declared shortfalls that still gate the login verdict / sign-in remedy. */
export function requiredMissingScopes(missing: readonly string[]): string[] {
  return missing.filter((name) => name && !isOptionalUserApiScope(name));
}
