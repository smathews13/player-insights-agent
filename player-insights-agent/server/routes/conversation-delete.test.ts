import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupInsightsRoutes, type InsightsAppKit } from './insights-routes';
import { resetLakebaseHealth } from '../lib/lakebase-store';

/**
 * What `DELETE /api/conversations/:id` removes, and what it leaves alone.
 *
 * This store had every conversation deleted once by an ad-hoc statement, and
 * the loss was diagnosed as a database outage for hours before anyone realised
 * it was self-inflicted. So the assertions here are as much about the blast
 * radius as about the feature: the statements are keyed on one primary key, the
 * tables named are the ones that actually hang off a conversation, and a store
 * that cannot answer is never read as a conversation that is not there.
 */

const OWNER = 'owner@example.example';
const asOwner = { 'x-forwarded-email': OWNER };

/**
 * A store that actually applies the deletes, so the final row counts are
 * evidence rather than a restatement of the mock.
 *
 * Only the statements this route issues are interpreted. Anything else answers
 * empty, which is what makes an unexpected statement visible: a delete aimed at
 * a table nobody modelled here removes nothing and the row survives the
 * assertion.
 */
function store(seed?: { failOn?: RegExp }) {
  const tables = {
    conversations: [
      { id: 'conv-1', user_email: OWNER },
      { id: 'conv-2', user_email: OWNER },
    ],
    messages: [
      { id: 'msg-1', conversation_id: 'conv-1' },
      { id: 'msg-2', conversation_id: 'conv-1' },
      { id: 'msg-other', conversation_id: 'conv-2' },
    ],
    attachments: [
      { id: 'att-1', conversation_id: 'conv-1' },
      { id: 'att-other', conversation_id: 'conv-2' },
    ],
    feedback: [
      { id: 'fb-1', message_id: 'msg-2' },
      { id: 'fb-other', message_id: 'msg-other' },
    ],
    // Present so that a statement reaching for it would have something to
    // destroy. A benchmark run belongs to a suite, not to a conversation.
    benchmark_runs: [{ id: 'bench-1', suite_id: 'poc-benchmark' }],
  };
  const statements: string[] = [];

  function take<T extends { id: string }>(rows: T[], keep: (row: T) => boolean) {
    const removed = rows.filter((row) => !keep(row));
    const survivors = rows.filter(keep);
    rows.length = 0;
    rows.push(...survivors);
    return { rows: removed.map((row) => ({ id: row.id })) };
  }

  return {
    tables,
    statements,
    lakebase: {
      query(text: string, params: unknown[] = []) {
        const sql = text.replace(/\s+/g, ' ').trim();
        if (sql.startsWith('CREATE') || sql.startsWith('INSERT INTO player_insights.benchmark_suites')) {
          return Promise.resolve({ rows: [] as Record<string, unknown>[] });
        }
        statements.push(sql);
        if (seed?.failOn?.test(sql)) return Promise.reject(new Error('connection terminated unexpectedly'));

        if (sql.startsWith('SELECT user_email FROM player_insights.conversations WHERE id = $1')) {
          const row = tables.conversations.find((c) => c.id === params[0]);
          return Promise.resolve({ rows: row ? [{ user_email: row.user_email }] : [] });
        }
        if (sql.startsWith('DELETE FROM player_insights.feedback')) {
          const doomed = new Set(tables.messages.filter((m) => m.conversation_id === params[0]).map((m) => m.id)
          );
          return Promise.resolve(take(tables.feedback, (row) => !doomed.has(row.message_id)));
        }
        if (sql.startsWith('DELETE FROM player_insights.attachments')) {
          return Promise.resolve(take(tables.attachments, (row) => row.conversation_id !== params[0]));
        }
        if (sql.startsWith('DELETE FROM player_insights.messages')) {
          return Promise.resolve(take(tables.messages, (row) => row.conversation_id !== params[0]));
        }
        if (sql.startsWith('DELETE FROM player_insights.conversations')) {
          return Promise.resolve(take(tables.conversations, (row) => !(row.id === params[0] && row.user_email === params[1]))
          );
        }
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    },
  };
}

async function startApp(lakebase: InsightsAppKit['lakebase']) {
  const app = express();
  app.use(express.json());
  await setupInsightsRoutes({
    lakebase,
    server: { extend: (fn) => fn(app) },
    servingTransport: () => Promise.reject(new Error('not used')),
  });
  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    fetch: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let nodeEnv: string | undefined;

beforeEach(() => {
  resetLakebaseHealth();
  nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  vi.restoreAllMocks();
});

describe('deleting one conversation', () => {
  it('removes the conversation and everything keyed to it, and says what it removed', async () => {
    const backing = store();
    const app = await startApp(backing.lakebase);

    try {
      const response = await app.fetch('/api/conversations/conv-1', { method: 'DELETE', headers: asOwner });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        conversationId: 'conv-1',
        deleted: { conversations: 1, messages: 2, attachments: 1, feedback: 1 },
      });
      expect(backing.tables.conversations.map((row) => row.id)).toEqual(['conv-2']);
      expect(backing.tables.messages.map((row) => row.id)).toEqual(['msg-other']);
      expect(backing.tables.attachments.map((row) => row.id)).toEqual(['att-other']);
      expect(backing.tables.feedback.map((row) => row.id)).toEqual(['fb-other']);
    } finally {
      await app.close();
    }
  });

  it('leaves every other conversation alone, which is the failure this store already had', async () => {
    const backing = store();
    const app = await startApp(backing.lakebase);

    try {
      await app.fetch('/api/conversations/conv-1', { method: 'DELETE', headers: asOwner });

      // Every statement is keyed on the one id. An unqualified DELETE is what
      // emptied this table once, so the shape of the statement is asserted and
      // not just its outcome on the seeded rows.
      const deletes = backing.statements.filter((sql) => sql.startsWith('DELETE'));
      expect(deletes).toHaveLength(4);
      for (const sql of deletes) {
        expect(sql).toMatch(/WHERE/);
        expect(sql).toContain('$1');
      }
    } finally {
      await app.close();
    }
  });

  it('removes feedback before the messages it is keyed on, or it could not find it at all', async () => {
    const backing = store();
    const app = await startApp(backing.lakebase);

    try {
      await app.fetch('/api/conversations/conv-1', { method: 'DELETE', headers: asOwner });

      const tableOf = (sql: string) => sql.match(/DELETE FROM player_insights\.(\w+)/)?.[1];
      const order = backing.statements.filter((sql) => sql.startsWith('DELETE')).map(tableOf);

      // `feedback` carries no conversation id, only a message id, so once the
      // messages are gone there is nothing left to identify these rows by.
      expect(order.indexOf('feedback')).toBeLessThan(order.indexOf('messages'));
      // The conversation row goes last, so a failure part-way through leaves it
      // in the rail and the delete retryable.
      expect(order[order.length - 1]).toBe('conversations');
    } finally {
      await app.close();
    }
  });

  it('never touches benchmark runs, which belong to a suite rather than to a conversation', async () => {
    const backing = store();
    const app = await startApp(backing.lakebase);

    try {
      await app.fetch('/api/conversations/conv-1', { method: 'DELETE', headers: asOwner });

      expect(backing.tables.benchmark_runs).toHaveLength(1);
      expect(backing.statements.join(' ')).not.toContain('benchmark_runs');
    } finally {
      await app.close();
    }
  });

  it('takes the derived run with the messages, because no run row exists to remove', async () => {
    const backing = store();
    const app = await startApp(backing.lakebase);

    try {
      await app.fetch('/api/conversations/conv-1', { method: 'DELETE', headers: asOwner });

      // `RUNS_QUERY` derives a conversation run from the assistant messages
      // that carry a trace rather than reading a stored row, so deleting the
      // messages is what removes the run. A statement naming a `runs` table
      // here would be deleting something that does not exist.
      expect(backing.statements.join(' ')).not.toMatch(/player_insights\.runs/);
      expect(backing.tables.messages.some((row) => row.conversation_id === 'conv-1')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('answers 404 for an id that is not in the store, without deleting anything', async () => {
    const backing = store();
    const app = await startApp(backing.lakebase);

    try {
      const response = await app.fetch('/api/conversations/conv-missing', {
        method: 'DELETE',
        headers: asOwner,
      });

      expect(response.status).toBe(404);
      expect(backing.statements.filter((sql) => sql.startsWith('DELETE'))).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('when the store cannot answer', () => {
  it('refuses rather than reporting a conversation deleted that is still there', async () => {
    const backing = store({ failOn: /^SELECT user_email/ });
    const app = await startApp(backing.lakebase);

    try {
      const response = await app.fetch('/api/conversations/conv-1', { method: 'DELETE', headers: asOwner });

      // The hazard `safeQuery` would have introduced: a failed read answers
      // with zero rows, which is indistinguishable from "no such conversation",
      // so an outage would have reported someone's conversation as already gone
      // and the rail would have dropped it.
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'conversation_delete_failed' });
      expect(backing.tables.conversations).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('leaves the conversation listed when the cascade fails part-way, so the retry can finish it', async () => {
    const backing = store({ failOn: /^DELETE FROM player_insights\.messages/ });
    const app = await startApp(backing.lakebase);

    try {
      const response = await app.fetch('/api/conversations/conv-1', { method: 'DELETE', headers: asOwner });

      expect(response.status).toBe(503);
      // Still in the rail, and still nameable, which is what makes the second
      // attempt able to remove what the first one did not.
      expect(backing.tables.conversations.map((row) => row.id)).toContain('conv-1');
    } finally {
      await app.close();
    }
  });
});
