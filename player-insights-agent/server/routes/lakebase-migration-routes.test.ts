import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isLakebaseMigrationReadiness } from '../../shared/lakebase-migrations';
import { announceSeedAdmins } from '../lib/admin-roles';
import { ADMIN_AUDIT_TABLE } from '../lib/admin-roles-schema';
import { isSchemaVersionBookkeeping, runMigrations, type MigrationOutcome } from '../lib/migration-runner';
import { schemaOwnershipQuery } from '../lib/schema-ownership-guard';
import { applySchema, bootMigrationMode, MIGRATIONS, type InsightsAppKit } from './insights-routes';
import { LakebaseMigrationReadinessService, setupLakebaseMigrationRoutes } from './lakebase-migration-routes';

const SCHEMA = 'player_insights';
const ADMIN = 'admin@example.test';

interface FakeStoreOptions {
  version?: number;
  ahead?: number;
  unavailable?: boolean;
  ownsSchema?: boolean;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const highest = options.version ?? 36;
  const versions = new Set(Array.from({ length: highest }, (_, index) => index + 1));
  if (options.ahead) versions.add(options.ahead);
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const queries: { sql: string; params: unknown[] }[] = [];
  const appliedBy: string[] = [];
  const auditActors: string[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- pg-compatible async test double
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    queries.push({ sql, params });
    if (options.unavailable) {
      const error = new Error('password=do-not-return host=private.example') as Error & { code?: string };
      error.code = '08006';
      throw error;
    }
    if (sql === 'SELECT 1 AS lakebase_migration_readiness') return { rows: [{ lakebase_migration_readiness: 1 }] };
    if (sql === schemaOwnershipQuery().replace(/\s+/g, ' ').trim()) {
      return {
        rows: [
          {
            schema_exists: true,
            owner: 'app-role',
            connected_role: options.ownsSchema === false ? 'other-role' : 'app-role',
            connected_role_holds_owner: options.ownsSchema !== false,
          },
        ],
      };
    }
    if (isSchemaVersionBookkeeping(sql, SCHEMA)) {
      if (/^SELECT version/i.test(sql)) {
        if (/WHERE version = \$1/i.test(sql)) {
          return { rows: versions.has(Number(params[0])) ? [{ version: Number(params[0]) }] : [] };
        }
        return { rows: [...versions].sort((left, right) => left - right).map((version) => ({ version })) };
      }
      if (/^INSERT INTO/i.test(sql)) {
        versions.add(Number(params[0]));
        appliedBy.push(String(params[4]));
      }
      return { rows: [] };
    }
    if (sql.includes(ADMIN_AUDIT_TABLE)) {
      auditActors.push(String(params[1]));
      return { rows: [] };
    }
    const table = /^CREATE TABLE IF NOT EXISTS \w+\.(\w+)/i.exec(sql)?.[1];
    if (table) {
      tables.add(table);
      const tableColumns = columns.get(table) ?? new Set<string>();
      for (const match of sql.matchAll(
        /\b(\w+)\s+(?:TEXT|INTEGER|BIGINT|NUMERIC|TIMESTAMPTZ|DATE|JSONB|BOOLEAN)\b/gi
      )) {
        tableColumns.add(match[1].toLowerCase());
      }
      columns.set(table, tableColumns);
    }
    const altered = /^ALTER TABLE \w+\.(\w+)/i.exec(sql)?.[1];
    if (altered) {
      const tableColumns = columns.get(altered) ?? new Set<string>();
      for (const match of sql.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/gi)) tableColumns.add(match[1].toLowerCase());
      columns.set(altered, tableColumns);
    }
    return { rows: [] };
  });

  return { lakebase: { query }, versions, tables, columns, queries, appliedBy, auditActors };
}

