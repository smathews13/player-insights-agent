/**
 * Handing back the Unity Catalog access earlier versions of this app granted.
 *
 * WHAT THIS MODULE NO LONGER DOES, AND WHY THAT IS THE POINT. It used to grant on
 * two objects whenever somebody was made an administrator: the telemetry schema
 * and the `system.billing` tables. The grant on `system` needs an account admin
 * who is also a metastore admin, which nobody holds by virtue of administering
 * this app, so appointing a colleague reported PERMISSION_DENIED on a catalog the
 * operator has no authority over and the whole workflow read as blocked. It was
 * never a prerequisite for the role: an administrator is a row in Lakebase, and
 * the Roles screen is user management.
 *
 * So the grant half is gone rather than merely optional. Optional would have left
 * a callable API for putting a Unity Catalog object back in front of a screen that
 * is about people, and a state word beside `system.billing.usage` is the thing Sam
 * asked to stop seeing. Nothing in this app grants Unity Catalog privileges now.
 *
 * WHAT REMAINS IS A DEBT TO PAY BACK. Deployments that ran the earlier version
 * have rows in the grants table recording privileges this app added, and a person
 * removed from the roster should not keep a privilege they only ever held because
 * this app handed it to them. So a removal still revokes, under the FORWARDED
 * TOKEN OF THE ADMIN WHO PRESSED THE BUTTON rather than the app's own service
 * principal, which is what keeps this app from being a way to move Unity Catalog
 * privileges around under its own authority. It is best effort and never refuses
 * the removal.
 *
 * THE ONLY THING REVOKED IS A PRIVILEGE RECORDED AS `app-granted`. Everything else
 * is left alone and reported as left alone. See {@link withdrawAccess}.
 */
import { columnText, normalizeAdminEmail, type AdminStore } from './admin-roles';
import { ADMIN_GRANTS_TABLE } from './admin-roles-schema';

/** The parts of a Unity Catalog privilege, in the form a statement takes. */
type SecurableKind = 'CATALOG' | 'SCHEMA' | 'TABLE';

interface Privilege {
  kind: SecurableKind;
  /** Fully qualified, unquoted. */
  name: string;
  privilege: string;
}

/**
 * What one statement did.
 *
 * A statement that refused carries the status beside the message, on the same
 * reasoning as the statement executor in access-verification.ts: a permission
 * refusal routinely arrives as a code with no body, and `HTTP 403` as prose reads
 * as unclassifiable to anything matching on wording.
 */
export interface SqlOutcome {
  ok: boolean;
  status?: number;
  message?: string;
  rows?: string[][];
}

export type SqlRunner = (statement: string) => Promise<SqlOutcome>;

