/**
 * Re-runs the table checks as the signed-in user instead of as the principal
 * that was granted access.
 *
 * Which scopes are in force is read from the token and from what the API says
 * about it, never asserted as a constant: a stated limitation outlives the
 * thing that caused it and goes on being given as a reason after it is false.
 */

import type { Request } from 'express';

/** Databricks Apps forwards the signed-in user's OAuth token under this name. */
export const USER_TOKEN_HEADER = 'x-forwarded-access-token';

export function forwardedUserToken(req: Request): string | null {
  const raw = req.header(USER_TOKEN_HEADER);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Why there is no user token, in terms of the layer somebody would go and fix.
 *
 * A workspace without the user-authorization preview, an app that was
 * redeployed instead of restarted, and a bug in this file all present
 * identically as "the checks did not run as me". Which was observed is
 * reported, because the three are fixed in different places.
 */
export type TokenDiagnosis =
  | { kind: 'present' }
  | { kind: 'absent-local'; summary: string; layer: string }
  | { kind: 'absent-in-apps'; summary: string; layer: string };

export function diagnoseUserToken(req: Request, isDevelopmentIdentity: boolean): TokenDiagnosis {
  if (forwardedUserToken(req)) return { kind: 'present' };
  if (isDevelopmentIdentity) {
    return {
      kind: 'absent-local',
      summary:
        'This session is not running behind Databricks Apps, so there is no signed-in ' +
        'user and nothing to forward a token for. Nothing is wrong with the deployment.',
      layer: 'local development',
    };
  }
  return {
    kind: 'absent-in-apps',
    summary:
      'Databricks Apps did not forward a user token with this request. The app is not ' +
      'acting on the user\u2019s behalf at all. This is a platform-side state, not a ' +
      'failure of any check. Either user authorization is not enabled for this workspace, ' +
      'or the app has not been stopped and started since `user_api_scopes` last changed. ' +
      'A redeploy alone does not apply a scope change.',
    layer: 'app configuration',
  };
}

/**
 * A token that arrives without the scope it needs looks like a broken app.
 *
 * It is not: `user_api_scopes` is applied when the app starts, so declaring
 * `sql` and redeploying leaves a token that is real, valid, and unable to run a
 * statement. The API says so in the error, which is the one place the
 * distinction is visible, so it gets read rather than flattened into "denied".
 */
export function looksLikeMissingScope(message: string): boolean {
  const text = message.toLowerCase();
  return (text.includes('does not have required scopes') ||
    text.includes('insufficient_scope') ||
    (text.includes('scope') && (text.includes('oauth') || text.includes('token')))
  );
}

/** The scope a forwarded token needs before Genie can be asked anything as the user. */
export const GENIE_SCOPE = 'dashboards.genie';

/** The CLI's own scope, which stands for every API rather than naming them. */
const ALL_APIS_SCOPE = 'all-apis';

/**
 * What the token says it can do, read off the token rather than asserted here.
 *
 * `null` means the token did not say: a PAT, an opaque token, an unrecognised
 * claim shape. Treating that as "said no" declines a check that would succeed.
 */
export function scopesFromToken(token: string): string[] | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  let claims: Record<string, unknown>;
  try {
    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const raw = claims?.scope ?? claims?.scopes;
  if (typeof raw === 'string') {
    const scopes = raw.split(/\s+/).filter(Boolean);
    return scopes.length ? scopes : null;
  }
  if (Array.isArray(raw)) {
    const scopes = raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return scopes.length ? scopes : null;
  }
  return null;
}

/**
 * Whether this token can be used to ask Genie anything, as three answers.
 *
 * `null` is the one that matters: a token that did not enumerate its scopes has
 * denied nothing, so the API is asked rather than the check declined on its
 * behalf with a reason nothing verified.
 */
export function tokenGrantsGenie(token: string): boolean | null {
  const scopes = scopesFromToken(token);
  if (!scopes) return null;
  return scopes.includes(GENIE_SCOPE) || scopes.includes(ALL_APIS_SCOPE);
}

/**
 * The command that would fix one refusal, in the form its object actually takes.
 *
 * Mirrors `Remedy` in `agent/preflight.py` down to the shape of the CLI call,
 * because that module owns the mapping from a failure to the grant that clears
 * it. The only difference is the principal: preflight grants the serving
 * principal, this grants the person reading the screen.
 */
export interface Remedy {
  /** `sql` runs in a SQL editor; `cli` is a Databricks CLI call; `ui` is a click path. */
  kind: 'sql' | 'cli' | 'ui';
  statement: string;
  note: string;
}

/** Backtick-quote one identifier part, escaping any backtick inside it. */
function quote(part: string): string {
  return '`' + part.replace(/`/g, '``') + '`';
}

function quotedName(fullName: string): string {
  return fullName.split('.').map(quote).join('.');
}

/**
 * The three grants somebody needs to read one table.
 *
 * All three every time rather than probing which one is absent, because the
 * traversal privileges are idempotent. Same statement text as `table_grant` in
 * `agent/preflight.py`.
 */
export function tableGrant(table: string, principal: string): Remedy {
  const parts = table.split('.');
  const target = quote(principal);
  const statements: string[] = [];
  if (parts.length >= 3) {
    statements.push(`GRANT USE CATALOG ON CATALOG ${quote(parts[0])} TO ${target};`);
    statements.push(`GRANT USE SCHEMA ON SCHEMA ${quote(parts[0])}.${quote(parts[1])} TO ${target};`);
  }
  statements.push(`GRANT SELECT ON TABLE ${quotedName(table)} TO ${target};`);
  return {
    kind: 'sql',
    statement: statements.join('\n'),
    note:
      'Unity Catalog hides objects the caller cannot traverse, so a missing USE CATALOG ' +
      'or USE SCHEMA reads as a missing table. All three are listed because any of them ' +
      'can be the one that is absent. Whoever owns the catalog can run these: the owner ' +
      'is on the catalog\u2019s Permissions tab in Catalog Explorer. If the catalog is not ' +
      'visible to you at all, a metastore admin has to make the grant.',
  };
}

/** The `access_control_list` key that matches this kind of principal. */
function aclField(principal: string): string {
  return principal.includes('@') ? 'user_name' : 'service_principal_name';
}

/**
 * A warehouse is a workspace object, not a Unity Catalog securable, so there is
 * no SQL GRANT for it and offering one would send the reader to a statement
 * that cannot work.
 */
export function warehouseGrant(warehouseId: string, principal: string): Remedy {
  return {
    kind: 'cli',
    statement:
      `databricks permissions update warehouses ${warehouseId} --json '` +
      `{"access_control_list":[{"${aclField(principal)}":"${principal}",` +
      `"permission_level":"CAN_USE"}]}'`,
    note:
      'SQL warehouses are workspace objects rather than Unity Catalog securables, so ' +
      'this CLI call is the equivalent of a GRANT. In the UI: SQL Warehouses \u2192 the ' +
      'warehouse \u2192 Permissions \u2192 Can use.',
  };
}

/**
 * The entitlement without which no statement runs as the reader, whatever the
 * warehouse's own ACL says.
 *
 * Not a grant. A workspace entitlement is an account-level assignment on the
 * identity, so nothing in the bundle, the app's resources, or a `GRANT`
 * statement reaches it. The Statement Execution API refuses a caller who lacks
 * it with the same bare `403` and empty body as one who lacks `CAN_USE`, so the
 * two are indistinguishable in the response, so SCIM has to be read to tell them
 * apart. A workspace admin's own rights are evaluated implicitly, but the
 * forwarded on-behalf-of token gets none of that, so an admin can be refused here
 * while their own CLI calls succeed.
 */
export const SQL_ACCESS_ENTITLEMENT = 'databricks-sql-access';

/**
 * The entitlement without which the reader would not have reached this app at
 * all, listed with the other because the patch that adds one should add both.
 */
export const WORKSPACE_ACCESS_ENTITLEMENT = 'workspace-access';

/**
 * Left obviously unfilled rather than guessed, on the same reasoning as
 * {@link UNKNOWN_PRINCIPAL}: SCIM patches by numeric id, not by email, and a
 * patch aimed at the wrong id is a patch that runs.
 */
export const UNKNOWN_USER_ID = '<numeric-user-id>';

/**
 * The SCIM patch that adds the entitlements, in the form the API takes.
 *
 * Both entitlements every time rather than only the absent one, for the same
 * reason {@link tableGrant} lists all three privileges: `add` is idempotent.
 *
 * A CLI call because there is no SQL form of this, and not a UI click path
 * because the Admin Settings page shows entitlements per GROUP by default,
 * which reads a user with none of their own as having both.
 */
export function entitlementGrant(userId: string | null): Remedy {
  const target = userId && userId.trim() ? userId.trim() : UNKNOWN_USER_ID;
  return {
    kind: 'cli',
    statement:
      `databricks api patch /api/2.0/preview/scim/v2/Users/${target} --json '` +
      '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],' +
      '"Operations":[{"op":"add","path":"entitlements","value":[' +
      `{"value":"${SQL_ACCESS_ENTITLEMENT}"},{"value":"${WORKSPACE_ACCESS_ENTITLEMENT}"}]}]}'`,
    note:
      'Run as a workspace or account admin. The id is the numeric SCIM id, not an email; ' +
      '`databricks api get "/api/2.0/preview/scim/v2/Users?filter=userName+eq+<email>"` returns ' +
      'it, and confirms the patch landed. Entitlements can be held through a group, so read the ' +
      'account\u2019s own rather than the group\u2019s.',
  };
}

/**
 * The grant that lets somebody ask a Genie space a question.
 */
export function genieSpaceGrant(spaceId: string, principal: string): Remedy {
  return {
    kind: 'cli',
    statement:
      `databricks permissions update genie ${spaceId} --json '` +
      `{"access_control_list":[{"${aclField(principal)}":"${principal}",` +
      `"permission_level":"CAN_RUN"}]}'`,
    note:
      'In the UI: open the space \u2192 Share \u2192 add the person with Can run. Permissions are ' +
      'inherited from the folder the space lives in, so a grant on that folder covers every ' +
      'space inside it and may be what an admin would rather do.',
  };
}

/** What is missing, named the way the object itself names it. */
export interface MissingGrant {
  /**
   * Fully qualified: `catalog.schema.table`, a warehouse id, a Genie space id.
   *
   * For a `workspace-entitlement` it is the PERSON, not an object: an
   * entitlement is an assignment on an identity rather than a privilege on a
   * securable, so the account is what is short of something.
   */
  object: string;
  /** `SELECT`, `USE CATALOG`, `USE SCHEMA`, `CAN_USE`, `databricks-sql-access`. */
  permission: string;
  objectKind:
    | 'table'
    | 'catalog'
    | 'schema'
    | 'sql-warehouse'
    | 'genie-space'
    | 'workspace-entitlement';
}

export interface TableVerdict {
  table: string;
  status: 'ok' | 'denied' | 'error';
  detail: string;
  /**
   * The exact object and permission, when the answer was no.
   *
   * Fully qualified, and the privilege is not always SELECT: a refusal naming
   * the catalog is a missing USE CATALOG, and granting SELECT on a table inside
   * a catalog the reader cannot enter does not clear it.
   */
  missing?: MissingGrant;
  /** The statement that would clear this one. */
  remedy?: Remedy;
  /**
   * Whether the grant is known to be missing, or whether the object is hidden
   * in a way that cannot be told apart from it being absent.
   */
  reason?: 'no-grant' | 'hidden-or-absent';
  /** The API's own words, verbatim, so nobody has to take this classification on trust. */
  apiMessage?: string;
}

/**
 * The seven ways this can stop for a reason that is not about any one table.
 *
 * Kept apart because each sends the reader somewhere different. The deployment
 * states do not read as "you lack permission": nothing about the reader's
 * access was established either way, so reporting a denial there is a claim
 * about something never asked. See {@link classifyWarehouseStatus} for the
 * reverse error.
 */
export type BlockedKind =
  /** Apps forwarded no token. Either the preview is off, or the app was not restarted. */
  | 'no-user-token'
  /** A real token arrived without the `sql` scope. A deployment state, not a grant. */
  | 'no-sql-scope'
  /** The token itself was refused. Not a grant, and not something an admin can grant. */
  | 'token-rejected'
  /** The token works and the warehouse refused it. One grant, not ten. */
  | 'warehouse-denied'
  /**
   * The same refusal, established to be the entitlement rather than the ACL.
   * A real thing the reader is short of, and one no warehouse grant fixes.
   */
  | 'no-sql-entitlement'
  /** The warehouse id resolves to nothing. A configured value, not a permission. */
  | 'warehouse-missing'
  /** The warehouse, or the endpoint behind the table list, did not answer. */
  | 'dependency-down'
  /** Something the app needs in order to check at all is not configured. */
  | 'not-configured';

/**
 * The status each block gets.
 */
export const BLOCKED_STATUS: Record<BlockedKind, number> = {
  'no-user-token': 409,
  'no-sql-scope': 409,
  'token-rejected': 401,
  'warehouse-denied': 403,
  // A denial like `warehouse-denied` and for the same reason: somebody was
  // asked about and told no. The object it is about is the account rather than
  // the warehouse, which changes the remedy and not the status.
  'no-sql-entitlement': 403,
  'warehouse-missing': 503,
  'dependency-down': 503,
  'not-configured': 503,
};

/**
 * The status for a whole outcome: the block's own, or `403` for a real denial.
 *
 * A run with no block that still did not verify was denied a table or a Genie
 * space, and that is the one case `403` was always right for.
 */
export function statusForOutcome(outcome: VerificationOutcome): number {
  return outcome.blocked ? BLOCKED_STATUS[outcome.blocked.kind] : 403;
}

export interface Blocked {
  summary: string;
  /** The layer somebody would go and fix, in the words they would use for it. */
  layer: string;
  kind: BlockedKind;
  missing?: MissingGrant;
  remedy?: Remedy;
  apiMessage?: string;
}

/**
 * Something this run did not establish, stated so a pass is not read as more
 * than it is.
 *
 * Two of the things it cannot prove (Genie space membership under the user's
 * own token, and row filters), degrade an answer quietly rather than fail it,
 * so a pass that did not cover them says so.
 */
export interface NotChecked {
  what: string;
  why: string;
  /** What was learned instead, when something was, and as whom. */
  insteadAs?: string;
}

export interface VerificationOutcome {
  verdicts: TableVerdict[];
  ok: number;
  denied: number;
  errored: number;
  /** Set when the run stopped for a reason that is not about any one table. */
  blocked?: Blocked;
  /**
   * Set when a `SELECT 1` ran on the warehouse under the caller's own token and
   * succeeded.
   *
   * This is the only positive evidence a run with no table list produces, so it
   * is recorded rather than inferred from an absent {@link blocked}: an outcome
   * that never probed a warehouse also has no block, and must not read the same.
   */
  warehouseVerified?: boolean;
  /** What this result means for the answers, in reading order. */
  impact?: string[];
  notChecked?: NotChecked[];
  /**
   * One entry per Genie space asked about under the caller's own token.
   *
   * Empty when the app could not ask at all, in which case the reason is in
   * {@link notChecked}. The two are not interchangeable and the client must
   * not render an absent list as a set of passes.
   */
  genie?: GenieVerdict[];
}

/**
 * The cheapest statement that still proves SELECT.
 */
export function probeStatement(table: string): string {
  return `SELECT 1 FROM ${table} WHERE 1=0`;
}

/**
 * Wording the API uses when the answer is a permission, not an absence.
 *
 * `SQLSTATE: 42501` is the reliable half of this list: it is the SQL standard's
 * "insufficient privilege" class and the platform emits it on the
 * `[INSUFFICIENT_PERMISSIONS]` path. The prose markers beside it are the
 * variants observed on the same responses.
 */
const PERMISSION_MARKERS = [
  'insufficient_permissions',
  'permission_denied',
  'sqlstate: 42501',
  'is not accessible',
  'not authorized',
  'does not have',
] as const;

/**
 * Wording the API uses when the object was not resolvable.
 *
 * These do NOT mean the object is absent. Unity Catalog hides what the caller
 * cannot traverse, so a missing `USE CATALOG` surfaces here rather than above,
 * and claiming to tell the two apart would be inventing certainty. What can be
 * said honestly is which of the two readings the API's own words support, and
 * these two lists are that distinction and nothing more.
 */
const ABSENCE_MARKERS = ['table_or_view_not_found', 'cannot be found', 'no such table'] as const;

/**
 * A refusal that names the catalog rather than the table.
 *
 * Transcribed from a real `[INSUFFICIENT_PERMISSIONS]` response ("Catalog
 * 'main' is not accessible in current workspace"), and it matters because the
 * grant that fixes it is `USE CATALOG`, not `SELECT`. Telling somebody to
 * grant themselves SELECT on a table inside a catalog they cannot enter is a
 * statement that runs, changes nothing they can observe, and sends them back.
 */
const CATALOG_REFUSED = /catalog\s+'([^']+)'\s+is not accessible/i;
const SCHEMA_REFUSED = /schema\s+'([^']+)'\s+is not accessible/i;

