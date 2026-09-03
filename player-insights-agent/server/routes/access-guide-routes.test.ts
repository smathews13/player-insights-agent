import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_IDLE_TIMEOUT_CODE,
  APP_SESSION_REQUIRED_CODE,
  registerAppSessionControls,
  type IdleTimeoutConfig,
} from '../lib/app-session';
import { ADMIN_REQUIRED_BODY, announceSeedAdmins, requireAdmin, type AdminStore } from '../lib/admin-roles';
import { requireIdentity, userEmail, type InsightsAppKit } from './insights-routes';
import {
  ACCESS_GUIDE_DOWNLOAD_PATH,
  ACCESS_GUIDE_FILENAME,
  ACCESS_GUIDE_META_PATH,
  accessGuideAssetPath,
  setupAccessGuideRoutes,
} from './access-guide-routes';

const ADMIN = 'admin@example.com';
const CONSUMER = 'consumer@example.com';
const enabled: IdleTimeoutConfig = { enabled: true, minutes: 120, source: 'configured' };
const env = {
  NODE_ENV: 'production',
  DATABRICKS_APP_NAME: 'astrolabe',
  DATABRICKS_WORKSPACE_ID: '123',
};

interface SessionRow {
  subject: string;
  deployment: string;
  state: 'active' | 'idle_expired';
}

function store() {
  const sessions = new Map<string, SessionRow>();
  const lakebase: AdminStore = {
    query(sql, params = []) {
      const compact = sql.replace(/\s+/g, ' ').trim();
      if (compact.startsWith('INSERT INTO') && compact.includes('app_sessions')) {
        sessions.set(String(params[0]), {
          subject: String(params[1]),
          deployment: String(params[2]),
          state: 'active',
        });
        return Promise.resolve({ rows: [] });
      }
      if (compact.startsWith('SELECT subject, deployment_key')) {
        const row = sessions.get(String(params[0]));
        return Promise.resolve({
          rows: row ? [{ subject: row.subject, deployment_key: row.deployment, session_state: row.state }] : [],
        });
      }
      if (compact.startsWith('UPDATE') && compact.includes('SET revoked_at')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return {
    lakebase,
    expireAll: () => {
      for (const row of sessions.values()) row.state = 'idle_expired';
    },
  };
}

let server: Server | undefined;
let temporary = '';

async function start(assetPath: string) {
  const state = store();
  const app = express();
  app.use(express.json());
  app.use(requireIdentity);
  registerAppSessionControls(app, {
    lakebase: state.lakebase,
    identity: userEmail,
    config: enabled,
    env,
  });
  app.use(requireAdmin(state.lakebase, userEmail));
  const appkit = {
    lakebase: state.lakebase,
    server: { extend: (register: (application: express.Application) => void) => register(app) },
  };
  setupAccessGuideRoutes(appkit as unknown as InsightsAppKit, { assetPath });

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server?.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const headers = (email: string, cookie = '') => ({
    'x-forwarded-email': email,
    ...(cookie ? { cookie } : {}),
  });
  const bootstrap = async (email: string) => {
    const response = await fetch(`${base}/api/app-session/bootstrap`, {
      method: 'POST',
      headers: {
        ...headers(email),
        origin: base,
        'x-astrolabe-session-action': 'bootstrap',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    return (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  };
  return {
    state,
    bootstrap,
    get: (pathname: string, email: string, cookie = '') =>
      fetch(`${base}${pathname}`, { headers: headers(email, cookie) }),
  };
}

beforeEach(async () => {
  process.env.NODE_ENV = 'production';
  announceSeedAdmins(ADMIN);
  temporary = await mkdtemp(path.join(os.tmpdir(), 'astrolabe-guide-route-'));
});

afterEach(async () => {
  announceSeedAdmins(undefined);
  delete process.env.NODE_ENV;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  server = undefined;
  await rm(temporary, { recursive: true, force: true });
  temporary = '';
});

describe('confidential access guide routes', () => {
  it('uses only the deploy asset in production and the tracked source in development', () => {
    expect(accessGuideAssetPath({ NODE_ENV: 'production' }, '/app')).toBe(
      path.join('/app', 'assets', ACCESS_GUIDE_FILENAME)
    );
    expect(accessGuideAssetPath({ NODE_ENV: 'development' }, '/app')).toBe(
      path.join('/app', 'docs', ACCESS_GUIDE_FILENAME)
    );
  });

  it('streams only the fixed PDF with private download headers to an active admin session', async () => {
    const bytes = Buffer.from('%PDF-1.7\nconfidential access guide\n', 'utf8');
    const asset = path.join(temporary, ACCESS_GUIDE_FILENAME);
    await writeFile(asset, bytes);
    const app = await start(asset);
    const cookie = await app.bootstrap(ADMIN);

    const response = await app.get(ACCESS_GUIDE_DOWNLOAD_PATH, ADMIN, cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${ACCESS_GUIDE_FILENAME}"`);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it('reports availability only after the same admin and app-session gates', async () => {
    const asset = path.join(temporary, ACCESS_GUIDE_FILENAME);
    await writeFile(asset, '%PDF-1.7\n');
    const app = await start(asset);
    const adminCookie = await app.bootstrap(ADMIN);
    const consumerCookie = await app.bootstrap(CONSUMER);

    const admin = await app.get(ACCESS_GUIDE_META_PATH, ADMIN, adminCookie);
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ available: true });
    expect(admin.headers.get('cache-control')).toBe('private, no-store');

    const consumer = await app.get(ACCESS_GUIDE_META_PATH, CONSUMER, consumerCookie);
    expect(consumer.status).toBe(403);
    expect(await consumer.json()).toEqual(ADMIN_REQUIRED_BODY);
    const consumerDownload = await app.get(ACCESS_GUIDE_DOWNLOAD_PATH, CONSUMER, consumerCookie);
    expect(consumerDownload.status).toBe(403);
    expect(await consumerDownload.json()).toEqual(ADMIN_REQUIRED_BODY);
  });

  it('denies missing and expired app sessions before the file handler', async () => {
    const asset = path.join(temporary, ACCESS_GUIDE_FILENAME);
    await writeFile(asset, '%PDF-1.7\n');
    const app = await start(asset);

    const unidentified = await app.get(ACCESS_GUIDE_DOWNLOAD_PATH, '');
    expect(unidentified.status).toBe(401);
    expect(await unidentified.json()).toMatchObject({ error: 'identity_unavailable' });

    const noSession = await app.get(ACCESS_GUIDE_DOWNLOAD_PATH, ADMIN);
    expect(noSession.status).toBe(401);
    expect(await noSession.json()).toMatchObject({ error: APP_SESSION_REQUIRED_CODE });

    const cookie = await app.bootstrap(ADMIN);
    app.state.expireAll();
    const expired = await app.get(ACCESS_GUIDE_DOWNLOAD_PATH, ADMIN, cookie);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: APP_IDLE_TIMEOUT_CODE });
  });

  it('hides the public control and returns a clear 404 when the asset is absent', async () => {
    const app = await start(path.join(temporary, 'absent', ACCESS_GUIDE_FILENAME));
    const cookie = await app.bootstrap(ADMIN);

    const meta = await app.get(ACCESS_GUIDE_META_PATH, ADMIN, cookie);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual({ available: false });

    const download = await app.get(ACCESS_GUIDE_DOWNLOAD_PATH, ADMIN, cookie);
    expect(download.status).toBe(404);
    expect(await download.json()).toEqual({
      error: 'access_guide_unavailable',
      detail: 'The access guide is not available in this build.',
    });
  });
});
