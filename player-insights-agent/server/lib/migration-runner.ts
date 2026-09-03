/**
 * Apply the numbered schema versions, and never lie about having done so.
 *
 * ── THE FAILURE THIS FILE IS WRITTEN AGAINST ──
 *
 * A migration runner that silently does nothing is worse than no runner at all.
 * With no runner, "has the schema been updated" is an open question and somebody
 * checks. With a runner that reports success on a database it never touched, the
 * question looks answered, the release goes out, and the first symptom is a route
 * failing with `undefined_column` — which in this app is one of the codes a
 * missing GRANT produces, so the investigation starts in the wrong place.
 *
 * Every design choice below follows from that:
 *
 *  - The version table is created FIRST and its failure stops everything. A run
 *    that cannot record what it did must not do it.
 *  - A migration whose statement fails is NOT recorded, and NOTHING AFTER IT
 *    RUNS. Ordering is the whole value of numbering; applying 3 after 2 failed
 *    would produce a database at no version at all.
 *  - `ok` is false unless every known version is recorded as applied. There is no
 *    path through this file that reports success while a version is pending.
 *  - "Nothing to do" and "did nothing" are different results and read
 *    differently. The first names the version it is already at.
 *
 * ── THE STATEMENT TIMEOUT, WHICH HAS ALREADY BROKEN A DEPLOY ──
 *
 * The deployment's `statement_timeout` is a SESSION setting a read leaves behind
 * on the pooled connection it borrowed. Since startup stopped blocking, DDL runs
 * while reads are in flight and can be handed one of those connections.
 * `CREATE INDEX` takes an ACCESS EXCLUSIVE lock and waits for the reads already
 * touching the table to finish — and that wait counts against the same timer, so
 * the queue and the index build share one thirty-second budget. Cancelled, it
 * comes back as an ordinary failed statement and the deployment carries on
 * without the index, with nothing anywhere naming a read's timer as the cause.
 *
 * So all DDL here runs inside {@link withoutReadTimeout}, which lifts the limit
 * on one checked-out connection and PUTS IT BACK before returning it to the pool.
 * That property is load-bearing in both directions and must survive any edit to
 * this file: without the lift, migrations are cancelled on a read's budget;
 * without the restore, every later read on that connection is unbounded.
 *
 * ── WHAT IS NOT HERE ──
 *
 * No transactions, because AppKit hands this app a bare `query(text, params)`
 * with no way to hold a connection across calls. Each statement commits on its
 * own and the `schema_version` row is a separate write, which is why every
 * migration statement has to be idempotent. See `migrations.ts`.
 *
 * `schema_version` records a number, an object-level name, a count, a clock,
 * and the trusted actor supplied by the caller. Boot and release callers use an
 * object label; the explicit in-app admin recovery path records the signed-in
 * administrator so a migration action is attributable without storing content.
 */

import {
  GRANT_DENIED_LOG_REMEDY,
  isGrantDenialFailure,
  withoutReadTimeout,
  type LakebaseReader,
} from './lakebase-store';
import { migrationRegistryFault, type Migration } from './migrations';
import { schemaOwnershipQuery, schemaWriteRefusal } from './schema-ownership-guard';

/** One statement of a migration that the database refused. */
export interface SchemaStatementFailure {
  /** 1-based within its migration, so it reads the same way as the log line. */
  position: number;
  /** {@link describeSql} of the statement: the verb and the object it touches. */
  label: string;
  message: string;
  /**
   * Postgres's SQLSTATE, when it gave one.
   *
   * Kept because the summary has to tell two failures apart that read
   * identically in prose: a statement refused because the app's role does not
   * own the table it is altering, and a statement refused because the role has
   * no privilege on the schema at all. The first is a harmless no-op; the second
   * is a deployment whose one manual setup step was never performed. Only the
   * second has a remedy worth printing, and printing it for the first would
   * train the reader to skip it.
   */
  code: string;
  /**
   * Whether the end state the statement maintains is already in place.
   *
   * Established by reading the schema rather than inferred from the error: an
   * `ADD COLUMN IF NOT EXISTS` refused on ownership changes nothing when the
   * columns are already there, and reporting that at the same volume as a
   * statement which left the schema incomplete is what made the summary
   * unreadable on every boot.
   */
  satisfied: boolean;
}

/** What one version's attempt came to. */
export interface MigrationAttempt {
  version: number;
  name: string;
  /**
   * `applied` — every statement landed, or was refused with its end state
   * already verifiably in place, and the version is recorded.
   * `failed` — at least one statement was refused and its end state could not be
   * confirmed. The version is NOT recorded and nothing after it was attempted.
   * `unrecorded` — the statements landed but the `schema_version` write did not,
   * so the next run will replay them. Distinguished from `applied` because the
   * database is now ahead of what it claims, and from `failed` because the
   * schema is actually correct.
   */
  outcome: 'applied' | 'failed' | 'unrecorded';
  failures: SchemaStatementFailure[];
}

