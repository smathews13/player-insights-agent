/**
 * What a Connections picker may ask the server for, and what it gets back.
 *
 * WHY THIS EXISTS. The Connections page used to take every remote identifier as
 * free text: a Genie space id, a warehouse id, a three-part Unity Catalog name.
 * The operator wants to pick from what their own sign-in can see. These types are
 * the wire contract for that listing. The picker UI lives elsewhere; this file
 * is what it and the server must agree on.
 *
 * THE CONSTRAINT THAT DECIDES THE SHAPE. This app runs with user-authorization,
 * so every browse call goes out as the signed-in reader. Catalog browse needs
 * `catalog.catalogs:read`, `catalog.schemas:read` and `catalog.tables:read`, and
 * notebook browse needs `workspace.workspace:read`. All four are optional on this app
 * ({@link OPTIONAL_USER_API_SCOPES}). A sign-in that does not carry them answers
 * HTTP 403. That is not "the list is empty" and not "the call broke": nothing
 * was established about which catalogs exist. The picker falls back to a text
 * input on that outcome alone.
 *
 * THREE OUTCOMES, KEPT APART:
 *
 *   ok            the workspace answered; `items` may be empty
 *   unavailable   browsing cannot run because the sign-in does not carry the
 *                 scope this list needs (or the app does not ask for it)
 *   failed        the call ran and failed for another reason, or could not be
 *                 asked at all (no host, no token, timeout, 5xx)
 *
 * Never sum unavailable and failed. Never render unavailable as an empty list.
 * Never report a list as performed when the call was not made.
 */

import { isOptionalUserApiScope } from './optional-user-api-scopes';

/** Asset families the Connections page can ask to browse. */
export type BrowseKind =
  | 'catalogs'
  | 'schemas'
  | 'tables'
  | 'volumes'
  | 'notebooks'
  | 'warehouses'
  | 'genie-spaces'
  | 'serving-endpoints'
  | 'vector-search-endpoints'
  | 'vector-search-indexes'
  | 'lakebase-projects'
  | 'lakebase-branches'
  | 'lakebase-databases'
  | 'experiments';

/**
 * One row a picker can show.
 *
 * `id` is what the Connections setting stores (warehouse id, Genie space id,
 * three-part table name, workspace path, serving endpoint name). `label` is what
 * a human reads. `secondary` is optional context (warehouse state, notebook
 * language, the task a serving endpoint serves).
 */
export interface BrowseItem {
  id: string;
  label: string;
  /** Extra context for the row, or '' when there is none. */
  secondary: string;
  /**
   * For notebooks: whether this row is a directory the picker may open next.
   * False for every other kind.
   */
  expandable: boolean;
}

/**
 * Why browsing is unavailable, in a fixed vocabulary the picker can switch on.
 *
 * `scope_not_carried` covers both "the token does not list it" and "the app does
 * not declare it, so no sign-in it hands out can carry it". The picker only needs
 * one branch: fall back to typing. The `scope` field names which permission.
 *
 * `apps_has_no_scope` is the harder stop: Databricks Apps rejects every name in
 * that API family (MLflow today), so there is nothing to grant and nothing to
 * declare. `scope` is empty; the detail says so in as many words.
 */
export type BrowseUnavailableReason = 'scope_not_carried' | 'apps_has_no_scope';

/** Successful list. Empty `items` means none visible, not that browsing failed. */
export interface BrowseOk {
  status: 'ok';
  kind: BrowseKind;
  items: BrowseItem[];
  /**
   * Pass back as `page_token` on the next request. Empty when there is no next
   * page. Notebooks have no page token; drill down with `path` instead.
   */
  next_page_token: string;
  /**
   * For notebooks: the directory that was listed. Empty for other kinds.
   */
  path: string;
}

/**
 * Browsing cannot run. Distinct from empty and from failed.
 *
 * HTTP 200 on purpose: this is a settled answer about capability, not an auth
 * failure of the app route itself. The picker reads `status` and falls back.
 */
export interface BrowseUnavailable {
  status: 'unavailable';
  kind: BrowseKind;
  reason: BrowseUnavailableReason;
  /**
   * The Apps-API scope name this list needs, or '' when {@link reason} is
   * `apps_has_no_scope` (there is no name Apps will accept).
   */
  scope: string;
  detail: string;
}

/** The call failed or was never made. Not a refusal of browsing capability. */
export interface BrowseFailed {
  status: 'failed';
  kind: BrowseKind;
  detail: string;
  /** Workspace or transport wording, when any. */
  error: string;
}

export type BrowseResponse = BrowseOk | BrowseUnavailable | BrowseFailed;

/**
 * One concrete category the signed-in reader can enumerate.
 *
 * A category is returned only when its user-scoped root API answered with at
 * least one visible resource. Denied, failed and genuinely empty roots stay in
 * `unavailable`, where the add form can explain why they are absent without
 * pretending the workspace has no resources.
 */
export interface ConnectionTypeAvailability {
  id:
    | 'catalog'
    | 'schema'
    | 'table'
    | 'sql-warehouse'
    | 'serving-endpoint'
    | 'genie-space'
    | 'vector-search-endpoint'
    | 'vector-search-index'
    | 'volume';
  label: string;
  rootKind: BrowseKind;
}

export interface ConnectionTypesResponse {
  available: ConnectionTypeAvailability[];
  unavailable: Array<{
    rootKind: BrowseKind;
    status: 'empty' | 'denied' | 'failed';
    detail: string;
  }>;
}

/** Type guard the picker uses before reading `items`. */
export function isBrowseOk(response: BrowseResponse): response is BrowseOk {
  return response.status === 'ok';
}

/** Type guard: fall back to a text input. */
export function isBrowseUnavailable(response: BrowseResponse): response is BrowseUnavailable {
  return response.status === 'unavailable';
}

/**
 * Prose for a scope the sign-in does not carry.
 *
 * No em dash. Names the scope so a reader can find it on the Connected as
 * section. Does not claim anything about whether the underlying objects exist.
 */
export function browseScopeUnavailableDetail(scope: string): string {
  return (
    `Browsing is unavailable because your sign-in does not carry \`${scope}\`. ` +
    'Nothing was established about which assets exist. Enter the value by hand, or sign in again ' +
    'after this app asks for that permission.'
  );
}

/**
 * Prose when Apps itself has no scope for this family.
 *
 * Distinct from {@link browseScopeUnavailableDetail}: there is nothing to put
 * on `user_api_scopes` and nothing a fresh sign-in can carry. Typing is the
 * only route, not a temporary fallback.
 */
export function browseAppsHasNoScopeDetail(family: string): string {
  return (
    `Browsing is unavailable because Databricks Apps has no ${family} scope to forward. ` +
    'Nothing was established about which assets exist. Enter the value by hand.'
  );
}

/**
 * Whether this scope is one a picker may be missing on purpose.
 *
 * Optional scopes are the case the Connections page was built around: asks
 * still work without them, browse does not. The three `catalog.*:read` scopes
 * and `workspace.workspace:read` are all in that set, so this answers for
 * notebook browse as well as for catalog browse despite the name it was given
 * first.
 */
export function isCatalogBrowseScope(scope: string): boolean {
  return isOptionalUserApiScope(scope);
}
