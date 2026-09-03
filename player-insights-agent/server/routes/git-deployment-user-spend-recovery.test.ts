/* eslint-disable @typescript-eslint/no-unsafe-assignment -- HTTP payloads and pg-compatible fakes are runtime-shaped. */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserMonitoringPayload } from '../../shared/user-monitoring-contract';
import type { SpendByUserPayload } from '../../shared/user-spend-contract';
import { announceSeedAdmins, isAdminRoute, requireAdmin } from '../lib/admin-roles';
import { ADMIN_AUDIT_TABLE } from '../lib/admin-roles-schema';
import { isSchemaVersionBookkeeping } from '../lib/migration-runner';
import {
  READ_USER_SPEND_COMPONENTS_QUERY,
  READ_USER_SPEND_REFRESH_STATE_QUERY,
  READ_USER_SPEND_SUMMARY_QUERY,
  runUserSpendReadModelRefresh,
  type UserSpendDailyRow,
  type UserSpendRefreshSource,
} from '../lib/user-spend-read-model';
import { schemaOwnershipQuery } from '../lib/schema-ownership-guard';
import { MIGRATIONS, userEmail, type InsightsAppKit } from './insights-routes';
import { setupLakebaseMigrationRoutes } from './lakebase-migration-routes';
import { setupUserSpendReadModelRoutes } from './user-spend-read-model-routes';

const ADMIN = 'admin@example.test';
const PROFILE = 'spend.user@example.test';
const DAY = '2026-09-02';
const TARGET = Math.max(...MIGRATIONS.map(({ version }) => version));

function undefinedTable(): Error & { code: string } {
  return Object.assign(new Error('private relation name must not cross the route'), { code: '42P01' });
}