export interface MigrationOutcome {
  /** Which question was asked: apply the pending versions, or just report them. */
  mode: 'apply' | 'verify';
  /**
   * The highest recorded version before this run, or `null` when that could not
   * be established at all. `null` is never collapsed into `0`: "no version
   * recorded" and "could not read the version table" send an operator to
   * different places.
   */
  versionBefore: number | null;
  versionAfter: number | null;
  attempts: MigrationAttempt[];
  /** Known versions still not recorded as applied when this run finished. */
  pending: number[];
  /**
   * Versions the database records that this build does not know about, which
   * means an older build is running against a newer database. Reported and never
   * acted on: nothing here deletes a row it cannot explain.
   */
  ahead: number[];
  /** Why the run could not proceed at all, or '' when it did. */
  blocked: string;
  /**
   * True only when every known version is recorded as applied. A caller may gate
   * a release on this, and nothing in this file sets it optimistically.
   */
  ok: boolean;
}

export interface RollbackOutcome {
  /** The version the database was at before this call, or `null` if unreadable. */
  versionBefore: number | null;
  versionAfter: number | null;
  /** Versions whose `down` ran and whose `schema_version` row was removed. */
  reverted: number[];
  /** Why it stopped, or '' when it reached the target. */
  blocked: string;
  ok: boolean;
}

export interface RunnerOptions {
  /** The app's schema. Passed in so this file holds no second copy of the name. */
  schema: string;
  migrations: readonly Migration[];
  /**
   * `apply` runs the pending versions. `verify` runs none of them and reports
   * what is pending, which is what a release check and a boot on a deployment
   * with a wired deploy step both want.
   */
  mode?: 'apply' | 'verify';
  /**
   * Recorded in `schema_version.applied_by`, so an operator can tell whether the
   * explicit deploy step, boot fallback, or signed-in administrator applied it.
   * The caller must supply only a trusted actor label, never request content.
   */
  appliedBy?: string;
}

/* ── Reading the schema, to tell a no-op refusal from a real one ───────────── */

const ALTER_TARGET = /^ALTER TABLE\s+(\w+)\.(\w+)/i;
const ADDED_COLUMN = /ADD COLUMN IF NOT EXISTS\s+(\w+)/gi;
const CREATE_TABLE_TARGET = /^CREATE TABLE IF NOT EXISTS\s+(\w+)\.(\w+)/i;
const CREATE_INDEX_TARGET = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF NOT EXISTS\s+(\w+)\s+ON\s+(\w+)\./i;

/**
 * A short label for a statement: the verb and the object it touches.
 *
 * Long enough to find the statement, short enough to list a dozen of them on one
 * line. A bare "CREATE" tells a reader nothing; the whole statement pushes the
 * summary off the screen. A refused `ALTER TABLE ${APP_SCHEMA}.messages` reads
 * as exactly the object somebody has to go and look at.
 *
 * An index is named by its own name rather than by its table. Naming it by the
 * table would give four statements on `${APP_SCHEMA}.runs` the same label, and
 * the summary lists labels, so a reader would be told that "CREATE
 * ${APP_SCHEMA}.runs" failed with no way to tell which of the four it was.
 */
