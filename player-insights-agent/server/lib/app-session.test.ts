import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_IDLE_TIMEOUT_CODE,
  APP_SESSION_COOKIE,
  APP_SESSION_REQUIRED_CODE,
  APP_SESSION_UNAVAILABLE_CODE,
  appSessionCookie,
  cleanupExpiredAppSessions,
  createOpaqueSessionId,
  hashSessionId,
  registerAppSessionControls,
  resolveIdleTimeout,
  sessionMutationRefusal,
  shouldProtectWithAppSession,
  type AppSessionLakebase,
  type IdleTimeoutConfig,
} from './app-session';

interface StoredSession {
  subject: string;
  deployment: string;
  created: number;
  lastActive: number;
  idleExpires: number;
  absoluteExpires: number;
  retentionExpires: number;
  revoked: number | null;
}

function memoryStore(start = Date.parse('2026-08-28T12:00:00Z')) {
  let now = start;
  const rows = new Map<string, StoredSession>();
  const calls: { sql: string; params: unknown[] }[] = [];
  let unavailable = false;
  const lakebase: AppSessionLakebase = {
    query(sql, params = []) {
      calls.push({ sql, params });
      if (unavailable) return Promise.reject(new Error('Lakebase unavailable'));
      const compact = sql.replace(/\s+/g, ' ').trim();
      if (compact.startsWith('INSERT INTO') && compact.includes('app_sessions')) {
        const idleMinutes = Number(params[3]);
        rows.set(String(params[0]), {
          subject: String(params[1]),
          deployment: String(params[2]),
          created: now,
          lastActive: now,
          idleExpires: now + idleMinutes * 60_000,
          absoluteExpires: now + 24 * 60 * 60_000,
          retentionExpires: now + idleMinutes * 60_000 + 24 * 60 * 60_000,
          revoked: null,
        });
        return Promise.resolve({ rows: [] });
      }
      if (compact.startsWith('SELECT subject, deployment_key')) {
        const row = rows.get(String(params[0]));
        if (!row) return Promise.resolve({ rows: [] });
        const sessionState =
          row.revoked !== null
            ? 'revoked'
            : row.idleExpires <= now
              ? 'idle_expired'
              : row.absoluteExpires <= now
                ? 'absolute_expired'
                : 'active';
        return Promise.resolve({
          rows: [{ subject: row.subject, deployment_key: row.deployment, session_state: sessionState }],
        });
      }
      if (compact.startsWith('UPDATE') && compact.includes('SET revoked_at')) {
        const row = rows.get(String(params[0]));
        if (row) {
          row.revoked ??= now;
          row.retentionExpires = Math.min(row.retentionExpires, now + 24 * 60 * 60_000);
        }
        return Promise.resolve({ rows: [] });
      }
      if (compact.startsWith('UPDATE') && compact.includes('SET last_active_at')) {
        const row = rows.get(String(params[0]));
        const idleMinutes = Number(params[3]);
        if (
          row &&
          row.subject === params[1] &&
          row.deployment === params[2] &&
          row.revoked === null &&
          row.idleExpires > now &&
          row.absoluteExpires > now &&
          row.lastActive <= now - 45_000
        ) {
          row.lastActive = now;
          row.idleExpires = now + idleMinutes * 60_000;
          row.retentionExpires = Math.min(row.absoluteExpires + 24 * 60 * 60_000, row.idleExpires + 24 * 60 * 60_000);
        }
        return Promise.resolve({ rows: [] });
      }
      if (compact.startsWith('WITH expired AS')) {
        const limit = Number(params[0]);
        const expired = [...rows.entries()]
          .filter(([, row]) => row.retentionExpires <= now)
          .sort((a, b) => a[1].retentionExpires - b[1].retentionExpires)
          .slice(0, limit);
        for (const [key] of expired) rows.delete(key);
        return Promise.resolve({ rows: expired.map(([session_hash]) => ({ session_hash })) });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return {
    lakebase,
    rows,
    calls,
    advance: (ms: number) => void (now += ms),
    fail: (value = true) => void (unavailable = value),
  };
}

const enabled: IdleTimeoutConfig = { enabled: true, minutes: 30, source: 'configured' };
const env = {
  NODE_ENV: 'production',
  DATABRICKS_APP_NAME: 'astrolabe',
  DATABRICKS_WORKSPACE_ID: '123',
};
const user = 'Analyst@Example.COM';
const appHeaders = {
  'x-forwarded-email': user,
};

async function start(store = memoryStore(), config: IdleTimeoutConfig = enabled) {
  const app = express();
  app.use(express.json());
  registerAppSessionControls(app, {
    lakebase: store.lakebase,
    identity: (req) => String(req.header('x-forwarded-email') ?? ''),
    config,
    env,
  });
  app.get('/api/data', (_req, res) => res.json({ secret: 'protected' }));
  app.post('/api/mutate', (_req, res) => res.status(204).send());
  app.get('/api/storage', (_req, res) => res.json({ status: 'health-only' }));
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { ...appHeaders, origin: `http://127.0.0.1:${port}`, ...init.headers },
    });
  const bootstrap = (cookie = '') =>
    call('/api/app-session/bootstrap', {
      method: 'POST',
      headers: {
        ...(cookie ? { cookie } : {}),
        'x-astrolabe-session-action': 'bootstrap',
        'content-type': 'application/json',
      },
      body: '{}',
    });
  return {
    store,
    call,
    bootstrap,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function cookieFrom(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()?.();
});

describe('idle timeout configuration', () => {
  it('defaults to 30 minutes and requires an explicit disable', () => {
    expect(resolveIdleTimeout({})).toEqual({ enabled: true, minutes: 30, source: 'default' });
    expect(resolveIdleTimeout({ PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES: 'disabled' })).toEqual({
      enabled: false,
      minutes: 0,
      source: 'disabled',
    });
    expect(resolveIdleTimeout({ PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES: '0' }).enabled).toBe(true);
  });

  it('enforces safe bounds and fails invalid input back to the default', () => {
    expect(resolveIdleTimeout({ PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES: '1' }).minutes).toBe(5);
    expect(resolveIdleTimeout({ PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES: '9999' }).minutes).toBe(480);
    expect(resolveIdleTimeout({ PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES: 'forever' })).toMatchObject({
      enabled: true,
      minutes: 30,
      source: 'invalid-default',
    });
  });
});

describe('opaque cookie and replica-safe persistence', () => {
  it('sets a high-entropy host cookie with no identity or token content', async () => {
    const first = createOpaqueSessionId();
    const second = createOpaqueSessionId();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(appSessionCookie(first)).toContain(`${APP_SESSION_COOKIE}=${first}`);
    expect(appSessionCookie(first)).toContain('Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400');
    expect(first).not.toContain('Analyst');
    expect(first).not.toContain('Bearer');

    const running = await start();
    open.push(running.close);
    const response = await running.bootstrap();
    const cookie = cookieFrom(response);
    const raw = cookie.slice(cookie.indexOf('=') + 1);
    expect(response.status).toBe(201);
    expect(running.store.rows.has(raw)).toBe(false);
    expect(running.store.rows.has(hashSessionId(raw))).toBe(true);
    expect([...running.store.rows.values()][0]?.subject).toBe('analyst@example.com');
  });

  it('keeps two browsers separate and lets another replica verify either row', async () => {
    const shared = memoryStore();
    const firstReplica = await start(shared);
    const secondReplica = await start(shared);
    open.push(firstReplica.close, secondReplica.close);
    const cookieA = cookieFrom(await firstReplica.bootstrap());
    const cookieB = cookieFrom(await firstReplica.bootstrap());
    expect(cookieA).not.toBe(cookieB);
    expect(shared.rows.size).toBe(2);
    expect((await secondReplica.call('/api/data', { headers: { cookie: cookieA } })).status).toBe(200);
    expect((await secondReplica.call('/api/data', { headers: { cookie: cookieB } })).status).toBe(200);
  });

  it('never creates or accepts a session without an authenticated subject', async () => {
    const running = await start();
    open.push(running.close);
    const missing = await running.call('/api/app-session/bootstrap', {
      method: 'POST',
      headers: {
        'x-forwarded-email': '',
        'x-astrolabe-session-action': 'bootstrap',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: APP_SESSION_REQUIRED_CODE });
    expect(running.store.rows.size).toBe(0);

    const cookie = cookieFrom(await running.bootstrap());
    const unbound = await running.call('/api/data', {
      headers: { cookie, 'x-forwarded-email': '' },
    });
    expect(unbound.status).toBe(401);
    expect(await unbound.json()).toMatchObject({ error: APP_SESSION_REQUIRED_CODE });
  });
});

describe('expiry and activity semantics', () => {
  it('treats the exact idle boundary as expired and rejects reads and writes', async () => {
    const running = await start();
    open.push(running.close);
    const cookie = cookieFrom(await running.bootstrap());
    running.store.advance(30 * 60_000);
    for (const [path, method] of [
      ['/api/data', 'GET'],
      ['/api/mutate', 'POST'],
    ] as const) {
      const response = await running.call(path, { method, headers: { cookie } });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: APP_IDLE_TIMEOUT_CODE });
    }
  });

  it('also enforces the absolute boundary and subject binding', async () => {
    const running = await start();
    open.push(running.close);
    const cookie = cookieFrom(await running.bootstrap());
    const row = [...running.store.rows.values()][0];
    row.absoluteExpires = row.created + 1_000;

    const otherUser = await running.call('/api/data', {
      headers: { cookie, 'x-forwarded-email': 'other@example.com' },
    });
    expect(otherUser.status).toBe(401);
    expect(await otherUser.json()).toMatchObject({ error: APP_SESSION_REQUIRED_CODE });

    row.deployment = 'other-workspace:astrolabe';
    const otherDeployment = await running.call('/api/data', { headers: { cookie } });
    expect(otherDeployment.status).toBe(401);
    expect(await otherDeployment.json()).toMatchObject({ error: APP_SESSION_REQUIRED_CODE });
    row.deployment = '123:astrolabe';

    running.store.advance(1_000);
    const expired = await running.call('/api/data', { headers: { cookie } });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: APP_IDLE_TIMEOUT_CODE });
  });

  it('refreshes only explicit activity; ordinary and background reads do not extend it', async () => {
    const running = await start();
    open.push(running.close);
    const cookie = cookieFrom(await running.bootstrap());
    const row = [...running.store.rows.values()][0];
    const originalExpiry = row.idleExpires;
    running.store.advance(60_000);
    expect((await running.call('/api/data', { headers: { cookie } })).status).toBe(200);
    expect(row.idleExpires).toBe(originalExpiry);
    expect((await running.call('/api/activity/heartbeat', { method: 'POST', headers: { cookie } })).status).not.toBe(
      204
    );
    expect(row.idleExpires).toBe(originalExpiry);

    const activity = await running.call('/api/app-session/activity', {
      method: 'POST',
      headers: {
        cookie,
        'x-astrolabe-session-action': 'activity',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(activity.status).toBe(204);
    expect(row.idleExpires).toBeGreaterThan(originalExpiry);
  });

  it('does not replace an expired or attacker-supplied cookie during bootstrap', async () => {
    const running = await start();
    open.push(running.close);
    const cookie = cookieFrom(await running.bootstrap());
    running.store.advance(30 * 60_000);
    const expired = await running.bootstrap(cookie);
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { error: string }).error).toBe(APP_IDLE_TIMEOUT_CODE);
    expect(expired.headers.get('set-cookie')).toBeNull();
    expect(running.store.rows.size).toBe(1);

    const fixed = await running.bootstrap(`${APP_SESSION_COOKIE}=${createOpaqueSessionId()}`);
    expect(fixed.status).toBe(401);
    expect(((await fixed.json()) as { error: string }).error).toBe(APP_SESSION_REQUIRED_CODE);
    expect(running.store.rows.size).toBe(1);
  });
});

