/**
 * Where an object lives in a workspace, when the app knows which workspace.
 *
 * EVERY FUNCTION HERE RETURNS NULL RATHER THAN A GUESS. A link built from a
 * host the app does not have lands the reader on a workspace that is not
 * theirs, or on nothing, and both are worse than an identifier with no link on
 * it: a dead link teaches people the page is decorative. So the host is an
 * argument rather than a constant, the caller passes what the server actually
 * reported, and a missing host or a missing id produces no link at all.
 *
 * Nothing in this module names a workspace, a catalog or an id. The host comes
 * from `DATABRICKS_HOST` in the app container and the identifiers come from the
 * deployment's own configuration, which is what keeps a customer's workspace
 * out of this repository and past the publication leak check.
 */

/**
 * A workspace host in the one shape a link can be built on.
 *
 * `DATABRICKS_HOST` is written with and without a scheme and with and without a
 * trailing slash depending on who set it, and all four have been seen. Empty
 * for anything that is not a host, which is what makes the null returns below
 * reachable rather than theoretical.
 */
export function normalizeWorkspaceHost(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The workspace's own Apps list.
 *
 * `/apps-v2?o=<workspace id>` is the address the workspace UI puts in the bar,
 * and the `?o=` is what makes it land for a reader signed in to more than one
 * workspace. The host and the id are both arguments: a hostname compiled in
 * here would send every deployment to whichever workspace was current when the
 * line was written.
 */
export function workspaceAppsUrl(host: string, workspaceId?: string | null): string {
  const base = normalizeWorkspaceHost(host);
  if (!base) return '';
  const org = (workspaceId ?? '').trim();
  return org ? `${base}/apps-v2?o=${encodeURIComponent(org)}` : `${base}/apps-v2`;
}

/** What kind of workspace object a link points at. */
export type DatabricksObject =
  | { kind: 'serving-endpoint'; name: string }
  | { kind: 'genie-space'; spaceId: string }
  | { kind: 'sql-warehouse'; warehouseId: string }
  | { kind: 'catalog'; catalog: string }
  | { kind: 'schema'; catalog: string; schema: string }
  | { kind: 'experiment'; experimentId: string }
  | { kind: 'vector-index'; index: string }
  | { kind: 'table'; table: string };

/**
 * The Explore path for a three-level name, or null for anything else.
 *
 * Shared by the two Unity Catalog objects below because they are the same
 * object to the browser: an index and a table are both browsed at
 * `/explore/data/<catalog>/<schema>/<name>`, and a rule written twice is a rule
 * that gets fixed once. A partial name is refused rather than truncated, since
 * `catalog.schema` resolves to the SCHEMA page, which looks like a link that
 * worked and is a link to the wrong object.
 */
function unityCatalogPath(name: string, part: (value: string) => string): string | null {
  const parts = name
    .trim()
    .split('.')
    .filter((segment) => segment.length > 0);
  return parts.length === 3 ? `/explore/data/${parts.map(part).join('/')}` : null;
}

/**
 * The workspace path for one object, or null when it cannot be built.
 *
 * Split from `databricksLink` so the path rules can be tested without a host
 * and so a caller that only wants to know whether an object is linkable at all
 * does not have to synthesise one.
 */
export function workspacePath(object: DatabricksObject): string | null {
  const part = (value: string) => encodeURIComponent(value.trim());
  switch (object.kind) {
    case 'serving-endpoint':
      return object.name.trim() ? `/ml/endpoints/${part(object.name)}` : null;
    case 'genie-space':
      return object.spaceId.trim() ? `/genie/rooms/${part(object.spaceId)}` : null;
    case 'sql-warehouse':
      return object.warehouseId.trim() ? `/sql/warehouses/${part(object.warehouseId)}` : null;
    case 'catalog':
      return object.catalog.trim() ? `/explore/data/${part(object.catalog)}` : null;
    case 'schema':
      // Both halves or neither. A schema link with an empty catalog segment is
      // a path to a different object.
      return object.catalog.trim() && object.schema.trim()
        ? `/explore/data/${part(object.catalog)}/${part(object.schema)}`
        : null;
    case 'experiment':
      return object.experimentId.trim() ? `/ml/experiments/${part(object.experimentId)}` : null;
    case 'vector-index':
      return unityCatalogPath(object.index, part);
    case 'table':
      // The name an answer or a plan cites, which is written fully qualified or
      // not at all. A bare `gold_title_daily_summary` names no workspace object
      // -- it is the tail of one -- so it produces no link, and the surface that
      // asked for it renders the identifier without one. See DataEntityLinks.tsx.
      return unityCatalogPath(object.table, part);
  }
}

/**
 * The absolute URL for one object in one workspace, or null.
 *
 * Null whenever the host is unknown, which is the case the whole module exists
 * for: a deployment whose `DATABRICKS_HOST` is unset still renders every
 * identifier it knows, just without anything to click.
 */
export function databricksLink(host: string, object: DatabricksObject): string | null {
  const base = normalizeWorkspaceHost(host);
  if (!base) return null;
  const path = workspacePath(object);
  return path ? `${base}${path}` : null;
}
