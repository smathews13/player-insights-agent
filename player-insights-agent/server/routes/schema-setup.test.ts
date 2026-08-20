import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, MIGRATIONS, schemaStatements, setupInsightsRoutes, type InsightsAppKit } from './insights-routes';
import { resetLakebaseHealth, stopLakebaseWatchdog } from '../lib/lakebase-store';
import { isSchemaVersionBookkeeping } from '../lib/migration-runner';
import { schemaOwnershipQuery } from '../lib/schema-ownership-guard';

/**
 * What boot does when one schema statement is refused.
 *
 * The incident these cover happened at every boot of the deployed app and was
 * visible only as one line in the log. `ALTER TABLE player_insights.messages
 * ADD COLUMN IF NOT EXISTS ...` is refused because the tables are owned by the
 * developer who created them rather than by the app's Postgres role, and
 * Postgres checks ownership before it evaluates `IF NOT EXISTS`, so a
 * statement that would change nothing fails deterministically. The loop then
 * broke, and the seven statements after it never ran. Nothing was broken only
 * because every object they create already existed on that database; the next
 * statement added below the ALTER would simply never have been applied, and
 * the log said the app was "starting without a usable store" while it read and
 * wrote all evening.
 *
 * So there are two properties here, and they pull in opposite directions:
 * a failure must not stop the rest, and a failure must still be loud and
 * attributable. A test for either one alone is satisfiable by the bug in the
 * other direction.
 */

/** The position of the statement these cases refuse, so they read in one place. */
const ALTER_MESSAGES = schemaStatements.findIndex((statement) => /^ALTER TABLE/i.test(statement.trim()));

/**
 * A store that refuses whichever statements the case names, and records the
 * order it was asked in.
 */
