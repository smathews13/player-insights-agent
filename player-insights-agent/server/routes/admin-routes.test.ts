/**
 * The admin surfaces, from the outside: who is refused, and what an add actually does.
 *
 * The refusal is asserted over the prefix list rather than over a hand-written set
 * of paths, so a family added later is covered by this file without anybody
 * remembering to add a case. That is the same reason the guard is a prefix
 * middleware rather than a wrapper per handler: the handler somebody forgets to
 * wrap is the one that serves everybody.
 *
 * The add path is asserted end to end because it used to be two halves that could
 * disagree. It granted Unity Catalog read on the telemetry schema and the
 * `system.billing` tables as well as writing the role, and granting on `system`
 * needs an account admin who is also a metastore admin, so appointing a colleague
 * routinely answered 201 with PERMISSION_DENIED printed beside their name. The
 * tests below hold the fix: an add runs no statement, and no Unity Catalog answer
 * can stop somebody being made an administrator.
 */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupAdminRoutes } from './admin-routes';
import { userEmail, type InsightsAppKit } from './insights-routes';
import {
  ADMIN_ROUTE_PREFIXES,
  announceSeedAdmins,
  requireAdmin,
  SUPER_ADMIN_ROUTE_PREFIXES,
  type AdminStore,
} from '../lib/admin-roles';
import { ADDED_ADMINS_TABLE, ADMIN_AUDIT_TABLE, ADMIN_GRANTS_TABLE } from '../lib/admin-roles-schema';

const BOSS = 'boss@example.com';
const NEWCOMER = 'newcomer@example.com';
const CONSUMER = 'consumer@example.com';
const ACCESS_GUIDE_URL = new URL('../../../docs/Player_Insights_Agent_Access_Guide.md', import.meta.url);
const ACCESS_GUIDE = existsSync(ACCESS_GUIDE_URL) ? readFileSync(ACCESS_GUIDE_URL, 'utf8') : null;

function guideTextBlock(heading: string): string[] {
  if (ACCESS_GUIDE === null) throw new Error('The internal access guide is not published in this checkout.');
  const marker = `### ${heading}\n\n\`\`\`text\n`;
  const start = ACCESS_GUIDE.indexOf(marker);
  if (start < 0) throw new Error(`Access guide has no text block under "${heading}".`);
  const bodyStart = start + marker.length;
  const end = ACCESS_GUIDE.indexOf('\n```', bodyStart);
  if (end < 0) throw new Error(`Access guide has no closing fence under "${heading}".`);
  return ACCESS_GUIDE.slice(bodyStart, end).split('\n').filter(Boolean);
}
/**
 * A telemetry schema an earlier version of this app granted on.
 *
 * Invented, and `example_catalog` deliberately: the real name is a deployment's own
 * catalog, resolved at runtime, and a real one in a test file is a real one in the
 * published tree.
 */
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
    // The route that used to reconcile grants on every page load. Kept as a probe
    // so its absence is asserted rather than assumed.
    reconcile: (email: string) => fetch(`${base}/api/admins/access`, { method: 'POST', headers: headers(email) }),
    probe: (path: string, email: string) => fetch(`${base}${path}`, { headers: headers(email) }),
    probeWithMethod: (path: string, email: string, method: 'POST' | 'DELETE') =>
      fetch(`${base}${path}`, { method, headers: headers(email), body: method === 'POST' ? '{}' : undefined }),
  };
}

