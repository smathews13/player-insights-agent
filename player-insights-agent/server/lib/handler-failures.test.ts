import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Application } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerRatherThanExit, respondToHandlerFailures } from './handler-failures';

/**
 * What happens to the rest of the app when one handler throws.
 */

let rejections: unknown[];
let recordRejection: (reason: unknown) => void;

beforeEach(() => {
  rejections = [];
  recordRejection = (reason: unknown) => void rejections.push(reason);
  process.on('unhandledRejection', recordRejection);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.off('unhandledRejection', recordRejection);
  vi.restoreAllMocks();
});

async function serve(register: (app: Application) => void) {
  const app = express();
  answerRatherThanExit(app);
  register(app);
  respondToHandlerFailures(app);
  const server: Server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    /** Bounded, because the failure being tested for is no answer rather than a wrong one. */
    fetch: (path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('a route handler that throws', () => {
  it('is answered 500, and does not leave a rejection for Node to exit on', async () => {
    const app = await serve((express) => {
      express.get('/api/throws', async () => {
        await Promise.resolve();
        throw new Error('the store went away mid-handler');
      });
    });

    try {
      const response = await app.fetch('/api/throws');

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: 'request_failed' });
    } finally {
      await app.close();
    }

    expect(rejections).toEqual([]);
  });

  it('is answered 500 when it throws before its first await, too', async () => {
    const app = await serve((express) => {
      express.get('/api/throws-sync', (_req, _res) => {
        throw new Error('a bad assumption about the request');
      });
    });

    try {
      expect((await app.fetch('/api/throws-sync')).status).toBe(500);
    } finally {
      await app.close();
    }

    expect(rejections).toEqual([]);
  });

  it('takes nothing away from the requests around it', async () => {
    const app = await serve((express) => {
      express.get('/api/throws', () => Promise.reject(new Error('gone')));
      express.get('/api/works', (_req, res) => void res.json({ ok: true }));
    });

    try {
      // The point of answering rather than exiting: the next request still lands.
      expect((await app.fetch('/api/throws')).status).toBe(500);
      const after = await app.fetch('/api/works');
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }

    expect(rejections).toEqual([]);
  });

  it('does not report a failure the handler already answered', async () => {
    const app = await serve((express) => {
      // The shape most handlers here have: they catch their own failures and say
      // something specific about them. The guard must not second-guess that.
      express.get('/api/handled', async (_req, res) => {
        try {
          await Promise.reject(new Error('lakebase is down'));
        } catch {
          res.status(503).json({ error: 'storage_unavailable' });
        }
      });
    });

    try {
      const response = await app.fetch('/api/handled');
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'storage_unavailable' });
    } finally {
      await app.close();
    }
  });
});

describe('what the guard leaves alone', () => {
  it('keeps app.get working as the settings reader', () => {
    const app = express();
    app.set('trust proxy', 1);
    answerRatherThanExit(app);

    // `app.get(name)` with one string argument reads a setting rather than
    // registering a route. Wrapping arguments blindly would break it, and it is
    // how AppKit and Express itself read their own configuration.
    expect(app.get('trust proxy')).toBe(1);
  });

  it('keeps a mounted router mounted', async () => {
    const router = express.Router();
    router.get('/inside', (_req, res) => void res.json({ mounted: true }));
    const app = await serve((express) => void express.use('/api/nested', router));

    try {
      const response = await app.fetch('/api/nested/inside');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mounted: true });
    } finally {
      await app.close();
    }
  });
});
