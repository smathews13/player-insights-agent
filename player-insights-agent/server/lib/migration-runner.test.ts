import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSchemaVersionBookkeeping, readAppliedVersions, rollbackTo, runMigrations } from './migration-runner';
import type { LakebaseReader } from './lakebase-store';
import { BASELINE_VERSION, buildMigrations, migrationRegistryFault, type Migration } from './migrations';
import { MIGRATIONS } from '../routes/insights-routes';
import { schemaOwnershipQuery } from './schema-ownership-guard';

/**
 * What the migration runner does when things go wrong, which is the only thing
 * worth testing about it.
 *
 * A runner that applies a clean list to an empty database is easy and is not the
 * risk. The risk is a runner that SILENTLY DOES NOTHING: reports success on a
 * database it never touched, records a version whose statements failed, or
 * applies version 3 after version 2 was refused. Any of those is worse than
 * having no runner at all, because with no runner somebody checks by hand,
 * whereas a green migration step is believed.
 *
 * So every case below is a failure mode, and each asserts two things: what the
 * runner reported, and what it did or did not issue to the database.
 */

const SCHEMA = 'test_app';

interface FakeOptions {
  /** A message to reject with, or null to accept. Called for every query. */
  refuse?: (sql: string) => string | { message: string; code: string } | null;
  /** Versions the version table already holds. */
  recorded?: number[];
  /** Answer the version table's own reads and writes at all. */
  versionTable?: 'works' | 'missing';
  /** Objects `statementAlreadySatisfied` should find when it reads the schema. */
  present?: { columns?: string[]; tables?: string[]; indexes?: string[] };
  /** What the ownership probe should say. Absent means "schema does not exist". */
  ownership?: Record<string, unknown>;
  /** Simulate another replica recording this version while the lock is awaited. */
  recordOnLock?: number;
}

/**
 * A Lakebase stand-in that records what it was asked, separating the runner's own
 * bookkeeping from the statements a migration asked for.
 *
 * The separation matters for nearly every case here: "was version 3 attempted"
 * is a question about migration statements, and a fake that lumped the version
 * table's SELECT in with them would answer it wrongly by one every time.
 */