/** Backtick-quote one identifier part, escaping any backtick inside it. */
function quote(part: string): string {
  return '`' + part.replace(/`/g, '``') + '`';
}

function quotedName(fullName: string): string {
  return fullName.split('.').map(quote).join('.');
}

export function revokeStatement(privilege: Privilege, principal: string): string {
  return `REVOKE ${privilege.privilege} ON ${privilege.kind} ${quotedName(privilege.name)} FROM ${quote(principal)};`;
}

export type Provenance = 'app-granted' | 'pre-existing' | 'unknown';

export interface ProvenanceRow {
  email: string;
  object: string;
  privilege: string;
  provenance: Provenance;
}

export async function readProvenance(store: AdminStore, email: string): Promise<ProvenanceRow[]> {
  const result = await store.query(
    `SELECT email, target, object, privilege, provenance FROM ${ADMIN_GRANTS_TABLE}
     WHERE email = $1 ORDER BY recorded_at ASC`,
    [normalizeAdminEmail(email)]
  );
  return result.rows.map((row) => ({
    email: columnText(row.email),
    object: columnText(row.object),
    privilege: columnText(row.privilege),
    // Anything this app cannot read as one of the three provenances is treated as
    // `unknown`, which is the reading that never revokes.
    provenance: (['app-granted', 'pre-existing'].includes(columnText(row.provenance))
      ? columnText(row.provenance)
      : 'unknown') as Provenance,
  }));
}

/**
 * Why no statement can be run, in the words the audit row prints.
 *
 * Two different absences, kept apart because they are fixed in different places
 * and by different people. Neither is a refusal and neither is reported as one.
 */
export const NO_WAREHOUSE_REASON =
  'Not checked. This deployment has no SQL warehouse configured, so no statement could be attempted.';

export const NO_TOKEN_REASON =
  'Not checked. This session has no forwarded sign-in token, so a statement would have to be run by ' +
  'the app itself rather than by you. It is not, deliberately.';

/**
 * Privileges this app hands back and then never takes back, on purpose.
 *
 * `USE CATALOG` is the root of everything in a catalog and grants no read on its
 * own: it is traversal, and without it Unity Catalog hides objects rather than
 * refusing them. Revoking it is the one revoke here that can break something
 * nobody asked this app to touch, and the sequence is ordinary rather than
 * contrived: an earlier version granted traversal on a catalog so an admin could
 * reach the telemetry schema, a data owner later granted that same person `SELECT`
 * on a table in the same catalog, and then somebody takes them off the roster.
 * Taking the traversal back would make that table read as absent, in a way whose
 * cause is two unrelated actions apart.
 */
function keptOnRemoval(row: { privilege: string }): boolean {
  return row.privilege.toUpperCase() === 'USE CATALOG';
}

/**
 * What was left alone, and which of the two reasons it was left for.
 *
 * Both sentences or neither. A reader deciding whether this person can still see
 * something needs to know that some of what they hold was never this app's, and
 * that some of it was and was kept anyway.
 */
function leftInPlaceNote(theirs: number, kept: number): string {
  const parts: string[] = [];
  if (theirs > 0) parts.push('Access this app did not grant was left in place.');
  if (kept > 0) {
    parts.push(
      'Permission to see into the catalog was left in place. It shows no data on its own, and taking it ' +
        'back could hide tables this person was given for another reason.'
    );
  }
  return parts.join(' ');
}

/** The kind of securable a recorded object name is, by how many parts it has. */
function kindOf(object: string): SecurableKind {
  const parts = object.split('.').length;
  return parts === 1 ? 'CATALOG' : parts === 2 ? 'SCHEMA' : 'TABLE';
}

/**
 * What a removal handed back.
 *
 * Not drawn on any screen. The Roles pane is people and roles, and a Unity
 * Catalog state word on it is what this change removed. This is what the audit
 * row says instead, so the record of a privilege being taken back names the
 * person who did it and what was left alone.
 */
export interface WithdrawalOutcome {
  /** How many privileges were handed back. */
  revoked: number;
  /** The statements Unity Catalog refused, for somebody with authority to run. */
  refused: string[];
  summary: string;
  note: string;
}

/**
 * Hand back what this app handed out, and nothing else.
 *
 * A privilege recorded as `pre-existing` was there before, a privilege recorded as
 * `unknown` could not be checked, and an absent row is no claim at all. All three
 * are left alone, because Unity Catalog keeps no record that would let anybody put
 * back access this app removed by guessing.
 *
 * A failed revoke keeps its provenance row. A successful one deletes it, so the
 * app stops claiming a privilege it no longer added.
 *
 * NEVER THROWS AND NEVER REFUSES THE REMOVAL. Taking somebody off the roster is
 * the thing the caller asked for; this is the tidying up that follows it.
 */
export async function withdrawAccess(input: {
  run: SqlRunner | null;
  store: AdminStore;
  email: string;
  unavailable?: string;
}): Promise<WithdrawalOutcome> {
  const email = normalizeAdminEmail(input.email);
  const nothing = (summary: string, note = ''): WithdrawalOutcome => ({ revoked: 0, refused: [], summary, note });
  let rows: ProvenanceRow[];
  try {
    rows = await readProvenance(input.store, email);
  } catch (error) {
    console.warn(
      `[admin] The grant record for ${email} could not be read (${(error as Error).message}), so nothing ` +
        'was revoked. Leaving access in place is the safe reading: this app cannot show it was the one ' +
        'that granted it.'
    );
    return nothing('Not checked. The record of what this app granted could not be read, so no access was taken away.');
  }

  // Three groups, not two, because two of them are left alone for different
  // reasons and a reader is owed the right one. `theirs` was never this app's to
  // take. `kept` was this app's and is left anyway; see keptOnRemoval.
  const mine = rows.filter((row) => row.provenance === 'app-granted' && !keptOnRemoval(row));
  const kept = rows.filter((row) => row.provenance === 'app-granted' && keptOnRemoval(row));
  const theirs = rows.filter((row) => row.provenance !== 'app-granted');
  const leftInPlace = leftInPlaceNote(theirs.length, kept.length);

  if (mine.length === 0) {
    return nothing(
      theirs.length + kept.length > 0
        ? 'No read access to take away.'
        : 'No access to take away. This app granted none.',
      leftInPlace
    );
  }
  if (!input.run) return nothing(input.unavailable ?? NO_WAREHOUSE_REASON);

  const failed: string[] = [];
  const revoked: ProvenanceRow[] = [];
  for (const row of mine) {
    const statement = revokeStatement({ kind: kindOf(row.object), name: row.object, privilege: row.privilege }, email);
    const outcome = await input.run(statement);
    if (outcome.ok) revoked.push(row);
    else failed.push(statement);
  }

  for (const row of revoked) {
    try {
      await input.store.query(`DELETE FROM ${ADMIN_GRANTS_TABLE} WHERE email = $1 AND object = $2 AND privilege = $3`, [
        email,
        row.object,
        row.privilege,
      ]);
    } catch (error) {
      console.error(
        `[admin] The grant record for ${row.privilege} on ${row.object} could not be cleared: ` +
          `${(error as Error).message}. The revoke itself succeeded.`
      );
    }
  }

  return {
    revoked: revoked.length,
    refused: failed,
    summary:
      failed.length > 0
        ? `Access not fully taken back. ${failed.length} of ${mine.length} statements were refused.`
        : 'Access taken back.',
    note: leftInPlace,
  };
}

/** How long one statement is waited on. A cold warehouse takes most of it. */
export const ACCESS_STATEMENT_TIMEOUT_MS = 40_000;

/**
 * The parts of the SQL Statement Execution API's answer this module reads.
 *
 * Declared rather than reached into as `any`, because these fields decide whether
 * a revoke is reported as made or refused, and a rename upstream should become a
 * type error here rather than a statement silently reported as failed.
 */
interface StatementResponse {
  message?: string;
  status?: { state?: string; error?: { message?: string } };
  result?: { data_array?: string[][] };
}

/**
 * Run statements as the signed-in admin, over the SQL Statement Execution API.
 *
 * Same call shape as `statementExecutorFor` in access-verification.ts.
 */
export function accessRunner(options: {
  host: string;
  token: string;
  warehouseId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): SqlRunner {
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? ACCESS_STATEMENT_TIMEOUT_MS;
  return async (statement: string): Promise<SqlOutcome> => {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await call(`${options.host}/api/2.0/sql/statements`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          warehouse_id: options.warehouseId,
          statement,
          wait_timeout: '30s',
          on_wait_timeout: 'CANCEL',
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
      return {
        ok: false,
        message: timedOut
          ? `The SQL warehouse did not answer within ${timeoutMs} ms, so this did not complete.`
          : `The SQL warehouse could not be reached: ${(error as Error).message}`,
      };
    }
    const body = (await response.json().catch(() => ({}))) as StatementResponse;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: body.message ?? `Databricks answered HTTP ${response.status} with no message body.`,
      };
    }
    if (body.status?.state !== 'SUCCEEDED') {
      return {
        ok: false,
        message: body.status?.error?.message ?? `The statement ended in state ${body.status?.state ?? 'UNKNOWN'}.`,
      };
    }
    // `data_array` is absent for a statement that returns nothing, which every
    // REVOKE does. An empty array rather than undefined, so a caller reading rows
    // never has to tell "no rows" from "no result set".
    const data = body.result?.data_array;
    return { ok: true, rows: Array.isArray(data) ? data : [] };
  };
}
