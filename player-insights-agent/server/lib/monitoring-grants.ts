/**
 * The admin's own table grants, resolved once per range, and what they condition.
 *
 * THE DECISION THIS IMPLEMENTS. An admin reading Monitoring sees other people's
 * whole conversations, answer bodies included, because that is how Genie's
 * Monitor tab works and it is the surface this audience already knows. What is
 * conditioned is narrow: where the reading admin lacks SELECT on a table a run
 * read, that run's answer body is replaced by one line naming the table. Nothing
 * else changes, and everything in the always-shown set still renders.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT, each of which is a decision recorded
 * in section 5.4 of the plan rather than a preference:
 *
 *  1. THE UNIT IS THE TABLE. A stored answer is prose a model wrote with figures
 *     inside it. Removing one figure from a finished sentence cannot be done
 *     reliably: an implementation that tries either leaves the number where it
 *     was, or mangles the sentence into something a reader takes for a defect.
 *     So the unit of conditioning is the unit the app actually records, which is
 *     the fully-qualified tables a run read. Column-level conditioning is not
 *     attempted and PIA does not store what would be needed for it.
 *
 *  2. RESOLUTION IS ONCE PER ADMIN PER RANGE, NOT ONCE PER ROW. A Unity Catalog
 *     round trip in front of every rendered row puts a network call inside a list
 *     that scrolls. The distinct tables in the range are probed together, through
 *     the access-verification path the access gate already uses, and the result
 *     is cached until the range changes.
 *
 *  3. A FAILED RESOLUTION SHOWS EVERYTHING. This is the one that is tempting to
 *     get wrong, because failing closed feels safer. It is not safer, it is
 *     wrong: an admin's grants normally cover whatever a consumer asked about, so
 *     the overwhelmingly likely truth when a permission check times out is that
 *     they were entitled to all of it. The data itself is still governed, because
 *     every query that produced these answers already ran under the asking user's
 *     grants and Unity Catalog is still the boundary. Conditioning is a courtesy
 *     on top of that boundary, not the boundary. Hiding the page when the
 *     courtesy cannot be performed is the failure mode the whole section was
 *     written against.
 *
 * A TABLE THAT COULD NOT BE CHECKED IS NOT A TABLE THAT WAS DENIED. The
 * verification path reports `error` for a probe that ran out of budget or whose
 * refusal it could not classify. Those do not condition anything, for the reason
 * in 3 and because "not checked" in this app always means not checked yet.
 */

import {
  verifyTableAccess,
  type StatementRunner,
  type TableVerdict,
  type VerificationOutcome,
} from '../routes/access-verification';
import type { AnswerConditioning } from '../../shared/monitoring-contract';
import { ExpiringLruCache } from './expiring-lru';

/** Permission decisions are deliberately brief: a revocation must be observed quickly. */
export const GRANT_CACHE_TTL_MS = 30_000;
export const GRANT_CACHE_MAX_ENTRIES = 256;

/**
 * What the check found, per table, plus whether it ran at all.
 *
 * `resolved: false` is the failure case and carries no verdicts. Callers must
 * treat it as "show everything", never as "deny everything"; `conditioningFor`
 * below enforces that so a caller cannot get it wrong by omission.
 */
export interface GrantResolution {
  resolved: boolean;
  /** Fully-qualified table to what the probe found. Empty when unresolved. */
  verdicts: Map<string, TableVerdict>;
  resolvedAt: number;
}

export function unresolvedGrants(now: number): GrantResolution {
  return { resolved: false, verdicts: new Map(), resolvedAt: now };
}

/**
 * Which table, if any, stops this run's answer being shown to this reader.
 *
 * Returns the FIRST denied table in the order the run recorded its sources, so
 * the line a reader sees is stable across refreshes rather than depending on map
 * iteration. Naming one table is enough: the reader needs a grant to proceed and
 * a list of five does not change what they do next.
 */
