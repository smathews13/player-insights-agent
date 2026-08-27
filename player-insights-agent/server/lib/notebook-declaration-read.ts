/**
 * Fetching what a notebook published, as the person reading the page.
 *
 * WHY A TABLE AND NOT THE NOTEBOOK. Reading the notebook file itself would need a
 * workspace or files OAuth scope this app does not declare, and consent is all or
 * nothing: a scope the workspace declines to issue fails sign-in ahead of the app,
 * for everyone, with nothing in any log (see `app_user_api_scopes` in
 * databricks.yml for the episode that cost a day). A table is readable on the
 * `sql` scope the app already holds, so this adds no consent risk at all.
 *
 * READ AS THE SIGNED-IN USER, NEVER AS THE APP. The forwarded user token is the
 * only credential used here. Three service-principal read paths were deliberately
 * closed in this deployment and this does not reopen one: if the reader has not
 * been granted the declaration table, they see that it could not be read, which is
 * the true answer for them. The alternative -- the app reading it under its own
 * identity and showing the result -- would tell one person what another person's
 * grants allow.
 *
 * NOTHING FETCHED HERE IS TRUSTED. The document is parsed by
 * `shared/notebook-declaration.ts`, which drops anything malformed, and no value
 * it carries is applied to the running deployment. It is compared and displayed.
 */
import {
  MAX_DECLARATION_BYTES,
  parseDeclaration,
  type NotebookDeclaration,
} from '../../shared/notebook-declaration';
import { sqlQueryTags } from './sql-query-tags';

/**
 * A three-part Unity Catalog name, and nothing else.
 *
 * The location is interpolated into a statement, so this is the whole defence
 * against that. Parameter markers are not available for an identifier, and the
 * Statement Execution API offers no identifier binding, so the shape is checked
 * instead: three dot-separated segments of word characters, each of which
 * Postgres-style quoting could not smuggle anything through. Anything else is
 * refused before a statement is built.
 */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}(\.[A-Za-z_][A-Za-z0-9_]{0,127}){2}$/;

/** Whether a string is a location this reader will build a statement for. */
export function isDeclarationLocation(value: string): boolean {
  return TABLE_NAME.test(value.trim());
}

/**
 * The statement that fetches the current declaration.
 *
 * Newest row wins, which makes publishing an append rather than an update: a
 * notebook run writes a row and the app reads the latest. That is the shape a
 * notebook can produce with one `INSERT` and no read-modify-write, and it leaves
 * the previous declarations in place as a record of what was published when.
 *
 * `LIMIT 1` rather than reading the table: this is on a page load, the document is
 * bounded, and older rows are history rather than configuration.
 */
export function declarationStatement(location: string): string {
  return `SELECT document FROM ${location} ORDER BY published_at DESC LIMIT 1`;
}

/** Why there is no declaration, when there is none. */
export type DeclarationFailure =
  /** No location is configured, so nothing was asked for. */
  | 'not-configured'
  /** The configured location is not a three-part name. */
  | 'bad-location'
  /** No token was forwarded, so nothing could be read as the reader. */
  | 'no-token'
  /** The workspace refused the read. Usually a grant the reader does not hold. */
  | 'refused'
  /** The table answered and held no rows. */
  | 'empty'
  /** Something answered and it was not a declaration. */
  | 'unreadable'
  /** The read did not complete. */
  | 'unavailable';

export interface DeclarationRead {
  declaration: NotebookDeclaration | null;
  failure: DeclarationFailure | null;
  /** What to say about it, already phrased for a reader. Empty when it was read. */
  detail: string;
}

/** The sentence each failure owes the person looking at the row. */
const FAILURE_DETAIL: Record<DeclarationFailure, string> = {
  'not-configured': 'No notebook is connected. Add the table a notebook publishes to.',
  'bad-location':
    'The configured location is not a three-part Unity Catalog name, so nothing was read.',
  'no-token': 'Sign in again to read this as yourself.',
  refused:
    'You do not have access to the table the notebook publishes to. Ask for SELECT on it.',
  empty: 'The table is there and nothing has been published to it yet.',
  unreadable: 'The published row is not a declaration this app can read.',
  unavailable: 'The published declaration could not be read just now.',
};

function failed(failure: DeclarationFailure): DeclarationRead {
  return { declaration: null, failure, detail: FAILURE_DETAIL[failure] };
}

/** How long the page will wait for the declaration before giving up on it. */
export const DECLARATION_TIMEOUT_MS = 8_000;

/**
 * What the notebook published, read under the reader's own credential.
 *
 * Never rejects. This is one row on a diagnostics page, and a page somebody opens
 * to find out why a deployment is misbehaving must not be taken down by the
 * failure of one of the things it reports on.
 */
export async function readPublishedDeclaration(input: {
  location: string;
  warehouseId: string;
  host: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<DeclarationRead> {
  const location = input.location.trim();
  if (!location) return failed('not-configured');
  if (!isDeclarationLocation(location)) return failed('bad-location');
  if (!input.token) return failed('no-token');
  if (!input.host || !input.warehouseId.trim()) return failed('not-configured');

  const call = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await call(`${input.host.replace(/\/$/, '')}/api/2.0/sql/statements`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        statement: declarationStatement(location),
        warehouse_id: input.warehouseId.trim(),
        query_tags: sqlQueryTags({
          surface: 'declaration',
          tool: 'notebook_declaration',
          operation: 'read',
        }),
        wait_timeout: '30s',
        on_wait_timeout: 'CANCEL',
        // One row of bounded text. Asked for inline so there is no external link
        // to fetch, which would be a second request on a different credential.
        format: 'JSON_ARRAY',
        disposition: 'INLINE',
        row_limit: 1,
      }),
      signal: AbortSignal.timeout(DECLARATION_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn('[connections] The published declaration could not be read:', (error as Error).message);
    return failed('unavailable');
  }

  if (response.status === 401 || response.status === 403) return failed('refused');
  if (!response.ok) return failed('unavailable');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failed('unavailable');
  }

  const document = firstCell(body);
  if (document === null) {
    // A statement that succeeded and returned nothing is a different state from
    // one that failed, and the difference is the whole of what a reader needs:
    // the table exists and their grant is fine, so what is missing is a publish.
    return failed(statementSucceeded(body) ? 'empty' : 'unavailable');
  }
  if (document.length > MAX_DECLARATION_BYTES) return failed('unreadable');

  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return failed('unreadable');
  }
  const declaration = parseDeclaration(parsed);
  if (!declaration) return failed('unreadable');
  return { declaration, failure: null, detail: '' };
}

/** Whether the statement reached a successful state, whatever it returned. */
function statementSucceeded(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const status = (body as { status?: { state?: unknown } }).status;
  return typeof status === 'object' && status !== null && status.state === 'SUCCEEDED';
}

/**
 * The single cell the statement asked for, or `null`.
 *
 * Read defensively rather than by shape assertion: this is a response from
 * outside, and a shape this build does not expect must read as "nothing was
 * returned" rather than throw on a page that has to keep answering.
 */
function firstCell(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const result = (body as { result?: { data_array?: unknown } }).result;
  if (typeof result !== 'object' || result === null) return null;
  const rows = (result as { data_array?: unknown }).data_array;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first: unknown = rows[0];
  if (!Array.isArray(first) || first.length === 0) return null;
  return typeof first[0] === 'string' ? first[0] : null;
}