function service(store: ReturnType<typeof fakeStore>, overrides: Record<string, unknown> = {}) {
  return new LakebaseMigrationReadinessService(store.lakebase, {
    schema: SCHEMA,
    migrations: MIGRATIONS,
    storeReady: Promise.resolve(),
    timeoutMs: 1_000,
    ...overrides,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  announceSeedAdmins(`${ADMIN}`);
});

afterEach(() => {
  announceSeedAdmins('');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Lakebase migration readiness contracts', () => {
  it('reports current, behind, ahead, unavailable, and blocked states without raw database material', async () => {
    const current = await service(fakeStore()).read();
    expect(current).toMatchObject({
      currentVersion: 36,
      targetVersion: 36,
      pendingCount: 0,
      status: 'up_to_date',
      canApply: false,
    });

    const behind = await service(fakeStore({ version: 30 })).read();
    expect(behind.status).toBe('update_required');
    expect(behind.pending.map(({ version }) => version)).toEqual([31, 32, 33, 34, 35, 36]);
    expect(behind.pending.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'daily user spend read model',
        'hourly user spend read model',
        'user spend token coverage',
      ])
    );

    expect((await service(fakeStore({ ahead: 37 })).read()).status).toBe('ahead');
    expect((await service(fakeStore({ unavailable: true })).read()).status).toBe('unavailable');
    const blocked = await service(fakeStore({ version: 30, ownsSchema: false })).read();
    expect(blocked).toMatchObject({ status: 'blocked', canApply: false });

    for (const contract of [current, behind, blocked]) {
      expect(isLakebaseMigrationReadiness(contract)).toBe(true);
      const wire = JSON.stringify(contract);
      expect(wire).not.toContain('SELECT ');
      expect(wire).not.toContain('password=');
      expect(wire).not.toContain('app-role');
      expect(wire).not.toContain('other-role');
    }
  });

  it('reuses only the short-lived verification cache', async () => {
    const store = fakeStore({ version: 30 });
    let now = 1_000;
    let verifies = 0;
    const countedRun: typeof runMigrations = async (client, options) => {
      if (options.mode === 'verify') verifies += 1;
      return runMigrations(client, options);
    };
    const readiness = service(store, { run: countedRun, now: () => now, cacheMs: 50 });

    await readiness.read();
    await readiness.read();
    expect(verifies).toBe(1);
    now += 51;
    await readiness.read();
    expect(verifies).toBe(2);
  });

  it('applies v31 through v36 in order and records the signed-in admin', async () => {
    const store = fakeStore({ version: 30 });
    const result = await service(store).apply(ADMIN);

    expect(result).toMatchObject({ status: 'up_to_date', currentVersion: 36, targetVersion: 36, appliedCount: 6 });
    const orderedVersions = [...store.versions].sort((left, right) => left - right);
    expect(orderedVersions[orderedVersions.length - 1]).toBe(36);
    expect([...store.tables]).toEqual(
      expect.arrayContaining([
        'user_spend_daily',
        'user_spend_refresh_state',
        'user_spend_hourly',
        'user_spend_hourly_refresh_state',
      ])
    );
    expect(store.tables.has('user_spend_daily')).toBe(true);
    expect(store.tables.has('user_spend_refresh_state')).toBe(true);
    expect(store.tables.has('user_spend_hourly')).toBe(true);
    expect(store.tables.has('user_spend_hourly_refresh_state')).toBe(true);
    expect(store.columns.get('user_spend_daily')?.has('token_covered_runs')).toBe(true);
    expect(store.columns.get('user_spend_hourly')?.has('token_covered_questions')).toBe(true);
    expect(store.appliedBy).toEqual(Array(6).fill(ADMIN));
    expect(store.auditActors).toEqual([ADMIN]);
    expect(store.queries.flatMap(({ params }) => params)).not.toContain('forwarded-user-token');
  });

  it('keeps default boot apply and lets the button recover verify-only boot', async () => {
    expect(bootMigrationMode({})).toBe('apply');
    expect(bootMigrationMode({ PLAYER_INSIGHTS_MIGRATE_ON_BOOT: 'verify' })).toBe('verify');

    const verifyOnly = fakeStore({ version: 30 });
    vi.stubEnv('PLAYER_INSIGHTS_MIGRATE_ON_BOOT', 'verify');
    await applySchema({ lakebase: verifyOnly.lakebase } as unknown as InsightsAppKit);
    expect(Math.max(...verifyOnly.versions)).toBe(30);
    expect(await service(verifyOnly).apply(ADMIN)).toMatchObject({ status: 'up_to_date', currentVersion: 36 });

    const defaultApply = fakeStore({ version: 30 });
    vi.stubEnv('PLAYER_INSIGHTS_MIGRATE_ON_BOOT', '');
    await applySchema({ lakebase: defaultApply.lakebase } as unknown as InsightsAppKit);
    expect(Math.max(...defaultApply.versions)).toBe(36);
  });

  it('coalesces double clicks, remains idempotent, and permits a failed migration retry', async () => {
    const store = fakeStore({ version: 30 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let applyRuns = 0;
    const delayedRun: typeof runMigrations = async (client, options) => {
      if (options.mode === 'apply') {
        applyRuns += 1;
        await gate;
      }
      return runMigrations(client, options);
    };
    const readiness = service(store, { run: delayedRun });
    const first = readiness.apply(ADMIN);
    const second = readiness.apply(ADMIN);
    await vi.waitFor(() => expect(applyRuns).toBe(1));
    release();
    expect(await first).toMatchObject({ status: 'up_to_date', appliedCount: 6 });
    expect(await second).toMatchObject({ status: 'up_to_date', appliedCount: 6 });
    expect((await readiness.apply(ADMIN)).appliedCount).toBe(0);

    const retryStore = fakeStore({ version: 30 });
    let failed = false;
    const flakyRun: typeof runMigrations = async (client, options) => {
      if (options.mode === 'apply' && !failed) {
        failed = true;
        return {
          mode: 'apply',
          versionBefore: 30,
          versionAfter: 30,
          attempts: [{ version: 31, name: 'daily user spend read model', outcome: 'failed', failures: [] }],
          pending: [31, 32, 33, 34, 35, 36],
          ahead: [],
          blocked: '',
          ok: false,
        } satisfies MigrationOutcome;
      }
      return runMigrations(client, options);
    };
    const retry = service(retryStore, { run: flakyRun });
    expect(await retry.apply(ADMIN)).toMatchObject({ status: 'blocked', canApply: true });
    expect(await retry.apply(ADMIN)).toMatchObject({ status: 'up_to_date', currentVersion: 36 });
  });

  it('bounds boot waits, honors caller cancellation, and fences a stale verification result', async () => {
    const never = new Promise<void>(() => undefined);
    const timed = service(fakeStore({ version: 30 }), { storeReady: never, timeoutMs: 5 });
    expect((await timed.read()).status).toBe('unavailable');

    const cancelled = new AbortController();
    cancelled.abort();
    expect((await service(fakeStore({ version: 30 })).read(cancelled.signal)).status).toBe('unavailable');

    const store = fakeStore({ version: 30 });
    let releaseVerify!: () => void;
    const verifyGate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    let verification = 0;
    const delayedVerify: typeof runMigrations = async (client, options) => {
      if (options.mode === 'verify' && verification++ === 0) await verifyGate;
      return runMigrations(client, options);
    };
    const readiness = service(store, { run: delayedVerify });
    const stale = readiness.read();
    const applying = readiness.apply(ADMIN);
    releaseVerify();
    await stale;
    expect(await applying).toMatchObject({ status: 'up_to_date' });
    expect(await readiness.read()).toMatchObject({ status: 'up_to_date' });
  });
});

describe('admin route boundary', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  });

  it('allows Admin+ and refuses a consumer independently of the browser role', async () => {
    const store = fakeStore({ version: 30 });
    const app = express();
    app.use(express.json());
    setupLakebaseMigrationRoutes(
      {
        lakebase: store.lakebase,
        server: { extend: (register) => register(app) },
      } as InsightsAppKit,
      { schema: SCHEMA, migrations: MIGRATIONS, storeReady: Promise.resolve(), timeoutMs: 1_000 }
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const allowed = await fetch(`http://127.0.0.1:${port}/api/admin/lakebase/migrations`, {
      headers: { 'x-forwarded-email': ADMIN, authorization: 'Bearer forwarded-user-token' },
    });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()) as object).toMatchObject({ status: 'update_required' });

    const refused = await fetch(`http://127.0.0.1:${port}/api/admin/lakebase/migrations`, {
      headers: { 'x-forwarded-email': 'consumer@example.test' },
    });
    expect(refused.status).toBe(403);
    const refusedApply = await fetch(`http://127.0.0.1:${port}/api/admin/lakebase/migrations/apply`, {
      method: 'POST',
      headers: { 'x-forwarded-email': 'consumer@example.test' },
    });
    expect(refusedApply.status).toBe(403);
  });
});