function fakeStore(options: FakeOptions = {}) {
  const migrationSql: string[] = [];
  const bookkeeping: string[] = [];
  const recordedVersions = new Set(options.recorded ?? []);
  const inserts: unknown[][] = [];
  const deletes: unknown[][] = [];
  const sessionSql: string[] = [];

  function answer(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const collapsed = sql.replace(/\s+/g, ' ').trim();

    if (collapsed === schemaOwnershipQuery().replace(/\s+/g, ' ').trim()) {
      return Promise.resolve({
        rows: [
          options.ownership ?? {
            schema_exists: false,
            owner: '',
            connected_role: 'a-test',
            connected_role_holds_owner: false,
          },
        ],
      });
    }

    // The verifying reads that decide whether a refusal changed anything.
    if (/information_schema\.columns/i.test(collapsed)) {
      return Promise.resolve({ rows: (options.present?.columns ?? []).map((column_name) => ({ column_name })) });
    }
    if (/information_schema\.tables/i.test(collapsed)) {
      return Promise.resolve({ rows: (options.present?.tables ?? []).map((table_name) => ({ table_name })) });
    }
    if (/pg_catalog\.pg_index/i.test(collapsed)) {
      return Promise.resolve({ rows: (options.present?.indexes ?? []).map((indexname) => ({ indexname })) });
    }

    if (isSchemaVersionBookkeeping(collapsed, SCHEMA)) {
      bookkeeping.push(collapsed);
      if (options.versionTable === 'missing') {
        return Promise.reject(new Error(`relation "${SCHEMA}.schema_version" does not exist`));
      }
      if (/^SELECT version/i.test(collapsed)) {
        return Promise.resolve({ rows: [...recordedVersions].sort((a, b) => a - b).map((version) => ({ version })) });
      }
      if (/^INSERT INTO/i.test(collapsed)) {
        inserts.push(params);
        recordedVersions.add(Number(params[0]));
        return Promise.resolve({ rows: [] });
      }
      if (/^DELETE FROM/i.test(collapsed)) {
        deletes.push(params);
        recordedVersions.delete(Number(params[0]));
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }

    migrationSql.push(collapsed);
    if (/^SELECT pg_advisory_lock/i.test(collapsed) && options.recordOnLock !== undefined) {
      recordedVersions.add(options.recordOnLock);
    }
    const refusal = options.refuse?.(collapsed) ?? null;
    if (refusal) {
      const error = new Error(typeof refusal === 'string' ? refusal : refusal.message) as Error & { code?: string };
      if (typeof refusal !== 'string') error.code = refusal.code;
      return Promise.reject(error);
    }
    return Promise.resolve({ rows: [] });
  }

  const client: LakebaseReader = {
    lakebase: {
      query: (sql: string, params?: unknown[]) => answer(sql, params),
      // A pool, so that `withoutReadTimeout` takes its real path rather than the
      // fallback. Without one, the case that proves the timeout is lifted and put
      // back would pass against a runner that did neither.
      pool: {
        connect: () =>
          Promise.resolve({
            query: (sql: string, params?: unknown[]) => {
              if (/^SET statement_timeout/i.test(sql.trim())) {
                sessionSql.push(sql.trim());
                return Promise.resolve({ rows: [] });
              }
              return answer(sql, params);
            },
            release: () => {},
          }),
      },
    },
  };

  return { client, migrationSql, bookkeeping, inserts, deletes, sessionSql, recordedVersions };
}

/** Two versions, the second undoable, so ordering and rollback both have a subject. */
function twoVersions(): Migration[] {
  return [
    {
      version: 1,
      name: 'first',
      statements: [`CREATE TABLE IF NOT EXISTS ${SCHEMA}.one (id TEXT PRIMARY KEY)`],
      down: null,
    },
    {
      version: 2,
      name: 'second',
      statements: [`ALTER TABLE ${SCHEMA}.one ADD COLUMN IF NOT EXISTS added TEXT`],
      down: [`ALTER TABLE ${SCHEMA}.one DROP COLUMN IF EXISTS added`],
    },
  ];
}

function options(migrations: readonly Migration[], mode?: 'apply' | 'verify') {
  return { schema: SCHEMA, migrations, mode, appliedBy: 'a test' };
}

let errors: string[];
let warnings: string[];
let logs: string[];

beforeEach(() => {
  errors = [];
  warnings = [];
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
});

afterEach(() => vi.restoreAllMocks());

describe('a migration list this build cannot trust', () => {
  /**
   * Checked before the database is touched, because a version recorded twice
   * cannot be recovered by reading: "applied 3" would mean two different sets of
   * statements and nothing could tell which.
   */
  it('is refused without issuing a single statement', async () => {
    const duplicated: Migration[] = [
      { version: 1, name: 'first', statements: ['SELECT 1'], down: null },
      { version: 1, name: 'again', statements: ['SELECT 2'], down: null },
    ];
    const store = fakeStore();

    const outcome = await runMigrations(store.client, options(duplicated));

    expect(outcome.ok).toBe(false);
    expect(store.migrationSql).toEqual([]);
    expect(store.bookkeeping).toEqual([]);
    expect(outcome.blocked).toContain('appears twice');
    expect(errors.join('\n')).toContain('MIGRATIONS NOT APPLIED');
  });

  it('names each way the list can be wrong', () => {
    expect(migrationRegistryFault([])).toContain('no migrations');
    expect(
      migrationRegistryFault([
        { version: 2, name: 'later', statements: ['SELECT 1'], down: null },
        { version: 1, name: 'earlier', statements: ['SELECT 1'], down: null },
      ])
    ).toContain('must ascend');
    expect(migrationRegistryFault([{ version: 1, name: 'empty', statements: [], down: null }])).toContain(
      'no statements'
    );
    expect(migrationRegistryFault([{ version: 1, name: '  ', statements: ['SELECT 1'], down: null }])).toContain(
      'no name'
    );
    expect(migrationRegistryFault([{ version: 0, name: 'zero', statements: ['SELECT 1'], down: null }])).toContain(
      'positive whole number'
    );
  });

  /** The list the app actually ships has to satisfy the same check. */
  it('passes for the versions this build ships', () => {
    expect(migrationRegistryFault(MIGRATIONS)).toBeNull();
  });
});

describe('the model release audit migration', () => {
  it('persists identity, immutable declaration, versions, and both preflight results', () => {
    const migration = MIGRATIONS.find((entry) => entry.name === 'model release requests');
    expect(migration?.version).toBe(6);
    const ddl = migration?.statements.join('\n') ?? '';
    for (const column of [
      'requested_by',
      'requested_at',
      'declaration JSONB',
      'declaration_revision',
      'v_from',
      'v_to',
      'preflight_at_request',
      'preflight_result',
      'execution_id',
    ]) {
      expect(ddl, column).toContain(column);
    }
  });
});

describe('the app request timing migration', () => {
  it('creates the Lakebase destination on existing versioned schemas', () => {
    const migration = MIGRATIONS.find((entry) => entry.name === 'app request timings');
    expect(migration?.version).toBe(8);
    expect(migration?.statements.join('\n')).toContain('CREATE TABLE IF NOT EXISTS');
    expect(migration?.statements.join('\n')).toContain('request_latencies');
    expect(MIGRATIONS[0].statements.join('\n')).not.toContain('request_latencies');
  });
});

describe('serialized online migrations', () => {
  it('holds one session advisory lock around concurrent index statements', async () => {
    const migration: Migration = {
      version: 2,
      name: 'online indexes',
      lock: 'session',
      statements: [`CREATE INDEX CONCURRENTLY IF NOT EXISTS one_added_idx ON ${SCHEMA}.one (added)`],
      down: [`DROP INDEX CONCURRENTLY IF EXISTS ${SCHEMA}.one_added_idx`],
    };
    const store = fakeStore({ recorded: [1] });

    const outcome = await runMigrations(store.client, options([twoVersions()[0], migration]));

    expect(outcome.ok).toBe(true);
    expect(store.migrationSql).toEqual([
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS one_added_idx ON ${SCHEMA}.one (added)`,
      'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
    ]);
    expect(store.inserts).toEqual([[2, 'online indexes', 1, 0, 'a test']]);
  });

  it('does not replay cleanup after another replica records the version', async () => {
    const migration: Migration = {
      version: 2,
      name: 'online indexes',
      lock: 'session',
      statements: [
        `DROP INDEX CONCURRENTLY IF EXISTS ${SCHEMA}.one_added_idx`,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS one_added_idx ON ${SCHEMA}.one (added)`,
      ],
      down: [`DROP INDEX CONCURRENTLY IF EXISTS ${SCHEMA}.one_added_idx`],
    };
    const store = fakeStore({ recorded: [1], recordOnLock: 2 });

    const outcome = await runMigrations(store.client, options([twoVersions()[0], migration]));

    expect(outcome.ok).toBe(true);
    expect(store.migrationSql).toEqual([
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
    ]);
    expect(store.inserts).toEqual([]);
    expect(store.recordedVersions).toEqual(new Set([1, 2]));
  });
});

describe('the upgrade path after v22', () => {
  const recordedThrough22 = Array.from({ length: 22 }, (_, index) => index + 1);
  const pendingAfter22 = MIGRATIONS.filter((migration) => migration.version > 22).map((migration) => migration.version);

  it('records telemetry rollups before query-path indexes', async () => {
    const store = fakeStore({ recorded: recordedThrough22 });

    const outcome = await runMigrations(store.client, options(MIGRATIONS));

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts.map((attempt) => attempt.version)).toEqual(pendingAfter22);
    expect(store.inserts.map((row) => row[0])).toEqual(pendingAfter22);
    expect(store.migrationSql.findIndex((sql) => sql.includes('request_latency_daily_rollups'))).toBeLessThan(
      store.migrationSql.findIndex((sql) => sql.includes('conversations_owner_updated_idx'))
    );
  });

  it('never attempts or records later migrations when v23 is incomplete', async () => {
    const store = fakeStore({
      recorded: recordedThrough22,
      refuse: (sql) => (sql.includes('request_latency_daily_rollups') ? 'rollup table refused' : null),
    });

    const outcome = await runMigrations(store.client, options(MIGRATIONS));

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts.map((attempt) => attempt.version)).toEqual([23]);
    expect(outcome.pending).toEqual(pendingAfter22);
    expect(store.inserts.map((row) => row[0])).toEqual([]);
    expect(store.migrationSql.join('\n')).not.toContain('conversations_owner_updated_idx');
  });
});

