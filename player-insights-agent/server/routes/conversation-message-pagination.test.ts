import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { announceSeedAdmins } from '../lib/admin-roles';
import { resetLakebaseHealth } from '../lib/lakebase-store';
import {
  decodeConversationMessageCursor,
  encodeConversationMessageCursor,
  MAX_CONVERSATION_MESSAGE_LIMIT,
  setupInsightsRoutes,
  type InsightsAppKit,
} from './insights-routes';

const ALICE = 'alice@example.com';
const asAlice = { 'x-forwarded-email': ALICE, 'x-forwarded-access-token': 'alice-token' };

const rows = Array.from({ length: 120 }, (_, index) => ({
  id: `msg-${String(index).padStart(3, '0')}`,
  conversation_id: 'conv-alice',
  role: index % 2 ? 'assistant' : 'user',
  content: `message ${index}`,
  response_json: null,
  trace_id: null,
  created_at: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
}));

function store(): InsightsAppKit['lakebase'] {
  const sessions = new Map<string, { subject: string; deployment: string }>();
  return {
    query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('INSERT INTO player_insights.app_sessions')) {
        sessions.set(String(params[0]), { subject: String(params[1]), deployment: String(params[2]) });
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('SELECT subject, deployment_key, CASE')) {
        const session = sessions.get(String(params[0]));
        return Promise.resolve({
          rows: session
            ? [{ subject: session.subject, deployment_key: session.deployment, session_state: 'active' }]
            : [],
        });
      }
      if (!sql.startsWith('SELECT m.id, m.role, m.content')) {
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }
      const conversationId = String(params[0]);
      const caller = String(params[1]);
      if (conversationId !== 'conv-alice' || caller !== ALICE || !sql.includes('c.user_email = $2')) {
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      }
      const hasCursor = sql.includes('(m.created_at, m.id) <');
      const before = hasCursor ? { createdAt: String(params[2]), id: String(params[3]) } : null;
      const limit = Number(params[hasCursor ? 4 : 2]);
      const page = rows
        .filter((row) => !before || `${row.created_at}\u0000${row.id}` < `${before.createdAt}\u0000${before.id}`)
        .slice()
        .reverse()
        .slice(0, limit);
      return Promise.resolve({ rows: page });
    },
  };
}

async function startApp(lakebase: InsightsAppKit['lakebase']) {
  const app = express();
  app.use(express.json());
  await setupInsightsRoutes(
    {
      lakebase,
      server: { extend: (fn) => fn(app) },
      servingTransport: () => Promise.reject(new Error('not used')),
    },
    {
      appSessionConfig: { enabled: false, minutes: 0, source: 'disabled' },
    }
  );
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    fetch: (path: string) => fetch(`${base}${path}`, { headers: asAlice }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

beforeEach(() => {
  process.env.NODE_ENV = 'development';
  announceSeedAdmins('');
  resetLakebaseHealth();
});

afterEach(() => announceSeedAdmins(''));

describe('conversation message cursor', () => {
  it('round-trips an opaque timestamp/id key and rejects malformed cursors', () => {
    const value = { createdAt: '2026-08-01T00:00:50.000Z', id: 'msg-050' };
    expect(decodeConversationMessageCursor(encodeConversationMessageCursor(value))).toEqual(value);
    expect(decodeConversationMessageCursor('not-a-cursor')).toBeNull();
  });

  it('pages a 120-message thread newest-first by page and ascending within each page', async () => {
    const app = await startApp(store());
    try {
      const firstResponse = await app.fetch('/api/conversations/conv-alice/messages?limit=50');
      const first = (await firstResponse.json()) as {
        messages: typeof rows;
        nextCursor: string;
        hasMore: boolean;
      };
      expect(first.messages).toHaveLength(50);
      expect(first.messages[0].id).toBe('msg-070');
      expect(first.messages[first.messages.length - 1]?.id).toBe('msg-119');
      expect(first.hasMore).toBe(true);

      const second = await app
        .fetch(`/api/conversations/conv-alice/messages?limit=50&cursor=${encodeURIComponent(first.nextCursor)}`)
        .then((response) => response.json() as Promise<typeof first>);
      expect(second.messages.map((row) => row.id)).toEqual(rows.slice(20, 70).map((row) => row.id));

      const third = await app
        .fetch(`/api/conversations/conv-alice/messages?limit=50&cursor=${encodeURIComponent(second.nextCursor)}`)
        .then((response) => response.json() as Promise<typeof first>);
      expect(third.messages.map((row) => row.id)).toEqual(rows.slice(0, 20).map((row) => row.id));
      expect(third.hasMore).toBe(false);
      expect(third.nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps ownership isolation and bounds page size', async () => {
    const app = await startApp(store());
    try {
      const other = await app.fetch('/api/conversations/conv-bob/messages?limit=50');
      expect(await other.json()).toMatchObject({ messages: [] });
      const tooLarge = await app.fetch(
        `/api/conversations/conv-alice/messages?limit=${MAX_CONVERSATION_MESSAGE_LIMIT + 1}`
      );
      expect(tooLarge.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('keeps the old unpaged array response available', async () => {
    const app = await startApp(store());
    try {
      const legacy = (await app
        .fetch('/api/conversations/conv-alice/messages')
        .then((response) => response.json())) as typeof rows;
      expect(legacy).toHaveLength(50);
      expect(legacy[0]?.id).toBe('msg-070');
      expect(legacy[49]?.id).toBe('msg-119');
    } finally {
      await app.close();
    }
  });
});
