/**
 * The roster over HTTP, and the refusal that is the whole feature.
 *
 * THE ENFORCEMENT TESTS ASSERT A REFUSED CALLER, NOT A HIDDEN CONTROL. A test that
 * checked the roster panel was not drawn for an administrator would pass on a
 * deployment where any administrator could appoint themselves super admin by
 * calling the endpoint, which is the failure this file exists to make impossible.
 *
 * Every address here is invented. The people this feature exists for are at a
 * customer domain, and a real address in a test file is a real address in the
 * published tree.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupUserRoutes } from './user-routes';
import { userEmail, type InsightsAppKit } from './insights-routes';
import { announceSeedAdmins, requireAdmin, requireSuperAdmin, type AdminStore } from '../lib/admin-roles';
import { ADDED_ADMINS_TABLE, ADMIN_AUDIT_TABLE, ADMIN_GRANTS_TABLE } from '../lib/admin-roles-schema';
import type { RosterPayload } from '../../shared/user-roster-contract';

const LEAD = 'lead@example.invalid';
const DEPUTY = 'deputy@example.invalid';
const ANALYST = 'analyst@example.invalid';
const STRANGER = 'stranger@example.invalid';
/** A schema an earlier version of this app granted on. Invented, as every name here is. */
const TELEMETRY = 'example_catalog.player_insights_telemetry';

interface Rows {
  roster: { email: string; role: string; added_by: string; added_at: string }[];
  audit: { actor: string; action: string; subject: string; detail: string }[];
  grants: { email: string; object: string; privilege: string; provenance: string }[];
}