describe('the recorded app activity migration', () => {
  it('adds a new idempotent table without altering customer history tables', () => {
    const migration = MIGRATIONS.find((entry) => entry.name === 'recorded app activity minutes');
    expect(migration?.version).toBe(18);
    const ddl = migration?.statements.join('\n') ?? '';
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS');
    expect(ddl).toContain('app_activity_minutes');
    expect(ddl).toContain('PRIMARY KEY (user_email, active_minute)');
    expect(ddl).not.toMatch(/ALTER TABLE/i);
  });
});

describe('the app idle-session migration', () => {
  it('stores only a session hash with per-browser, subject, deployment, and expiry fields', () => {
    const migration = MIGRATIONS.find((entry) => entry.name === 'app idle sessions');
    expect(migration?.version).toBe(22);
    const ddl = migration?.statements.join('\n') ?? '';
    expect(ddl).toContain('session_hash TEXT PRIMARY KEY');
    expect(ddl).toContain('subject TEXT NOT NULL');
    expect(ddl).toContain('deployment_key TEXT NOT NULL');
    expect(ddl).toContain('last_active_at TIMESTAMPTZ NOT NULL');
    expect(ddl).toContain('idle_expires_at TIMESTAMPTZ NOT NULL');
    expect(ddl).toContain('absolute_expires_at TIMESTAMPTZ NOT NULL');
    expect(ddl).toContain('retention_expires_at');
    expect(ddl).not.toMatch(/\btoken\b|raw_cookie|authorization/i);
  });
});