export function describeSql(sql: string): string {
  const collapsed = sql.replace(/\s+/g, ' ').trim();
  const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(collapsed);
  if (index) return `CREATE INDEX ${index[1]}`;
  const dropped = /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:\w+\.)?(\w+)/i.exec(collapsed);
  if (dropped) return `DROP INDEX ${dropped[1]}`;
  const verb = collapsed.split(' ', 1)[0]?.toUpperCase() ?? 'QUERY';
  const object =
    /(?:FROM|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|SCHEMA(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+(\w+(?:\.\w+)?)/i.exec(
      collapsed
    )?.[1];
  return object ? `${verb} ${object}` : `${verb} statement`;
}

/**
 * The lowercased values of one column of a verifying read, or null if the read
 * itself failed.
 *
 * Null and empty are distinguished on purpose. An empty result means the object
 * is genuinely absent, which keeps the refusal loud; a failed read means nothing
 * was established at all, and collapsing the two would let a database that
 * refuses `information_schema` quieten every refusal at once.
 *
 * The column is read through {@link identifierText}, so a value that is not
 * already a scalar is read as absent rather than stringified. These are
 * identifier columns, so that should not arise; when it did, `['created_at']`
 * stringified to `created_at` and a refusal was reported as a harmless no-op on
 * the strength of a row nobody could vouch for.
 */
async function schemaNames(
  client: LakebaseReader,
  sql: string,
  params: unknown[],
  column: string
): Promise<Set<string> | null> {
  try {
    const result = await client.lakebase.query(sql, params);
    return new Set(result.rows.map((row) => (identifierText(row[column]) ?? '').toLowerCase()));
  } catch {
    return null;
  }
}

/** Scalar columns only. Anything that is not already a scalar is not a name. */
function identifierText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Whether the end state a refused statement maintains is already in place.
 *
 * Established by READING THE SCHEMA rather than by interpreting the error,
 * because the two cases that matter arrive as the same SQLSTATE with nearly the
 * same prose: a statement that changed nothing, and a statement that left the
 * schema short of what this version reads. Only the second is worth waking
 * somebody for, and reporting both at the same volume is what taught people to
 * skip the line.
 *
 * Three kinds of statement can be decided this way, and they are the three that
 * Postgres refuses on ownership before it decides they are no-ops:
 * `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS` and
 * `CREATE INDEX IF NOT EXISTS`. Anything else, and any verifying read that
 * itself fails, answers false and stays loud: the point is to quieten the case
 * that is PROVABLY harmless, not the case nobody could check.
 */
export async function statementAlreadySatisfied(client: LakebaseReader, statement: string): Promise<boolean> {
  const trimmed = statement.trim();

  const altered = ALTER_TARGET.exec(trimmed);
  if (altered) {
    const wanted = [...statement.matchAll(ADDED_COLUMN)].map((match) => match[1].toLowerCase());
    if (wanted.length === 0) return false;
    const present = await schemaNames(
      client,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [altered[1], altered[2]],
      'column_name'
    );
    return present !== null && wanted.every((column) => present.has(column));
  }

  const created = CREATE_TABLE_TARGET.exec(trimmed);
  if (created) {
    const present = await schemaNames(
      client,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
      [created[1], created[2]],
      'table_name'
    );
    return present !== null && present.has(created[2].toLowerCase());
  }

  const indexed = CREATE_INDEX_TARGET.exec(trimmed);
  if (indexed) {
    // `CREATE INDEX CONCURRENTLY` can leave a same-named INVALID index after a
    // cancelled build. `IF NOT EXISTS` sees that object and skips it, so name
    // presence alone is not enough to record the migration. Only a ready,
    // valid index is the end state this statement promises.
    const present = await schemaNames(
      client,
      `SELECT index_class.relname AS indexname
       FROM pg_catalog.pg_class index_class
       JOIN pg_catalog.pg_namespace namespace
         ON namespace.oid = index_class.relnamespace
       JOIN pg_catalog.pg_index index_state
         ON index_state.indexrelid = index_class.oid
       WHERE namespace.nspname = $1
         AND index_class.relname = $2
         AND index_state.indisready
         AND index_state.indisvalid`,
      [indexed[2], indexed[1]],
      'indexname'
    );
    return present !== null && present.has(indexed[1].toLowerCase());
  }

  return false;
}

/* ── The version table ─────────────────────────────────────────────────────── */

/** The table's unqualified name, for anything that has to look for it. */
export const SCHEMA_VERSION_TABLE = 'schema_version';

/**
 * The one statement that makes the version table exist.
 *
 * ── WHY THERE IS NO `CREATE SCHEMA` HERE, AND WHY IT RUNS LATE ──
 *
 * The obvious shape is `CREATE SCHEMA` then `CREATE TABLE`, before anything
 * else. It was written that way first and it was wrong twice over. The schema
 * statement is textually identical to the first statement of the baseline
 * migration, so every boot issued it twice and nothing downstream could tell the
 * runner's copy from the migration's — including the fixtures that assert which
 * DDL the app issued.
 *
 * So instead: read the version table first, and create it only if that read
 * failed, AFTER the migrations have run. On a genuinely fresh database the
 * baseline has by then created the schema this table lives in; on every
 * deployment after the first, the read succeeds and no DDL is issued here at
 * all. The cost is that a fresh database's first `INSERT` is preceded by one
 * `CREATE TABLE IF NOT EXISTS`, which is the statement that would have run
 * anyway.
 *
 * Nothing in this table is a question or request content: a version number, an
 * object-level name, two counts, a clock, and the trusted actor that ran it.
 */
export function schemaVersionDdl(schema: string): string {
  return `CREATE TABLE IF NOT EXISTS ${schema}.${SCHEMA_VERSION_TABLE} (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       statement_count INTEGER NOT NULL,
       refused_but_satisfied INTEGER NOT NULL DEFAULT 0,
       applied_by TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`;
}

/**
 * Whether a query is the runner's own bookkeeping rather than a migration.
 *
 * The runner issues three things no migration asked for: the version table's
 * `CREATE`, the `SELECT` that reads applied versions, and the `INSERT`/`DELETE`
 * that record them. A caller reasoning about WHICH SCHEMA STATEMENTS were issued
 * — a test asserting that one refusal did not stop the rest, a fake store
 * counting DDL — has to be able to exclude them without knowing how this file is
 * written.
 *
 * Matched on the table name rather than on exact text, so that adding a column to
 * `schema_version` cannot quietly turn its own DDL into something a caller counts
 * as a migration statement.
 */
export function isSchemaVersionBookkeeping(sql: string, schema: string): boolean {
  return sql.replace(/\s+/g, ' ').includes(`${schema}.${SCHEMA_VERSION_TABLE}`);
}

/**
 * The versions the database records as applied, ascending.
 *
 * `null` when the question could not be answered — the table is absent on a
 * database nothing has migrated, and unreadable on one where the grant is
 * missing. Both are `null` here and separated by the caller, which has just
 * tried to create it and therefore knows which of the two it is looking at.
 */
export async function readAppliedVersions(client: LakebaseReader, schema: string): Promise<number[] | null> {
  try {
    const result = await client.lakebase.query(
      `SELECT version FROM ${schema}.${SCHEMA_VERSION_TABLE} ORDER BY version ASC`,
      []
    );
    const versions: number[] = [];
    for (const row of result.rows) {
      const version = Number(row.version);
      if (Number.isInteger(version)) versions.push(version);
    }
    return versions;
  } catch {
    return null;
  }
}

/* ── Applying ──────────────────────────────────────────────────────────────── */

function failureCode(error: unknown): string {
  const raw = (error as { code?: unknown }).code;
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
}

/**
 * Why the DDL must not run, or '' when it may.
 *
 * A guard that cannot read `pg_namespace` must not become a second way for the
 * app to refuse to start, so an unanswerable question proceeds. The statements
 * are individually safe against a schema this role does not own; this exists to
 * stop the one case that is not, which is a table this version has newly ADDED
 * being created and owned by whoever happened to boot.
 */
async function ownershipRefusal(client: LakebaseReader, schema: string): Promise<string> {
  try {
    const result = await client.lakebase.query(schemaOwnershipQuery(), [schema]);
    const row = result.rows[0];
    if (!row) return '';
    return schemaWriteRefusal(schema, {
      schemaExists: row.schema_exists === true,
      owner: identifierText(row.owner) ?? '',
      connectedRole: identifierText(row.connected_role) ?? '',
      connectedRoleHoldsOwner: row.connected_role_holds_owner === true,
    });
  } catch (error) {
    console.warn(
      `[migrate] could not establish who owns ${schema}, so the migrations are being attempted as before: ` +
        `${(error as Error).message}`
    );
    return '';
  }
}

/**
 * Bring the database up to the newest known version, or say exactly why not.
 *
 * The order is not negotiable: bootstrap the version table, read what is
 * applied, then apply the pending versions ascending, stopping at the first one
 * that fails. Every early return sets `ok: false`, because the only thing this
 * function may claim on the way out is that the schema is at the version the
 * code expects.
 */
export async function runMigrations(client: LakebaseReader, options: RunnerOptions): Promise<MigrationOutcome> {
  const mode = options.mode ?? 'apply';
  const appliedBy = options.appliedBy ?? 'unknown';
  const { schema, migrations } = options;
  const known = migrations.map((migration) => migration.version);

  const blank = (blocked: string): MigrationOutcome => ({
    mode,
    versionBefore: null,
    versionAfter: null,
    attempts: [],
    pending: [...known],
    ahead: [],
    blocked,
    ok: false,
  });

  // A registry this build could not trust must not be applied to a database.
  // Checked here as well as in the suite because a release runs this file, not
  // the suite, and a version recorded twice is unrecoverable by reading.
  const fault = migrationRegistryFault(migrations);
  if (fault) {
    console.error(
      `[migrate] MIGRATIONS NOT APPLIED: the migration list in this build is not usable — ${fault} ` +
        `Nothing was attempted, and the schema is whatever it already was.`
    );
    return blank(fault);
  }

  // Only when something is about to be written. Verification issues no DDL, so
  // ownership has no bearing on it — and gating it anyway made the release check
  // useless in exactly the case it exists for: a release runs as a person, the
  // schema is owned by the app's service principal, and the guard refused to so
  // much as READ the version. It reported "skipped" against a database it could
  // have answered about, which is the shape of uselessness this whole file is
  // written against.
  if (mode === 'apply') {
    const refusal = await ownershipRefusal(client, schema);
    if (refusal) {
      console.error(`[migrate] MIGRATIONS SKIPPED: ${refusal}`);
      return blank(refusal);
    }
  }

  const applied = await readAppliedVersions(client, schema);
  if (applied === null) {
    // Unknown, not zero, and NOT a reason to stop. On a deployment nothing has
    // migrated the table does not exist yet; on a store that refuses everything
    // this is one more symptom of the same cause, and the per-statement
    // reporting below is where that diagnosis lives — stopping here would
    // replace it with one line about a bookkeeping table.
    //
    // Applying anyway is safe because every statement is idempotent. What must
    // not happen is CLAIMING to have applied them, and `recorded` staying empty
    // is what stops that: a version that cannot be written comes back
    // `unrecorded`, which leaves `pending` non-empty and `ok` false.
    console.warn(
      `[migrate] VERSION UNKNOWN: ${schema}.${SCHEMA_VERSION_TABLE} could not be read, so what is already applied ` +
        `is unknown. ${
          mode === 'verify'
            ? 'Nothing was run, because this was a verification. On a deployment that has never been migrated the ' +
              'table does not exist yet, which is itself the answer: run the migration step.'
            : 'Every version is being attempted, because the statements are idempotent, and the table is created ' +
              'before the first version is recorded.'
        }`
    );
  }

  const recorded = new Set(applied ?? []);
  const versionBefore = applied === null ? null : applied.length > 0 ? Math.max(...applied) : 0;
  const ahead = (applied ?? []).filter((version) => !known.includes(version));
  if (ahead.length > 0) {
    console.warn(
      `[migrate] This database records version(s) ${ahead.join(', ')}, which this build does not know about. An ` +
        `older build is running against a newer schema. Nothing is being removed: a row this build cannot explain ` +
        `is not a row it may delete.`
    );
  }

  const pending = migrations.filter((migration) => !recorded.has(migration.version));

  if (pending.length === 0) {
    console.log(
      `[migrate] Schema is at version ${versionBefore} (${recorded.size} recorded); nothing to apply. ` +
        `This is not the same as having done nothing: every known version is recorded as applied.`
    );
    return {
      mode,
      versionBefore,
      versionAfter: versionBefore,
      attempts: [],
      pending: [],
      ahead,
      blocked: '',
      ok: true,
    };
  }

  if (mode === 'verify') {
    console.error(
      `[migrate] SCHEMA BEHIND: version(s) ${pending.map((migration) => migration.version).join(', ')} ` +
        `(${pending.map((migration) => migration.name).join('; ')}) are not applied. Nothing was run, because this ` +
        `was a verification. Run the migration step before serving traffic that reads what they create.`
    );
    return {
      mode,
      versionBefore,
      versionAfter: versionBefore,
      attempts: [],
      pending: pending.map((migration) => migration.version),
      ahead,
      blocked: '',
      ok: false,
    };
  }

  const attempts: MigrationAttempt[] = [];
  let versionAfter = versionBefore;
  // Created once per run, lazily, and only when the read above could not see it.
  // See `schemaVersionDdl` for why it is not the first thing this function does.
  let versionTableReady = applied !== null;

  for (const migration of pending) {
    const attempt = await applyOne(client, schema, migration, appliedBy, async () => {
      if (versionTableReady) return;
      versionTableReady = true;
      await bootstrapVersionTable(client, schema);
    });
    attempts.push(attempt);
    if (attempt.outcome === 'applied') {
      versionAfter = Math.max(versionAfter ?? 0, migration.version);
      continue;
    }
    // Stop. Ordering is the entire value of numbering: version 4 may read a
    // column version 3 was supposed to add, and applying it anyway would leave a
    // database that is at no coherent version at all and cannot be repaired by
    // re-running.
    console.error(
      `[migrate] STOPPED AT VERSION ${migration.version} (${migration.name}). ` +
        `${pending.length - attempts.length} later version(s) were NOT attempted, deliberately: a migration that ` +
        `runs after the one it depends on failed leaves the schema at no version at all.`
    );
    break;
  }

  const stillPending = migrations
    .filter((migration) => !recorded.has(migration.version))
    .filter(
      (migration) => !attempts.some((attempt) => attempt.version === migration.version && attempt.outcome === 'applied')
    )
    .map((migration) => migration.version);

  const ok = stillPending.length === 0;
  if (ok) {
    console.log(
      `[migrate] Applied version(s) ${attempts.map((attempt) => attempt.version).join(', ')}; schema is now at ` +
        `version ${versionAfter}.`
    );
  } else {
    console.error(
      `[migrate] SCHEMA INCOMPLETE: version(s) ${stillPending.join(', ')} are not applied. The schema is at ` +
        `version ${versionAfter}, and anything that reads what those versions create will fail. This is reported ` +
        `as a failure rather than logged and forgotten, so a release that reads it can refuse to promote.`
    );
  }

  return { mode, versionBefore, versionAfter, attempts, pending: stillPending, ahead, blocked: '', ok };
}

/**
 * The version table, created because the read of it failed.
 *
 * A refusal here is warned about and not fatal: a table refused on ownership is
 * a table that already exists, and the `INSERT` that follows will say so far more
 * precisely than a guess made from this statement's error would.
 */
async function bootstrapVersionTable(client: LakebaseReader, schema: string): Promise<void> {
  try {
    await withoutReadTimeout(client, (query) => query(schemaVersionDdl(schema)));
  } catch (error) {
    console.warn(
      `[migrate] ${schema}.${SCHEMA_VERSION_TABLE} could not be created (${failureCode(error) || 'no code'}): ` +
        `${(error as Error).message}. If it already exists this changed nothing; if it does not, the version below ` +
        `will be reported as applied-but-not-recorded.`
    );
  }
}

/** One version: its statements, then its row. */
async function applyOne(
  client: LakebaseReader,
  schema: string,
  migration: Migration,
  appliedBy: string,
  ensureVersionTable: () => Promise<void>
): Promise<MigrationAttempt> {
  const refused: { failure: SchemaStatementFailure; statement: string }[] = [];
  const total = migration.statements.length;
  const lockKey = `${schema}:migration:${migration.version}`;
  let recordedWhileWaiting = false;

  // NOT ON A READ'S BUDGET. See the file header: the timeout is a session
  // setting a read leaves on a pooled connection, `CREATE INDEX` waits on an
  // ACCESS EXCLUSIVE lock, and that wait counts against the same timer.
  // `withoutReadTimeout` lifts it on one connection and restores it before the
  // connection goes back to the pool.
  try {
    await withoutReadTimeout(
      client,
      async (query) => {
        let locked = false;
        try {
          if (migration.lock === 'session') {
            await query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
            locked = true;
            // Another replica may have completed this version while this one
            // waited for the lock. Re-read on the pinned session before running
            // replay cleanup such as DROP INDEX, or the stale replica could
            // remove the valid index the winner just built.
            try {
              const current = await query(`SELECT version FROM ${schema}.${SCHEMA_VERSION_TABLE} WHERE version = $1`, [
                migration.version,
              ]);
              recordedWhileWaiting = current.rows.some((row) => Number(row.version) === migration.version);
            } catch {
              // A fresh database may not have the version table yet. The normal
              // post-statement bootstrap path below remains authoritative.
            }
          }
          for (const [index, statement] of (recordedWhileWaiting ? [] : migration.statements).entries()) {
            try {
              await query(statement);
            } catch (error) {
              // Every statement is attempted, including the ones after a failure. The
              // loop used to `break`, which turned one ownership no-op into seven
              // statements that silently never ran.
              refused.push({
                statement,
                failure: {
                  position: index + 1,
                  label: describeSql(statement),
                  message: (error as Error).message,
                  code: failureCode(error),
                  satisfied: false,
                },
              });
            }
          }
        } finally {
          if (locked) {
            await query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
          }
        }
      },
      { requirePinnedConnection: migration.lock === 'session' }
    );
  } catch (error) {
    const failure: SchemaStatementFailure = {
      position: 1,
      label: `SERIALIZE version ${migration.version}`,
      message: (error as Error).message,
      code: failureCode(error),
      satisfied: false,
    };
    console.error(
      `[migrate] version ${migration.version} (${migration.name}) could not reserve its serialized migration ` +
        `session, so none of its state may be recorded: ${failure.message}`
    );
    return { version: migration.version, name: migration.name, outcome: 'failed', failures: [failure] };
  }

  if (recordedWhileWaiting) {
    return { version: migration.version, name: migration.name, outcome: 'applied', failures: [] };
  }

  const failures = refused.map((entry) => entry.failure);

  // ── WHEN THE VERIFYING READ IS WORTH MAKING ──
  //
  // Verify every refused idempotent statement. A migration may consist entirely
  // of ALTERs against tables owned by an earlier app role; all can be harmless
  // no-ops even though every write is refused. `schemaNames` returns null when
  // the store itself is unreachable, so this remains fail-closed.
  const ownershipNoops = refused.filter(
    ({ failure }) => failure.code === '42501' || /must be owner\b/i.test(failure.message)
  );
  if (ownershipNoops.length > 0) {
    for (const entry of ownershipNoops) {
      entry.failure.satisfied = await statementAlreadySatisfied(client, entry.statement);
    }
  }

  const unresolved = failures.filter((failure) => !failure.satisfied);
  reportStatementFailures(migration, total, refused, unresolved);

  if (unresolved.length > 0) {
    return { version: migration.version, name: migration.name, outcome: 'failed', failures };
  }

  // Only now, and only if the earlier read could not see it. The schema this
  // table lives in may not have existed before the statements above ran.
  await ensureVersionTable();

  try {
    await client.lakebase.query(
      `INSERT INTO ${schema}.${SCHEMA_VERSION_TABLE} (version, name, statement_count, refused_but_satisfied, applied_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (version) DO NOTHING`,
      [migration.version, migration.name, total, failures.length, appliedBy]
    );
  } catch (error) {
    // The schema is correct and the record of it is not, which is its own
    // outcome rather than a success or a failure. Re-running replays idempotent
    // statements and writes the row, so this is recoverable — but only if it is
    // reported, which is why it is not swallowed here.
    console.error(
      `[migrate] v${migration.version} (${migration.name}) APPLIED BUT NOT RECORDED: ${(error as Error).message}. ` +
        `The statements landed, so the schema is correct, but ${SCHEMA_VERSION_TABLE} does not say so and the next ` +
        `run will replay them. Every statement is idempotent, so that replay is safe.`
    );
    return { version: migration.version, name: migration.name, outcome: 'unrecorded', failures };
  }

  return { version: migration.version, name: migration.name, outcome: 'applied', failures };
}

/**
 * Say what a version's refused statements mean, in the wording this app already
 * uses for it.
 *
 * ── WHY THE SENTENCES ARE PRESERVED VERBATIM ──
 *
 * These lines are the app's operational vocabulary for a schema problem and each
 * clause was added because its absence misled somebody:
 *
 *  - A refusal that changed nothing warns; a refusal that left the schema short
 *    errors. Both arrive as the same SQLSTATE, so the split is decided by reading
 *    the schema, and reporting them at one volume is what taught people to skip
 *    the line on every boot.
 *  - The partial-failure summary must NOT say the store is unusable. Ten accepted
 *    statements are proof it answered, and claiming otherwise sent the next
 *    person to debug an outage that was not happening.
 *  - Only the all-refused case says the app is starting without a usable store,
 *    and it never promises representative rows: no deployment has any, and an
 *    operator who reads that goes looking for seeded data on a screen that is
 *    reporting an outage.
 *  - The grant-script remedy is appended only for an actual privilege denial, so
 *    that it does not print on every healthy boot and stop meaning anything.
 *
 * The version and its name are appended rather than woven in, so that a grep or
 * a test written against the old sentence still finds it.
 */
function reportStatementFailures(
  migration: Migration,
  total: number,
  refused: readonly { failure: SchemaStatementFailure; statement: string }[],
  unresolved: readonly SchemaStatementFailure[]
): void {
  const version = `(version ${migration.version}, ${migration.name})`;

  for (const { failure } of refused) {
    if (failure.satisfied) {
      console.warn(
        `[lakebase] SCHEMA STATEMENT ${failure.position} of ${total} was refused (${failure.label}): ` +
          `${failure.message}. Every column it adds is already present, so the schema is what this version ` +
          `reads and nothing changed. The usual cause is ownership, which Postgres checks before it decides ` +
          `the statement is a no-op. To stop it recurring, see scripts/grant-app-db-access.mjs. ${version}`
      );
      continue;
    }
    const remaining = total - failure.position;
    console.error(
      `[lakebase] SCHEMA STATEMENT ${failure.position} of ${total} FAILED (${failure.label}): ` +
        `${failure.message}. ` +
        (remaining > 0 ? `The remaining ${remaining} statement(s) still run: one refusal no longer stops them. ` : '') +
        `If the object this statement maintains is already in place, nothing changed; if it is not, ` +
        `everything that reads it will fail. ${version}`
    );
  }

  if (unresolved.length === 0) return;

  const denied = unresolved.filter(isGrantDenialFailure);
  const grantRemedy = denied.length > 0 ? ` ${GRANT_DENIED_LOG_REMEDY}` : '';

  if (unresolved.length === total) {
    // Nothing was accepted, which on the baseline means the store never
    // answered: the first statement is `CREATE SCHEMA IF NOT EXISTS`, which
    // succeeds against any reachable database the app can write to. Unless it
    // was refused rather than unanswered — a role with no CREATE on the database
    // fails that first statement too, and then every one after it, which looks
    // identical from the count alone. Saying "the store never answered" of a
    // store that answered eleven times to say no is the same conflation this
    // reporting exists to remove.
    console.error(
      `[lakebase] SCHEMA SETUP ${denied.length === total ? 'REFUSED' : 'FAILED'}: all ${total} statements ` +
        `were ${denied.length === total ? 'refused by Postgres on privileges' : 'refused'}, so the app is ` +
        `starting without a usable store and every read below will report itself unavailable rather than ` +
        `return rows. First error (${unresolved[0].label}): ${unresolved[0].message}${grantRemedy} ${version}`
    );
    return;
  }

  console.error(
    `[lakebase] SCHEMA SETUP INCOMPLETE: ${unresolved.length} of ${total} statements failed ` +
      `(${unresolved.map((failure) => failure.label).join(', ')}); the other ${total - unresolved.length} ` +
      `left the schema as this version reads it, so the store answered and reads and writes below will ` +
      `use it, and nothing below is answered from anywhere else. What is not established is ` +
      `whatever those statements maintain, check the objects named above exist and carry the columns ` +
      `this version expects. The usual cause on a database that already has these tables is ownership: ` +
      `ALTER requires the app's Postgres role to own the table, IF NOT EXISTS does not exempt it, because ` +
      `Postgres refuses on ownership before it decides the statement is a no-op. ` +
      `See scripts/grant-app-db-access.mjs.` +
      (grantRemedy
        ? ` ${denied.length} of those refusals ${denied.length === 1 ? 'is' : 'are'} a privilege ` +
          `denial (${[...new Set(denied.map((failure) => failure.code))].join(', ')}) rather than the ` +
          `ownership no-op, which means the grant is missing rather than merely narrow.${grantRemedy}`
        : '') +
      ` ${version}`
  );
}

/* ── Rolling back ──────────────────────────────────────────────────────────── */

/**
 * Undo applied versions down to `target`, newest first, or say why it stopped.
 *
 * A version whose `down` is `null` STOPS the rollback with its row intact. That
 * is the whole point: a rollback that deleted the row for a migration whose
 * objects are still there would leave the database ahead of the version it
 * claims to be at, and the next deployment would skip the migration that would
 * have repaired it. Nothing here is best-effort.
 */
export async function rollbackTo(
  client: LakebaseReader,
  target: number,
  options: RunnerOptions
): Promise<RollbackOutcome> {
  const { schema, migrations } = options;
  const applied = await readAppliedVersions(client, schema);
  if (applied === null) {
    const message = `${schema}.${SCHEMA_VERSION_TABLE} could not be read, so there is no record of what to undo.`;
    console.error(`[migrate] ROLLBACK NOT ATTEMPTED: ${message}`);
    return { versionBefore: null, versionAfter: null, reverted: [], blocked: message, ok: false };
  }

  const versionBefore = applied.length > 0 ? Math.max(...applied) : 0;
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const toRevert = applied.filter((version) => version > target).sort((a, b) => b - a);

  if (toRevert.length === 0) {
    console.log(`[migrate] Schema is at version ${versionBefore}, which is already at or below ${target}.`);
    return { versionBefore, versionAfter: versionBefore, reverted: [], blocked: '', ok: true };
  }

  const reverted: number[] = [];
  let versionAfter = versionBefore;

  for (const version of toRevert) {
    const migration = byVersion.get(version);
    if (!migration) {
      const message =
        `Version ${version} is recorded as applied but this build does not contain it, so there is nothing to ` +
        `run to undo it. An older build cannot roll back a newer database.`;
      console.error(`[migrate] ROLLBACK STOPPED AT ${version}: ${message}`);
      return { versionBefore, versionAfter, reverted, blocked: message, ok: false };
    }
    if (migration.down === null) {
      const message =
        `Version ${version} (${migration.name}) declares no way to undo itself, so the rollback stops here with ` +
        `its record intact. Going back past it is a database restore, not a migration rollback.`;
      console.error(`[migrate] ROLLBACK STOPPED AT ${version}: ${message}`);
      return { versionBefore, versionAfter, reverted, blocked: message, ok: false };
    }

    const refusals: string[] = [];
    await withoutReadTimeout(client, async (query) => {
      for (const statement of migration.down ?? []) {
        try {
          await query(statement);
        } catch (error) {
          refusals.push(`${describeSql(statement)}: ${(error as Error).message}`);
        }
      }
    });
    const failed = refusals[0];
    if (failed) {
      const message =
        `Version ${version} (${migration.name}) could not be undone — ${failed}. Its record is left in place, ` +
        `because a version whose objects are still there must not be reported as removed.`;
      console.error(`[migrate] ROLLBACK FAILED AT ${version}: ${message}`);
      return { versionBefore, versionAfter, reverted, blocked: message, ok: false };
    }

    try {
      await client.lakebase.query(`DELETE FROM ${schema}.${SCHEMA_VERSION_TABLE} WHERE version = $1`, [version]);
    } catch (error) {
      const message =
        `Version ${version} (${migration.name}) was undone but its record could not be removed: ` +
        `${(error as Error).message}. The database is now BEHIND the version it claims to be at, which the next ` +
        `migration run will not repair on its own because it skips versions already recorded.`;
      console.error(`[migrate] ROLLBACK HALF-DONE AT ${version}: ${message}`);
      return { versionBefore, versionAfter, reverted, blocked: message, ok: false };
    }

    reverted.push(version);
    versionAfter = Math.max(0, ...applied.filter((other) => other < version));
    console.log(`[migrate] Rolled version ${version} (${migration.name}) back; schema is now at ${versionAfter}.`);
  }

  return { versionBefore, versionAfter, reverted, blocked: '', ok: true };
}
