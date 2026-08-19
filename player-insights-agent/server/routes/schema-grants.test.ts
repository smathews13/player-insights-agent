import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, schemaStatements, setupInsightsRoutes, type InsightsAppKit } from './insights-routes';
import { chooseRows, lakebaseHealth, readStored, resetLakebaseHealth } from '../lib/lakebase-store';
import { GRANT_HOOK_PATH } from '../../shared/setup-remedies';

/**
 * The setup step a customer's first deploy skips, and how loudly it is now said.
 *
 * The release hook runs `scripts/grant-app-db-access.mjs` after the app has
 * been created: the app's service principal does not exist until the app does,
 * so no bundle resource can grant to it. Skipping it left the app
 * answering HTTP 200 with seeded conversations and runs, and the only thing
 * distinguishing that from a working deployment was a banner saying "Lakebase
 * is unreachable", which is not what is happening, sends the deployer to the
 * Lakebase console to look at a healthy endpoint, and never mentions the
 * script.
 */

/** What Postgres says when the grant was never made. */
function permissionDenied(message = 'permission denied for schema player_insights') {
  const error = new Error(message) as Error & { code?: string };
  error.code = '42501';
  return error;
}

/** And what it says when the endpoint is simply not there. */
function connectionLost() {
  const error = new Error('Connection terminated unexpectedly') as Error & { code?: string };
  error.code = '08006';
  return error;
}

/** The `lakebase` client itself, shaped as `InsightsAppKit` expects it. */
function store(answer: (sql: string) => Record<string, unknown>[] | Error): InsightsAppKit['lakebase'] {
  return {
    query(text: string) {
      const outcome = answer(text);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve({ rows: outcome });
    },
  };
}

/** The same client wrapped as `readStored` takes it, which is one level up. */
function reader(lakebase: InsightsAppKit['lakebase']) {
  return { lakebase };
}

/**
 * A database the app can reach and is not allowed to read.
 */