describe('the recorded run persona migration', () => {
  it('adds nullable historical snapshot columns without backfilling assignments', () => {
    const migration = MIGRATIONS.find((entry) => entry.name === 'recorded run persona');
    expect(migration?.version).toBe(26);
    const ddl = migration?.statements.join('\n') ?? '';
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS persona_id TEXT');
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS persona_name TEXT');
    expect(ddl).not.toContain('sp_assignments');
    expect(ddl).not.toMatch(/UPDATE|DEFAULT/i);
  });
});

describe('a fresh database', () => {
  it('applies every version in order and records each one', async () => {
    const store = fakeStore();

    const outcome = await runMigrations(store.client, options(twoVersions()));

    expect(outcome.ok).toBe(true);
    expect(outcome.versionBefore).toBe(0);
    expect(outcome.versionAfter).toBe(2);
    expect(outcome.attempts.map((attempt) => attempt.outcome)).toEqual(['applied', 'applied']);
    expect(store.migrationSql).toEqual([
      `CREATE TABLE IF NOT EXISTS ${SCHEMA}.one (id TEXT PRIMARY KEY)`,
      `ALTER TABLE ${SCHEMA}.one ADD COLUMN IF NOT EXISTS added TEXT`,
    ]);
    expect(errors).toEqual([]);
  });

  /**
   * Nothing recorded about a version may identify a person or a question. The
   * whole row is asserted rather than spot-checked, so a column added later has
   * to come past this case to get in.
   */
  it('records a number, a name, two counts and a label, and nothing else', async () => {
    const store = fakeStore();

    await runMigrations(store.client, options(twoVersions()));

    expect(store.inserts).toEqual([
      [1, 'first', 1, 0, 'a test'],
      [2, 'second', 1, 0, 'a test'],
    ]);
  });
});