beforeEach(() => {
  process.env.DATABRICKS_HOST = 'https://workspace.example.com';
  process.env.DATABRICKS_SQL_WAREHOUSE_ID = 'wh-1';
  announceSeedAdmins(BOSS);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.DATABRICKS_SQL_WAREHOUSE_ID;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

describe('a consumer is refused at the route', () => {
  it.skipIf(ACCESS_GUIDE === null)('keeps the access guide aligned with authoritative role prefixes', () => {
    expect(guideTextBlock('Administrator route prefixes (enforced)')).toEqual(ADMIN_ROUTE_PREFIXES);
    expect(guideTextBlock('Super-administrator route prefixes (enforced)')).toEqual(SUPER_ADMIN_ROUTE_PREFIXES);
  });

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
    expect((await app.probe('/api/monitoring/feedback', CONSUMER)).status).toBe(403);
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

  it('keeps connection create/delete authorization aligned across all role levels', async () => {
    const admin = 'admin@example.com';
    const owner = 'owner@example.com';
    const superAdmin = 'super@example.com';
    announceSeedAdmins(`${admin} super:${owner} super:${superAdmin}`);
    const app = await startApp(fakeLakebase());

    for (const email of [admin, owner, superAdmin]) {
      expect((await app.probeWithMethod('/api/settings/connections', email, 'POST')).status).not.toBe(403);
      expect((await app.probeWithMethod('/api/settings/connections/batch', email, 'POST')).status).not.toBe(403);
      expect((await app.probeWithMethod('/api/settings/connections/resource-1', email, 'DELETE')).status).not.toBe(403);
    }
    expect((await app.probeWithMethod('/api/settings/connections', CONSUMER, 'POST')).status).toBe(403);
    expect((await app.probeWithMethod('/api/settings/connections/batch', CONSUMER, 'POST')).status).toBe(403);
    expect((await app.probeWithMethod('/api/settings/connections/resource-1', CONSUMER, 'DELETE')).status).toBe(403);
  });
});

describe('reading the list', () => {
  it('shows a seed row as not removable, and runs no statement to do it', async () => {
    const calls = stubStatements(() => SUCCEEDED);
    const app = await startApp(fakeLakebase());

    const body = (await (await app.get(BOSS)).json()) as {
      entries: { email: string; origin: string; removable: boolean }[];
    };

    expect(body.entries).toEqual([
      { email: BOSS, origin: 'seed', addedBy: '', addedAt: '', isYou: true, removable: false },
    ]);
    // A pure read. The list appears without waiting on a warehouse that may be
    // cold, and a page load makes no Unity Catalog change.
    expect(calls).toHaveLength(0);
  });

  it('offers no Unity Catalog state to draw, on any row', async () => {
    // The Roles card is people and roles. A payload carrying grant state is how a
    // `system.billing` refusal got onto a screen about who administers the app.
    stubStatements(() => SUCCEEDED);
    const app = await startApp(fakeLakebase());

    const body = (await (await app.get(BOSS)).json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty('access');
    expect(JSON.stringify(body)).not.toContain('billing');
  });

  it('shares one full-roster read between the guard and list handler', async () => {
    announceSeedAdmins('');
    const store = fakeLakebase();
    store.rows.admins.push({ email: BOSS, added_by: BOSS, added_at: '2026-08-15T00:00:00.000Z' });
    const query = vi.spyOn(store, 'query');
    const app = await startApp(store);

    expect((await app.get(BOSS)).status).toBe(200);

    const rosterReads = query.mock.calls.filter(
      ([sql]) => String(sql).trim().startsWith('SELECT') && String(sql).includes(ADDED_ADMINS_TABLE)
    );
    expect(rosterReads).toHaveLength(1);
  });
});

describe('adding an administrator', () => {
  it('writes the role and asks Unity Catalog for nothing at all', async () => {
    const calls = stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);

    const response = await app.add(BOSS, NEWCOMER);
    const body = (await response.json()) as { entries: { email: string }[] };

    expect(response.status).toBe(201);
    expect(body.entries.map((entry) => entry.email)).toContain(NEWCOMER);
    expect(store.rows.admins.map((row) => row.email)).toContain(NEWCOMER);
    // The whole of the fix. There is no grant to be refused, so there is no
    // PERMISSION_DENIED to print beside a person who was appointed successfully.
    expect(calls).toHaveLength(0);
  });

  /**
   * SAM'S REPORT, AS A TEST. The operator is not a metastore admin, so every
   * statement aimed at the `system` catalog is refused. Adding an administrator has
   * to work anyway: read access to the billing tables was never a condition of the
   * role, and the screen that appoints people must not report a refusal it did not
   * need to ask for.
   */
  it('succeeds for an operator who cannot grant on the system catalog', async () => {
    const calls = stubStatements(() => REFUSED);
    const store = fakeLakebase();
    const app = await startApp(store);

    const response = await app.add(BOSS, NEWCOMER);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(store.rows.admins.map((row) => row.email)).toContain(NEWCOMER);
    expect(calls).toHaveLength(0);
    // Nothing on the response for a screen to draw as a failed add.
    expect(JSON.stringify(body)).not.toContain('PERMISSION_DENIED');
    expect(JSON.stringify(body)).not.toContain('system');
    // And nothing in the audit trail claiming a grant was attempted.
    expect(store.rows.audit.map((row) => row.action)).toEqual(['admin-added']);
  });

  it('adds the administrator when there is no warehouse at all', async () => {
    // A deployment without a configured warehouse used to report the access as not
    // checked on every add. There is nothing to check.
    delete process.env.DATABRICKS_SQL_WAREHOUSE_ID;
    const calls = stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);

    const response = await app.add(BOSS, NEWCOMER);

    expect(response.status).toBe(201);
    expect(store.rows.admins.map((row) => row.email)).toContain(NEWCOMER);
    expect(calls).toHaveLength(0);
  });

  it('adds the administrator when no user token is forwarded', async () => {
    const calls = stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);

    const response = await app.add(BOSS, NEWCOMER, null);

    expect(response.status).toBe(201);
    expect(store.rows.admins.map((row) => row.email)).toContain(NEWCOMER);
    expect(calls).toHaveLength(0);
  });

  it('refuses an address already set at deployment', async () => {
    const app = await startApp(fakeLakebase());

    const response = await app.add(BOSS, BOSS);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('already_an_admin');
  });
});