function recoveryStore() {
  const versions = new Set(Array.from({ length: 30 }, (_, index) => index + 1));
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const appliedBy: string[] = [];
  const lakebaseQueries: Array<{ sql: string; params: unknown[] }> = [];
  let refreshed = false;
  let summaryReads = 0;

  const storedRow = () => ({
    display_email: PROFILE,
    submitted_questions: '4',
    completed_questions: '4',
    run_count: '4',
    active_minutes: '12',
    total_tokens: '800',
    token_covered_runs: '4',
    token_covered_questions: '4',
    spend_usd_covered_days: '1',
    spend_dbu_covered_days: '1',
    spend_usd: '12',
    spend_dbu: '6',
    spend_usd_quality: 'direct',
    spend_dbu_quality: 'direct',
    app_spend_usd: '48',
    app_spend_dbu: '24',
    activity_complete: true,
    billing_complete: true,
    app_role: 'consumer',
    persona_id: 'analyst',
    persona_name: 'Analyst',
    identity_updated_at: '2026-09-02T08:00:00Z',
    source_through: '2026-09-02T23:59:59.999Z',
    computed_at: '2026-09-03T00:05:00Z',
    refresh_status: 'ready',
    refresh_source_through: '2026-09-02T23:59:59.999Z',
    refresh_completed_at: '2026-09-03T00:05:00Z',
    billing_complete_through: DAY,
    total_users: '1',
  });

  // eslint-disable-next-line @typescript-eslint/require-await -- pg-compatible async test double
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    lakebaseQueries.push({ sql, params });
    if (sql === 'SELECT 1 AS lakebase_migration_readiness') return { rows: [{ lakebase_migration_readiness: 1 }] };
    if (sql === schemaOwnershipQuery().replace(/\s+/g, ' ').trim()) {
      return {
        rows: [
          {
            schema_exists: true,
            owner: 'app-service-principal',
            connected_role: 'app-service-principal',
            connected_role_holds_owner: true,
          },
        ],
      };
    }
    if (isSchemaVersionBookkeeping(sql, 'player_insights')) {
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
    if (sql.includes(ADMIN_AUDIT_TABLE)) return { rows: [] };
    if (/SELECT email, (?:role, )?added_by, added_at FROM player_insights\.admin_emails/i.test(sql)) {
      return {
        rows: [
          {
            email: PROFILE,
            role: 'consumer',
            added_by: ADMIN,
            added_at: '2026-09-02T08:00:00Z',
          },
        ],
      };
    }
    if (text === READ_USER_SPEND_SUMMARY_QUERY) {
      summaryReads += 1;
      if (!tables.has('user_spend_daily')) throw undefinedTable();
      return { rows: refreshed ? [storedRow()] : [] };
    }
    if (text === READ_USER_SPEND_REFRESH_STATE_QUERY) {
      if (!tables.has('user_spend_refresh_state')) throw undefinedTable();
      return {
        rows: refreshed
          ? [
              {
                refresh_status: 'ready',
                refresh_source_through: '2026-09-02T23:59:59.999Z',
                refresh_completed_at: '2026-09-03T00:05:00Z',
                billing_complete_through: DAY,
                identity_updated_at: '2026-09-02T08:00:00Z',
              },
            ]
          : [],
      };
    }
    if (text === READ_USER_SPEND_COMPONENTS_QUERY) {
      if (!tables.has('user_spend_daily')) throw undefinedTable();
      return {
        rows: refreshed
          ? [
              {
                component_id: 'warehouse:questions',
                label: 'Questions',
                spend_usd: '12',
                spend_dbu: '6',
                spend_usd_quality: 'direct',
                spend_dbu_quality: 'direct',
                reason: '',
              },
            ]
          : [],
      };
    }
    const table = /^CREATE TABLE IF NOT EXISTS \w+\.(\w+)/i.exec(sql)?.[1];
    if (table) {
      tables.add(table);
      const known = columns.get(table) ?? new Set<string>();
      for (const match of sql.matchAll(
        /\b(\w+)\s+(?:TEXT|INTEGER|BIGINT|NUMERIC|TIMESTAMPTZ|DATE|JSONB|BOOLEAN)\b/gi
      )) {
        known.add(match[1].toLowerCase());
      }
      columns.set(table, known);
    }
    const altered = /^ALTER TABLE \w+\.(\w+)/i.exec(sql)?.[1];
    if (altered) {
      const known = columns.get(altered) ?? new Set<string>();
      for (const match of sql.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/gi)) known.add(match[1].toLowerCase());
      columns.set(altered, known);
    }
    return { rows: [] };
  });

  const connection = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes("SET status = 'refreshing'") && sql.includes('RETURNING watermark_day')) {
        return { rows: [{ watermark_day: null }] };
      }
      if (sql.includes("SET status = 'ready'")) refreshed = true;
      if (
        sql === 'BEGIN' ||
        sql === 'COMMIT' ||
        sql === 'ROLLBACK' ||
        sql.includes('pg_advisory_unlock') ||
        /^(?:INSERT INTO|UPDATE) player_insights\.user_spend_refresh_state/i.test(sql)
      ) {
        return { rows: [] };
      }
      return query(text, params);
    }),
    release: vi.fn(),
  };
  const lakebase = { query, pool: { connect: vi.fn().mockResolvedValue(connection) } };
  return {
    lakebase,
    versions,
    tables,
    columns,
    appliedBy,
    lakebaseQueries,
    isRefreshed: () => refreshed,
    summaryReads: () => summaryReads,
  };
}