function store(refuse: (statement: string) => string | null) {
  const attempted: string[] = [];
  return {
    attempted,
    lakebase: {
      query(text: string) {
        // The ownership probe is answered but not recorded. `applySchema` now
        // asks who owns the schema before it writes to it, so that a local server
        // pointed at the deployed app's branch cannot create a table the app will
        // never be able to maintain. It is not a schema statement, and the cases
        // below are about the schema statements, so counting it here would make
        // every one of them off by one for a reason that has nothing to do with
        // what they assert. Answered as a schema that does not exist yet, which
        // is the state in which the DDL is meant to run.
        if (text === schemaOwnershipQuery()) {
          return Promise.resolve({
            rows: [{ schema_exists: false, owner: '', connected_role: 'a-test', connected_role_holds_owner: false }],
          });
        }
        // The version runner's own bookkeeping, answered and not recorded, for
        // the same reason: reading `schema_version` and writing a row to it
        // belong to no migration, and counting them here would make every case
        // below off by one for a reason that has nothing to do with what it
        // asserts. Answered as an empty table — a database whose versions have
        // never been recorded, which is when the baseline is meant to run — and
        // answered even by the cases that refuse everything else, so that what
        // they assert stays about the DDL rather than about the version table.
        if (isSchemaVersionBookkeeping(text, 'player_insights')) {
          return Promise.resolve({ rows: [] as Record<string, unknown>[] });
        }
        attempted.push(text);
        const refusal = refuse(text);
        if (refusal) return Promise.reject(new Error(refusal));
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    },
  };
}

let errors: string[];
let warnings: string[];

beforeEach(() => {
  resetLakebaseHealth();
  errors = [];
  warnings = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  stopLakebaseWatchdog();
  vi.restoreAllMocks();
});

/**
 * The two indexes Monitoring's reads need on `messages`.
 *
 * Pinned here because they are easy to lose and expensive to be without: the
 * table carried nothing but its primary key before them, so every read of it
 * that was not by id was a sequential scan, and Monitoring's per-answer question
 * lookup was a scan of the whole store per answer.
 *
 * They are created by the APP at boot, deliberately, and not by hand. An index
 * created by a person against the deployed branch belongs to that person, and
 * the app's own DDL is then refused on it forever. That is the failure that cost
 * a release, and the schema list is the path that cannot make it.
 */
describe('the message indexes', () => {
  const messageIndexes = schemaStatements.filter((statement) =>
    /CREATE INDEX[\s\S]*ON player_insights\.messages\b/i.test(statement.trim())
  );

  it('indexes the range bound and the per-answer question lookup', () => {
    const all = messageIndexes.join('\n');

    // The pairing lookup, which is the one that was quadratic. `created_at` is
    // the second column because the subquery ends ORDER BY created_at DESC
    // LIMIT 1, so this makes finding the question one walk rather than a sort.
    expect(all).toMatch(/messages_conversation_created_idx[\s\S]*\(conversation_id, created_at DESC\)/);
    // The window every Monitoring and per-user-panel read applies.
    expect(all).toMatch(/messages_created_at_idx[\s\S]*\(created_at DESC\)/);
    expect(messageIndexes).toHaveLength(2);
  });

  /** A second boot must do nothing, so both carry IF NOT EXISTS. */
  it('is idempotent, so a second boot changes nothing', () => {
    for (const statement of messageIndexes) {
      expect(statement.trim()).toMatch(/^CREATE INDEX IF NOT EXISTS\b/i);
    }
  });

  /**
   * The boot path's own refusal handling has to recognise these.
   *
   * `CREATE INDEX` checks ownership of the table it indexes before it considers
   * IF NOT EXISTS, so on a database where `messages` is owned by somebody other
   * than the app's role these are refused. That is survivable, but only because
   * `statementAlreadySatisfied` can read the schema and confirm the index is
   * there anyway, and its pattern requires the exact `IF NOT EXISTS <name> ON
   * <schema>.<table>` shape. Written differently, a refusal that changed nothing
   * would be reported at the same volume as a schema left incomplete.
   */
  it('is written in the shape the boot path can prove harmless', () => {
    for (const statement of messageIndexes) {
      expect(statement.replace(/\s+/g, ' ').trim()).toMatch(
        /^CREATE INDEX IF NOT EXISTS \w+ ON player_insights\.messages \(/i
      );
    }
  });

  /** Never by hand, and never anywhere but the boot list. */
  it('exists only in the schema the app applies at startup', () => {
    expect(messageIndexes.length).toBeGreaterThan(0);
    for (const statement of messageIndexes) {
      expect(schemaStatements).toContain(statement);
      expect(statement).not.toMatch(/\bCONCURRENTLY\b/i);
    }
  });
});

describe('a schema statement the database refuses', () => {
  it('has an ALTER partway down the list, which is the case worth testing', () => {
    // Guards the fixtures below rather than the app: if the ALTER is ever
    // folded into a CREATE or moved to the end, these cases would still pass
    // while testing nothing, because a failure in the last position costs
    // nothing whether the loop breaks or not.
    expect(ALTER_MESSAGES).toBeGreaterThan(0);
    expect(ALTER_MESSAGES).toBeLessThan(schemaStatements.length - 1);
  });

  it('does not stop the statements after it', async () => {
    const { attempted, lakebase } = store((text) =>
      /^ALTER TABLE/i.test(text.trim()) ? 'must be owner of table messages' : null
    );

    await applySchema({ lakebase } as InsightsAppKit);

    // A prefix rather than the whole list: a refusal is now followed by a read
    // that checks whether it mattered, so `attempted` legitimately holds more
    // than the DDL. What must hold is that every statement was still issued.
    expect(attempted.slice(0, schemaStatements.length)).toEqual([...schemaStatements]);
  });

  it('reports the failure against the statement that caused it, not as a whole-setup verdict', async () => {
    const { lakebase } = store((text) =>
      /^ALTER TABLE/i.test(text.trim()) ? 'must be owner of table messages' : null
    );

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    expect(failures).toEqual([
      {
        position: ALTER_MESSAGES + 1,
        label: 'ALTER player_insights.messages',
        message: 'must be owner of table messages',
        // Carried alongside the message so the summary can tell a privilege
        // denial from an unreachable store without re-reading the prose. Empty
        // here because this fixture rejects with a plain Error; Postgres
        // supplies a SQLSTATE, and `schema-grants.test.ts` covers what is done
        // with it.
        code: '',
        // The verifying read answers no rows on this fixture, so the columns
        // cannot be shown to be present and the failure stays loud.
        satisfied: false,
      },
    ]);
    const perStatement = errors.find((line) => line.includes('SCHEMA STATEMENT'));
    expect(perStatement).toContain(`${ALTER_MESSAGES + 1} of ${schemaStatements.length}`);
    expect(perStatement).toContain('ALTER player_insights.messages');
    expect(perStatement).toContain('must be owner of table messages');
  });

  it('names every failed statement in the summary, so a second one cannot hide behind the first', async () => {
    const { lakebase } = store((text) =>
      /^ALTER TABLE/i.test(text.trim()) || /feedback/i.test(text) ? 'must be owner' : null
    );

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    expect(failures.map((failure) => failure.label)).toEqual([
      'ALTER player_insights.messages',
      'CREATE player_insights.feedback',
    ]);
    const summary = errors.find((line) => line.includes('SCHEMA SETUP INCOMPLETE'));
    // The total is read from the list rather than written out. It was a
    // literal, and every workstream that adds a statement then has to notice
    // that a case about two failures hiding each other is failing on the count
    // of statements that did not.
    expect(summary).toContain(`2 of ${schemaStatements.length} statements failed`);
    expect(summary).toContain('ALTER player_insights.messages');
    expect(summary).toContain('CREATE player_insights.feedback');
  });

  /**
   * The half of this that is about honesty rather than control flow. The store
   * demonstrably worked (ten of eleven statements were accepted on it), and a
   * log line saying otherwise sends the next person to debug an outage that is
   * not happening.
   */
  it('does not claim the store is unusable when the store just answered ten statements', async () => {
    const { lakebase } = store((text) =>
      /^ALTER TABLE/i.test(text.trim()) ? 'must be owner of table messages' : null
    );

    await applySchema({ lakebase } as InsightsAppKit);

    const said = errors.join('\n');
    expect(said).not.toContain('starting without a usable store');
    expect(said).not.toContain('every read below will report itself unavailable');
    expect(said).toContain('SCHEMA SETUP INCOMPLETE');
    expect(said).toContain('nothing below is answered from anywhere else');
  });

  it('points at ownership, which is what this failure actually is', async () => {
    const { lakebase } = store((text) =>
      /^ALTER TABLE/i.test(text.trim()) ? 'must be owner of table messages' : null
    );

    await applySchema({ lakebase } as InsightsAppKit);

    const summary = errors.find((line) => line.includes('SCHEMA SETUP INCOMPLETE')) ?? '';
    expect(summary).toContain('IF NOT EXISTS does not exempt it');
    expect(summary).toContain('scripts/grant-app-db-access.mjs');
  });
});

/**
 * The refusal that changes nothing, told apart from the one that leaves the
 * schema short.
 *
 * Both arrive as the same SQLSTATE with nearly the same prose, so the error
 * cannot decide it. Reading the schema can: if every column the statement
 * would have added is already there, the boot is healthy and saying otherwise
 * on every start is what taught people to skip the line.
 */
const ADDED_COLUMNS = [...schemaStatements[ALTER_MESSAGES].matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/gi)].map(
  (match) => match[1]
);

/**
 * A database where the app owns no table and every column is already there.
 *
 * Every `ALTER` is refused, and the column read answers for whichever table was
 * asked about. Answering one fixed list regardless of the table was fine while
 * `messages` held the only `ALTER` in the schema; a second one (version 2's
 * `runs.correlation_id`) then looked short, which is the fixture claiming a
 * schema nobody deployed rather than the runner getting it wrong.
 */
function ownedTable(columnsByTable: Record<string, string[]>) {
  return {
    lakebase: {
      query(text: string, params?: unknown[]) {
        if (/^ALTER TABLE/i.test(text.trim())) {
          return Promise.reject(new Error('must be owner of table messages'));
        }
        if (/information_schema\.columns/i.test(text)) {
          const table = typeof params?.[1] === 'string' ? params[1] : '';
          const present = columnsByTable[table] ?? [];
          return Promise.resolve({ rows: present.map((column_name) => ({ column_name })) });
        }
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    },
  };
}

/** Every column every `ALTER` in the numbered schema would add, by table. */
const ALTERED_COLUMNS: Record<string, string[]> = MIGRATIONS.reduce<Record<string, string[]>>(
  (accumulated, migration) => {
    for (const statement of migration.statements) {
      const target = /^ALTER\s+TABLE\s+\w+\.(\w+)/i.exec(statement.trim())?.[1];
      if (!target) continue;
      const added = [...statement.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/gi)].map((match) => match[1]);
      accumulated[target] = [...(accumulated[target] ?? []), ...added];
    }
    return accumulated;
  },
  {}
);

/** The verdict on the `messages` ALTER, which is the statement under test here. */
function messagesVerdict(failures: { label: string; satisfied: boolean }[]): boolean[] {
  return failures.filter((failure) => failure.label.endsWith('messages')).map((f) => f.satisfied);
}

describe('an ALTER refused on ownership whose columns are already there', () => {
  it('guards the fixture: the statement adds columns worth checking for', () => {
    expect(ADDED_COLUMNS.length).toBeGreaterThan(0);
  });

  it('is reported as the no-op it is, not as an incomplete schema', async () => {
    const { lakebase } = ownedTable(ALTERED_COLUMNS);

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    // Every refused ALTER, not just this one: a database the app owns nothing in
    // and whose columns are all present is healthy, and the whole schema has to
    // read that way or the summary is back to being unreadable.
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((failure) => failure.satisfied)).toBe(true);
    expect(errors).toEqual([]);
    const said = warnings.join('\n');
    expect(said).toContain('already present');
    expect(said).toContain('scripts/grant-app-db-access.mjs');
  });

  /**
   * The carve-out has to be narrow in the direction that matters. A statement
   * that added four columns and found three is a schema this version will read
   * off the end of, and quietening it because the failure looked familiar is
   * the same mistake in the opposite direction.
   */
  it('stays loud when only some of the columns it adds are present', async () => {
    const { lakebase } = ownedTable({ ...ALTERED_COLUMNS, messages: ADDED_COLUMNS.slice(0, -1) });

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    expect(messagesVerdict(failures)).toEqual([false]);
    expect(errors.some((line) => line.includes('SCHEMA SETUP INCOMPLETE'))).toBe(true);
  });

  /**
   * The verifying read is what decides whether a refusal is quietened, so a row
   * it cannot make sense of has to fall on the loud side.
   *
   * A column name that arrives wrapped rather than as a string is the case that
   * bites: stringifying an array yields its element, so `['created_at']` read as
   * the column `created_at` and a refusal was reported as a harmless no-op on
   * the strength of a row nobody could vouch for. Reading a non-scalar as absent
   * means it matches no column this statement asked for, and the refusal keeps
   * the operator's attention.
   */
  it('stays loud when the columns arrive in a shape it cannot read as names', async () => {
    const lakebase = {
      query(text: string) {
        if (/^ALTER TABLE/i.test(text.trim())) {
          return Promise.reject(new Error('must be owner of table messages'));
        }
        if (/information_schema\.columns/i.test(text)) {
          return Promise.resolve({ rows: ADDED_COLUMNS.map((column) => ({ column_name: [column] })) });
        }
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    };

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    expect(messagesVerdict(failures)).toEqual([false]);
    expect(errors.some((line) => line.includes('SCHEMA SETUP INCOMPLETE'))).toBe(true);
  });

  it('stays loud when the schema cannot be read to decide', async () => {
    const lakebase = {
      query(text: string) {
        if (/^ALTER TABLE/i.test(text.trim())) {
          return Promise.reject(new Error('must be owner of table messages'));
        }
        if (/information_schema\.columns/i.test(text)) {
          return Promise.reject(new Error('permission denied for schema information_schema'));
        }
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    };

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    expect(messagesVerdict(failures)).toEqual([false]);
    expect(errors.some((line) => line.includes('SCHEMA SETUP INCOMPLETE'))).toBe(true);
  });
});

describe('a store that refuses everything', () => {
  it('is still reported as the fatal thing it is', async () => {
    const { attempted, lakebase } = store(() => 'Connection terminated unexpectedly');

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    // Every statement is still attempted (a store that is merely slow to
    // accept the first one is not a reason to skip the rest), but the verdict
    // is the fatal one, because nothing was accepted.
    expect(attempted).toHaveLength(schemaStatements.length);
    expect(failures).toHaveLength(schemaStatements.length);
    const fatal = errors.find((line) => line.includes('SCHEMA SETUP FAILED'));
    expect(fatal).toContain('starting without a usable store');
    // Not "will serve representative data", which is what this promised
    // unconditionally, on deployments that had none and then on every
    // deployment. An operator reading it goes looking for seeded rows on
    // screens that are reporting an outage, which is the same conflation one
    // level down from the one this whole function was rewritten to remove.
    expect(fatal).toContain('every read below will report itself unavailable rather than return rows');
    expect(fatal).not.toContain('representative');
    expect(fatal).toContain('Connection terminated unexpectedly');
    expect(errors.some((line) => line.includes('SCHEMA SETUP INCOMPLETE'))).toBe(false);
  });
});

describe('a schema that applies cleanly', () => {
  it('says nothing, because there is nothing to say', async () => {
    const { lakebase } = store(() => null);

    const failures = await applySchema({ lakebase } as InsightsAppKit);

    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('booting the app with a statement that fails', () => {
  it('still registers its routes and still runs the rest of the schema', async () => {
    const { attempted, lakebase } = store((text) =>
      /^ALTER TABLE/i.test(text.trim()) ? 'must be owner of table messages' : null
    );
    const app = express();
    app.use(express.json());

    const { storeReady } = await setupInsightsRoutes({
      lakebase,
      server: { extend: (fn) => fn(app) },
      servingTransport: () => Promise.reject(new Error('not used')),
    });
    // Awaited here and nowhere on the boot path: the schema pass runs in the
    // background so the app can answer while it is still going. This assertion
    // is about what the pass did, so it has to wait for the pass.
    await storeReady;

    expect(attempted.slice(0, schemaStatements.length)).toEqual([...schemaStatements]);
  });
});
