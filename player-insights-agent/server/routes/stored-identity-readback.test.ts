import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupInsightsRoutes, type InsightsAppKit } from './insights-routes';
import { resetLakebaseHealth } from '../lib/lakebase-store';

/**
 * What a reopened conversation is told about who its answers ran as.
 *
 * The ask route records the executing identity in columns on the message row,
 * beside the answer rather than inside it, because who a run executed as is this
 * app's record about the agent and not part of the agent's answer contract. The
 * route that serves a conversation back did not project those columns, so the
 * browser was handed answers with no identity attached and its footer said, of
 * every answer ever given, that the identity was unconfirmed.
 *
 * The projection is the whole of the server's part in that, and it is asserted
 * two ways here: that the columns are in the statement, and that a row holding
 * them survives the trip to the response body. The second is the one that would
 * catch a later change dropping them somewhere between the query and the JSON;
 * the first is the one that names what is missing when it breaks.
 */

const ALICE = 'alice@example.example';
const asAlice = { 'x-forwarded-email': ALICE, 'x-forwarded-access-token': 'alice-token' };

/**
 * One conversation with two answers in it: one taken after the identity columns
 * existed, one taken before. The second is not an edge case to be tidied away --
 * it is most of the history of any deployment that has been running a while, and
 * it has to keep arriving with nothing in those columns.
 */
function conversationStore() {
  const rows: Record<string, unknown>[] = [
    {
      id: 'msg-recent',
      role: 'assistant',
      content: 'Active players rose 4%.',
      response_json: { id: 'msg-recent', takeaway: 'Active players rose 4%.' },
      trace_id: 'tr-00000000000000000000000000000001',
      created_at: '2026-08-15T10:00:00.000Z',
      app_principal: 'app-sp',
      serving_principal: 'serving-sp',
      serving_principal_observed_at: '2026-08-15T09:00:00.000Z',
      access_mode: 'user-verified',
      execution_mode: 'signed_in_user',
      execution_identity_verified: false,
      asked_by: ALICE,
    },
    {
      id: 'msg-older-than-the-columns',
      role: 'assistant',
      content: 'Retention held steady.',
      response_json: { id: 'msg-older-than-the-columns', takeaway: 'Retention held steady.' },
      trace_id: 'tr-00000000000000000000000000000002',
      created_at: '2026-06-01T10:00:00.000Z',
      app_principal: null,
      serving_principal: null,
      serving_principal_observed_at: null,
      access_mode: null,
      execution_mode: null,
      execution_identity_verified: null,
      asked_by: ALICE,
    },
  ];

  const statements: string[] = [];
  return {
    statements,
    lakebase: {
      query(text: string, _params: unknown[] = []) {
        const sql = text.replace(/\s+/g, ' ').trim();
        statements.push(sql);
        if (sql.startsWith('SELECT m.id, m.role, m.content')) return Promise.resolve({ rows });
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
  // Loopback rather than the wildcard, or this binds a port another process holds
  // on 127.0.0.1 and the fetch below reaches that process. See shared-rail.test.ts.
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    messages: (id: string) => fetch(`http://127.0.0.1:${port}/api/conversations/${id}/messages`, { headers: asAlice }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let nodeEnv: string | undefined;

beforeEach(() => {
  resetLakebaseHealth();
  nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  vi.restoreAllMocks();
});

describe('reading a conversation back', () => {
  it('asks for both halves of the executing identity, not one', async () => {
    const store = conversationStore();
    const app = await startApp(store.lakebase);

    try {
      await app.messages('conv-alice');
      const read = store.statements.find((sql) => sql.startsWith('SELECT m.id, m.role, m.content'));

      expect(read).toBeDefined();
      // Both, because they are separate facts and a half-filled pair is read as
      // no claim at all downstream. Projecting the mode alone would turn every
      // answered turn into an unconfirmed one just as surely as projecting
      // neither did.
      expect(read).toContain('m.execution_mode');
      expect(read).toContain('m.execution_identity_verified');
    } finally {
      await app.close();
    }
  });

  it('carries what each turn recorded, and nothing for the turns that recorded none', async () => {
    const app = await startApp(conversationStore().lakebase);

    try {
      const rows = (await (await app.messages('conv-alice')).json()) as Record<string, unknown>[];

      expect(rows).toHaveLength(2);
      // Recorded as unverified, and it arrives unverified. The flag says whether
      // the forwarded token was proven to be the reader's, which is a different
      // question from which credential the endpoint was called with, and a route
      // that filled an absent one in would be confirming runs nobody checked.
      expect(rows[1]).toMatchObject({
        id: 'msg-recent',
        execution_mode: 'signed_in_user',
        execution_identity_verified: false,
      });
      // Taken before the columns existed. Null on the way out, because there is
      // nothing to report and no way to work it out afterwards: the reader's
      // session says who is looking now, not who ran this then.
      expect(rows[0]).toMatchObject({
        id: 'msg-older-than-the-columns',
        execution_mode: null,
        execution_identity_verified: null,
      });
    } finally {
      await app.close();
    }
  });
});
