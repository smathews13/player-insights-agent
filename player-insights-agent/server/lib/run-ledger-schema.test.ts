import { describe, expect, it, vi } from 'vitest';
import { applySchema, schemaStatements, type InsightsAppKit } from '../routes/insights-routes';
import { isSchemaVersionBookkeeping } from './migration-runner';
import { RUN_LEDGER_DDL } from './run-ledger-schema';
import { EXECUTING_STATES, RUN_STATES } from './run-state';

/**
 * These cases are about one thing: that adding the run ledger to a database
 * which is currently serving a customer cannot break it.
 *
 * The failure they guard against has happened here, more than once, and it is
 * not subtle in hindsight. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is
 * refused when the app's Postgres role does not own the table, because
 * ownership is checked BEFORE the statement is found to be a no-op. The whole
 * `player_insights` schema had to be exported, dropped and recreated to get out
 * of it. So the ledger's migrations are constrained in a way that is easy to
 * state and easy to violate accidentally, and the constraints are asserted here
 * rather than left in a comment.
 */

const ALL = RUN_LEDGER_DDL.map((statement) => statement.trim());

describe('what the ledger migrations are allowed to be', () => {
  it('never alters, drops or renames anything', () => {
    // The whole rule, in one case. An ALTER against `messages` or
    // `conversations` is the statement that took eight others down with it, and
    // a DROP against a table holding the customer's history needs no
    // explanation.
    for (const statement of ALL) {
      expect(statement).not.toMatch(/^ALTER\b/i);
      expect(statement).not.toMatch(/\bDROP\b/i);
      expect(statement).not.toMatch(/\bRENAME\b/i);
      expect(statement).not.toMatch(/\bTRUNCATE\b/i);
    }
  });

  it('creates only objects nothing else in the schema already owns', () => {
    // Names taken from the existing statements would be `CREATE TABLE IF NOT
    // EXISTS` against somebody else's table: a no-op that says nothing, and a
    // ledger silently writing into a table shaped for something else.
    const existing = schemaStatements.filter((statement) => !RUN_LEDGER_DDL.includes(statement)).join('\n');
    for (const table of ['runs', 'run_attempts', 'run_events']) {
      expect(existing).not.toContain(`player_insights.${table}`);
    }
  });

  it('is idempotent statement by statement, so a second boot changes nothing', () => {
    for (const statement of ALL) {
      expect(statement).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS\b/i);
    }
  });

  it('declares every constraint inside the CREATE that needs it', () => {
    // The property that removes the ALTER. A uniqueness rule added afterwards
    // would be an `ALTER TABLE ... ADD CONSTRAINT`, which is refused on
    // ownership exactly as the ADD COLUMN was, and unlike `CREATE INDEX` there
    // is no `IF NOT EXISTS` form of it to make the refusal harmless.
    const runs = ALL.find((statement) => /CREATE TABLE IF NOT EXISTS player_insights\.runs\b/i.test(statement)) ?? '';
    expect(runs).toContain('CONSTRAINT runs_idempotency_key_unique UNIQUE (user_email, idempotency_key_hash)');
    const attempts = ALL.find((statement) => /player_insights\.run_attempts\b/i.test(statement)) ?? '';
    expect(attempts).toContain('CONSTRAINT run_attempts_fence_unique UNIQUE (run_id, fencing_token)');
  });

  it('indexes only tables it created itself', () => {
    // `CREATE INDEX` checks ownership of the table it indexes, before it
    // considers IF NOT EXISTS, exactly as ALTER does. On a table this list
    // creates, the app is the owner and the check passes. On `messages` it
    // would be the same refusal all over again.
    const created = new Set(
      ALL.flatMap((statement) => [...statement.matchAll(/CREATE TABLE IF NOT EXISTS\s+player_insights\.(\w+)/gi)]).map(
        (match) => match[1]
      )
    );
    const indexed = ALL.flatMap((statement) => [...statement.matchAll(/\bON\s+player_insights\.(\w+)/gi)]).map(
      (match) => match[1]
    );
    expect(indexed.length).toBeGreaterThan(0);
    for (const table of indexed) {
      expect([...created]).toContain(table);
    }
  });

  it('reaches the boot path, which is the only place migrations run', () => {
    for (const statement of RUN_LEDGER_DDL) {
      expect(schemaStatements).toContain(statement);
    }
  });
});

