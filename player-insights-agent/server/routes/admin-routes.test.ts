/**
 * The admin surfaces, from the outside: who is refused, and what an add actually does.
 *
 * The refusal is asserted over the prefix list rather than over a hand-written set
 * of paths, so a family added later is covered by this file without anybody
 * remembering to add a case. That is the same reason the guard is a prefix
 * middleware rather than a wrapper per handler: the handler somebody forgets to
 * wrap is the one that serves everybody.
 *
 * The add path is asserted end to end because its two halves can disagree, and
 * every way of hiding that is a defect: a 201 that means "role granted, access
 * refused" has to say so, the row has to still be there, and the statement a human
 * with authority runs has to be on the response.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupAdminRoutes } from './admin-routes';
import { userEmail, type InsightsAppKit } from './insights-routes';
import {
  ADMIN_ROUTE_PREFIXES,
  announceSeedAdmins,
  requireAdmin,
  type AdminStore,
} from '../lib/admin-roles';
import { TELEMETRY_SCHEMA_ENV } from '../lib/admin-access';
import { ADDED_ADMINS_TABLE, ADMIN_AUDIT_TABLE, ADMIN_GRANTS_TABLE } from '../lib/admin-roles-schema';

const BOSS = 'boss@example.com';
const NEWCOMER = 'newcomer@example.com';
const CONSUMER = 'consumer@example.com';
const TELEMETRY = 'example_catalog.player_insights_telemetry';

interface Rows {
  admins: { email: string; added_by: string; added_at: string }[];
  audit: { actor: string; action: string; subject: string; detail: string }[];
  grants: { email: string; target: string; object: string; privilege: string; provenance: string }[];
}

/** Enough Lakebase for the three tables this family writes, so the real SQL runs. */
function fakeLakebase(): AdminStore & { rows: Rows } {
  const rows: Rows = { admins: [], audit: [], grants: [] };
  return {
    rows,
    query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      const values = params as string[];
      if (sql.includes(ADDED_ADMINS_TABLE)) {
        if (sql.startsWith('INSERT')) {
          if (rows.admins.some((row) => row.email === values[0])) return Promise.resolve({ rows: [] });
          rows.admins.push({ email: values[0], added_by: values[1], added_at: '2026-08-15T00:00:00.000Z' });
          return Promise.resolve({ rows: [{ email: values[0] }] });
        }
        if (sql.startsWith('DELETE')) {
          const at = rows.admins.findIndex((row) => row.email === values[0]);
          if (at < 0) return Promise.resolve({ rows: [] });
          rows.admins.splice(at, 1);
          return Promise.resolve({ rows: [{ email: values[0] }] });
        }
        return Promise.resolve({ rows: rows.admins as unknown as Record<string, unknown>[] });
      }
      if (sql.includes(ADMIN_AUDIT_TABLE)) {
        rows.audit.push({ actor: values[1], action: values[2], subject: values[3], detail: values[4] });
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes(ADMIN_GRANTS_TABLE)) {
        if (sql.startsWith('INSERT')) {
          const row = {
            email: values[0],
            target: values[1],
            object: values[2],
            privilege: values[3],
            provenance: values[4],
          };
          const at = rows.grants.findIndex(
            (existing) =>
              existing.email === row.email && existing.object === row.object && existing.privilege === row.privilege
          );
          if (at >= 0) rows.grants[at] = row;
          else rows.grants.push(row);
          return Promise.resolve({ rows: [] });
        }
        if (sql.startsWith('DELETE')) {
          const at = rows.grants.findIndex(
            (row) => row.email === values[0] && row.object === values[1] && row.privilege === values[2]
          );
          if (at >= 0) rows.grants.splice(at, 1);
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({
          rows: rows.grants.filter((row) => row.email === values[0]) as unknown as Record<string, unknown>[],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

/** One SQL Statement Execution response, in the shape the runner reads. */
function statementResponse(body: Record<string, unknown>, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const SUCCEEDED = statementResponse({ status: { state: 'SUCCEEDED' }, result: { data_array: [] } });
const REFUSED = statementResponse({ message: 'PERMISSION_DENIED: User is not an owner of Schema' }, 403);

/**
 * Every statement the app ran, with the bearer token it presented.
 *
 * The token is recorded because it is the security property of this whole
 * mechanism: a grant made under the app's own credential would be a way to hand
 * out Unity Catalog privileges from inside the app, and the tests below assert it
 * is the signed-in admin's token instead.
 */
function stubStatements(respond: (statement: string) => Response) {
  const calls: { statement: string; token: string }[] = [];
  // Everything that is not the Statement Execution API goes to the real fetch,
  // because the test client below reaches the app over one. A stub that swallowed
  // every call would replace the thing under test with itself.
  const realFetch = globalThis.fetch;
  const fetchStub = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (!target.includes('/api/2.0/sql/statements')) return realFetch(url, init);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { statement?: string };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ statement: body.statement ?? '', token: headers.authorization ?? '' });
    return Promise.resolve(respond(body.statement ?? ''));
  });
  vi.stubGlobal('fetch', fetchStub);
  return calls;
}

let server: Server | undefined;

async function startApp(store: AdminStore) {
  const app = express();
  app.use(express.json());
  const appkit = { lakebase: store, server: { extend: (fn: (a: express.Application) => void) => fn(app) } };
  // The same order server.ts uses. Registered first, the routes below would serve
  // the admin list to every consumer who asked for it.
  app.use(requireAdmin(store, userEmail));
  setupAdminRoutes(appkit as unknown as InsightsAppKit);

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server?.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const headers = (email: string, token: string | null = 'forwarded-user-token') => ({
    'content-type': 'application/json',
    'x-forwarded-email': email,
    ...(token ? { 'x-forwarded-access-token': token } : {}),
  });

  return {
    get: (email: string) => fetch(`${base}/api/admins`, { headers: headers(email) }),
    add: (email: string, target: string, token?: string | null) =>
      fetch(`${base}/api/admins`, {
        method: 'POST',
        headers: headers(email, token === undefined ? 'forwarded-user-token' : token),
        body: JSON.stringify({ email: target }),
      }),
    remove: (email: string, target: string) =>
      fetch(`${base}/api/admins/${encodeURIComponent(target)}`, { method: 'DELETE', headers: headers(email) }),
    reconcile: (email: string) => fetch(`${base}/api/admins/access`, { method: 'POST', headers: headers(email) }),
    probe: (path: string, email: string) => fetch(`${base}${path}`, { headers: headers(email) }),
  };
}

beforeEach(() => {
  process.env.DATABRICKS_HOST = 'https://workspace.example.com';
  process.env.DATABRICKS_SQL_WAREHOUSE_ID = 'wh-1';
  process.env[TELEMETRY_SCHEMA_ENV] = TELEMETRY;
  announceSeedAdmins(BOSS);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.DATABRICKS_SQL_WAREHOUSE_ID;
  delete process.env[TELEMETRY_SCHEMA_ENV];
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

describe('a consumer is refused at the route', () => {
  it.each(ADMIN_ROUTE_PREFIXES)('answers 403 on %s', async (prefix) => {
    const app = await startApp(fakeLakebase());

    const response = await app.probe(prefix, CONSUMER);

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe('admin_role_required');
    // It says the caller is not an administrator and nothing else. A refusal that
    // describes the thing behind it is a directory of the things worth asking for.
    expect(body.detail).not.toContain('telemetry');
    expect(body.detail).not.toContain(BOSS);
  });

  it('refuses a path under an admin prefix as well as the prefix itself', async () => {
    const app = await startApp(fakeLakebase());

    expect((await app.probe('/api/ops/cost', CONSUMER)).status).toBe(403);
    expect((await app.probe('/api/monitoring/runs', CONSUMER)).status).toBe(403);
  });

  it('leaves a consumer-visible path alone', async () => {
    // `GET /api/settings` is the Connections page's read endpoint, and it is one
    // of the diagnostics that has to keep answering when the rest is refusing.
    // Mutating Connections routes are admin-only (asserted below).
    const app = await startApp(fakeLakebase());

    expect((await app.probe('/api/settings', CONSUMER)).status).not.toBe(403);
  });

  it('refuses a consumer on Connections mutations and Apply', async () => {
    const app = await startApp(fakeLakebase());

    expect((await app.probe('/api/settings/values/sql-warehouse', CONSUMER)).status).toBe(403);
    expect((await app.probe('/api/settings/connections', CONSUMER)).status).toBe(403);
    expect((await app.probe('/api/settings/apply', CONSUMER)).status).toBe(403);
  });
});

describe('reading the list', () => {
  it('shows a seed row as not removable, and runs no statement to do it', async () => {
    const calls = stubStatements(() => SUCCEEDED);
    const app = await startApp(fakeLakebase());

    const body = (await (await app.get(BOSS)).json()) as {
      entries: { email: string; origin: string; removable: boolean }[];
      access: unknown[];
    };

    expect(body.entries).toEqual([
      { email: BOSS, origin: 'seed', addedBy: '', addedAt: '', isYou: true, removable: false },
    ]);
    // A pure read. The list appears without waiting on a warehouse that may be
    // cold, and a page load makes no Unity Catalog change.
    expect(calls).toHaveLength(0);
    expect(body.access).toEqual([]);
  });
});

describe('adding an administrator', () => {
  it('grants the access the role needs, under the acting admin\u2019s own token', async () => {
    const calls = stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);

    const response = await app.add(BOSS, NEWCOMER);
    const body = (await response.json()) as { access: { email: string; results: { target: string; state: string }[] }[] };

    expect(response.status).toBe(201);
    expect(body.access[0].email).toBe(NEWCOMER);
    expect(body.access[0].results.map((result) => result.state)).toEqual(['granted', 'granted']);
    // THE SECURITY PROPERTY. Never the app's own credential: the admin list is
    // edited inside the app by admins the app appointed, so an app-authority grant
    // would widen real access with no Unity Catalog decision by anybody who holds
    // authority over the object.
    expect(calls.every((call) => call.token === 'Bearer forwarded-user-token')).toBe(true);
    expect(calls.some((call) => call.statement.startsWith(`GRANT SELECT ON SCHEMA`))).toBe(true);
  });

  it('keeps the role when the grant is refused, and says both halves', async () => {
    // The other order was considered and is worse: an add that rolled back on a
    // refused grant would stop an admin without Unity Catalog authority from ever
    // appointing anybody, on the one screen that exists to appoint people.
    stubStatements((statement) => (statement.startsWith('SHOW GRANTS') ? SUCCEEDED : REFUSED));
    const store = fakeLakebase();
    const app = await startApp(store);

    const response = await app.add(BOSS, NEWCOMER);
    const body = (await response.json()) as {
      entries: { email: string }[];
      access: { results: { state: string; grant: { object: string; privilege: string; statement: string } | null }[] }[];
    };

    expect(response.status).toBe(201);
    expect(body.entries.map((entry) => entry.email)).toContain(NEWCOMER);
    expect(store.rows.admins.map((row) => row.email)).toContain(NEWCOMER);
    const refused = body.access[0].results.filter((result) => result.state === 'refused');
    expect(refused).toHaveLength(2);
    // The object, the privilege, and a statement somebody with authority can run.
    for (const result of refused) {
      expect(result.grant?.object).toBeTruthy();
      expect(result.grant?.privilege).toBe('SELECT');
      expect(result.grant?.statement).toContain('GRANT');
    }
  });

  it('records the refusal in the audit trail as loudly as a success', async () => {
    // An audit trail that records only what worked answers "who was given access"
    // and cannot answer "who was supposed to have it and does not", which is the
    // question somebody asks when a page is empty.
    stubStatements((statement) => (statement.startsWith('SHOW GRANTS') ? SUCCEEDED : REFUSED));
    const store = fakeLakebase();
    const app = await startApp(store);

    await app.add(BOSS, NEWCOMER);

    expect(store.rows.audit.map((row) => row.action)).toEqual([
      'admin-added',
      'access-refused',
      'access-refused',
    ]);
    expect(store.rows.audit.every((row) => row.actor === BOSS && row.subject === NEWCOMER)).toBe(true);
  });

  it('adds the administrator and reports the access as not checked when there is no warehouse', async () => {
    // Not checked means not checked YET. A missing warehouse is not a permission
    // decision and must not read as one.
    delete process.env.DATABRICKS_SQL_WAREHOUSE_ID;
    const calls = stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);

    const body = (await (await app.add(BOSS, NEWCOMER)).json()) as {
      access: { results: { state: string; grant: unknown }[] }[];
    };

    expect(store.rows.admins.map((row) => row.email)).toContain(NEWCOMER);
    expect(body.access[0].results.every((result) => result.state === 'not-checked')).toBe(true);
    expect(body.access[0].results.every((result) => result.grant === null)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('never falls back to the app\u2019s own credential when no user token is forwarded', async () => {
    const calls = stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);

    const body = (await (await app.add(BOSS, NEWCOMER, null)).json()) as {
      access: { results: { state: string; summary: string }[] }[];
    };

    expect(calls).toHaveLength(0);
    expect(body.access[0].results.every((result) => result.state === 'not-checked')).toBe(true);
    expect(body.access[0].results[0].summary).toContain('forwarded sign-in token');
  });

  it('refuses an address already set at deployment', async () => {
    const app = await startApp(fakeLakebase());

    const response = await app.add(BOSS, BOSS);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('already_an_admin');
  });
});

describe('removing an administrator', () => {
  it('takes back only what the app granted', async () => {
    const store = fakeLakebase();
    const app = await startApp(store);
    // Two privileges on the record: one this app added, one the person already had.
    store.rows.admins.push({ email: NEWCOMER, added_by: BOSS, added_at: '2026-08-15T00:00:00.000Z' });
    store.rows.grants.push(
      { email: NEWCOMER, target: 'telemetry', object: TELEMETRY, privilege: 'SELECT', provenance: 'app-granted' },
      { email: NEWCOMER, target: 'billing', object: 'system.billing.usage', privilege: 'SELECT', provenance: 'pre-existing' }
    );
    const calls = stubStatements(() => SUCCEEDED);

    const response = await app.remove(BOSS, NEWCOMER);

    expect(response.status).toBe(200);
    const revokes = calls.filter((call) => call.statement.startsWith('REVOKE'));
    expect(revokes).toHaveLength(1);
    expect(revokes[0].statement).toContain('`example_catalog`.`player_insights_telemetry`');
    // The one it did not grant is untouched, and the claim survives as the record
    // of that decision.
    expect(store.rows.grants.map((row) => row.provenance)).toEqual(['pre-existing']);
  });

  it('revokes nothing when the app can show it granted nothing', async () => {
    const store = fakeLakebase();
    const app = await startApp(store);
    store.rows.admins.push({ email: NEWCOMER, added_by: BOSS, added_at: '2026-08-15T00:00:00.000Z' });
    const calls = stubStatements(() => SUCCEEDED);

    const body = (await (await app.remove(BOSS, NEWCOMER)).json()) as {
      access: { results: { summary: string }[] }[];
    };

    expect(calls.filter((call) => call.statement.startsWith('REVOKE'))).toHaveLength(0);
    expect(body.access[0].results[0].summary).toContain('No access to take away');
  });

  it('refuses to remove a seed row, because that would leave them an administrator', async () => {
    const app = await startApp(fakeLakebase());

    const response = await app.remove(BOSS, BOSS);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('removal_refused_seed_row');
  });
});

describe('reconciling on the editor\u2019s load', () => {
  it('grants a seed administrator the access they never asked for', async () => {
    // Seed admins come from bundle configuration and never pass through the Add
    // button, so without this they hold the role and none of the access.
    const calls = stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);

    const body = (await (await app.reconcile(BOSS)).json()) as {
      access: { email: string; results: { state: string }[] }[];
    };

    expect(body.access.map((report) => report.email)).toEqual([BOSS]);
    expect(body.access[0].results.every((result) => result.state === 'granted')).toBe(true);
    expect(calls.some((call) => call.statement.startsWith('GRANT'))).toBe(true);
    expect(store.rows.audit.map((row) => row.action)).toContain('access-reconciled');
  });

  it('writes no audit row on a load that changed nothing', async () => {
    // Idempotent, so it runs on every load. A row per load would fill the table
    // with the fact that somebody opened a page.
    stubStatements((statement) =>
      statement.startsWith('SHOW GRANTS')
        ? statementResponse({ status: { state: 'SUCCEEDED' }, result: { data_array: [[BOSS, 'ALL PRIVILEGES']] } })
        : SUCCEEDED
    );
    const store = fakeLakebase();
    const app = await startApp(store);

    const body = (await (await app.reconcile(BOSS)).json()) as { access: { results: { state: string }[] }[] };

    expect(body.access[0].results.every((result) => result.state === 'already-held')).toBe(true);
    expect(store.rows.audit).toHaveLength(0);
  });
});
