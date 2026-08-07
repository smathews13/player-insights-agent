import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, schemaStatements, setupInsightsRoutes, type InsightsAppKit } from './insights-routes';
import { resetLakebaseHealth, stopLakebaseWatchdog } from '../lib/lakebase-store';

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
        attempted.push(text);
        const refusal = refuse(text);
        if (refusal) return Promise.reject(new Error(refusal));
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    },
  };
}

let errors: string[];

beforeEach(() => {
  resetLakebaseHealth();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  stopLakebaseWatchdog();
  vi.restoreAllMocks();
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

    expect(attempted).toEqual([...schemaStatements]);
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
    expect(summary).toContain('2 of 10 statements failed');
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
    expect(said).not.toContain('every read below will serve representative data');
    expect(said).toContain('SCHEMA SETUP INCOMPLETE');
    expect(said).toContain('This is NOT the app falling back to representative data');
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
    expect(fatal).toContain('every read below will serve representative data');
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

    await setupInsightsRoutes({
      lakebase,
      server: { extend: (fn) => fn(app) },
      servingTransport: () => Promise.reject(new Error('not used')),
    });

    expect(attempted.slice(0, schemaStatements.length)).toEqual([...schemaStatements]);
  });
});