describe('a database already at the newest version', () => {
  /**
   * "Nothing to do" and "did nothing" are different results. This one has to name
   * the version it is already at, because the sentence an operator reads after a
   * deploy is the only evidence they have that the step ran at all.
   */
  it('issues no statements and says which version it is at', async () => {
    const store = fakeStore({ recorded: [1, 2] });

    const outcome = await runMigrations(store.client, options(twoVersions()));

    expect(outcome.ok).toBe(true);
    expect(outcome.versionAfter).toBe(2);
    expect(store.migrationSql).toEqual([]);
    expect(logs.join('\n')).toContain('at version 2');
    expect(logs.join('\n')).toContain('nothing to apply');
    expect(errors).toEqual([]);
  });
});

describe('a version whose statement fails', () => {
  /**
   * The case ordering exists for. Version 3 may read a column version 2 was
   * supposed to add, so applying it after 2 failed leaves a database at no
   * coherent version — and, worse, one that re-running cannot repair, because 3
   * would be recorded as applied.
   */
  it('is not recorded, and the version after it is never attempted', async () => {
    const three: Migration[] = [
      ...twoVersions(),
      {
        version: 3,
        name: 'third',
        statements: [`CREATE INDEX IF NOT EXISTS three ON ${SCHEMA}.one (added)`],
        down: [],
      },
    ];
    const store = fakeStore({ refuse: (sql) => (/^ALTER TABLE/i.test(sql) ? 'must be owner of table one' : null) });

    const outcome = await runMigrations(store.client, options(three));

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts.map((attempt) => [attempt.version, attempt.outcome])).toEqual([
      [1, 'applied'],
      [2, 'failed'],
    ]);
    expect(outcome.pending).toEqual([2, 3]);
    expect(outcome.versionAfter).toBe(1);
    // The statement of version 3 was never issued, and version 2 has no row.
    expect(store.migrationSql.some((sql) => sql.includes('CREATE INDEX IF NOT EXISTS three'))).toBe(false);
    expect(store.inserts.map((row) => row[0])).toEqual([1]);
    expect(errors.join('\n')).toContain('STOPPED AT VERSION 2');
  });

  /** A refusal whose object is verifiably already there changed nothing. */
  it('is recorded as applied when the schema shows its end state is already in place', async () => {
    const store = fakeStore({
      refuse: (sql) => (/^ALTER TABLE/i.test(sql) ? 'must be owner of table one' : null),
      present: { columns: ['added'] },
    });

    const outcome = await runMigrations(store.client, options(twoVersions()));

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts.map((attempt) => attempt.outcome)).toEqual(['applied', 'applied']);
    expect(store.inserts).toEqual([
      [1, 'first', 1, 0, 'a test'],
      // The refusal is counted, so the row says the version landed with one
      // statement the database refused and nothing lost by it.
      [2, 'second', 1, 1, 'a test'],
    ]);
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toContain('already present');
  });

  /**
   * The carve-out above has to stay narrow in the direction that matters: a
   * schema that cannot be read establishes nothing, and treating "could not
   * check" as "already there" would record a version that never applied.
   */
  it('stays a failure when the schema cannot be read to decide', async () => {
    const store = fakeStore({
      refuse: (sql) =>
        /^ALTER TABLE/i.test(sql)
          ? 'must be owner of table one'
          : /information_schema/i.test(sql)
            ? 'permission denied for schema information_schema'
            : null,
    });

    const outcome = await runMigrations(store.client, options(twoVersions()));

    expect(outcome.ok).toBe(false);
    expect(store.inserts.map((row) => row[0])).toEqual([1]);
  });
});