export function conditioningFor(tables: readonly string[], grants: GrantResolution): AnswerConditioning | null {
  // The whole of decision 3, in one line. Nothing is conditioned when the check
  // did not run.
  if (!grants.resolved) return null;
  for (const table of tables) {
    const verdict = grants.verdicts.get(table);
    // Absent means this table was not in the probed set, which happens when a
    // run's sources changed after the range was resolved. Not a denial.
    if (!verdict || verdict.status !== 'denied') continue;
    return {
      table: verdict.missing?.object ?? table,
      // The privilege the refusal actually named, which is not always SELECT: a
      // refusal naming the catalog is a missing USE CATALOG, and granting SELECT
      // on a table inside a catalog the reader cannot enter does not clear it.
      permission: verdict.missing?.permission ?? 'SELECT',
    };
  }
  return null;
}

/**
 * A probe of one table under one reader's credentials.
 *
 * The access-verification path's own type rather than a restatement of it, so
 * that a change to what a probe reports reaches this file as a type error rather
 * than as a silently narrower reading.
 */
export type TableProbe = StatementRunner;

export interface GrantCacheKey {
  admin: string;
  /** The range, as one string, so a range change is a cache miss. */
  window: string;
}

function cacheKey(key: GrantCacheKey): string {
  return `${key.admin.trim().toLowerCase()}\u0000${key.window}`;
}

/**
 * The cache. One entry per admin per range, holding a resolution or a failure.
 *
 * A FAILURE IS CACHED TOO, and deliberately. Without that, a deployment whose
 * warehouse is refusing would re-probe every table on every request for as long
 * as it stayed broken, which turns a permission check nobody can complete into a
 * load generator. The entry expires like any other, so recovery is picked up.
 */
const cache = new ExpiringLruCache<GrantResolution>(GRANT_CACHE_MAX_ENTRIES, GRANT_CACHE_TTL_MS);

/** For tests, and for a deployment that has just changed somebody's grants. */
export function resetGrantCache() {
  cache.clear();
  tablePolicies.clear();
  personPrivileges.clear();
}

export interface ResolveGrantsOptions {
  key: GrantCacheKey;
  /** The distinct fully-qualified tables the range's answers recorded. */
  tables: readonly string[];
  probe: TableProbe | null;
  now?: number;
  ttlMs?: number;
  /** Injected so a test can assert the cache rather than the network. */
  verify?: typeof verifyTableAccess;
}

/**
 * The admin's grants over this range's tables, from the cache or by probing.
 *
 * A range with no tables in it resolves trivially and truthfully: there is
 * nothing to condition, so the resolution succeeded and conditions nothing. That
 * is not the same as a failure, and reporting it as one would put the "could not
 * check" line above an empty list.
 */
export async function resolveGrants(options: ResolveGrantsOptions): Promise<GrantResolution> {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? GRANT_CACHE_TTL_MS;
  const id = cacheKey(options.key);
  const cached = cache.get(id, now);
  if (cached) return cached;

  if (options.tables.length === 0) {
    const empty: GrantResolution = { resolved: true, verdicts: new Map(), resolvedAt: now };
    cache.set(id, empty, now, ttl);
    return empty;
  }
  // No probe means the app has no warehouse, no workspace host, or no forwarded
  // token to run one with. Unresolved, which shows everything and says so.
  if (!options.probe) {
    const failed = unresolvedGrants(now);
    cache.set(id, failed, now, ttl);
    return failed;
  }

  let outcome: VerificationOutcome;
  try {
    outcome = await (options.verify ?? verifyTableAccess)(options.tables, options.probe, options.key.admin);
  } catch (error) {
    console.warn(
      `[monitoring] Table permissions could not be resolved for ${options.key.admin}: ${(error as Error).message}. ` +
        'Everything is shown, and the page says the check could not run.'
    );
    const failed = unresolvedGrants(now);
    cache.set(id, failed, now, ttl);
    return failed;
  }
  // A block is a reason that is not about any one table: no forwarded token, no
  // SQL scope, a warehouse that is down. Nothing was established about this
  // reader's access to anything, so it is a failed resolution rather than a set
  // of denials.
  if (outcome.blocked) {
    console.warn(
      `[monitoring] Table permissions not established for ${options.key.admin}: ${outcome.blocked.kind}. Everything is shown.`
    );
    const failed = unresolvedGrants(now);
    cache.set(id, failed, now, ttl);
    return failed;
  }
  const verdicts = new Map<string, TableVerdict>();
  for (const verdict of outcome.verdicts) verdicts.set(verdict.table, verdict);
  const resolution: GrantResolution = { resolved: true, verdicts, resolvedAt: now };
  cache.set(id, resolution, now, ttl);
  return resolution;
}