describe('request boundaries and cleanup', () => {
  it('rejects spoofed activity and accepts only matching same-origin requests', async () => {
    const running = await start();
    open.push(running.close);
    const cookie = cookieFrom(await running.bootstrap());
    const missingHeader = await running.call('/api/app-session/activity', {
      method: 'POST',
      headers: { cookie },
    });
    expect(missingHeader.status).toBe(403);
    const crossOrigin = await running.call('/api/app-session/activity', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://attacker.example',
        'x-astrolabe-session-action': 'activity',
      },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('fails protected data closed when Lakebase cannot verify state', async () => {
    const running = await start();
    open.push(running.close);
    const cookie = cookieFrom(await running.bootstrap());
    running.store.fail();
    const response = await running.call('/api/data', { headers: { cookie } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: APP_SESSION_UNAVAILABLE_CODE });
    expect((await running.call('/api/storage')).status).toBe(200);
  });

  it('clears the app cookie before native sign-out and permits a fresh explicit bootstrap', async () => {
    const running = await start();
    open.push(running.close);
    const cookie = cookieFrom(await running.bootstrap());
    const ended = await running.call('/api/app-session/end', {
      method: 'POST',
      headers: { cookie, 'x-astrolabe-session-action': 'end' },
    });
    expect(ended.status).toBe(204);
    expect(ended.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(cookieFrom(await running.bootstrap())).not.toBe(cookie);
  });

  it('deletes a bounded indexed retention batch outside request handling', async () => {
    const store = memoryStore();
    const running = await start(store);
    open.push(running.close);
    await running.bootstrap();
    await running.bootstrap();
    for (const row of store.rows.values()) row.retentionExpires = 0;
    expect(await cleanupExpiredAppSessions(store.lakebase, 1)).toBe(1);
    expect(store.rows.size).toBe(1);
    const cleanup = store.calls[store.calls.length - 1];
    expect(cleanup?.sql).toContain('ORDER BY retention_expires_at');
    expect(cleanup?.sql).toContain('LIMIT $1');
  });

  it('protects every API except bootstrap, end, health, and storage diagnostics', () => {
    expect(shouldProtectWithAppSession('/api/conversations')).toBe(true);
    expect(shouldProtectWithAppSession('/api/admin/model-releases')).toBe(true);
    expect(shouldProtectWithAppSession('/api/app-session/activity')).toBe(true);
    expect(shouldProtectWithAppSession('/api/app-session/bootstrap')).toBe(false);
    expect(shouldProtectWithAppSession('/api/app-session/end')).toBe(false);
    expect(shouldProtectWithAppSession('/api/storage')).toBe(false);
    expect(shouldProtectWithAppSession('/health')).toBe(false);
    expect(shouldProtectWithAppSession('/.auth/sign_out')).toBe(false);
  });

  it('keeps disabled mode explicit and does not touch Lakebase', async () => {
    const store = memoryStore();
    const running = await start(store, { enabled: false, minutes: 0, source: 'disabled' });
    open.push(running.close);
    const boot = await running.bootstrap();
    expect(boot.status).toBe(200);
    expect(await boot.json()).toEqual({ enabled: false, idleTimeoutMinutes: 0 });
    expect((await running.call('/api/data')).status).toBe(200);
    expect(store.calls).toEqual([]);
  });

  it('requires both custom header and current host on session mutations', () => {
    const req = {
      header(name: string) {
        const values: Record<string, string> = {
          host: 'app.example',
          origin: 'https://app.example',
          'x-astrolabe-session-action': 'activity',
        };
        return values[name.toLowerCase()];
      },
    };
    expect(sessionMutationRefusal(req as never, 'activity')).toBe('');
    expect(sessionMutationRefusal(req as never, 'bootstrap')).toContain('header');
  });
});
