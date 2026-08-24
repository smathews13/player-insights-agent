import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { schemaStatements, setupInsightsRoutes, type InsightsAppKit } from './insights-routes';
import { resetLakebaseHealth, stopLakebaseWatchdog } from '../lib/lakebase-store';
import { schemaOwnershipQuery } from '../lib/schema-ownership-guard';

/**
 * That the app answers before it has finished creating its own schema.
 *
 * WHY THIS IS A TEST AND NOT A NOTE. AppKit does not begin listening until the
 * `onPluginsReady` callback resolves, so anything awaited on that path is time
 * the container answers nothing at all: not the health check, not readiness, not
 * a redeploy's first request. The schema pass is 20-odd DDL statements against
 * Lakebase and takes 0.5-2s cold, longer on a first deploy.
 *
 * The failure mode is the reason this cannot be left to review. On a laptop the
 * store is warm and local, the pass takes milliseconds, and a boot that blocks on
 * it looks instant. The same code in the workspace holds the port closed long
 * enough for a platform health check to decide the container is not up. So the
 * property is asserted against a schema pass that has not finished AT ALL, which
 * no amount of local speed can fake.
 */

/** A schema pass that does not finish until the case lets it. */
function gatedStore() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ddl = new Set(schemaStatements);
  const attempted: string[] = [];
  const completed: string[] = [];
  return {
    attempted,
    completed,
    release,
    lakebase: {
      async query(text: string) {
        if (text === schemaOwnershipQuery()) {
          return {
            rows: [{ schema_exists: false, owner: '', connected_role: 'a-test', connected_role_holds_owner: false }],
          };
        }
        if (ddl.has(text)) {
          attempted.push(text);
          await gate;
          completed.push(text);
          return { rows: [] as Record<string, unknown>[] };
        }
        // Everything that is not the schema pass answers immediately, which is
        // what makes the assertion below about the pass rather than about the
        // store being slow in general.
        return { rows: [] as Record<string, unknown>[] };
      },
    },
  };
}

let server: Server | null = null;

beforeEach(() => {
  resetLakebaseHealth();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  stopLakebaseWatchdog();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  vi.restoreAllMocks();
});

describe('boot does not wait for the schema before it serves', () => {
  it('registers routes and answers a request while the schema pass is still running', async () => {
    const store = gatedStore();
    const app = express();
    app.use(express.json());

    const { storeReady } = await setupInsightsRoutes({
      lakebase: store.lakebase,
      server: { extend: (fn: (target: typeof app) => void) => fn(app) },
      servingTransport: () => Promise.reject(new Error('not used')),
    } as unknown as InsightsAppKit);

    // The claim, in the only form that matters: setup has RESOLVED -- which is
    // when AppKit would open the port -- and not one schema statement has
    // finished. Before this change setup could not return until all of them had.
    // Not one statement has even been ATTEMPTED yet, in fact: the pass has to
    // ask who owns the schema first, and setup returned without waiting for the
    // answer to that either.
    expect(store.completed).toEqual([]);

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/identity`, {
      headers: { 'x-forwarded-email': 'an.admin@example.test' },
    });

    // Answered, with the schema pass still blocked behind the gate.
    expect(response.status).toBe(200);
    expect(store.completed).toEqual([]);

    store.release();
    await storeReady;

    // And the pass did run to completion rather than being dropped: a
    // non-blocking boot that quietly skipped the DDL would satisfy everything
    // above and leave the app with no tables.
    expect(store.completed).toEqual([...schemaStatements]);
  });

  it('holds only role-bearing requests until the roster bootstrap settles', async () => {
    const store = gatedStore();
    const app = express();
    app.use(express.json());
    let releaseRoles!: () => void;
    const rolesReady = new Promise<void>((resolve) => {
      releaseRoles = resolve;
    });

    const { storeReady } = await setupInsightsRoutes(
      {
        lakebase: store.lakebase,
        server: { extend: (fn: (target: typeof app) => void) => fn(app) },
        servingTransport: () => Promise.reject(new Error('not used')),
      } as unknown as InsightsAppKit,
      { rolesReady: () => rolesReady }
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const headers = { 'x-forwarded-email': 'an.admin@example.test' };

    const adminResponse = fetch(`http://127.0.0.1:${port}/api/admins`, { headers });
    const beforeRoles = await Promise.race([
      adminResponse.then(() => 'answered'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(beforeRoles).toBe('pending');

    // Consumer and health-adjacent routes remain available while only the role
    // decision waits. This is the distinction the old boot-wide await erased.
    expect((await fetch(`http://127.0.0.1:${port}/api/identity`, { headers })).status).toBe(200);

    releaseRoles();
    // The empty fixture roster denies. Waiting never turns "not resolved yet"
    // into authorization, and the actual role guard still makes the decision.
    expect((await adminResponse).status).toBe(403);

    store.release();
    await storeReady;
  });
});
