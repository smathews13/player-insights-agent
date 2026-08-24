import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_RAIL_LIMIT,
  SHARED_CONVERSATION_RAIL_ENV,
  resolveSharedConversationRail,
  setupInsightsRoutes,
  type InsightsAppKit,
} from './insights-routes';
import { resetLakebaseHealth } from '../lib/lakebase-store';

/**
 * The switch that decides whether the rail is one person's or everyone's.
 */

function recordingStore() {
  const queries: { sql: string; params: unknown[] }[] = [];
  return {
    queries,
    /** The statements that read conversations, normalised to one line. */
    reads: () =>
      queries
        .filter((entry) => /FROM player_insights\.(conversations|messages)/i.test(entry.sql))
        .map((entry) => ({ sql: entry.sql.replace(/\s+/g, ' ').trim(), params: entry.params })),
    lakebase: {
      query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
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
  // The loopback address, named, rather than the wildcard `listen(0)` gives.
  //
  // A wildcard bind is 0.0.0.0:port, and macOS will hand out a port that another
  // process is already listening on at 127.0.0.1 -- Node sets SO_REUSEADDR, and
  // BSD permits a wildcard bind beside a specific one. The listen succeeds, on
  // (measured here) a port belonging to Cursor or to a Logitech helper, and the
  // fetch below is then demuxed to the *more specific* socket: this test's
  // request is answered by that process instead of by this app. Naming the
  // address the test actually fetches turns the collision into an EADDRINUSE
  // that the port allocator skips, which is the behaviour one wants.
  //
  // This was the flake. Ten worker processes, 400 servers each: 2-3 requests per
  // 4,000 answered by the wrong process on the wildcard, none on the loopback.
  // Which symptom arrives depends on who owns the port, which is why it looked
  // like several unrelated flakes -- an empty body, ECONNRESET, `other side
  // closed`, a 404 from a foreign HTTP server, and a delete that returned
  // success while this test's fixture sat untouched were all the same bug.
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    fetch: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const asAlice = { 'x-forwarded-email': 'alice@example.example' };

let previous: string | undefined;
let nodeEnv: string | undefined;
let logs: string[];

beforeEach(() => {
  resetLakebaseHealth();
  previous = process.env[SHARED_CONVERSATION_RAIL_ENV];
  nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.join(' '));
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'log').mockImplementation(capture);
});

afterEach(() => {
  if (previous === undefined) delete process.env[SHARED_CONVERSATION_RAIL_ENV];
  else process.env[SHARED_CONVERSATION_RAIL_ENV] = previous;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  vi.restoreAllMocks();
});

describe('resolving the flag', () => {
  it('is off when nothing is set', () => {
    expect(resolveSharedConversationRail(undefined)).toMatchObject({ shared: false, reason: 'unset' });
  });

  it.each(['', '   ', '\n'])('is off for the blank value %j', (value) => {
    expect(resolveSharedConversationRail(value)).toMatchObject({ shared: false, reason: 'unset' });
  });

  it.each(['true', 'TRUE', 'True', '  true  '])('is on only for %j', (value) => {
    expect(resolveSharedConversationRail(value)).toMatchObject({ shared: true, reason: 'enabled' });
  });

  it.each(['false', 'FALSE', ' false '])('is off for the explicit %j', (value) => {
    expect(resolveSharedConversationRail(value)).toMatchObject({ shared: false, reason: 'disabled' });
  });

  // The cases that matter. Each of these is something a person would plausibly
  // write meaning "on", and every one of them has to fail closed.
  it.each(['1', 'yes', 'y', 'on', 'shared', 'treu', 'ture', 'True!', 'enabled'])(
    'fails closed on %j, and marks it unrecognised rather than merely off',
    (value) => {
      const resolved = resolveSharedConversationRail(value);
      expect(resolved.shared).toBe(false);
      // Distinct from `disabled` on purpose: somebody meant to turn this on and
      // it did not happen, which the boot log has to be able to say.
      expect(resolved.reason).toBe('unrecognised');
    }
  );
});

describe('what the rail reads', () => {
  it('scopes to the caller when the flag is unset', async () => {
    delete process.env[SHARED_CONVERSATION_RAIL_ENV];
    const store = recordingStore();
    const app = await startApp(store.lakebase);
    store.queries.length = 0;

    try {
      expect((await app.fetch('/api/conversations', { headers: asAlice })).status).toBe(200);
    } finally {
      await app.close();
    }

    const [read] = store.reads();
    expect(read.sql).toContain('WHERE user_email = $1');
    expect(read.sql).toContain(`LIMIT ${CONVERSATION_RAIL_LIMIT}`);
    expect(read.params).toEqual(['alice@example.example']);
  });

  it.each(['1', 'yes', 'treu', ''])('still scopes to the caller when the flag says %j', async (value) => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = value;
    const store = recordingStore();
    const app = await startApp(store.lakebase);
    store.queries.length = 0;

    try {
      await app.fetch('/api/conversations', { headers: asAlice });
    } finally {
      await app.close();
    }

    const [read] = store.reads();
    expect(
      read.sql,
      `${JSON.stringify(value)} is not "true", so the rail must stay scoped. A value nobody ` +
        'recognises must never be the thing that widens it.'
    ).toContain('WHERE user_email = $1');
    expect(read.params).toEqual(['alice@example.example']);
  });

  it('lists everyone once the flag is exactly true', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const store = recordingStore();
    const app = await startApp(store.lakebase);
    store.queries.length = 0;

    try {
      expect((await app.fetch('/api/conversations', { headers: asAlice })).status).toBe(200);
    } finally {
      await app.close();
    }

    const [read] = store.reads();
    expect(read.sql).not.toContain('WHERE');
    expect(read.sql).toContain(`LIMIT ${CONVERSATION_RAIL_LIMIT}`);
    expect(read.params).toEqual([]);
  });

  it('opens a shared conversation, because a rail that lists one it cannot open is not a feature', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const store = recordingStore();
    const app = await startApp(store.lakebase);
    store.queries.length = 0;

    try {
      await app.fetch('/api/conversations/conv-bob/messages', { headers: asAlice });
    } finally {
      await app.close();
    }

    const [read] = store.reads();
    expect(read.sql).toContain('WHERE m.conversation_id = $1');
    expect(read.sql).not.toContain('c.user_email = $2');
    // The caller is still passed, and not as a tenancy predicate: the projection
    // reads back this reader's own rating of each answer, which is why the rating
    // a reader gave survives reopening the conversation. The rail shares whose
    // question and whose answer; it does not share whose opinion of it.
    expect(read.params).toEqual(['conv-bob', 'alice@example.example']);
    expect(read.sql).toContain('f.user_email = $2');
  });
});