function grantsNeverRun() {
  return store((sql) => (/player_insights/i.test(sql) ? permissionDenied() : [{ '?column?': 1 }]));
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
    get: (path: string) => fetch(`http://127.0.0.1:${port}${path}`),
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

describe('a refused read is not an outage', () => {
  it('records the refusal as a missing grant rather than as an unreachable store', async () => {
    const read = await readStored(reader(grantsNeverRun()), 'GET /api/runs', 'SELECT id FROM player_insights.messages');

    expect(read.available).toBe(false);
    const health = lakebaseHealth();
    // Both are true and they are not the same fact. `state` says reads are not
    // working; `access` says why, and it is the half that decides what anyone
    // should do about it.
    expect(health.state).toBe('unavailable');
    expect(health.access).toBe('denied');
  });

  it('leaves a genuine connection failure diagnosed as a connection failure', async () => {
    // The guard on the case above. A diagnosis that fires for every failure is
    // worth nothing, and telling somebody whose Lakebase endpoint has stopped
    // to go and run a grant script wastes the trust the specific message needs.
    await readStored(reader(store(() => connectionLost())), 'GET /api/runs', 'SELECT id FROM player_insights.messages');

    expect(lakebaseHealth().access).not.toBe('denied');
    expect(errors.some((line) => line.includes('STORAGE UNAVAILABLE'))).toBe(true);
    expect(errors.some((line) => line.includes('SCHEMA GRANTS MISSING'))).toBe(false);
  });

  it('does not read a privilege error on a bare connection check as a missing schema grant', async () => {
    // Depth is half the diagnosis. A role refused on `SELECT 1` cannot use the
    // database at all, which the grant script does not fix, pointing at it
    // would send the deployer to run something that cannot help.
    await readStored(reader(store(() => permissionDenied('permission denied for database'))), 'watchdog', 'SELECT 1');

    expect(lakebaseHealth().access).not.toBe('denied');
  });

  it('names the target-aware hook in the log line', async () => {
    await readStored(reader(grantsNeverRun()), 'GET /api/runs', 'SELECT id FROM player_insights.messages');

    const line = errors.find((entry) => entry.includes('SCHEMA GRANTS MISSING'));
    expect(line).toBeDefined();
    // The four words that decide whether anyone reads the rest.
    expect(line).toContain('was REFUSED by Postgres');
    expect(line).toContain('not an outage and waiting will not fix it');
    expect(line).toContain(GRANT_HOOK_PATH);
    expect(line).toContain('TARGET=<target>');
    expect(line).toContain("PROFILE='<profile>'");
  });

  it('marks the substituted rows with a reason a client can word correctly', async () => {
    const app = await startApp(grantsNeverRun());
    try {
      const response = await app.get('/api/runs');

      // 200 with an empty list rather than 200 with seeded rows. The rows were
      // gated on the demo setting, which is off here as it is on a customer
      // deployment, and the point this test defends is unchanged either way:
      // the REASON is `storage_grants_missing` and not the generic outage.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      expect(response.headers.get('x-pia-data-origin')).toBe('none');
      // The header the outage case sets is `storage_unavailable`. This one is
      // its own value, because the browser cannot infer the remedy from a
      // reason that covers both and was writing the wrong banner from it.
      expect(response.headers.get('x-pia-degraded-reason')).toBe('storage_grants_missing');
    } finally {
      await app.close();
    }
  });

  it('says so on /api/storage, which is what the banner reads', async () => {
    const app = await startApp(grantsNeverRun());
    try {
      await app.get('/api/runs');
      const body = (await (await app.get('/api/storage')).json()) as { access: string; state: string };

      expect(body.state).toBe('unavailable');
      expect(body.access).toBe('denied');
    } finally {
      await app.close();
    }
  });
});

describe('the Sources page row for a deployment that skipped the grant', () => {
  it('gives the invocation rather than a suggestion to check the endpoint', async () => {
    const app = await startApp(grantsNeverRun());
    try {
      await app.get('/api/runs');
      const body = (await (await app.get('/api/preflight')).json()) as {
        checks?: { id: string; status: string; detail: string; remedy: { statement: string; note: string } | null }[];
      };
      const check = body.checks?.find((entry) => entry.id === 'lakebase-storage');

      expect(check?.status).toBe('failed');
      expect(check?.detail).toContain('Postgres is answering and REFUSING');
      // The sentence that stops the deployer waiting for it to clear.
      expect(check?.detail).toContain('not an outage that will pass');
      expect(check?.remedy?.statement).toContain('bundle/app-db-grant.sh');
      expect(check?.remedy?.statement).toContain('TARGET=<target>');
      expect(check?.remedy?.statement).toContain("PROFILE='<profile>'");
    } finally {
      await app.close();
    }
  });
});

describe('applying the schema against a database that refuses it', () => {
  it('calls it a refusal and points at the script, rather than reporting silence', async () => {
    // The first contact the app makes with Postgres, and therefore the earliest
    // this condition can be caught, near the top of a fresh deploy's log,
    // which is the only part of it anyone reads.
    const failures = await applySchema({ lakebase: store(() => permissionDenied()) } as InsightsAppKit);

    // Every statement, read off the list rather than written out: a workstream
    // that adds one should not have to discover that a case about privilege
    // denials fails on a count of statements.
    expect(failures).toHaveLength(schemaStatements.length);
    const summary = errors.find((line) => line.includes('SCHEMA SETUP REFUSED'));
    expect(summary).toBeDefined();
    expect(summary).toContain('refused by Postgres on privileges');
    expect(summary).toContain(GRANT_HOOK_PATH);
    // And not the other verdict, which describes a store that never answered.
    expect(errors.some((line) => line.includes('SCHEMA SETUP FAILED'))).toBe(false);
  });

  it('still calls an unanswered store a failure, not a refusal', async () => {
    await applySchema({ lakebase: store(() => connectionLost()) } as InsightsAppKit);

    expect(errors.some((line) => line.includes('SCHEMA SETUP FAILED'))).toBe(true);
    expect(errors.some((line) => line.includes('SCHEMA SETUP REFUSED'))).toBe(false);
  });

  it('does not print the grant remedy for the ownership no-op it fires on every healthy boot', async () => {
    // `ALTER TABLE ... IF NOT EXISTS` is refused at every boot on a database
    // where the tables are owned by whoever first created them, changes
    // nothing, and is harmless. Attaching the grant remedy to it would print
    // the script on every healthy start, and a remedy printed when nothing is
    // wrong is one nobody reads when something is.
    //
    // The SQLSTATE below is the whole difficulty and the reason this case
    // exists: Postgres reports ownership with 42501, the same code it uses for
    // a grant that was never made. An earlier version of this test built the
    // error without a code and passed while the deployed app printed the script
    // on every boot, so the fixture states the code Postgres actually sends.
    const owned = store((sql) =>
      /^ALTER TABLE/i.test(sql.trim()) ? permissionDenied('must be owner of table messages') : []
    );

    await applySchema({ lakebase: owned } as InsightsAppKit);

    const summary = errors.find((line) => line.includes('SCHEMA SETUP INCOMPLETE'));
    expect(summary).toBeDefined();
    expect(summary).not.toContain('privilege denial');
    expect(summary).not.toContain(GRANT_HOOK_PATH);
  });

  it('still names a real denial that arrives alongside the ownership no-op', async () => {
    // The carve-out above has to be narrow. On a database that has both (the
    // ownership ALTER that always fails, and one table the app was never
    // granted), the boot that matters would otherwise be indistinguishable from
    // the boot that is fine, because the loud half was filtered out with the
    // harmless half.
    const both = store((sql) => {
      if (/^ALTER TABLE/i.test(sql.trim())) return permissionDenied('must be owner of table messages');
      if (/feedback/i.test(sql)) return permissionDenied('permission denied for table feedback');
      return [];
    });

    await applySchema({ lakebase: both } as InsightsAppKit);

    const summary = errors.find((line) => line.includes('SCHEMA SETUP INCOMPLETE'));
    expect(summary).toContain('1 of those refusals is a privilege denial');
    expect(summary).toContain(GRANT_HOOK_PATH);
  });
});

describe('a deployment that did run the grant script', () => {
  it('says nothing at all', async () => {
    // The property the rest of this file depends on. Every message above is
    // only readable because a correctly configured deployment is silent: a
    // warning that is always on is furniture, and this is the test that keeps
    // it off.
    const healthy = store(() => [{ id: 'msg-1' }]);
    const read = await readStored(reader(healthy), 'GET /api/runs', 'SELECT id FROM player_insights.messages');
    const chosen = chooseRows('GET /api/runs', read);

    expect(chosen.substitution).toEqual({ reason: null, origin: 'lakebase' });
    expect(lakebaseHealth().access).toBe('ok');
    expect(errors).toEqual([]);
  });
});
