/**
 * That the schema pass is not governed by the READ timeout.
 *
 * ── THE FAULT, WHICH TOOK TWO CHANGES LANDING ON THE SAME DAY ──
 *
 * The statement timeout cannot be pool configuration, because AppKit drops it
 * (see the head of `lakebase-pool.ts`), so reads apply it as a SESSION setting
 * on a pooled connection: `SET statement_timeout = 30000`, once per physical
 * connection, remembered so it costs nothing thereafter.
 *
 * A session setting outlives the read that made it. It belongs to the
 * connection, and the pool hands that connection to whoever asks next. Nothing
 * about that mattered while the schema pass ran to completion BEFORE the app
 * served anything: no read had happened, so no connection carried the setting.
 *
 * The same day made startup non-blocking. The schema pass is now fired and not
 * awaited, and `startLakebaseWatchdog` begins probing immediately, so a read
 * lands on the pool while the DDL is still going. From then on `CREATE INDEX`
 * can be issued on a connection some earlier read set a thirty-second limit on.
 *
 * ── WHY THIRTY SECONDS IS NOT OBVIOUSLY ENOUGH FOR A CREATE INDEX ──
 *
 * Not because building the index is slow. `CREATE INDEX` takes an ACCESS
 * EXCLUSIVE lock and WAITS for the reads already touching `messages` to finish,
 * and `statement_timeout` counts that wait. The build and the queue are one
 * budget. A redeploy that adds an index to a table this app is concurrently
 * serving reads from -- which is precisely what non-blocking startup made
 * normal, and what happened on 2026-08-16 with `messages_conversation_created_idx`
 * over 260,000 rows -- can therefore be cancelled without the index ever having
 * been the slow part.
 *
 * What that leaves behind is the bad kind of broken: the statement is reported
 * as FAILED with Postgres's cancellation message, the deployment carries on,
 * and every Monitoring read is quadratic against a store that has no index and
 * no record of why. The log says the statement failed. Nothing says the app set
 * a read's timer on it.
 *
 * ── WHAT IS ASSERTED ──
 *
 * A single connection, reused, exactly as a pool reuses one. The reads set
 * their limit on it and the DDL must not run under that limit -- and, the half
 * a careless fix breaks, the reads after the schema pass must still have it.
 */
import { describe, expect, it, vi } from 'vitest';

import { applySchema, schemaStatements } from './insights-routes';
import { readStored, resetLakebaseHealth } from '../lib/lakebase-store';
import type { InsightsAppKit } from './insights-routes';

/** What the session limit was when a statement ran. 0 is Postgres's "no limit". */
interface Ran {
  sql: string;
  timeout: number;
}

/**
 * One connection, behaving like a Postgres session: `SET` changes state that
 * outlives the statement, and every later statement on it runs under that state.
 *
 * ONE, not a pool of several, because the whole fault is reuse. A simulator
 * that handed out a fresh connection per checkout could not reproduce it, and
 * would pass whatever the code did.
 */
function oneSession() {
  const ran: Ran[] = [];
  let timeout = 0;
  let released = 0;
  const connection = {
    query: (sql: string, _params?: unknown[]) => {
      const set = /^SET statement_timeout = (\d+)$/.exec(sql.trim());
      if (set) {
        timeout = Number(set[1]);
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }
      ran.push({ sql: sql.trim(), timeout });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    release: () => {
      released += 1;
    },
  };
  const appkit = {
    lakebase: {
      // What `pool.query` is: check the idle connection out, run, give it back.
      query: (sql: string, params?: unknown[]) => connection.query(sql, params),
      pool: { connect: () => Promise.resolve(connection) },
    },
  } as unknown as InsightsAppKit;
  return {
    appkit,
    ran,
    released: () => released,
    timeoutNow: () => timeout,
    of: (fragment: string) => ran.filter((entry) => entry.sql.includes(fragment)),
  };
}

const INDEX = 'CREATE INDEX IF NOT EXISTS messages_conversation_created_idx';

describe('the schema pass on a connection a read has already used', () => {
  it('does not build an index under the read timeout', async () => {
    resetLakebaseHealth();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = oneSession();

    // The watchdog, or any request that beat the schema pass. This is what puts
    // the limit on the connection.
    await readStored(session.appkit, 'GET /probe', 'SELECT 1');
    expect(session.of('SELECT 1')[0].timeout).toBe(30_000);

    await applySchema(session.appkit);

    // THE CLAIM. Every statement of the schema pass, not just the indexes: a
    // migration is not a read and none of it should be cut off on a read's
    // budget.
    for (const statement of session.ran.filter((entry) => schemaStatements.includes(entry.sql))) {
      expect(statement.timeout, `${statement.sql.slice(0, 60)} ran under a ${statement.timeout}ms limit`).toBe(0);
    }
    expect(session.of(INDEX)).toHaveLength(1);
    warn.mockRestore();
  });

  /**
   * THE HALF A CARELESS FIX BREAKS. Lifting the limit for the DDL is one `SET`;
   * putting it back is the part that gets forgotten, and forgetting it hands
   * the pool a connection on which every subsequent read is unbounded -- which
   * is the fault the timeout was added to fix, reintroduced by its own repair
   * and invisible until something hangs.
   */
  it('leaves the connection limited again for the reads that follow', async () => {
    resetLakebaseHealth();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = oneSession();

    await applySchema(session.appkit);
    await readStored(session.appkit, 'GET /after', 'SELECT 2');

    expect(session.of('SELECT 2')[0].timeout).toBe(30_000);
    expect(session.timeoutNow()).toBe(30_000);
    warn.mockRestore();
  });

  /**
   * A pool that cannot lend a connection still runs ordinary idempotent DDL on
   * the pool fallback. A migration guarded by a session advisory lock cannot
   * use that fallback: locking one session and executing on another would only
   * pretend to serialize replicas, so it fails loudly and remains unrecorded.
   */
  it('falls back for ordinary DDL but refuses a session-locked migration without a connection', async () => {
    resetLakebaseHealth();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = oneSession();
    const appkit = {
      lakebase: {
        query: (sql: string, params?: unknown[]) => session.appkit.lakebase.query(sql, params),
        pool: { connect: () => Promise.reject(new Error('pool exhausted')) },
      },
    } as unknown as InsightsAppKit;

    const failures = await applySchema(appkit);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe('SERIALIZE version 24');
    expect(failures[0]?.message).toContain('pool exhausted');
    expect(failures[0]?.satisfied).toBe(false);
    expect(session.of(INDEX)).toHaveLength(1);
    warn.mockRestore();
  });

  /** And it gives the connection back, however the pass went. */
  it('returns the connection to the pool', async () => {
    resetLakebaseHealth();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = oneSession();

    await applySchema(session.appkit);

    expect(session.released()).toBeGreaterThan(0);
    warn.mockRestore();
  });
});