describe('a version that applies but cannot be recorded', () => {
  /**
   * Its own outcome, and neither of the other two. The schema is CORRECT, so
   * calling it a failure would send somebody to look at statements that worked;
   * the record is missing, so calling it applied would let a release gate promote
   * a build against a database whose version means nothing.
   */
  it('is reported as applied-but-not-recorded, and the run still fails', async () => {
    const store = fakeStore({ versionTable: 'missing' });

    const outcome = await runMigrations(store.client, options(twoVersions()));

    expect(outcome.attempts[0].outcome).toBe('unrecorded');
    expect(outcome.ok).toBe(false);
    expect(outcome.pending).toContain(1);
    // The statements were still issued: this is a bookkeeping failure, not a
    // schema one.
    expect(store.migrationSql[0]).toContain(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.one`);
    expect(errors.join('\n')).toContain('APPLIED BUT NOT RECORDED');
  });

  it('never claims success when the version table cannot be read at all', async () => {
    const store = fakeStore({ versionTable: 'missing' });

    const outcome = await runMigrations(store.client, options(twoVersions()));

    expect(outcome.ok).toBe(false);
    expect(outcome.versionBefore).toBeNull();
    expect(warnings.join('\n')).toContain('VERSION UNKNOWN');
  });
});

describe('verifying rather than applying', () => {
  /** The release check. It must not issue DDL, and it must fail on a gap. */
  it('reports what is pending and issues nothing', async () => {
    const store = fakeStore({ recorded: [1] });

    const outcome = await runMigrations(store.client, options(twoVersions(), 'verify'));

    expect(outcome.ok).toBe(false);
    expect(outcome.pending).toEqual([2]);
    expect(store.migrationSql).toEqual([]);
    expect(store.inserts).toEqual([]);
    expect(errors.join('\n')).toContain('SCHEMA BEHIND');
  });

  it('passes, silently, on a database that is up to date', async () => {
    const store = fakeStore({ recorded: [1, 2] });

    const outcome = await runMigrations(store.client, options(twoVersions(), 'verify'));

    expect(outcome.ok).toBe(true);
    expect(store.migrationSql).toEqual([]);
    expect(errors).toEqual([]);
  });

  /** Verification on a database with no version table is a gap, not a crash. */
  it('fails rather than throwing when there is no version table', async () => {
    const store = fakeStore({ versionTable: 'missing' });

    const outcome = await runMigrations(store.client, options(twoVersions(), 'verify'));

    expect(outcome.ok).toBe(false);
    expect(store.migrationSql).toEqual([]);
  });
});

describe('the statement timeout', () => {
  /**
   * The hazard that has already cost a deploy. The timeout is a session setting a
   * read leaves on a pooled connection; `CREATE INDEX` waits on an ACCESS
   * EXCLUSIVE lock and that wait counts against the same timer, so a migration
   * issued on a borrowed connection can be cancelled on a read's budget and the
   * deployment carries on without the index.
   *
   * Both halves are asserted. Lifting it without restoring it would leave every
   * later read on that connection unbounded, which is the fault the timeout was
   * added to fix, reintroduced by its own repair.
   */
  it('is lifted for the DDL and put back before the connection is returned', async () => {
    const store = fakeStore();

    await runMigrations(store.client, options(twoVersions()));

    expect(store.sessionSql.length).toBeGreaterThanOrEqual(2);
    const restored = store.sessionSql[store.sessionSql.length - 1];
    expect(store.sessionSql[0]).toBe('SET statement_timeout = 0');
    expect(restored).toMatch(/^SET statement_timeout = \d+$/);
    expect(restored).not.toBe('SET statement_timeout = 0');
  });
});

describe('a database ahead of this build', () => {
  /**
   * An older container against a newer schema. Reported, and nothing is removed:
   * a row this build cannot explain is not a row it may delete, and deleting it
   * would make the newer build re-run a migration it had already applied.
   */
  it('is reported and left alone', async () => {
    const store = fakeStore({ recorded: [1, 2, 99] });

    const outcome = await runMigrations(store.client, options(twoVersions()));

    expect(outcome.ahead).toEqual([99]);
    expect(outcome.ok).toBe(true);
    expect(store.deletes).toEqual([]);
    expect(warnings.join('\n')).toContain('does not know about');
  });
});

describe('a schema owned by somebody else', () => {
  /**
   * A local server pointed at the deployed app's branch. The statements that
   * would be refused are not the problem; the ones that would SUCCEED are, since
   * a table this version newly adds would be created owned by whoever booted and
   * ownership cannot be handed back.
   */
  it('has nothing applied to it', async () => {
    const store = fakeStore({
      ownership: {
        schema_exists: true,
        owner: 'someone-else',
        connected_role: 'a-test',
        connected_role_holds_owner: false,
      },
    });

    const outcome = await runMigrations(store.client, options(twoVersions()));

    expect(outcome.ok).toBe(false);
    expect(store.migrationSql).toEqual([]);
    expect(store.inserts).toEqual([]);
    expect(errors.join('\n')).toContain('MIGRATIONS SKIPPED');
  });

  /**
   * But it can still be ASKED what version it is at, and this is the case the
   * release gate lives in: a release runs as a person, the schema is owned by the
   * app's service principal, and every verification would otherwise come back
   * "skipped" against a database that could have answered. A check that reports
   * nothing useful in its normal case is a check nobody reads.
   */
  it('is still verifiable, because verifying writes nothing', async () => {
    const store = fakeStore({
      recorded: [1, 2],
      ownership: {
        schema_exists: true,
        owner: 'someone-else',
        connected_role: 'a-test',
        connected_role_holds_owner: false,
      },
    });

    const outcome = await runMigrations(store.client, options(twoVersions(), 'verify'));

    expect(outcome.ok).toBe(true);
    expect(outcome.versionAfter).toBe(2);
    expect(errors).toEqual([]);
  });
});

describe('rolling back', () => {
  it('runs the undo statements and removes the record', async () => {
    const store = fakeStore({ recorded: [1, 2] });

    const outcome = await rollbackTo(store.client, 1, options(twoVersions()));

    expect(outcome.ok).toBe(true);
    expect(outcome.reverted).toEqual([2]);
    expect(outcome.versionAfter).toBe(1);
    expect(store.migrationSql).toEqual([`ALTER TABLE ${SCHEMA}.one DROP COLUMN IF EXISTS added`]);
    expect(store.deletes).toEqual([[2]]);
  });

  /**
   * The most dangerous thing a rollback can do is report having undone something
   * it did not. The row stays, so the database is never BEHIND the version it
   * claims to be at — if it were, the next deployment would skip the migration
   * that would have repaired it.
   */
  it('stops at a version that declares no way to undo itself, with its record intact', async () => {
    const store = fakeStore({ recorded: [1, 2] });

    const outcome = await rollbackTo(store.client, 0, options(twoVersions()));

    expect(outcome.ok).toBe(false);
    expect(outcome.reverted).toEqual([2]);
    expect(outcome.blocked).toContain('no way to undo itself');
    // Version 2 came off; version 1 did not, and still says so.
    expect(store.deletes).toEqual([[2]]);
    expect([...store.recordedVersions]).toEqual([1]);
  });

  it('leaves the record in place when an undo statement fails', async () => {
    const store = fakeStore({
      recorded: [1, 2],
      refuse: (sql) => (/DROP COLUMN/i.test(sql) ? 'must be owner of table one' : null),
    });

    const outcome = await rollbackTo(store.client, 1, options(twoVersions()));

    expect(outcome.ok).toBe(false);
    expect(outcome.reverted).toEqual([]);
    expect(store.deletes).toEqual([]);
    expect(outcome.blocked).toContain('could not be undone');
  });

  /** An older build cannot undo a version it does not contain. */
  it('refuses a version this build does not know about', async () => {
    const store = fakeStore({ recorded: [1, 2, 99] });

    const outcome = await rollbackTo(store.client, 1, options(twoVersions()));

    expect(outcome.ok).toBe(false);
    expect(outcome.blocked).toContain('this build does not contain it');
    expect(store.deletes).toEqual([]);
  });

  it('does nothing, successfully, when it is already at the target', async () => {
    const store = fakeStore({ recorded: [1] });

    const outcome = await rollbackTo(store.client, 1, options(twoVersions()));

    expect(outcome.ok).toBe(true);
    expect(outcome.reverted).toEqual([]);
    expect(store.migrationSql).toEqual([]);
  });

  it('will not attempt anything when it cannot read what is applied', async () => {
    const store = fakeStore({ versionTable: 'missing' });

    const outcome = await rollbackTo(store.client, 0, options(twoVersions()));

    expect(outcome.ok).toBe(false);
    expect(store.migrationSql).toEqual([]);
    expect(errors.join('\n')).toContain('ROLLBACK NOT ATTEMPTED');
  });
});

describe('the versions this build ships', () => {
  /**
   * The baseline is the schema every existing deployment already has, and its
   * objects hold conversations, runs and feedback that predate the runner. Its
   * undo would be a data-loss statement dressed as a rollback, so it declares
   * none — going back past version 1 is a database restore.
   */
  it('cannot roll the baseline back', () => {
    const baseline = MIGRATIONS.find((migration) => migration.version === BASELINE_VERSION);
    expect(baseline?.down).toBeNull();
  });

  it('starts at the baseline and carries the whole boot DDL as version 1', () => {
    expect(MIGRATIONS[0].version).toBe(BASELINE_VERSION);
    expect(MIGRATIONS[0].statements.length).toBeGreaterThan(10);
    expect(MIGRATIONS[0].statements[0]).toMatch(/^CREATE SCHEMA IF NOT EXISTS/);
  });

  /**
   * Every statement of every version has to be a no-op the second time, because
   * there are no transactions available here: AppKit hands this app a bare
   * `query`, so a version is separately-committed statements plus a separate row,
   * and the re-run after a partial application must be harmless.
   */
  it('is idempotent statement by statement, because a replay has to be harmless', () => {
    for (const migration of MIGRATIONS) {
      for (const statement of migration.statements) {
        expect(statement.replace(/\s+/g, ' ').trim()).toMatch(/IF NOT EXISTS|ON CONFLICT|IF EXISTS|CREATE OR REPLACE/i);
      }
    }
  });

  it('composes the baseline from whatever statement list it is given', () => {
    const built = buildMigrations(['CREATE SCHEMA IF NOT EXISTS somewhere']);
    expect(built[0].statements).toEqual(['CREATE SCHEMA IF NOT EXISTS somewhere']);
    expect(migrationRegistryFault(built)).toBeNull();
  });
});

describe('reading the applied versions', () => {
  it('answers null rather than an empty list when the table cannot be read', async () => {
    const store = fakeStore({ versionTable: 'missing' });
    await expect(readAppliedVersions(store.client, SCHEMA)).resolves.toBeNull();
  });

  /**
   * Null and empty mean different things and are never collapsed: "nothing has
   * been recorded here" sends an operator to the migration step, and "the table
   * could not be read" sends them to the grant.
   */
  it('answers an empty list for a table that holds nothing', async () => {
    const store = fakeStore({ recorded: [] });
    await expect(readAppliedVersions(store.client, SCHEMA)).resolves.toEqual([]);
  });
});