/* ── The per-user panel's live read, which is a different question ────────── */

/**
 * A workspace API GET as the application. Injected so nothing here holds a client.
 *
 * The per-user panel asks Unity Catalog what one named person is entitled to.
 * That is read AS THE APPLICATION and not as the admin, and the difference is
 * worth stating because it looks inconsistent beside the conditioning above:
 * asking "what is this person entitled to" returns a list of privileges and no
 * rows from any table, whereas the conditioning probe reads a table. The app
 * already reads workspace entitlements this way, for the same reason: the
 * forwarded user token carries no scope that covers the lookup, and an admin
 * cannot borrow another person's token.
 */
export type WorkspaceRead = (path: string, query?: Record<string, string>) => Promise<unknown>;

export interface TableGrantReading {
  table: string;
  /** Null when the read did not answer. Never defaulted to either verdict. */
  canRead: boolean | null;
  missing: string | null;
  rowFilter: boolean | null;
  maskedColumns: string[] | null;
}

const EFFECTIVE_PERMISSIONS_PATH = '/api/2.1/unity-catalog/effective-permissions/table';
const TABLE_PATH = '/api/2.1/unity-catalog/tables';

/** The privilege that decides whether a person can read a table. */
const READ_PRIVILEGE = 'SELECT';

/**
 * ── WHY THIS HALF IS CACHED, AND THE TWO HALVES SEPARATELY ────────────────
 *
 * Opening the per-person panel used to cost TWO Unity Catalog calls per table in
 * the manifest, every time, for every person an admin looked at. An admin working
 * through a range pays that again per name, and the panel is the surface they use
 * when they are trying to explain a difference between two people — so it is
 * opened repeatedly, in a row, over the same tables.
 *
 * The two calls answer different questions and get different treatment:
 *
 *  - `/tables/{name}` reports the ROW FILTER AND COLUMN MASKS. Those belong to the
 *    table, not to the person, so one reading serves every person the admin looks
 *    at next. Held ten minutes.
 *  - `effective-permissions` reports WHAT ONE PERSON MAY DO. That is a permission,
 *    so it is held for thirty seconds and no longer. It is deliberately shorter
 *    than the other, and the reason is worth stating: a grant revoked while an
 *    admin is reading must stop being reported as held quickly. Thirty seconds
 *    still collapses the repeated opens that made this slow, because those happen
 *    within a few seconds of each other.
 *
 * NOTHING HERE IS AN ENFORCEMENT PATH. This panel reports what Unity Catalog says
 * about a person; it does not decide what anybody may read. The answers people
 * actually get are governed by Unity Catalog at query time, under their own
 * credentials, and none of that goes through this file. If that ever stops being
 * true, this cache has to go rather than get a shorter window.
 *
 * A reading that DID NOT ANSWER is never cached, on either half. Caching silence
 * would turn one unreadable moment into ten minutes of a panel confidently saying
 * "Not checked" while the workspace was answering again.
 */
export const TABLE_POLICY_TTL_MS = 10 * 60_000;
export const TABLE_POLICY_CACHE_MAX_ENTRIES = 512;
export const PERSON_PRIVILEGE_TTL_MS = 30_000;
export const PERSON_PRIVILEGE_CACHE_MAX_ENTRIES = 2_048;

const tablePolicies = new ExpiringLruCache<{ rowFilter: boolean | null; maskedColumns: string[] | null }>(
  TABLE_POLICY_CACHE_MAX_ENTRIES,
  TABLE_POLICY_TTL_MS
);
const personPrivileges = new ExpiringLruCache<{ canRead: boolean | null; missing: string | null }>(
  PERSON_PRIVILEGE_CACHE_MAX_ENTRIES,
  PERSON_PRIVILEGE_TTL_MS
);

/** In flight, so N concurrent opens of the same panel make one call, not N. */
const inFlight = new Map<string, Promise<unknown>>();

function once<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = work().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

/**
 * What one named person may do with one table, and what the table does to them.
 *
 * Every failure path answers `null` rather than a verdict. A lookup that could
 * not run has established nothing, and rendering that as "Cannot read" would
 * report a permissions problem the person does not have, which is the mirror of
 * the failure decision 3 above exists to prevent.
 */