describe('existing Git deployment user-spend recovery', () => {
  let server: Server | null = null;

  beforeEach(() => {
    announceSeedAdmins(ADMIN);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    announceSeedAdmins('');
    vi.restoreAllMocks();
  });

  it('upgrades v30 and materializes complete spend on the first read without restart', async () => {
    const store = recoveryStore();
    let billingReads = 0;
    let releaseBilling!: () => void;
    const billingGate = new Promise<void>((resolve) => {
      releaseBilling = resolve;
    });
    const row: UserSpendDailyRow = {
      appScope: 'player-insights',
      userKey: PROFILE,
      displayEmail: PROFILE,
      activityDate: DAY,
      calculationVersion: 1,
      submittedQuestions: 4,
      completedQuestions: 4,
      runCount: 4,
      activeMinutes: 12,
      promptTokens: 500,
      completionTokens: 300,
      totalTokens: 800,
      tokenCoveredRuns: 4,
      tokenCoveredQuestions: 4,
      spendUsd: '12',
      spendDbu: '6',
      appSpendUsd: '48',
      appSpendDbu: '24',
      spendUsdQuality: 'direct',
      spendDbuQuality: 'direct',
      components: {},
      activityComplete: true,
      billingComplete: true,
      sourceThrough: '2026-09-02T23:59:59.999Z',
      computedAt: '2026-09-03T00:05:00Z',
    };
    const source: UserSpendRefreshSource = {
      firstAvailableDay: vi.fn().mockResolvedValue(DAY),
      loadRange: vi.fn(async () => {
        billingReads += 1;
        await billingGate;
        return {
          rows: [row],
          sourceThrough: row.sourceThrough,
          billingCompleteThrough: DAY,
        };
      }),
    };

    const app = express();
    app.use(express.json());
    const appkit = {
      lakebase: store.lakebase,
      server: { extend: (register: (application: express.Application) => void) => register(app) },
    } as unknown as InsightsAppKit;
    setupLakebaseMigrationRoutes(appkit, {
      migrations: MIGRATIONS,
      storeReady: Promise.resolve(),
      timeoutMs: 2_000,
      warmUserSpend: async () => {
        await runUserSpendReadModelRefresh(store.lakebase, source, {
          fromDay: DAY,
          throughDay: DAY,
          timeoutMs: 2_000,
        });
      },
    });
    app.use(requireAdmin(store.lakebase, userEmail));
    setupUserSpendReadModelRoutes(appkit, {
      isAdminRoute,
      source,
      now: () => Date.parse('2026-09-03T00:30:00Z'),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { 'x-forwarded-email': ADMIN, authorization: 'Bearer forwarded-user-token' };

    const readiness = await fetch(`${base}/api/admin/lakebase/migrations`, { headers });
    expect(await readiness.json()).toMatchObject({
      status: 'update_required',
      currentVersion: 30,
      targetVersion: TARGET,
    });

    const apply = await fetch(`${base}/api/admin/lakebase/migrations/apply`, { method: 'POST', headers });
    expect(await apply.json()).toMatchObject({
      status: 'up_to_date',
      currentVersion: TARGET,
      appliedCount: TARGET - 30,
    });
    expect([...store.tables]).toEqual(
      expect.arrayContaining(['user_spend_daily', 'user_spend_refresh_state', 'user_spend_hourly'])
    );
    expect(store.columns.get('user_spend_daily')).toEqual(expect.objectContaining({ has: expect.any(Function) }));
    expect(store.columns.get('user_spend_daily')?.has('token_covered_runs')).toBe(true);

    const responses = Promise.all([
      fetch(`${base}/api/monitoring/user-spend?from=${DAY}&to=${DAY}&unit=USD`, { headers }),
      fetch(`${base}/api/monitoring/user-spend/${encodeURIComponent(PROFILE)}?from=${DAY}&to=${DAY}&unit=USD`, {
        headers,
      }),
    ]);
    await vi.waitFor(() => {
      expect(billingReads).toBe(1);
      expect(store.summaryReads()).toBeGreaterThanOrEqual(2);
    });
    releaseBilling();
    const [listResponse, detailResponse] = await responses;
    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    const list = (await listResponse.json()) as UserMonitoringPayload;
    const detail = (await detailResponse.json()) as SpendByUserPayload;
    expect(list).toMatchObject({
      state: 'ready',
      users: [
        {
          email: PROFILE,
          questions: 4,
          coveredDays: 1,
          tokenUsage: { totalTokens: 800, coveredRuns: 4, coveredQuestions: 4 },
          spend: { usd: { amount: 12, quality: 'direct' } },
        },
      ],
      freshness: {
        completeness: { activity: 'complete', billing: 'complete', usd: 'complete', dbu: 'complete' },
      },
    });
    expect(detail.users[0]).toMatchObject({
      email: PROFILE,
      total: { usd: { amount: 12, quality: 'direct' } },
      metrics: {
        questions: 4,
        coveredDays: 1,
        costPerQuestion: { value: 3, state: 'value' },
        averageDaily: { value: 12, state: 'value' },
        appShare: { value: 25, state: 'value' },
        averageTokens: {
          totalTokens: 800,
          coveredRuns: 4,
          coveredQuestions: 4,
          perRun: 200,
          perQuestion: 200,
        },
      },
    });
    expect(store.isRefreshed()).toBe(true);
    expect(billingReads).toBe(1);

    const second = await fetch(
      `${base}/api/monitoring/user-spend/${encodeURIComponent(PROFILE)}?from=${DAY}&to=${DAY}&unit=USD`,
      { headers }
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as SpendByUserPayload).users[0]?.total.usd.amount).toBe(12);
    expect(billingReads).toBe(1);
    expect(store.appliedBy).toEqual(Array(TARGET - 30).fill(ADMIN));
    expect(store.lakebaseQueries.flatMap(({ params }) => params)).not.toContain('forwarded-user-token');
    expect(JSON.stringify({ row, list, detail })).not.toContain('take2games.com');
  });
});
