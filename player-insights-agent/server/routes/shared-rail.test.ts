import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
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
import { announceSeedAdmins } from '../lib/admin-roles';

/**
 * The switch that decides whether the rail is one person's or everyone's.
 */

function recordingStore(
  role?: 'admin' | 'super_admin',
  conversationRows: Record<string, unknown>[] = [],
  personaRows: Record<string, unknown>[] = []
) {
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
        if (/SELECT email, role, added_by, added_at FROM player_insights\.admin_emails/i.test(sql)) {
          return Promise.resolve({
            rows: role
              ? [{ email: 'alice@example.example', role, added_by: 'operator@example.example', added_at: new Date(0) }]
              : [],
          });
        }
        if (/FROM player_insights\.conversations c/i.test(sql)) {
          return Promise.resolve({ rows: conversationRows });
        }
        if (/FROM player_insights\.sp_personas/i.test(sql)) {
          return Promise.resolve({ rows: personaRows });
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
const ROUTE_SOURCE = readFileSync(new URL('insights-routes.ts', import.meta.url), 'utf8');

let previous: string | undefined;
let nodeEnv: string | undefined;
let logs: string[];

beforeEach(() => {
  resetLakebaseHealth();
  announceSeedAdmins('');
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
  announceSeedAdmins('');
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

describe('source security invariants', () => {
  it('derives shared reads from both the operator switch and the authoritative role', () => {
    const guard = ROUTE_SOURCE.slice(
      ROUTE_SOURCE.indexOf('async function callerReadsSharedConversations'),
      ROUTE_SOURCE.indexOf('/**\n * The only thing `POST /api/insights/ask`')
    );
    expect(guard).toContain('if (!sharedRail.shared) return false');
    expect(guard).toContain('resolveRole(store, email)');
    expect(guard).toContain('opensAdminSurfaces(role)');
  });

  it('guards every conversation-bound read while leaving owner-only writes narrow', () => {
    for (const route of [
      "app.get('/api/conversations'",
      "app.get('/api/conversations/:id/messages'",
      "app.get('/api/conversations/:id/run'",
      "app.get('/api/conversations/:id/attachments'",
      "app.post('/api/feedback'",
    ]) {
      const start = ROUTE_SOURCE.indexOf(route);
      expect(start, route).toBeGreaterThan(-1);
      expect(ROUTE_SOURCE.slice(start, start + 700), route).toContain('callerReadsSharedConversations');
    }
    const upload = ROUTE_SOURCE.slice(
      ROUTE_SOURCE.indexOf("app.post('/api/conversations/:id/attachments'"),
      ROUTE_SOURCE.indexOf("app.delete('/api/conversations/:conversationId/attachments/:attachmentId'")
    );
    expect(upload).not.toContain('callerReadsSharedConversations');
    expect(upload).toContain('ownerEmail !== userEmail(req)');
  });
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
    // The OWNER predicate specifically, and not the mere presence of a WHERE.
    // The rail query carries a lateral join that reads each conversation's
    // latest answered turn for the status badge, and that subquery has a WHERE
    // of its own about message rows -- so "contains WHERE" stopped being a
    // statement about tenancy the moment the badge was derived here.
    expect(read.sql).toContain('WHERE c.user_email = $1');
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
    ).toContain('WHERE c.user_email = $1');
    expect(read.params).toEqual(['alice@example.example']);
  });

  it('keeps a consumer self-only when the flag is exactly true', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const store = recordingStore();
    const app = await startApp(store.lakebase);
    store.queries.length = 0;

    try {
      expect(
        (
          await app.fetch('/api/conversations?owners=bob%40example.example&owners=alice%40example.example', {
            headers: asAlice,
          })
        ).status
      ).toBe(200);
    } finally {
      await app.close();
    }

    const [read] = store.reads();
    // No owner predicate on the conversations table. Asserted on the predicate
    // rather than on the absence of any WHERE at all, because the status badge
    // is derived by a lateral join whose own WHERE selects a conversation's
    // latest answered turn -- see the note on the scoped case above.
    expect(read.sql).toContain('c.user_email = $1');
    expect(read.sql).toContain(`LIMIT ${CONVERSATION_RAIL_LIMIT}`);
    expect(read.params).toEqual(['alice@example.example']);
  });

  it('keeps a consumer message read self-only when the flag is exactly true', async () => {
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
    expect(read.sql).toContain('c.user_email = $2');
    // The caller is still passed, and not as a tenancy predicate: the projection
    // reads back this reader's own rating of each answer, which is why the rating
    // a reader gave survives reopening the conversation. The rail shares whose
    // question and whose answer; it does not share whose opinion of it.
    expect(read.params).toEqual(['conv-bob', 'alice@example.example', 51]);
    expect(read.sql).toContain('f.user_email = $2');
  });

  it.each(['admin', 'super_admin'] as const)('lets a %s list and open shared conversations', async (role) => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const store = recordingStore(role);
    const app = await startApp(store.lakebase);
    store.queries.length = 0;

    try {
      await app.fetch('/api/conversations?owners=bob%40example.example', { headers: asAlice });
      await app.fetch('/api/conversations/conv-bob/messages', { headers: asAlice });
    } finally {
      await app.close();
    }

    const [list, messages] = store.reads();
    expect(list.sql).not.toContain('c.user_email = $1');
    expect(list.params).toEqual([]);
    expect(messages.sql).not.toContain('AND c.user_email = $2');
    expect(messages.params).toEqual(['conv-bob', 'alice@example.example', 51]);
  });

  it('fails closed when the authoritative role store cannot be read', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const base = recordingStore();
    const app = await startApp({
      query(sql: string, params: unknown[] = []) {
        if (/FROM player_insights\.admin_emails/i.test(sql)) {
          return Promise.reject(new Error('role store unavailable'));
        }
        return base.lakebase.query(sql, params);
      },
    });
    base.queries.length = 0;
    try {
      expect((await app.fetch('/api/conversations?owners=bob%40example.example', { headers: asAlice })).status).toBe(200);
    } finally {
      await app.close();
    }
    const [read] = base.reads();
    expect(read.sql).toContain('WHERE c.user_email = $1');
    expect(read.params).toEqual(['alice@example.example']);
  });

  it('derives persona from the newest persisted run, never the current assignment', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const store = recordingStore('admin');
    const app = await startApp(store.lakebase);
    store.queries.length = 0;
    try {
      await app.fetch('/api/conversations', { headers: asAlice });
    } finally {
      await app.close();
    }
    const [read] = store.reads();
    expect(read.sql).toContain('r.persona_id');
    expect(read.sql).toContain('r.persona_name');
    expect(read.sql).toContain('ORDER BY r.created_at DESC, r.run_id DESC');
    expect(read.sql).not.toContain('sp_assignments');
  });

  it('ANDs owner and persona while preserving the full authorized set for counts', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const rows = [
      { id: 'alice-finance', user_email: 'alice@example.example', persona_id: 'finance' },
      { id: 'alice-none', user_email: 'alice@example.example', persona_id: null },
      { id: 'bob-finance', user_email: 'bob@example.example', persona_id: 'finance' },
      { id: 'bob-sales', user_email: 'bob@example.example', persona_id: 'sales' },
    ];
    const store = recordingStore('admin', rows, [
      { id: 'finance', display_name: 'Finance analyst' },
      { id: 'sales', display_name: 'Sales analyst' },
    ]);
    const app = await startApp(store.lakebase);
    try {
      const response = await app.fetch('/api/conversations?owners=alice%40example.example&personas=finance', {
        headers: asAlice,
      });
      const body = (await response.json()) as {
        conversations: Record<string, unknown>[];
        matching_conversation_ids: string[];
        available_personas: { id: string; name: string }[];
        persona_filter_rule: string;
      };
      expect(body.conversations).toHaveLength(4);
      expect(body.matching_conversation_ids).toEqual(['alice-finance']);
      expect(body.available_personas).toEqual([
        { id: 'finance', name: 'Finance analyst' },
        { id: 'sales', name: 'Sales analyst' },
      ]);
      expect(body.persona_filter_rule).toContain('newest active or completed run');
    } finally {
      await app.close();
    }
  });

  it('matches No persona without reclassifying a recorded persona', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const store = recordingStore('admin', [
      { id: 'old-oauth', user_email: 'alice@example.example', persona_id: null },
      { id: 'recorded', user_email: 'alice@example.example', persona_id: 'finance' },
    ]);
    const app = await startApp(store.lakebase);
    store.queries.length = 0;
    try {
      const response = await app.fetch('/api/conversations?no_persona=true', { headers: asAlice });
      const body = (await response.json()) as { matching_conversation_ids: string[] };
      expect(body.matching_conversation_ids).toEqual(['old-oauth']);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed filter parameters before reading conversations', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const store = recordingStore('admin');
    const app = await startApp(store.lakebase);
    store.queries.length = 0;
    try {
      const response = await app.fetch('/api/conversations?no_persona=yes', { headers: asAlice });
      expect(response.status).toBe(400);
    } finally {
      await app.close();
    }
    expect(store.reads()).toEqual([]);
  });

  it('does not expose persona evidence or metadata to a consumer', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const store = recordingStore(undefined, [
      {
        id: 'alice-only',
        user_email: 'alice@example.example',
        persona_id: 'finance',
        persona_name: 'Finance analyst',
        persona_recorded_at: new Date(),
      },
    ]);
    const app = await startApp(store.lakebase);
    store.queries.length = 0;
    try {
      const response = await app.fetch('/api/conversations?owners=bob%40example.example&personas=finance', {
        headers: asAlice,
      });
      const body = (await response.json()) as Record<string, unknown>[];
      expect(Array.isArray(body)).toBe(true);
      expect(body[0]).not.toHaveProperty('persona_id');
      expect(body[0]).not.toHaveProperty('persona_name');
      expect(body[0]).not.toHaveProperty('persona_recorded_at');
    } finally {
      await app.close();
    }
    const [read] = store.reads();
    expect(read.sql).toContain('WHERE c.user_email = $1');
    expect(read.params).toEqual(['alice@example.example']);
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
    expect(read?.sql).toContain('c.user_email = $2');
    expect(read?.params).toEqual(['conv-bob', 'alice@example.example', false]);
  });

  it('keeps guessed run ids self-only for a consumer', async () => {
    const store = recordingStore();
    const app = await startApp(store.lakebase);
    store.queries.length = 0;
    try {
      await app.fetch('/api/conversations/conv-bob/run', { headers: asAlice });
    } finally {
      await app.close();
    }
    const read = store.queries.find((entry) => /FROM player_insights\.runs/i.test(entry.sql));
    expect(read?.sql).toContain('($3 OR user_email = $2)');
    expect(read?.params).toEqual(['conv-bob', 'alice@example.example', false]);
  });

  it('lets an admin poll and read attachments for a shared conversation', async () => {
    const store = recordingStore('admin');
    const app = await startApp(store.lakebase);
    store.queries.length = 0;
    try {
      await app.fetch('/api/conversations/conv-bob/run', { headers: asAlice });
      await app.fetch('/api/conversations/conv-bob/attachments', { headers: asAlice });
    } finally {
      await app.close();
    }
    const run = store.queries.find((entry) => /FROM player_insights\.runs/i.test(entry.sql));
    const attachments = store.queries.find((entry) => /FROM player_insights\.attachments/i.test(entry.sql));
    expect(run?.params).toEqual(['conv-bob', 'alice@example.example', true]);
    expect(attachments?.params).toEqual(['conv-bob', 'alice@example.example', true]);
  });

  it('will not record feedback against a guessed message id for a consumer', async () => {
    const store = recordingStore();
    const app = await startApp(store.lakebase);
    store.queries.length = 0;
    try {
      const response = await app.fetch('/api/feedback', {
        method: 'POST',
        headers: { ...asAlice, 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'msg-bob', usefulness: 5 }),
      });
      expect(response.status).toBe(404);
    } finally {
      await app.close();
    }
    const write = store.queries.find((entry) => /INSERT INTO player_insights\.feedback/i.test(entry.sql));
    expect(write?.sql).toContain('JOIN player_insights.conversations c');
    expect(write?.sql).toContain('($7 OR c.user_email = $3)');
    expect(write?.params[2]).toBe('alice@example.example');
    expect(write?.params[6]).toBe(false);
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

  it('reports the effective consumer scope on /api/identity', async () => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const app = await startApp(recordingStore().lakebase);

    try {
      const payload = (await (await app.fetch('/api/identity', { headers: asAlice })).json()) as {
        sharedConversationRail: boolean;
      };
      expect(payload.sharedConversationRail).toBe(false);
    } finally {
      await app.close();
    }
  });

  it.each(['admin', 'super_admin'] as const)('reports shared scope to a %s', async (role) => {
    process.env[SHARED_CONVERSATION_RAIL_ENV] = 'true';
    const app = await startApp(recordingStore(role).lakebase);
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