export async function readTableGrant(
  read: WorkspaceRead,
  table: string,
  principal: string,
  now = Date.now()
): Promise<TableGrantReading> {
  const reading: TableGrantReading = {
    table,
    canRead: null,
    missing: null,
    rowFilter: null,
    maskedColumns: null,
  };

  const personKey = `${table}\u0000${principal.trim().toLowerCase()}`;
  const heldPrivileges = personPrivileges.get(personKey, now);
  if (heldPrivileges) {
    reading.canRead = heldPrivileges.canRead;
    reading.missing = heldPrivileges.missing;
  } else {
    try {
      const body = await once(`p:${personKey}`, () =>
        read(`${EFFECTIVE_PERMISSIONS_PATH}/${encodeURIComponent(table)}`, { principal })
      );
      const privileges = privilegesFrom(body, principal);
      if (privileges !== null) {
        reading.canRead = privileges.includes(READ_PRIVILEGE);
        reading.missing = reading.canRead ? null : `${READ_PRIVILEGE} missing`;
        personPrivileges.set(personKey, { canRead: reading.canRead, missing: reading.missing }, now);
      }
    } catch (error) {
      console.warn(`[monitoring] Effective permissions on ${table} could not be read: ${(error as Error).message}`);
    }
  }

  const heldPolicies = tablePolicies.get(table, now);
  if (heldPolicies) {
    reading.rowFilter = heldPolicies.rowFilter;
    reading.maskedColumns = heldPolicies.maskedColumns;
  } else {
    try {
      const body = await once(`t:${table}`, () => read(`${TABLE_PATH}/${encodeURIComponent(table)}`));
      const policies = policiesFrom(body);
      reading.rowFilter = policies.rowFilter;
      reading.maskedColumns = policies.maskedColumns;
      tablePolicies.set(table, policies, now);
    } catch (error) {
      console.warn(`[monitoring] Row filter and masks on ${table} could not be read: ${(error as Error).message}`);
    }
  }
  return reading;
}

/**
 * The privileges this principal holds, or null when the body did not say.
 *
 * An empty privilege list for a principal the response DOES mention is a real
 * answer and means no privileges. A response that mentions nobody is not: it may
 * simply not have been readable, and turning that silence into "no privileges"
 * would be a finding about the person.
 */
function privilegesFrom(body: unknown, principal: string): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const assignments = (body as { privilege_assignments?: unknown }).privilege_assignments;
  if (!Array.isArray(assignments)) return null;
  const wanted = principal.trim().toLowerCase();
  const entries: unknown[] = assignments;
  const match = entries.find((entry) => {
    const owner = (entry as { principal?: unknown }).principal;
    return typeof owner === 'string' && owner.trim().toLowerCase() === wanted;
  });
  if (!match) return null;
  const privileges = (match as { privileges?: unknown }).privileges;
  if (!Array.isArray(privileges)) return null;
  return privileges
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const named = (entry as { privilege?: unknown }).privilege;
      return typeof named === 'string' ? named : '';
    })
    .filter((value) => value !== '')
    .map((value) => value.toUpperCase());
}

/**
 * Whether the table carries a row filter, and which columns are masked.
 *
 * PIA CANNOT SAY WHAT EITHER DID TO A PARTICULAR RUN, and the panel must not
 * imply it can. A filtered query succeeds and returns fewer rows; nothing in the
 * result says a filter ran. So this reports that a policy exists on a table the
 * person queries, which is still the answer to the question an admin actually
 * has when two people get different totals from the same question.
 */
function policiesFrom(body: unknown): { rowFilter: boolean | null; maskedColumns: string[] | null } {
  if (!body || typeof body !== 'object') return { rowFilter: null, maskedColumns: null };
  const table = body as { row_filter?: unknown; columns?: unknown };
  const rowFilter = table.row_filter !== undefined && table.row_filter !== null ? true : false;
  if (!Array.isArray(table.columns)) return { rowFilter, maskedColumns: null };
  const masked = table.columns
    .filter((column) => {
      const mask = (column as { mask?: unknown }).mask;
      return mask !== undefined && mask !== null;
    })
    .map((column) => {
      const name = (column as { name?: unknown }).name;
      return typeof name === 'string' ? name : '';
    })
    .filter((name) => name !== '');
  return { rowFilter, maskedColumns: masked };
}
