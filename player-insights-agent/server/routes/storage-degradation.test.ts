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
  const server: Server = app.listen(0);
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

afterEach(() => vi.restoreAllMocks());

describe('serving representative rows for stored ones', () => {
  it('labels the response and shouts in the logs when the store is unreachable', async () => {
    const app = await startApp(store('down'));
    try {
      const response = await app.get('/api/runs');
      const body = (await response.json()) as { id: string }[];

      // The fallback itself is intended; a reviewer being unable to see it is not.
      expect(response.status).toBe(200);
      expect(body.map((run) => run.id)).toEqual(['run-1042', 'run-1041', 'run-1040']);
      expect(response.headers.get('x-pia-storage')).toBe('unavailable');
      expect(response.headers.get('x-pia-data-origin')).toBe('representative');
      expect(response.headers.get('x-pia-degraded-reason')).toBe('storage_unavailable');
      expect(errors.some((line) => line.includes('SERVING REPRESENTATIVE DATA on GET /api/runs'))).toBe(true);
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

      // Still representative rows, because an empty POC database should stay
      // explorable, but declared as such, and not called an outage.
      expect(response.status).toBe(200);
      expect(response.headers.get('x-pia-data-origin')).toBe('representative');
      expect(response.headers.get('x-pia-degraded-reason')).toBe('storage_empty');
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
        substitutions_while_unavailable: number;
      };

      expect(response.status).toBe(503);
      expect(body.state).toBe('unavailable');
      expect(body.last_error?.code).toBe('08006');
      expect(body.substitutions_while_unavailable).toBe(1);
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
      const response = await app.post('/api/feedback', { messageId: 'msg-1', usefulness: 5 });
      const body = (await response.json()) as { error: string; message: string };

      // A thumbs-up confirmed during a demo and lost is worse than one that
      // failed visibly: the usefulness figure is computed from this table.
      expect(response.status).toBe(503);
      expect(body.error).toBe('feedback_not_recorded');
      expect(response.headers.get('x-pia-storage')).toBe('unavailable');
      expect(response.headers.get('x-pia-degraded-reason')).toBe('storage_unavailable');
    } finally {
      await app.close();
    }
  });

  it('still confirms feedback the store accepted', async () => {
    const app = await startApp(store('empty'));
    try {
      const response = await app.post('/api/feedback', { messageId: 'msg-1', usefulness: 5 });
      const body = (await response.json()) as { messageId: string; usefulness: number };

      // An INSERT returns no rows on success, so "no rows" must not be read here
      // as "nothing happened".
      expect(response.status).toBe(201);
      expect(body).toMatchObject({ messageId: 'msg-1', usefulness: 5 });
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
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(503);
      expect(body.error).toBe('run_trace_unavailable');
    } finally {
      await app.close();
    }
  });
});