/** Enough Lakebase for the three tables this family touches, so the real SQL runs. */
function fakeLakebase(seedRows: Rows['roster'] = []): AdminStore & { rows: Rows } {
  const rows: Rows = { roster: [...seedRows], audit: [], grants: [] };
  return {
    rows,
    query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      const values = params as string[];
      if (sql.includes(ADDED_ADMINS_TABLE)) {
        if (sql.startsWith('INSERT')) {
          const at = rows.roster.findIndex((row) => row.email === values[0]);
          const row = { email: values[0], role: values[1], added_by: values[2], added_at: '2026-08-17T00:00:00.000Z' };
          if (at >= 0) rows.roster[at] = row;
          else rows.roster.push(row);
          return Promise.resolve({ rows: [{ email: values[0] }] });
        }
        if (sql.startsWith('DELETE')) {
          const at = rows.roster.findIndex((row) => row.email === values[0]);
          if (at < 0) return Promise.resolve({ rows: [] });
          rows.roster.splice(at, 1);
          return Promise.resolve({ rows: [{ email: values[0] }] });
        }
        return Promise.resolve({ rows: rows.roster as unknown as Record<string, unknown>[] });
      }
      if (sql.includes(ADMIN_AUDIT_TABLE)) {
        rows.audit.push({ actor: values[1], action: values[2], subject: values[3], detail: values[4] });
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes(ADMIN_GRANTS_TABLE)) {
        if (sql.startsWith('INSERT')) {
          const row = { email: values[0], object: values[2], privilege: values[3], provenance: values[4] };
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

/** The `error` field of a refusal, typed, so an assertion is not reading `unknown`. */
async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error?: string }).error ?? '';
}

function statementResponse(body: Record<string, unknown>, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const SUCCEEDED = statementResponse({ status: { state: 'SUCCEEDED' }, result: { data_array: [] } });
const REFUSED = statementResponse({ message: 'PERMISSION_DENIED: User is not an owner of Schema' }, 403);

/**
 * Every statement the app ran, with the bearer token it presented.
 *
 * The token is recorded because it is the security property of the whole mechanism:
 * a grant made under the app's own credential would be a way to hand out Unity
 * Catalog privileges from inside the app, and the tests below assert it is the
 * signed-in super admin's token instead.
 */
function stubStatements(respond: (statement: string) => Response) {
  const calls: { statement: string; token: string }[] = [];
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
  // The same order server.ts uses, both guards, because that ordering is half of
  // the protection: Express applies middleware to whatever is added afterwards, so
  // registering the routes first would serve the roster to everybody.
  app.use(requireAdmin(store, userEmail));
  app.use(requireSuperAdmin(store, userEmail));
  setupUserRoutes(appkit as unknown as InsightsAppKit);

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
    list: (email: string) => fetch(`${base}/api/users`, { headers: headers(email) }),
    add: (email: string, target: string, role: string) =>
      fetch(`${base}/api/users`, {
        method: 'POST',
        headers: headers(email),
        body: JSON.stringify({ email: target, role }),
      }),
    change: (email: string, target: string, role: string) =>
      fetch(`${base}/api/users/${encodeURIComponent(target)}`, {
        method: 'PATCH',
        headers: headers(email),
        body: JSON.stringify({ role }),
      }),
    remove: (email: string, target: string) =>
      fetch(`${base}/api/users/${encodeURIComponent(target)}`, { method: 'DELETE', headers: headers(email) }),
  };
}

beforeEach(() => {
  process.env.DATABRICKS_HOST = 'https://workspace.example.com';
  process.env.DATABRICKS_SQL_WAREHOUSE_ID = 'wh-1';
  // One seeded super admin and one seeded plain admin, which is the shape a
  // customer deployment has: the marker names the person who runs it.
  announceSeedAdmins(`super:${LEAD}, ${DEPUTY}`);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.DATABRICKS_SQL_WAREHOUSE_ID;
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

describe('an administrator who is not the super admin is refused', () => {
  it('is refused the roster, having been allowed every other admin surface', async () => {
    const app = await startApp(fakeLakebase());
    const response = await app.list(DEPUTY);
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toBe('super_admin_role_required');
  });

  it('is refused every method that changes a role', async () => {
    const store = fakeLakebase();
    const app = await startApp(store);
    const attempts = [
      await app.add(DEPUTY, ANALYST, 'admin'),
      await app.change(DEPUTY, ANALYST, 'admin'),
      await app.remove(DEPUTY, ANALYST),
    ];
    expect(attempts.map((response) => response.status)).toEqual([403, 403, 403]);
    // Nothing was written by any of them, which is the fact that matters: a guard
    // that answered 403 after the write would be no guard.
    expect(store.rows.roster).toEqual([]);
    expect(store.rows.audit).toEqual([]);
  });

  it('cannot appoint itself', async () => {
    const store = fakeLakebase();
    const app = await startApp(store);
    expect((await app.change(DEPUTY, DEPUTY, 'super_admin')).status).toBe(403);
    expect(store.rows.roster).toEqual([]);
  });
});

describe('a consumer is refused', () => {
  it('is refused by the admin guard, before the super-admin one', async () => {
    const app = await startApp(fakeLakebase());
    const response = await app.list(STRANGER);
    expect(response.status).toBe(403);
    // The first guard's body, so the reader is told the thing that is true of them.
    expect(await errorOf(response)).toBe('admin_role_required');
  });
});

describe('the super admin reads the roster', () => {
  it('lists both halves with the role each holds', async () => {
    const app = await startApp(fakeLakebase([{ email: ANALYST, role: 'consumer', added_by: LEAD, added_at: '' }]));
    const payload = (await (await app.list(LEAD)).json()) as RosterPayload;
    expect(payload.entries.map((entry) => [entry.email, entry.role])).toEqual([
      [LEAD, 'super_admin'],
      [DEPUTY, 'admin'],
      [ANALYST, 'consumer'],
    ]);
    expect(payload.superAdminCount).toBe(1);
  });

  it('runs no grant, so the roster appears without waiting on a warehouse', async () => {
    const calls = stubStatements(() => SUCCEEDED);
    const app = await startApp(fakeLakebase());
    await app.list(LEAD);
    expect(calls).toEqual([]);
  });

  it('reads the full Lakebase roster once across both guards and the handler', async () => {
    announceSeedAdmins('');
    const store = fakeLakebase([{ email: LEAD, role: 'super_admin', added_by: LEAD, added_at: '' }]);
    const query = vi.spyOn(store, 'query');
    const app = await startApp(store);

    expect((await app.list(LEAD)).status).toBe(200);

    const rosterReads = query.mock.calls.filter(
      ([sql]) => String(sql).trim().startsWith('SELECT') && String(sql).includes(ADDED_ADMINS_TABLE)
    );
    expect(rosterReads).toHaveLength(1);
  });
});

describe('appointing an administrator', () => {
  it('stores the role and asks Unity Catalog for nothing', async () => {
    const calls = stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);
    const response = await app.add(LEAD, ANALYST, 'admin');

    expect(response.status).toBe(200);
    expect(store.rows.roster).toEqual([
      { email: ANALYST, role: 'admin', added_by: LEAD, added_at: '2026-08-17T00:00:00.000Z' },
    ]);
    // A promotion used to grant read on the telemetry schema and the
    // `system.billing` tables. Read access to billing needs a metastore admin, so
    // the ordinary promotion reported a refusal for access the rank never required.
    expect(calls).toHaveLength(0);
  });

  /**
   * The operator is not a metastore admin, so Unity Catalog refuses everything. A
   * promotion still has to work: nothing about the rank depends on it.
   */
  it('promotes somebody even when Unity Catalog would refuse every statement', async () => {
    const calls = stubStatements(() => REFUSED);
    const store = fakeLakebase();
    const app = await startApp(store);

    const response = await app.add(LEAD, ANALYST, 'admin');
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(store.rows.roster[0].role).toBe('admin');
    expect(calls).toHaveLength(0);
    // Nothing on the response for the panel to draw as a failure, and no grant
    // state at all: this screen is people and roles.
    expect(payload).not.toHaveProperty('access');
    expect(JSON.stringify(payload)).not.toContain('PERMISSION_DENIED');
    expect(JSON.stringify(payload)).not.toContain('billing');
  });

  it('records who changed whose role, and to what', async () => {
    stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);
    await app.add(LEAD, ANALYST, 'admin');

    const change = store.rows.audit.find((row) => row.action === 'role-changed');
    expect(change?.actor).toBe(LEAD);
    expect(change?.subject).toBe(ANALYST);
    expect(change?.detail).toContain('consumer');
    expect(change?.detail).toContain('admin');
  });

  it('appoints another super admin, so one person leaving is not the end of it', async () => {
    stubStatements(() => SUCCEEDED);
    const store = fakeLakebase();
    const app = await startApp(store);
    expect((await app.add(LEAD, ANALYST, 'super_admin')).status).toBe(200);
    expect(store.rows.roster[0].role).toBe('super_admin');
  });

  it('invalidates the request snapshot after mutation and reads back the new role', async () => {
    announceSeedAdmins('');
    const store = fakeLakebase([
      { email: LEAD, role: 'super_admin', added_by: LEAD, added_at: '' },
      { email: ANALYST, role: 'consumer', added_by: LEAD, added_at: '' },
    ]);
    const query = vi.spyOn(store, 'query');
    const app = await startApp(store);

    const response = await app.change(LEAD, ANALYST, 'admin');
    const payload = (await response.json()) as RosterPayload;

    expect(payload.entries.find((entry) => entry.email === ANALYST)?.role).toBe('admin');
    const rosterReads = query.mock.calls.filter(
      ([sql]) => String(sql).trim().startsWith('SELECT') && String(sql).includes(ADDED_ADMINS_TABLE)
    );
    // One snapshot for both guards and the precondition; one authoritative read
    // after writeRole increments the store generation.
    expect(rosterReads).toHaveLength(2);
  });

  it('refuses an address that is not one', async () => {
    const app = await startApp(fakeLakebase());
    const response = await app.add(LEAD, 'not-an-address', 'admin');
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid_roster_email');
  });

  it('refuses a role that is not one of the three', async () => {
    const app = await startApp(fakeLakebase());
    const response = await app.add(LEAD, ANALYST, 'owner');
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('roster_refused_unknown_role');
  });
});

describe('changing and removing', () => {
  it('hands back the access an earlier version granted when somebody stops being an admin', async () => {
    const store = fakeLakebase([{ email: ANALYST, role: 'admin', added_by: LEAD, added_at: '' }]);
    // The record an earlier version of this app wrote when it still granted.
    store.rows.grants.push({ email: ANALYST, object: TELEMETRY, privilege: 'SELECT', provenance: 'app-granted' });
    const app = await startApp(store);
    const calls = stubStatements(() => SUCCEEDED);

    await app.change(LEAD, ANALYST, 'consumer');

    expect(store.rows.roster[0].role).toBe('consumer');
    const revokes = calls.filter((call) => call.statement.startsWith('REVOKE'));
    expect(revokes).toHaveLength(1);
    // Under the acting super admin's own token. Never the app's.
    expect(revokes.every((call) => call.token === 'Bearer forwarded-user-token')).toBe(true);
    expect(store.rows.audit.some((row) => row.action === 'access-revoked')).toBe(true);
  });

  it('asks Unity Catalog for nothing when there is nothing recorded to hand back', async () => {
    const store = fakeLakebase([{ email: ANALYST, role: 'admin', added_by: LEAD, added_at: '' }]);
    const app = await startApp(store);
    const calls = stubStatements(() => SUCCEEDED);

    await app.change(LEAD, ANALYST, 'consumer');

    expect(store.rows.roster[0].role).toBe('consumer');
    expect(calls).toEqual([]);
  });

  it('asks Unity Catalog for nothing when the rank does not cross the admin line', async () => {
    const store = fakeLakebase([{ email: ANALYST, role: 'admin', added_by: LEAD, added_at: '' }]);
    const app = await startApp(store);
    const calls = stubStatements(() => SUCCEEDED);

    await app.change(LEAD, ANALYST, 'super_admin');

    // A rise in rank grants nothing, and this one does not lose the admin surfaces
    // either, so there is nothing to take back.
    expect(calls).toEqual([]);
  });

  it('records a removal with the role the person held', async () => {
    stubStatements(() => SUCCEEDED);
    const store = fakeLakebase([{ email: ANALYST, role: 'admin', added_by: LEAD, added_at: '' }]);
    const app = await startApp(store);
    expect((await app.remove(LEAD, ANALYST)).status).toBe(200);
    expect(store.rows.roster).toEqual([]);
    const removal = store.rows.audit.find((row) => row.action === 'user-removed');
    expect(removal?.subject).toBe(ANALYST);
    expect(removal?.detail).toContain('admin');
  });

  it('refuses to lower a role the deployment configuration sets', async () => {
    const app = await startApp(fakeLakebase());
    const response = await app.change(LEAD, DEPUTY, 'consumer');
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('roster_refused_seed_floor');
  });

  it('refuses to change a super admin', async () => {
    // No seed at all, so the stored roster is the whole of it.
    announceSeedAdmins('');
    const store = fakeLakebase([{ email: LEAD, role: 'super_admin', added_by: LEAD, added_at: '' }]);
    const app = await startApp(store);
    const response = await app.change(LEAD, LEAD, 'admin');
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe('roster_refused_immutable_super_admin');
    expect(store.rows.roster[0].role).toBe('super_admin');
  });

  it('keeps a super admin immutable when another one exists', async () => {
    announceSeedAdmins('');
    stubStatements(() => SUCCEEDED);
    const store = fakeLakebase([
      { email: LEAD, role: 'super_admin', added_by: LEAD, added_at: '' },
      { email: ANALYST, role: 'super_admin', added_by: LEAD, added_at: '' },
    ]);
    const app = await startApp(store);
    expect((await app.change(LEAD, LEAD, 'admin')).status).toBe(409);
    expect(store.rows.roster[0].role).toBe('super_admin');
  });

  it('answers 404 for an address the roster does not name', async () => {
    const app = await startApp(fakeLakebase());
    expect((await app.remove(LEAD, STRANGER)).status).toBe(404);
  });
});

describe('when Lakebase is not answering', () => {
  const broken: AdminStore = { query: () => Promise.reject(new Error('connection terminated')) };

  it('changes nothing rather than guessing who else holds a role', async () => {
    const app = await startApp(broken);
    // The seeded super admin resolves from the environment, so the guard admits
    // them; the write refuses, because a role changed without knowing who else
    // holds one could leave the deployment with no super admin.
    const response = await app.change(LEAD, ANALYST, 'admin');
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toBe('roster_store_unavailable');
  });

  it('still shows the roster the environment names', async () => {
    const app = await startApp(broken);
    const payload = (await (await app.list(LEAD)).json()) as RosterPayload;
    expect(payload.storedRosterReadable).toBe(false);
    expect(payload.entries.map((entry) => entry.email)).toEqual([LEAD, DEPUTY]);
  });

  it('fails closed with one store read when no test-only seed floor can admit the caller', async () => {
    announceSeedAdmins('');
    const query = vi.fn(() => Promise.reject(new Error('connection terminated')));
    const app = await startApp({ query });

    const response = await app.list(LEAD);

    expect(response.status).toBe(403);
    expect(await errorOf(response)).toBe('admin_role_required');
    expect(query).toHaveBeenCalledOnce();
  });
});