describe('the uniqueness rule that stops a hundred requests becoming a hundred runs', () => {
  const live = ALL.find((statement) => statement.includes('runs_live_request_unique')) ?? '';

  it('is scoped to one reader and one question', () => {
    expect(live).toContain('(user_email, request_hash)');
  });

  it('applies only while a run is being worked on', () => {
    // Partial on purpose. Unrestricted, the same question could never be asked
    // twice: the first run would own that (user, hash) pair for the life of the
    // database and every later ask would be refused rather than answered.
    expect(live).toMatch(/WHERE state IN \(/i);
    for (const state of EXECUTING_STATES) {
      expect(live).toContain(`'${state}'`);
    }
  });

  it('does not hold a run that is waiting for a person', () => {
    // A plan can sit unapproved for as long as the reader takes. Blocking a
    // re-ask for that whole time would be a worse bug than the duplicate it
    // prevents, so AWAITING_APPROVAL is not an executing state.
    expect(live).not.toContain("'AWAITING_APPROVAL'");
  });

  it('does not hold a run that has finished', () => {
    for (const state of RUN_STATES.filter(
      (candidate) => !(EXECUTING_STATES as readonly string[]).includes(candidate)
    )) {
      expect(live).not.toContain(`'${state}'`);
    }
  });
});

/**
 * A store that refuses the ledger statements the way a foreign-owned schema
 * would, and answers the verifying reads with whatever the case says is really
 * there.
 */
function refusingStore(options: { tables?: string[]; indexes?: string[] }) {
  const attempted: string[] = [];
  return {
    attempted,
    lakebase: {
      query(text: string, params?: unknown[]) {
        const trimmed = text.trim();
        // The name the verifying read is asking after, which is the second
        // bound parameter and is always a string. Read as one rather than
        // stringified: `String()` over an `unknown` turns a parameter that is
        // not a name into `[object Object]`, and this store would then answer
        // "no such table" for it, which is a pass for the wrong reason.
        const askedAfter = (params ?? [])[1];
        const wantedName = typeof askedAfter === 'string' ? askedAfter : '';
        if (/information_schema\.tables/i.test(trimmed)) {
          return Promise.resolve({
            rows: (options.tables ?? []).filter((name) => name === wantedName).map((table_name) => ({ table_name })),
          });
        }
        if (/pg_catalog\.pg_index/i.test(trimmed)) {
          return Promise.resolve({
            rows: (options.indexes ?? []).filter((name) => name === wantedName).map((indexname) => ({ indexname })),
          });
        }
        if (/information_schema\.columns/i.test(trimmed)) return Promise.resolve({ rows: [] });
        // The ownership probe, answered like the verifying reads above and for
        // the same reason: it is not one of the statements this case is about.
        // `applySchema` asks who owns the schema before it writes to it, so a
        // local server pointed at the deployed app's branch cannot create a
        // table the app will never be able to maintain. Answered as a schema
        // that does not exist yet, which is when the DDL is meant to run.
        if (/to_regnamespace/i.test(trimmed)) {
          return Promise.resolve({
            rows: [{ schema_exists: false, owner: '', connected_role: 'a-test', connected_role_holds_owner: false }],
          });
        }
        // The version runner's own bookkeeping, answered and not recorded, for
        // the same reason: reading `schema_version` and writing a row to it are
        // not statements of any migration, and counting them here would make
        // every case below off by one for a reason that has nothing to do with
        // what it asserts. Answered as an empty table, which is a database whose
        // versions have never been recorded.
        if (isSchemaVersionBookkeeping(trimmed, 'player_insights')) {
          return Promise.resolve({ rows: [] as Record<string, unknown>[] });
        }
        attempted.push(trimmed);
        if (RUN_LEDGER_DDL.some((statement) => statement.trim() === trimmed)) {
          return Promise.reject(new Error('must be owner of table runs'));
        }
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    },
  };
}

describe('booting against a database that refuses the ledger statements', () => {
  it('still runs every other statement', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { attempted, lakebase } = refusingStore({});

    await applySchema({ lakebase } as InsightsAppKit);

    expect(attempted).toEqual(schemaStatements.map((statement) => statement.trim()));
    vi.restoreAllMocks();
  });

  it('is quiet when the objects are already there, because then nothing changed', async () => {
    // The case that matters on a redeploy. Postgres refuses on ownership before
    // it decides the statement is a no-op, so a healthy database reports a
    // refusal for every ledger statement on every boot. Erroring on those is
    // what made the boot log unreadable last time and taught people to skip it.
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { lakebase } = refusingStore({
      tables: ['runs', 'run_attempts', 'run_events'],
      indexes: ['runs_live_request_unique', 'runs_conversation_idx', 'runs_state_idx', 'run_attempts_run_idx'],
    });

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    expect(failures).toHaveLength(RUN_LEDGER_DDL.length);
    expect(failures.every((failure) => failure.satisfied)).toBe(true);
    expect(errors).toEqual([]);
    vi.restoreAllMocks();
  });

  it('stays loud when an index the ledger needs is genuinely absent', async () => {
    // The narrow direction. Quietening a refusal because it looked familiar,
    // when the object really is missing, is the same mistake pointing the other
    // way: the uniqueness rule that prevents duplicate execution would simply
    // not exist, and nothing would say so.
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { lakebase } = refusingStore({
      tables: ['runs', 'run_attempts', 'run_events'],
      indexes: ['runs_conversation_idx', 'runs_state_idx', 'run_attempts_run_idx'],
    });

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    expect(failures.filter((failure) => !failure.satisfied).map((failure) => failure.label)).toEqual([
      'CREATE INDEX runs_live_request_unique',
    ]);
    expect(errors.some((line) => line.includes('SCHEMA SETUP INCOMPLETE'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('names each refused index by its own name rather than by its table', async () => {
    // Four statements touch `player_insights.runs`. Labelled by the table they
    // would all read the same in the summary, which lists labels, so a reader
    // would be told something failed with no way to tell which.
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { lakebase } = refusingStore({});

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    expect(failures.map((failure) => failure.label)).toEqual([
      'CREATE player_insights.runs',
      'CREATE player_insights.run_attempts',
      'CREATE player_insights.run_events',
      'CREATE INDEX runs_live_request_unique',
      'CREATE INDEX runs_conversation_idx',
      'CREATE INDEX runs_state_idx',
      'CREATE INDEX run_attempts_run_idx',
    ]);
    vi.restoreAllMocks();
  });
});