function matches(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

export type Denial =
  | { kind: 'no-grant'; object: string; objectKind: 'catalog' | 'schema' | 'table'; permission: string }
  | { kind: 'hidden-or-absent' }
  | { kind: 'unrecognised' };

/**
 * Which of the failure modes one API message is, without flattening them.
 *
 * Permission wording is read before absence wording, because the platform
 * emits both in the same message on some paths and the permission half is the
 * more specific claim: `[INSUFFICIENT_PERMISSIONS]` names a privilege, whereas
 * `[TABLE_OR_VIEW_NOT_FOUND]` is the one that could mean either thing.
 */
export function classifyDenial(message: string, table: string): Denial {
  const text = message.toLowerCase();
  if (matches(text, PERMISSION_MARKERS)) {
    const catalog = CATALOG_REFUSED.exec(message);
    if (catalog) {
      return { kind: 'no-grant', object: catalog[1], objectKind: 'catalog', permission: 'USE CATALOG' };
    }
    const schema = SCHEMA_REFUSED.exec(message);
    if (schema) {
      return { kind: 'no-grant', object: schema[1], objectKind: 'schema', permission: 'USE SCHEMA' };
    }
    return { kind: 'no-grant', object: table, objectKind: 'table', permission: 'SELECT' };
  }
  if (matches(text, ABSENCE_MARKERS)) return { kind: 'hidden-or-absent' };
  return { kind: 'unrecognised' };
}

/**
 * One table's answer, with the object, the privilege, and the statement that
 * would change it, rather than a red cross the reader has to go and decode.
 */
function classify(message: string, table: string, principal: string): TableVerdict {
  const denial = classifyDenial(message, table);
  if (denial.kind === 'unrecognised') {
    return {
      table,
      status: 'error',
      detail:
        `The check did not complete, so your access to ${table} is unknown rather than ` +
        'refused. This is not a permission result and should not be read as one.',
      apiMessage: message,
    };
  }
  if (denial.kind === 'hidden-or-absent') {
    return {
      table,
      status: 'denied',
      detail:
        `${table} did not resolve for you. Unity Catalog hides objects it cannot traverse, ` +
        'so a missing grant and a table that is not there report identically. This is ' +
        'either no SELECT, no USE SCHEMA on the schema, no USE CATALOG on the catalog, or a ' +
        'table that genuinely does not exist. The grants below cover the first three; if ' +
        'they run and this still fails, the table is the one that is missing.',
      missing: { object: table, permission: 'SELECT', objectKind: 'table' },
      remedy: tableGrant(table, principal),
      reason: 'hidden-or-absent',
      apiMessage: message,
    };
  }
  const scope =
    denial.objectKind === 'table'
      ? `${denial.permission} on ${denial.object}`
      : `${denial.permission} on ${denial.objectKind} ${denial.object}, which ${table} is inside`;
  return {
    table,
    status: 'denied',
    detail:
      `You do not hold ${scope}. The API said so in those terms rather than hiding the ` +
      'object, so this is a grant that is missing and not a table that is absent.',
    missing: { object: denial.object, permission: denial.permission, objectKind: denial.objectKind },
    remedy: tableGrant(table, principal),
    reason: 'no-grant',
    apiMessage: message,
  };
}

/**
 * What one probe came back with, including the status code when there was one.
 *
 * `status` is carried separately rather than folded into `message` because the
 * SQL Statement Execution API refuses a warehouse with a bare 403 and often no
 * body, making the message the literal string `HTTP 403`. That matches no
 * permission wording, so classifying on prose alone reads a refusal as a
 * warehouse that never answered.
 *
 * Absent when the request never reached an HTTP response (a dead socket, a
 * timeout) or when the failure came back inside a 200 as a FAILED statement.
 */
export type ProbeResult = { ok: true } | { ok: false; message: string; status?: number };

export interface StatementRunner {
  (table: string): Promise<ProbeResult>;
}

/**
 * Left obviously unfilled rather than guessed, on the same reasoning as
 * `UNKNOWN_PRINCIPAL` in the agent's preflight: a GRANT naming the wrong
 * principal is worse than one the reader has to complete, because it runs.
 */
export const UNKNOWN_PRINCIPAL = '<your-username>';

/** The one block that is a deployment state wearing a permission error's clothes. */
function missingScopeBlock(apiMessage: string): Blocked {
  return {
    kind: 'no-sql-scope',
    summary:
      'Your token reached Databricks and was refused for lacking the `sql` scope, so no ' +
      'statement was run and nothing about your own permissions was established. This is ' +
      'not a permission you are missing. It is a scope the app is missing, and no grant ' +
      'made to you will change it.',
    layer: 'app configuration',
    remedy: {
      kind: 'cli',
      statement:
        '# 1. `sql` must be in user_api_scopes (resources/player_insights_app.app.yml).\n' +
        '# 2. A scope is applied when the app STARTS. A redeploy leaves it inert:\n' +
        'databricks apps stop <app-name>\n' +
        'databricks apps start <app-name>',
      note:
        'Adding a scope needs a full stop and start, not a redeploy, which is why a ' +
        'deployment that looks completely healthy can still forward a token that cannot ' +
        'run a statement.',
    },
    apiMessage,
  };
}

/**
 * How long the whole set of table probes may take before the rest are given up.
 *
 * The probes are sequential and each is bounded on its own, which multiplies:
 * ten tables against a warehouse answering slowly is minutes of a spinner, and
 * the user is sitting at the access gate waiting to be let in. Well clear of the
 * real shape of this (the first statement pays the wake-up cost, around 30 s
 * cold, and the rest come back in well under a second each), so a healthy
 * deployment never reaches it.
 */
export const VERIFICATION_BUDGET_MS = 120_000;

export interface VerifyTableAccessOptions {
  /** Total wall clock for all probes. Defaults to {@link VERIFICATION_BUDGET_MS}. */
  budgetMs?: number;
  now?: () => number;
}

/**
 * Run one probe per table and report each on its own.
 *
 * A table the budget ran out before is reported as errored and named as such,
 * never quietly dropped: `isVerified` requires every table to have passed, so an
 * unfinished check has to count as a no rather than shrinking the set that had
 * to pass.
 */
export async function verifyTableAccess(tables: readonly string[],
  run: StatementRunner,
  principal: string = UNKNOWN_PRINCIPAL,
  options: VerifyTableAccessOptions = {}
): Promise<VerificationOutcome> {
  const budgetMs = options.budgetMs ?? VERIFICATION_BUDGET_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const verdicts: TableVerdict[] = [];
  for (const table of tables) {
    if (now() - startedAt >= budgetMs) {
      verdicts.push({
        table,
        status: 'error',
        detail:
          `Not checked: the access check reached its ${Math.round(budgetMs / 1000)} s budget after ` +
          `${verdicts.length} table(s). Nothing is known about your access to ${table} either way.`,
      });
      continue;
    }
    let result: Awaited<ReturnType<StatementRunner>>;
    try {
      result = await run(table);
    } catch (error) {
      result = { ok: false, message: (error as Error).message };
    }
    if (result.ok) {
      verdicts.push({
        table,
        status: 'ok',
        detail: `SELECT on ${table} succeeded under your own token.`,
      });
      continue;
    }
    if (looksLikeMissingScope(result.message)) {
      return { verdicts, ...tally(verdicts), blocked: missingScopeBlock(result.message) };
    }
    verdicts.push(classify(result.message, table, principal));
  }
  return { verdicts, ...tally(verdicts) };
}

/**
 * What SCIM says the reader's account carries, or why it did not say.
 *
 * `unavailable` is the load-bearing member. A token that cannot read this user
 * has established nothing about their entitlements, and reading that silence
 * as "no entitlement" would replace one confident wrong answer with another,
 * which is the whole failure being fixed here, pointed at a different object.
 */
export type EntitlementReading =
  | { kind: 'read'; entitlements: string[]; userId: string | null }
  | { kind: 'unavailable'; why: string };

export interface EntitlementLookup {
  (email: string): Promise<EntitlementReading>;
}

/**
 * One workspace API GET, so the transport stays out of this module.
 *
 * The query is a separate argument rather than part of the path because the
 * Databricks SDK assigns `path` straight onto `URL.pathname`, which
 * percent-encodes a `?` into the path instead of starting a query string. A
 * filter smuggled into the path therefore reaches the API as part of the
 * resource name and comes back 404: an "unavailable" reading that looks like
 * a permissions problem and is a URL bug.
 */
export interface WorkspaceApiGet {
  (path: string, query: Record<string, string>): Promise<unknown>;
}

/**
 * Where the entitlements are readable, which is not where the grants are.
 *
 * The preview SCIM path is the only one that reports them; `current-user me`
 * and the permissions API both answer without ever mentioning entitlements,
 * which is part of why their absence goes unnoticed for so long.
 */
export const SCIM_USERS_PATH = '/api/2.0/preview/scim/v2/Users';

/**
 * The filter, unquoted, which is the form verified against a workspace and the
 * form the remedy note tells a reader to run by hand. An address needs no
 * quoting (SCIM quotes exist for values containing spaces, and an email has
 * none), and matching that command exactly means the reader reproducing this
 * check by hand runs the same query the app ran.
 */
export function scimUserFilter(email: string): Record<string, string> {
  return { filter: `userName eq ${email}` };
}

/**
 * The entitlements out of a SCIM user search, without inventing any.
 *
 * A filter that matched nobody is `unavailable`, not "no entitlements". The
 * caller may simply not be allowed to see other users (a non-admin token can
 * generally read itself and nothing else), and a lookup that came back empty
 * for that reason must not be turned into a finding about the reader.
 */
export function readScimEntitlements(body: unknown): EntitlementReading {
  const resources = (body as { Resources?: unknown } | null)?.Resources;
  if (!Array.isArray(resources) || resources.length === 0) {
    return {
      kind: 'unavailable',
      why:
        'the SCIM search returned no user for that address, so this token either cannot ' +
        'read that account or the address is not the one Databricks knows them by',
    };
  }
  const user = resources[0] as { id?: unknown; entitlements?: unknown };
  const entitlements = Array.isArray(user.entitlements)
    ? user.entitlements
        .map((entry) =>
          typeof entry === 'string' ? entry : ((entry as { value?: unknown } | null)?.value ?? null)
        )
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  return {
    kind: 'read',
    entitlements,
    userId: typeof user.id === 'string' && user.id ? user.id : null,
  };
}

/**
 * A lookup over whatever can make a workspace API call, refusals included.
 *
 * Every failure lands on `unavailable` with the reason attached rather than
 * throwing, because this runs inside a path that is already reporting a
 * refusal and a second failure must degrade the message rather than replace it
 * with a stack trace.
 */
export function entitlementLookupVia(get: WorkspaceApiGet): EntitlementLookup {
  return async (email: string): Promise<EntitlementReading> => {
    if (!email || !email.includes('@')) {
      return {
        kind: 'unavailable',
        why: 'the signed-in identity is not an email address, so there is nothing to look up',
      };
    }
    try {
      return readScimEntitlements(await get(SCIM_USERS_PATH, scimUserFilter(email)));
    } catch (error) {
      return { kind: 'unavailable', why: `the SCIM call failed: ${(error as Error).message}` };
    }
  };
}

/**
 * Which of the two causes of a bare 403 this one was, asked only once it has
 * happened.
 *
 * Only on the refusal, never before it. The happy path is the one everybody
 * takes, and paying a SCIM round trip on it to pre-empt a failure that has not
 * occurred would slow every sign-in to improve one message.
 */
async function refineWarehouseDenial(warehouseId: string,
  principal: string,
  apiMessage: string,
  lookup: EntitlementLookup | undefined
): Promise<Blocked> {
  if (!lookup) return warehouseDeniedBlock(warehouseId, principal, apiMessage);
  let reading: EntitlementReading;
  try {
    reading = await lookup(principal);
  } catch (error) {
    reading = { kind: 'unavailable', why: `the lookup threw: ${(error as Error).message}` };
  }
  if (reading.kind === 'unavailable') {
    return warehouseDeniedBlock(warehouseId, principal, apiMessage, {
      kind: 'unknown',
      why: reading.why,
    });
  }
  if (reading.entitlements.includes(SQL_ACCESS_ENTITLEMENT)) {
    return warehouseDeniedBlock(warehouseId, principal, apiMessage, { kind: 'held' });
  }
  return entitlementDeniedBlock(warehouseId, principal, reading.userId, apiMessage);
}

/**
 * Ask the warehouse a question with no table in it, before asking it ten with.
 *
 * `SELECT 1` names nothing, so its refusal cannot be about a table. That is a
 * structural distinction rather than a guess about wording, which is why it
 * comes first.
 */
export async function verifyWarehouseAccess(warehouseId: string,
  probe: () => Promise<ProbeResult>,
  principal: string = UNKNOWN_PRINCIPAL,
  entitlements?: EntitlementLookup
): Promise<Blocked | null> {
  let result: Awaited<ReturnType<typeof probe>>;
  try {
    result = await probe();
  } catch (error) {
    result = { ok: false, message: (error as Error).message };
  }
  if (result.ok) return null;
  // Read before the status, and only this one. A scope failure arrives as a 403
  // like a missing grant does, and the two have different fixes made by
  // different people, but the body says which, and the code cannot.
  if (looksLikeMissingScope(result.message)) return missingScopeBlock(result.message);

  const byStatus = classifyWarehouseStatus(result.status, warehouseId, principal, result.message);
  // A denial read off the STATUS is the ambiguous one, and the only one worth
  // a second question. The API sent a bare 403 with no body, so the code is
  // all there was, and two different things produce it. The other three
  // (401, 404, and the codes that fall through) are unambiguous and are left
  // exactly as they were.
  if (byStatus) {
    return byStatus.kind === 'warehouse-denied'
      ? refineWarehouseDenial(warehouseId, principal, result.message, entitlements)
      : byStatus;
  }

  // Not refined. This branch is reached only when the response carried
  // permission wording, and a missing entitlement does not produce wording,
  // it produces the empty 403 handled above. Asking SCIM here would cost a
  // round trip to answer a question the body has already answered.
  if (matches(result.message.toLowerCase(), PERMISSION_MARKERS)) {
    return warehouseDeniedBlock(warehouseId, principal, result.message);
  }
  return {
    kind: 'dependency-down',
    summary:
      `SQL warehouse ${warehouseId} did not answer \`SELECT 1\`, and did not refuse it for a ` +
      'permission either. It is most likely stopped, starting, or unhealthy. Nothing about ' +
      'your permissions was established; try again once it is running.',
    layer: 'SQL warehouse availability',
    apiMessage: result.message,
  };
}

/**
 * What was established about the OTHER thing that produces this 403.
 *
 * Absent means the question was never asked (a refusal that carried
 * permission wording, or a deployment with no lookup wired), and the message
 * then says exactly what it said before this distinction existed.
 */
type EntitlementNote = { kind: 'held' } | { kind: 'unknown'; why: string };

/**
 * The refusal that means one grant on one workspace object, and nothing else.
 *
 * The claim in the first sentence is the one that was wrong on screen for a
 * reader who held `CAN_USE` and lacked `databricks-sql-access`, so it is now
 * qualified by whatever was actually established. It still leads with CAN_USE,
 * because that remains the commonest cause and the remedy below it is the one
 * that fixes it, but it no longer asserts it as the only reading when nothing
 * ruled the other one out.
 */
function warehouseDeniedBlock(warehouseId: string,
  principal: string,
  apiMessage: string,
  entitlement?: EntitlementNote
): Blocked {
  const base =
    `You do not hold CAN_USE on SQL warehouse ${warehouseId}, so no statement could be ` +
    'run as you at all. No table was checked, and none of them should be assumed either ' +
    'way. This is one missing grant on one workspace object, not a verdict on your ' +
    'Unity Catalog access.';
  const qualifier =
    entitlement?.kind === 'held'
      ? ` Your account does carry the \`${SQL_ACCESS_ENTITLEMENT}\` entitlement, which is ` +
        'checked because a missing one is refused identically, so the warehouse\u2019s own ' +
        'permissions really are the thing to look at.'
      : entitlement?.kind === 'unknown'
        ? ` A missing \`${SQL_ACCESS_ENTITLEMENT}\` entitlement produces this exact refusal ` +
          `and could not be checked here (${entitlement.why}), so it is not ruled out. Read it ` +
          'before anybody edits the warehouse ACL:\n' +
          '  databricks api get "/api/2.0/preview/scim/v2/Users?filter=userName+eq+<email>"'
        : '';
  return {
    kind: 'warehouse-denied',
    summary: `${base}${qualifier}`,
    layer: 'SQL warehouse permissions',
    missing: { object: warehouseId, permission: 'CAN_USE', objectKind: 'sql-warehouse' },
    remedy: warehouseGrant(warehouseId, principal),
    apiMessage,
  };
}

/**
 * The same 403, established to be the entitlement rather than the ACL.
 */
function entitlementDeniedBlock(warehouseId: string,
  principal: string,
  userId: string | null,
  apiMessage: string
): Blocked {
  return {
    kind: 'no-sql-entitlement',
    summary:
      `Your account does not carry the \`${SQL_ACCESS_ENTITLEMENT}\` entitlement, so no SQL ` +
      'statement can run as you anywhere in this workspace. This was read from SCIM, not ' +
      'inferred from the refusal. An entitlement is an assignment on your identity, not a ' +
      `permission on warehouse ${warehouseId}, and no CAN_USE added to that warehouse would ` +
      'change it. A workspace admin can grant it with the command below. No table was checked.',
    layer: 'workspace entitlements',
    missing: {
      object: principal,
      permission: SQL_ACCESS_ENTITLEMENT,
      objectKind: 'workspace-entitlement',
    },
    remedy: entitlementGrant(userId),
    apiMessage,
  };
}

/**
 * What the warehouse probe's HTTP status means, when there was one.
 *
 * The codes are kept apart rather than grouped because each sends a different
 * person somewhere different: 403 is an admin granting `CAN_USE`, 401 is a
 * session or a token that no grant would fix, and 404 is a configured id that
 * resolves to nothing. Returning `null` leaves the message to be read as
 * before, which is right for a 5xx, for a 200 whose statement failed, and for
 * a request that never got a response at all.
 */
export function classifyWarehouseStatus(status: number | undefined,
  warehouseId: string,
  principal: string,
  apiMessage: string
): Blocked | null {
  if (status === undefined) return null;
  if (status === 403) return warehouseDeniedBlock(warehouseId, principal, apiMessage);
  if (status === 401) {
    return {
      kind: 'token-rejected',
      summary:
        'Databricks refused your forwarded token itself (HTTP 401) before it considered any ' +
        'permission, so no statement was run and nothing about your own access was ' +
        'established. This is not a permission you are missing and no grant made to you ' +
        'would change it. The token is expired, revoked, or not valid for this workspace.',
      layer: 'the forwarded user token',
      remedy: {
        kind: 'ui',
        statement:
          'Reload this page to pick up a fresh token. If it persists, sign out of the\n' +
          'workspace and back in, then open the app again.',
        note:
          'Databricks Apps mints the forwarded token and refreshes it with the session, so a ' +
          'token this app is handed can be stale without anything being wrong with the ' +
          'deployment or with your grants. If a reload and a fresh sign-in do not clear it, ' +
          'the app itself needs a stop and start.',
      },
      apiMessage,
    };
  }
  if (status === 404) {
    return {
      kind: 'warehouse-missing',
      summary:
        `Databricks has no SQL warehouse \`${warehouseId}\` to answer for (HTTP 404). Either ` +
        'that id does not exist in this workspace, or it is not visible to you at all. The ' +
        'API reports both the same way and this cannot tell them apart. Either way no ' +
        'statement was run, and nothing about your permissions was established.',
      layer: 'SQL warehouse configuration',
      remedy: {
        kind: 'cli',
        statement: `databricks warehouses get ${warehouseId}`,
        note:
          'Run as somebody who administers the workspace. If it returns a warehouse, the id ' +
          'is right and the problem is that it is not visible to you; if it also reports the ' +
          'id as absent, the app is configured with a warehouse that no longer exists and ' +
          'whoever deployed it has to correct that. This is not a grant you can be given.',
      },
      apiMessage,
    };
  }
  return null;
}

/**
 * What a partial result means for the answers, rather than what it counts to.
 *
 * "8 of 10" is a score. The reader needs the consequence, and the consequence
 * here is specific and documented: a Genie space fails as a whole when one
 * table it curates is unreadable, and the agent then falls back to direct SQL
 * over what it can reach: a narrower source, delivered in exactly the same
 * voice as a complete one. That is the degradation worth naming before
 * somebody starts asking questions, not after.
 */
export function describeImpact(outcome: VerificationOutcome, total: number): string[] {
  const lines: string[] = [];
  if (outcome.blocked) return lines;
  const readable =
    outcome.ok === total
      ? `You can read all ${total} of the tables these answers are built from.`
      : `You can read ${outcome.ok} of the ${total} tables these answers are built from.`;
  lines.push(readable);
  if (outcome.denied > 0) {
    lines.push('Genie is all-or-nothing per space: a space fails as a whole if a single table it ' +
        'curates is unreadable. A question that would have been answered by Genie will ' +
        'therefore either fail outright, or fall back to direct SQL over the tables that ' +
        'do resolve: a narrower source, answered in the same voice as a complete one.'
    );
  }
  if (outcome.errored > 0) {
    lines.push(`${outcome.errored} table${outcome.errored === 1 ? '' : 's'} could not be checked at all, ` +
        'so your access to them is unknown rather than refused. Treat them as neither until ' +
        'the check completes.'
    );
  }
  return lines;
}

/** One Genie space, asked about under the caller's own token. */
export interface GenieVerdict {
  space: string;
  label: string;
  status: 'ok' | 'denied' | 'error';
  detail: string;
  missing?: MissingGrant;
  remedy?: Remedy;
  reason?: 'no-grant' | 'hidden-or-absent';
  apiMessage?: string;
}

/**
 * What the Genie half of the check came back with, as a whole.
 *
 * The per-space verdicts and the reason there are none are different things
 * and are carried separately, because "no space passed" and "no space was
 * asked about" are the two answers this gate has historically confused. An
 * empty `verdicts` with a `notChecked` beside it is the second, and it must
 * never read as the first.
 */
export interface GenieOutcome {
  verdicts: GenieVerdict[];
  notChecked?: NotChecked;
}

/**
 * A 200 that named the space, or a refusal with the status it arrived with.
 */
export type GenieProbeResult =
  | { ok: true; space: string | null }
  | { ok: false; message: string; status?: number };

export interface GenieSpace {
  id: string;
  label: string;
}

/**
 * The scope limitation, stated only when something actually observed says so.
 *
 * `evidence` is what said it (the token's own scope claim, or the API's
 * refusal), so the reader can tell a deduction from a guess. The remedy is a
 * stop and start rather than a redeploy for the same reason as
 * {@link missingScopeBlock}: `user_api_scopes` is applied when the app starts,
 * so a deployment that looks completely healthy can still forward a token that
 * cannot read a space.
 */
export function missingGenieScopeLimit(evidence: string): NotChecked {
  return {
    what: 'Whether the Genie spaces are shared with you.',
    why:
      `Reading a Genie space needs the \`${GENIE_SCOPE}\` scope on the forwarded token, and ` +
      `this token does not carry it (${evidence}). That is a scope the app is missing ` +
      'rather than a permission you are missing, and no grant made to you would change it. ' +
      `Add \`${GENIE_SCOPE}\` to \`user_api_scopes\`, then STOP and START the app: a scope is ` +
      'applied when the app starts, and a redeploy leaves it inert.',
  };
}

/**
 * One space's answer, read from the status first and the prose second.
 */
export function classifyGenieProbe(result: GenieProbeResult,
  space: GenieSpace,
  principal: string
): GenieVerdict {
  const base = { space: space.id, label: space.label };
  if (result.ok) {
    if (result.space) {
      return {
        ...base,
        status: 'ok',
        detail:
          `${space.label} resolved under your own token, so you hold at least CAN RUN on it. ` +
          'This is about the space being shared with you, not about the tables it curates; ' +
          'those are the table rows above.',
      };
    }
    // The silent-empty case, refused rather than counted. A pass has to have
    // been said by the API, not merely not-denied by it.
    return {
      ...base,
      status: 'error',
      detail:
        `Databricks answered for ${space.label} without naming the space, so nothing about ` +
        'your access to it was established. An empty answer is not a yes, and this is ' +
        'deliberately not reported as one.',
      apiMessage: 'The response carried no space_id.',
    };
  }
  if (result.status === 403) {
    return {
      ...base,
      status: 'denied',
      detail:
        `You do not hold CAN RUN on ${space.label}. Databricks refused the space itself ` +
        '(HTTP 403), so this is one grant on one workspace object and says nothing about ' +
        'your Unity Catalog access.',
      missing: { object: space.id, permission: 'CAN_RUN', objectKind: 'genie-space' },
      remedy: genieSpaceGrant(space.id, principal),
      reason: 'no-grant',
      apiMessage: result.message,
    };
  }
  if (result.status === 404) {
    return {
      ...base,
      status: 'denied',
      detail:
        `${space.label} did not resolve for you (HTTP 404). Databricks reports a space that ` +
        'is not shared with you and a space id that does not exist the same way, so this is ' +
        'either a missing grant or a space that is gone. The grant below covers the first; ' +
        'if it runs and this still fails, the id the agent is configured with is the problem.',
      missing: { object: space.id, permission: 'CAN_RUN', objectKind: 'genie-space' },
      remedy: genieSpaceGrant(space.id, principal),
      reason: 'hidden-or-absent',
      apiMessage: result.message,
    };
  }
  if (result.status === 401) {
    return {
      ...base,
      status: 'error',
      detail:
        'Databricks refused your forwarded token itself (HTTP 401) before it considered any ' +
        `permission, so nothing about your access to ${space.label} was established. This is ` +
        'not a permission you are missing. Reload the page for a fresh token.',
      apiMessage: result.message,
    };
  }
  return {
    ...base,
    status: 'error',
    detail:
      `The check against ${space.label} did not complete, so your access to it is unknown ` +
      'rather than refused. This is not a permission result and should not be read as one.',
    apiMessage: result.message,
  };
}

export interface GenieProber {
  (spaceId: string): Promise<GenieProbeResult>;
}

/**
 * Ask, as the user, whether each space is theirs to run.
 *
 * The scope is established before the first call and again from the first
 * refusal, and both answers land in the same place: a limitation naming the
 * scope, not a denial naming the reader. Nothing here is conditional on a
 * constant: either the token enumerated its scopes, or the API said what it
 * thought of them.
 */
export async function verifyGenieAccess(spaces: readonly GenieSpace[],
  probe: GenieProber,
  principal: string = UNKNOWN_PRINCIPAL,
  scopeState: boolean | null = null
): Promise<GenieOutcome> {
  if (spaces.length === 0) {
    return {
      verdicts: [],
      notChecked: {
        what: 'Whether the Genie spaces are shared with you.',
        why:
          'The agent\u2019s dependency report named no Genie spaces, so there was nothing to ask ' +
          'about on your behalf. This is a configuration state and says nothing about your ' +
          'permissions.',
      },
    };
  }
  if (scopeState === false) {
    return {
      verdicts: [],
      notChecked: missingGenieScopeLimit('its own scope claim does not list it'),
    };
  }
  // Concurrent, because the spaces have nothing to do with each other and a
  // person is waiting at the gate for all of them. Serially this was one
  // {@link GENIE_PROBE_TIMEOUT_MS} per space of dead time (30 seconds on the
  // usual two), in front of a spinner, ahead of a warehouse probe that has its
  // own 45, and the browser puts no timeout on the request at all. A freshly
  // deployed workspace where Genie is slow spent that before a single table was
  // checked.
  const results = await Promise.all(spaces.map(async (space): Promise<GenieProbeResult> => {
      try {
        return await probe(space.id);
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    })
  );

  const refusedForScope = results.find((result): result is Extract<GenieProbeResult, { ok: false }> =>
      !result.ok && looksLikeMissingScope(result.message)
  );
  if (refusedForScope) {
    // Whole-run rather than per-space: the app cannot ask this question at
    // all, and reporting it once per space would read as several problems
    // where there is one, none of which belongs to the reader.
    //
    // Now found after every probe has been made rather than at the first one.
    // The report is identical (one limitation, no verdicts), and the calls it
    // no longer saves were metadata reads that had already been paid for by the
    // time the first answer arrived.
    return {
      verdicts: [],
      notChecked: missingGenieScopeLimit(`Databricks refused the call and said so: ${refusedForScope.message}`
      ),
    };
  }
  return {
    verdicts: results.map((result, index) => classifyGenieProbe(result, spaces[index], principal)),
  };
}

/**
 * What this verification does not cover, said out loud.
 *
 * Both entries are things that would degrade an answer quietly rather than
 * fail it, which is the category a reader has no way of noticing for
 * themselves.
 */
export function limitsOfThisCheck(servingChecked: readonly { object: string; label: string; status: string }[],
  genie?: GenieOutcome,
  /** How many tables this run actually ran a statement against. */
  tablesChecked = 0
): NotChecked[] {
  const servingSaw =
    servingChecked.length > 0
      ? 'Checked as the agent serving principal instead, which is the identity that ' +
        'actually calls Genie: ' +
        servingChecked.map((check) => `${check.label} (${check.status})`).join('; ') +
        '.'
      : undefined;
  const genieLimit: NotChecked = genie?.notChecked
    ? { ...genie.notChecked, insteadAs: servingSaw }
    : genie && genie.verdicts.length > 0
      ? {
          what: 'Whether the answers you get would be limited to what you can see in Genie.',
          why:
            'Your own access to the spaces was checked and is reported above. What that does ' +
            'not establish is whose access shapes an answer: the agent calls Genie as the ' +
            'serving principal, so a space you cannot run can still be behind a figure on ' +
            'screen, and a space you can run is not queried under your identity.',
          insteadAs: servingSaw,
        }
      : {
          what: 'Whether the Genie spaces are shared with you.',
          why:
            `Reading a Genie space needs the \`${GENIE_SCOPE}\` scope on the forwarded token. ` +
            'This run did not get as far as asking, so nothing about your access to the ' +
            'spaces was established either way.',
          insteadAs: servingSaw,
        };
  const limits: NotChecked[] = [
    genieLimit,
    ...(tablesChecked === 0
      ? [
          {
            what: 'Whether you can read the tables behind an answer.',
            why:
              'The app is not told which tables the agent reads. That list lives in the model ' +
              'artifact and reaches nothing outside the serving endpoint, so no SELECT was run ' +
              'on your behalf. A pass above means you can run a statement, not that you could ' +
              'read the data.',
          },
        ]
      : []),
    {
      what: 'Whether a row filter or a column mask narrows what you would see.',
      why:
        'Neither reports itself. A filtered query succeeds and returns fewer rows, so a ' +
        'green above means the grant exists, not that you would see every row behind a ' +
        'figure. There is no error to check for and nothing here can detect it.',
    },
  ];
  return limits;
}

export interface AccessProbes {
  /** `SELECT 1`. Proves CAN_USE without naming a table. */
  warehouse(): Promise<ProbeResult>;
  table: StatementRunner;
  /** Reads one Genie space as the user. Absent means the spaces go unasked. */
  genieSpace?: GenieProber;
  /**
   * Reads the reader's own workspace entitlements, and only when a bare 403
   * has already made it matter. Absent means the warehouse refusal is reported
   * exactly as it was before this existed, which is the correct degradation:
   * one of its two causes stays unnamed rather than being guessed at.
   */
  entitlements?: EntitlementLookup;
}

/**
 * The whole check, in the order that keeps its failure modes apart.
 *
 * Warehouse first so a workspace-object grant cannot be reported as ten Unity
 * Catalog ones; tables second; and the limits of the result attached either
 * way, so a pass is not read as covering more than it did.
 */
export async function verifyAccess(input: {
    tables: readonly string[];
    warehouseId: string;
    principal: string;
    servingChecked?: readonly { object: string; label: string; status: string }[];
    genieSpaces?: readonly GenieSpace[];
    /** True, false, or `null` for a token that did not enumerate its scopes. */
    genieScope?: boolean | null;
  },
  probes: AccessProbes
): Promise<VerificationOutcome> {
  const genie = probes.genieSpace
    ? await verifyGenieAccess(input.genieSpaces ?? [],
        probes.genieSpace,
        input.principal,
        input.genieScope ?? null
      )
    : undefined;
  const notChecked = limitsOfThisCheck(input.servingChecked ?? [], genie, input.tables.length);
  const blocked = await verifyWarehouseAccess(input.warehouseId,
    () => probes.warehouse(),
    input.principal,
    probes.entitlements
  );
  if (blocked) {
    return {
      verdicts: [],
      ok: 0,
      denied: 0,
      errored: 0,
      blocked,
      impact: [],
      notChecked,
      ...(genie ? { genie: genie.verdicts } : {}),
    };
  }
  const outcome = await verifyTableAccess(input.tables, probes.table, input.principal);
  return {
    ...outcome,
    warehouseVerified: true,
    impact: describeImpact(outcome, input.tables.length),
    notChecked,
    ...(genie ? { genie: genie.verdicts } : {}),
  };
}

function tally(verdicts: readonly TableVerdict[]) {
  return {
    ok: verdicts.filter((v) => v.status === 'ok').length,
    denied: verdicts.filter((v) => v.status === 'denied').length,
    errored: verdicts.filter((v) => v.status === 'error').length,
  };
}

/**
 * Whether this outcome is good enough to admit somebody as verified.
 *
 * Every table must pass. A partial pass is not a weaker yes, it is a no with
 * detail: the point of the mode is that the user could have read the data
 * behind the answers, and "eight of ten" does not support that sentence. An
 * errored check counts against it too, unknown is not permitted.
 *
 * A refused Genie space counts against it as well, and an unanswered one does
 * not. The difference is the line this module already draws everywhere else:
 * a refusal is something Databricks said about the reader, and a check that
 * could not run is something about the deployment. Blocking on the second
 * would fail every user of a workspace where `dashboards.genie` is not
 * effective, reporting a scope as if it were a permission, which is the one
 * mistake this file exists to stop. What the run could not establish is
 * carried in `notChecked` and in the summary instead of being laundered into a
 * pass.
 */
export function isVerified(outcome: VerificationOutcome): boolean {
  // Something has to have passed. A run with no table list is verified on the
  // warehouse probe alone, because executing `SELECT 1` under the caller's own
  // token is real evidence about the caller; a run that probed nothing at all
  // is not verified, whatever its empty verdict list averages out to. What a
  // warehouse-only pass does NOT establish is carried by `notChecked`.
  return (!outcome.blocked &&
    (outcome.warehouseVerified === true || outcome.verdicts.length > 0) &&
    outcome.verdicts.every((verdict) => verdict.status === 'ok') &&
    !(outcome.genie ?? []).some((verdict) => verdict.status === 'denied')
  );
}

/**
 * One sentence for the audit record, naming the boundary rather than implying
 * there is none.
 */
export function verificationSummary(outcome: VerificationOutcome, servingPrincipal: string | null): string {
  const tables = outcome.ok === 1 ? '1 table' : `${outcome.ok} tables`;
  const executes = servingPrincipal
    ? `execution still runs as ${servingPrincipal}`
    : 'execution still runs as the agent serving principal';
  // Nothing here may read as a clean bill of health for a check that ran no
  // statement against a table. The app is not told which tables the agent
  // reads: that list only exists in the model artifact.
  const head =
    outcome.ok === 0
      ? 'Verified you can run a statement on the SQL warehouse under your own token. No table ' +
        'was checked, so nothing about your access to the data behind an answer was established'
      : `Verified you hold CAN_USE on the SQL warehouse and SELECT on ${tables} under your own token`;
  return (`${head}; ${executes}. ${genieClause(outcome.genie)} Row-level filters and column masks ` +
    'were not checked and are not covered by this.'
  );
}

function genieClause(genie: readonly GenieVerdict[] | undefined): string {
  if (!genie || genie.length === 0) {
    return 'Genie space access was not checked as you and is not covered by this.';
  }
  const passed = genie.filter((verdict) => verdict.status === 'ok').length;
  const unknown = genie.filter((verdict) => verdict.status === 'error');
  const spaces = genie.length === 1 ? '1 Genie space' : `${genie.length} Genie spaces`;
  const head = `CAN RUN confirmed on ${passed} of ${spaces} under the same token.`;
  if (unknown.length === 0) return head;
  return (`${head} ${unknown.length} did not answer, so ${unknown.length === 1 ? 'it is' : 'they are'} ` +
    `unknown rather than granted: ${unknown.map((verdict) => verdict.label).join('; ')}.`
  );
}

/**
 * Run a statement as the user through the SQL Statement Execution API.
 */
export interface StatementOptions {
  host: string;
  token: string;
  warehouseId: string;
  fetchImpl?: typeof fetch;
  /** Overridden in tests so a hung socket can be simulated in milliseconds. */
  timeoutMs?: number;
}

/**
 * Upper bound on the HTTP call, as distinct from the statement.
 *
 * `wait_timeout: '30s'` bounds how long the warehouse will hold the statement
 * before cancelling it. It says nothing about the socket. A connection that is
 * accepted and then goes silent leaves `fetch` pending forever, and each of these
 * probes runs one after another with a person waiting on the answer, so one dead
 * socket was an access check that never came back. Comfortably above the
 * statement's own 30 s so a warehouse waking up still gets to answer.
 */
export const STATEMENT_TIMEOUT_MS = 45_000;

/**
 * `SELECT 1` as the user, which is the warehouse check and only the warehouse
 * check. It names no object, so its refusal cannot be read as being about one
 *. That is the whole reason this runs before the table probes rather than
 * being inferred from them afterwards.
 */
export function warehouseProbeFor(options: StatementOptions) {
  const run = statementExecutorFor(options);
  return () => run('SELECT 1');
}

export function statementRunnerFor(options: StatementOptions): StatementRunner {
  const run = statementExecutorFor(options);
  return (table: string) => run(probeStatement(table));
}

export interface GenieProbeOptions {
  host: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A metadata read, not a question.
 */
export const GENIE_PROBE_TIMEOUT_MS = 15_000;

export function genieSpaceProbeFor(options: GenieProbeOptions): GenieProber {
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GENIE_PROBE_TIMEOUT_MS;
  return async (spaceId: string): Promise<GenieProbeResult> => {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await call(`${options.host}/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
      return {
        ok: false,
        message: timedOut
          ? `Genie did not answer within ${timeoutMs} ms, so this check did not complete.`
          : `Genie could not be reached: ${(error as Error).message}`,
      };
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      // The status travels beside the message, on the same reasoning as the
      // statement executor above: a refusal here arrives as a code with a
      // one-line body, and a classifier reading only prose turns it into a
      // dependency that never answered.
      return {
        ok: false,
        status: response.status,
        message: String(body?.message ?? `Databricks answered HTTP ${response.status} with no message body.`
        ),
      };
    }
    return { ok: true, space: typeof body?.space_id === 'string' ? body.space_id : null };
  };
}

function statementExecutorFor(options: StatementOptions) {
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? STATEMENT_TIMEOUT_MS;
  return async (statement: string): Promise<ProbeResult> => {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await call(`${options.host}/api/2.0/sql/statements`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          warehouse_id: options.warehouseId,
          statement,
          // Long enough for a warehouse that has to wake up, and synchronous so
          // the route does not have to poll a statement id to find out whether a
          // permission held.
          wait_timeout: '30s',
          on_wait_timeout: 'CANCEL',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Reported as an unanswered check rather than thrown, so one silent socket
      // is one table nobody could establish and not the whole verification
      // failing. `isVerified` counts that against the run, which is right: this
      // is "unknown", and unknown is not permission.
      const timedOut = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
      return {
        ok: false,
        message: timedOut
          ? `The SQL warehouse did not answer within ${timeoutMs} ms, so this check did not complete.`
          : `The SQL warehouse could not be reached: ${(error as Error).message}`,
      };
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok) {
      // The status travels beside the message rather than inside it. A refusal
      // on this path routinely carries no body, and `HTTP 403` as a message is
      // a number wearing prose: it reads as unclassifiable to anything that
      // matches on wording, which is how a permission refusal came to be
      // reported as a warehouse that never answered.
      return {
        ok: false,
        status: response.status,
        message: String(body?.message ??
            `Databricks answered HTTP ${response.status} with no message body.`
        ),
      };
    }
    const state = body?.status?.state;
    if (state === 'SUCCEEDED') return { ok: true };
    const error = body?.status?.error;
    return {
      ok: false,
      message: String(error?.message ?? `The statement ended in state ${state ?? 'UNKNOWN'}.`),
    };
  };
}
