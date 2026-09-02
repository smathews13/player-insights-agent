import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupInsightsRoutes, type InsightsAppKit } from './insights-routes';
import { resetLakebaseHealth } from '../lib/lakebase-store';

/**
 * What a reviewer can tell from the outside when Lakebase goes away.
 *
 * The incident these cover: the app served HTTP 200 with three seeded runs and
 * demo conversations in place of real stored history, and nothing (not the
 * logs, not the response, not the Sources page), said the numbers had changed
 * from recorded to invented.
 */

/** A store that answers every read the same way, so a whole outage is one line. */
function store(outcome: 'rows' | 'empty' | 'down') {
  return {
    query() {
      if (outcome === 'down') {
        const error = new Error('Connection terminated unexpectedly') as Error & { code?: string };
        error.code = '08006';
        return Promise.reject(error);
      }
      if (outcome === 'empty') return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      return Promise.resolve({
        rows: [
          {
            id: 'msg-stored-1',
            kind: 'conversation',
            conversation_id: 'conv-stored',
            prompt: 'A question somebody really asked',
            stakeholder: '<your-username>',
            status: 'complete',
            duration_ms: 1234,
            rating: 5,
            created_at: '2026-08-04T18:00:00.000Z',
          },
        ],
      });
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
  // on 127.0.0.1 and the fetch below reaches that process instead of this app.
  // See the note in shared-rail.test.ts; the symptom here was a 404 from someone
  // else's HTTP server where this app answers 200 or 503 and never 404.
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    get: (path: string) => fetch(`http://127.0.0.1:${port}${path}`),
    post: (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let errors: string[];

beforeEach(() => {
  resetLakebaseHealth();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * What every deployment does, there now being only one posture.
 *
 * These cases did not exist before: an unreadable store was ALWAYS answered
 * with seeded rows, so there was no honest path to test. The rows were gated on
 * a demo setting for a while and are now gone, so the app has to say it cannot
 * answer without saying the store is empty, which is a different sentence and a
 * different remedy.
 */
describe('an unreadable store is reported rather than filled in', () => {
  it('answers an unreachable store with nothing, labelled unavailable', async () => {
    const app = await startApp(store('down'));
    try {
      const response = await app.get('/api/runs');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      // `none`, not `lakebase`. The body is identical to a store holding
      // nothing, so the header is the only thing telling the client which of the
      // two it is looking at, and getting it wrong renders "No runs yet" over an
      // outage.
      expect(response.headers.get('x-pia-data-origin')).toBe('none');
      expect(response.headers.get('x-pia-degraded-reason')).toBe('storage_unavailable');
      expect(response.headers.get('x-pia-storage')).toBe('unavailable');
      expect(errors.some((line) => line.includes('SERVING REPRESENTATIVE DATA'))).toBe(false);
      expect(errors.some((line) => line.includes('NO ROWS SERVED on GET /api/runs'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('answers a healthy empty store as empty, not as an outage', async () => {
    const app = await startApp(store('empty'));
    try {
      const response = await app.get('/api/conversations');

      // The state this change must not collapse into "unavailable". The read
      // succeeded; there is simply nothing in the table yet, which is what a
      // fresh deployment looks like and needs no remedy.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      expect(response.headers.get('x-pia-data-origin')).toBe('lakebase');
      expect(response.headers.get('x-pia-degraded-reason')).toBeNull();
      expect(response.headers.get('x-pia-storage')).toBe('ok');
    } finally {
      await app.close();
    }
  });

  it('reports the outage on the storage page rather than a count of fabrications', async () => {
    const app = await startApp(store('down'));
    try {
      await app.get('/api/runs');
      const response = await app.get('/api/storage');
      const body = (await response.json()) as Record<string, unknown>;

      expect(body.state).toBe('unavailable');
      // The counter is gone with the substitution it counted. A zero here read
      // as "nothing was fabricated on a deployment that could have", which is
      // no longer a distinction any deployment makes, and a field permanently
      // reporting zero is one somebody eventually wires back up to something.
      expect(body).not.toHaveProperty('substitutions_while_unavailable');
      expect(body).not.toHaveProperty('substitutions_total');
      expect(body).not.toHaveProperty('demo_content');
    } finally {
      await app.close();
    }
  });

  it('shouts in the logs when the store is unreachable', async () => {
    const app = await startApp(store('down'));
    try {
      const response = await app.get('/api/runs');
      const body = (await response.json()) as { id: string }[];

      // Empty, and a reviewer being unable to see why is the failure this
      // asserts against: the list is blank because the read failed.
      expect(response.status).toBe(200);
      expect(body).toEqual([]);
      expect(response.headers.get('x-pia-storage')).toBe('unavailable');
      expect(response.headers.get('x-pia-data-origin')).toBe('none');
      expect(response.headers.get('x-pia-degraded-reason')).toBe('storage_unavailable');
      expect(errors.some((line) => line.includes('SERVING REPRESENTATIVE DATA'))).toBe(false);
      expect(errors.some((line) => line.includes('STORAGE UNAVAILABLE'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('labels stored rows as stored', async () => {
    const app = await startApp(store('rows'));
    try {
      const response = await app.get('/api/runs');
      const body = (await response.json()) as { id: string }[];

      expect(body.map((run) => run.id)).toEqual(['msg-stored-1']);
      expect(response.headers.get('x-pia-data-origin')).toBe('lakebase');
      expect(response.headers.get('x-pia-storage')).toBe('ok');
    } finally {
      await app.close();
    }
  });

  it('separates a genuinely empty store from an unreachable one', async () => {
    const app = await startApp(store('empty'));
    try {
      const response = await app.get('/api/conversations');

      // Both answer with an empty list, so the headers carry the whole of the
      // difference: this one read the store successfully and it holds nothing,
      // which needs no remedy and must not render as an outage. So `lakebase`
      // and no degraded reason, against `none` and `storage_unavailable` above.
      expect(response.status).toBe(200);
      expect(response.headers.get('x-pia-data-origin')).toBe('lakebase');
      expect(response.headers.get('x-pia-degraded-reason')).toBeNull();
      expect(response.headers.get('x-pia-storage')).toBe('ok');
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/storage', () => {
  it('answers an outage with 503 and the error behind it', async () => {
    const app = await startApp(store('down'));
    try {
      await app.get('/api/runs');
      const response = await app.get('/api/storage');
      const body = (await response.json()) as {
        state: string;
        last_error: { code: string; message: string } | null;
      };

      expect(response.status).toBe(503);
      expect(body.state).toBe('unavailable');
      expect(body.last_error?.code).toBe('08006');
    } finally {
      await app.close();
    }
  });

  it('answers a healthy store with 200', async () => {
    const app = await startApp(store('rows'));
    try {
      await app.get('/api/runs');
      const response = await app.get('/api/storage');
      const body = (await response.json()) as { state: string; content: string };

      expect(response.status).toBe(200);
      expect(body.state).toBe('ok');
      expect(body.content).toBe('populated');
    } finally {
      await app.close();
    }
  });

  it('answers an empty store with 200 and reports it as reachable but empty', async () => {
    const app = await startApp(store('empty'));
    try {
      await app.get('/api/runs');
      const response = await app.get('/api/storage');
      const body = (await response.json()) as {
        state: string;
        content: string;
        empty_routes: string[];
        last_error: unknown;
      };

      // The state the app was actually in, and could not say: answering, and
      // holding nothing. Not a 503, and no error to report, because there was
      // no error: the browser needs both facts to word this correctly.
      expect(response.status).toBe(200);
      expect(body.state).toBe('ok');
      expect(body.content).toBe('empty');
      expect(body.empty_routes).toContain('GET /api/runs');
      expect(body.last_error).toBeNull();
    } finally {
      await app.close();
    }
  });
});

/**
 * Two routes that used `safeQuery` and then contradicted its contract.
 */
describe('a write is not confirmed unless something stored it', () => {
  it('refuses feedback rather than answering 201 for a row that was never written', async () => {
    const app = await startApp(store('down'));
    try {
      const response = await app.post('/api/feedback', { messageId: 'msg-1', sentiment: 'up' });
      const body = (await response.json()) as { error: string; message: string };

      // A thumbs-up confirmed during a demo and lost is worse than one that
      // failed visibly: the feedback counts are computed from this table.
      expect(response.status).toBe(503);
      expect(body.error).toBe('feedback_not_recorded');
      expect(response.headers.get('x-pia-storage')).toBe('unavailable');
      expect(response.headers.get('x-pia-degraded-reason')).toBe('storage_unavailable');
    } finally {
      await app.close();
    }
  });

  it('still confirms feedback the store accepted', async () => {
    const empty = store('empty');
    const app = await startApp({
      query(sql: string, params?: unknown[]) {
        if (/INSERT INTO player_insights\.feedback/i.test(sql)) {
          return Promise.resolve({ rows: [{ id: typeof params?.[0] === 'string' ? params[0] : '' }] });
        }
        return empty.query();
      },
    });
    try {
      const response = await app.post('/api/feedback', { messageId: 'msg-1', sentiment: 'up' });
      const body = (await response.json()) as { messageId: string; sentiment: string; comment: null };

      // The ownership-checked INSERT returns the row it accepted. No returned
      // row is intentionally the indistinguishable missing/other-owner case.
      expect(response.status).toBe(201);
      expect(body).toEqual(expect.objectContaining({ messageId: 'msg-1', sentiment: 'up', comment: null }));
      expect(body).not.toHaveProperty('usefulness');
      expect(response.headers.get('x-pia-data-origin')).toBe('lakebase');
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/conversations/:id/attachments', () => {
  it('does not report an outage as a conversation with no documents', async () => {
    const app = await startApp(store('down'));
    try {
      const response = await app.get('/api/conversations/conv-1/attachments');
      const body = (await response.json()) as { error: string };

      // `200 []` with no headers was indistinguishable from an empty
      // conversation, so the composer showed no chips and the user had no way to
      // know their uploaded report was simply unreadable.
      expect(response.status).toBe(503);
      expect(body.error).toBe('attachments_unavailable');
      expect(response.headers.get('x-pia-storage')).toBe('unavailable');
      expect(response.headers.get('x-pia-degraded-reason')).toBe('storage_unavailable');
    } finally {
      await app.close();
    }
  });

  it('answers a conversation that really has none with an empty list', async () => {
    const app = await startApp(store('empty'));
    try {
      const response = await app.get('/api/conversations/conv-1/attachments');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      // Nothing was substituted: there are no representative attachments, and
      // this is the store's own answer.
      expect(response.headers.get('x-pia-data-origin')).toBe('lakebase');
      expect(response.headers.get('x-pia-degraded-reason')).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/runs/:id/trace', () => {
  it('still refuses to report an outage as a missing run', async () => {
    // The convention this whole change follows, re-asserted here so a future
    // edit cannot quietly route this endpoint through the degrading helper.
    const app = await startApp(store('down'));
    try {
      const response = await app.get('/api/runs/msg-not-a-fallback-row/trace');
      const body = (await response.json()) as { kind: string; code: string; request_id: string };

      expect(response.status).toBe(503);
      // The shared terminal contract rather than this route's own error string,
      // so one outage reads the same way here as on Ask. See
      // shared/terminal-response.ts.
      expect(body.kind).toBe('unavailable');
      expect(body.code).toBe('PERSISTENCE_UNAVAILABLE');
      expect(body.request_id).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('does not answer a run nobody can read with a reference trace', async () => {
    const app = await startApp(store('down'));
    try {
      // A seeded run id, which used to be answered from the fixture during an
      // outage. The reader clicked a row and got stages that were never run.
      const response = await app.get('/api/runs/run-1042/trace');
      const body = (await response.json()) as { kind: string; stages?: unknown };

      expect(response.status).toBe(503);
      expect(body.kind).toBe('unavailable');
      expect(body.stages).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