describe('removing an administrator', () => {
  it('takes back only what an earlier version of the app granted', async () => {
    const store = fakeLakebase();
    const app = await startApp(store);
    // Two privileges on the record: one this app added, one the person already had.
    store.rows.admins.push({ email: NEWCOMER, added_by: BOSS, added_at: '2026-08-15T00:00:00.000Z' });
    store.rows.grants.push(
      { email: NEWCOMER, target: 'telemetry', object: TELEMETRY, privilege: 'SELECT', provenance: 'app-granted' },
      {
        email: NEWCOMER,
        target: 'billing',
        object: 'system.billing.usage',
        privilege: 'SELECT',
        provenance: 'pre-existing',
      }
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
    // Recorded in the audit trail, which is where it belongs. The Roles card says
    // the person is no longer an administrator and nothing about Unity Catalog.
    expect(store.rows.audit.map((row) => row.action)).toContain('access-revoked');
  });

  it('revokes nothing, and says nothing, when the app granted nothing', async () => {
    const store = fakeLakebase();
    const app = await startApp(store);
    store.rows.admins.push({ email: NEWCOMER, added_by: BOSS, added_at: '2026-08-15T00:00:00.000Z' });
    const calls = stubStatements(() => SUCCEEDED);

    const response = await app.remove(BOSS, NEWCOMER);

    expect(response.status).toBe(200);
    expect(calls.filter((call) => call.statement.startsWith('REVOKE'))).toHaveLength(0);
    // No audit row either. An action that changed no access should not leave a row
    // saying it considered changing some.
    expect(store.rows.audit.map((row) => row.action)).toEqual(['admin-removed']);
  });

  it('removes the administrator even when the revoke is refused', async () => {
    const store = fakeLakebase();
    const app = await startApp(store);
    store.rows.admins.push({ email: NEWCOMER, added_by: BOSS, added_at: '2026-08-15T00:00:00.000Z' });
    store.rows.grants.push({
      email: NEWCOMER,
      target: 'telemetry',
      object: TELEMETRY,
      privilege: 'SELECT',
      provenance: 'app-granted',
    });
    stubStatements(() => REFUSED);

    const response = await app.remove(BOSS, NEWCOMER);

    // Taking somebody off the list is the thing that was asked for. Handing back a
    // privilege is the tidying up, and a refusal there cannot keep them on it.
    expect(response.status).toBe(200);
    expect(store.rows.admins).toEqual([]);
    expect(store.rows.grants).toHaveLength(1);
  });

  it('refuses to remove a seed row, because that would leave them an administrator', async () => {
    const app = await startApp(fakeLakebase());

    const response = await app.remove(BOSS, BOSS);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('removal_refused_seed_row');
  });
});

describe('the route that used to grant on every page load', () => {
  /**
   * It reconciled Unity Catalog grants for everybody on the list whenever the card
   * was opened, so opening a settings page changed permissions and, on the ordinary
   * deployment, printed a refusal on `system.billing` for every administrator. It is
   * gone rather than quietened: a caller asking for it gets no answer.
   */
  it('is gone, and grants nothing on the way out', async () => {
    const calls = stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);

    expect((await app.reconcile(BOSS)).status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(store.rows.audit).toHaveLength(0);
  });
});