describe('what the flag deliberately does not widen', () => {
  beforeEach(() => void (process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true'));

  it('still refuses to delete a conversation belonging to somebody else', async () => {
    const statements: string[] = [];
    const app = await startApp({
      query(sql: string) {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        // The conversation exists, and it is Bob's.
        return /user_email\s+FROM player_insights\.conversations/i.test(sql)
          ? Promise.resolve({ rows: [{ user_email: 'bob@example.example' }] })
          : Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    });

    try {
      const response = await app.fetch('/api/conversations/conv-bob', {
        method: 'DELETE',
        headers: asAlice,
      });

      // Reading somebody's conversation and destroying it are different
      // permissions, and this flag only ever grants the first.
      expect(response.status).toBe(404);
      expect(statements.filter((sql) => sql.startsWith('DELETE'))).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('still scopes attachment reads to the owner', async () => {
    const store = recordingStore();
    const app = await startApp(store.lakebase);
    store.queries.length = 0;

    try {
      await app.fetch('/api/conversations/conv-bob/attachments', { headers: asAlice });
    } finally {
      await app.close();
    }

    const read = store.queries.find((entry) => /FROM player_insights\.attachments/i.test(entry.sql));
    expect(read?.sql).toContain('user_email = $2');
    expect(read?.params).toEqual(['conv-bob', 'alice@example.example']);
  });
});

describe('what the app says about itself at boot', () => {
  it('announces a widened rail loudly, rather than leaving it to be discovered', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const app = await startApp(recordingStore().lakebase);
    await app.close();

    const line = logs.find((entry) => entry.includes('SHARED CONVERSATION RAIL IS ON'));
    expect(line).toBeDefined();
    expect(line).toContain(SHARED_CONVERSATION_RAIL_ENV);
  });

  it('says a value it did not understand was ignored, so the flag does not look broken', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = '1';
    const app = await startApp(recordingStore().lakebase);
    await app.close();

    const line = logs.find((entry) => entry.includes('is not a value this app recognises'));
    expect(line).toBeDefined();
    expect(line).toContain('IGNORED');
  });

  it('reports the scope on /api/identity, so the page can say it too', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const app = await startApp(recordingStore().lakebase);

    try {
      const payload = (await (await app.fetch('/api/identity', { headers: asAlice })).json()) as {
        sharedConversationRail: boolean;
      };
      expect(payload.sharedConversationRail).toBe(true);
    } finally {
      await app.close();
    }
  });
});
