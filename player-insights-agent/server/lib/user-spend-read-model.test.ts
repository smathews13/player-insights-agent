import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  READ_USER_SPEND_SUMMARY_QUERY,
  USER_SPEND_CALCULATION_VERSION,
  USER_SPEND_DAILY_TABLE,
  USER_SPEND_READ_MODEL_DDL,
  USER_SPEND_REFRESH_TABLE,
  readUserSpendReadModelPage,
  runUserSpendReadModelRefresh,
  startUserSpendReadModelScheduler,
  stopUserSpendReadModelScheduler,
  type UserSpendDailyRow,
  type UserSpendReadModelStore,
  type UserSpendRefreshSource,
} from './user-spend-read-model';
import { LATER_MIGRATIONS } from './migrations';

function row(overrides: Partial<UserSpendDailyRow> = {}): UserSpendDailyRow {
  return {
    appScope: 'astrolabe',
    userKey: 'user@example.test',
    displayEmail: 'user@example.test',
    activityDate: '2026-08-31',
    calculationVersion: USER_SPEND_CALCULATION_VERSION,
    submittedQuestions: 3,
    completedQuestions: 2,
    runCount: 2,
    activeMinutes: 8,
    promptTokens: 100,
    completionTokens: 25,
    totalTokens: 125,
    spendUsd: '0.0000001234567',
    spendDbu: '0.25',
    appSpendUsd: '1.5',
    appSpendDbu: '0.75',
    spendUsdQuality: 'allocated',
    spendDbuQuality: 'allocated',
    components: {
      genie: { usd: '0.000000000000', dbu: '0.000000000000', quality: 'direct', free: true },
    },
    activityComplete: true,
    billingComplete: true,
    sourceThrough: '2026-09-01T03:00:00Z',
    computedAt: '2026-09-01T04:00:00Z',
    ...overrides,
  };
}

function source(overrides: Partial<UserSpendRefreshSource> = {}): UserSpendRefreshSource {
  return {
    firstAvailableDay: vi.fn().mockResolvedValue('2026-08-31'),
    loadRange: vi.fn().mockResolvedValue({
      rows: [row()],
      sourceThrough: '2026-09-01T03:00:00Z',
      billingCompleteThrough: '2026-08-31',
    }),
    ...overrides,
  };
}

function refreshStore(input: { acquired?: boolean; watermark?: string; failCommit?: boolean } = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn((sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    if (sql.includes('pg_try_advisory_lock')) return Promise.resolve({ rows: [{ acquired: input.acquired ?? true }] });
    if (sql.includes("SET status = 'refreshing'")) {
      return Promise.resolve({ rows: [{ watermark_day: input.watermark ?? null }] });
    }
    if (sql === 'COMMIT' && input.failCommit) return Promise.reject(new Error('commit failed'));
    return Promise.resolve({ rows: [] });
  });
  const release = vi.fn();
  const connection = { query, release };
  const store = {
    query,
    pool: { connect: vi.fn().mockResolvedValue(connection) },
  } satisfies UserSpendReadModelStore;
  return { store, statements, query, release };
}

afterEach(() => {
  stopUserSpendReadModelScheduler();
  vi.useRealTimers();
});

describe('daily user spend schema migration', () => {
  it('adds app-owned daily and refresh tables at v31 with only justified indexes', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.name === 'daily user spend read model');
    expect(migration?.version).toBe(31);
    const ddl = migration?.statements.join('\n') ?? '';
    expect(ddl).toContain(USER_SPEND_DAILY_TABLE);
    expect(ddl).toContain(USER_SPEND_REFRESH_TABLE);
    expect(ddl).toContain('NUMERIC(30,12)');
    expect(ddl).toContain('PRIMARY KEY (app_scope, user_key, activity_date, calculation_version)');
    expect(ddl).toContain('(activity_date, app_scope, calculation_version)');
    expect(ddl).not.toMatch(/prompt_text|answer_text|sql_text|trace_id/i);
    expect(USER_SPEND_READ_MODEL_DDL.filter((statement) => /CREATE INDEX/i.test(statement))).toHaveLength(1);
  });

  it('keeps every statement idempotent and provides an ordered rollback', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.version === 31)!;
    expect(migration.statements.every((statement) => /IF NOT EXISTS/i.test(statement))).toBe(true);
    expect(migration.down).toEqual([
      `DROP TABLE IF EXISTS ${USER_SPEND_REFRESH_TABLE}`,
      expect.stringContaining('user_spend_daily_date_scope_idx'),
      `DROP TABLE IF EXISTS ${USER_SPEND_DAILY_TABLE}`,
    ]);
  });
});

describe('bounded user spend materialization', () => {
  it('loads all users in one batch, stores decimals as fixed strings, and commits before advancing state', async () => {
    const fake = refreshStore();
    const load = vi.fn().mockResolvedValue({
      rows: [row(), row({ userKey: 'other@example.test', displayEmail: 'other@example.test', spendUsd: '1.2' })],
      sourceThrough: '2026-09-01T03:00:00Z',
      billingCompleteThrough: '2026-08-31',
    });

    const result = await runUserSpendReadModelRefresh(fake.store, source({ loadRange: load }), {
      appScope: 'astrolabe',
      throughDay: '2026-08-31',
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ from: '2026-08-31', to: '2026-08-31' }, expect.any(AbortSignal));
    expect(result).toMatchObject({ acquired: true, refreshed: true, rows: 2, users: 2 });
    const inserts = fake.statements.filter((entry) => entry.sql.includes(`INSERT INTO ${USER_SPEND_DAILY_TABLE}`));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params[12]).toBe('0.000000123457');
    expect(inserts[1].params[12]).toBe('1.200000000000');
    const begin = fake.statements.findIndex((entry) => entry.sql === 'BEGIN');
    const replace = fake.statements.findIndex((entry) => entry.sql.includes(`DELETE FROM ${USER_SPEND_DAILY_TABLE}`));
    const commit = fake.statements.findIndex((entry) => entry.sql === 'COMMIT');
    expect(begin).toBeLessThan(replace);
    expect(replace).toBeLessThan(commit);
  });

  it('deduplicates in process and reports cross-replica lock contention without reading the source', async () => {
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const fake = refreshStore();
    const load = vi.fn(async () => {
      await gate;
      return {
        rows: [row()],
        sourceThrough: '2026-09-01T03:00:00Z',
        billingCompleteThrough: '2026-08-31',
      };
    });
    const first = runUserSpendReadModelRefresh(fake.store, source({ loadRange: load }), {
      appScope: 'astrolabe',
      throughDay: '2026-08-31',
    });
    const second = runUserSpendReadModelRefresh(fake.store, source({ loadRange: load }), {
      appScope: 'astrolabe',
      throughDay: '2026-08-31',
    });
    expect(second).toBe(first);
    releaseLoad();
    await first;
    expect(load).toHaveBeenCalledTimes(1);

    const contended = refreshStore({ acquired: false });
    const firstAvailableDay = vi.fn().mockResolvedValue('2026-08-31');
    const loadRange = vi.fn().mockResolvedValue({
      rows: [row()],
      sourceThrough: null,
      billingCompleteThrough: null,
    });
    const unavailableSource = source({ firstAvailableDay, loadRange });
    await expect(
      runUserSpendReadModelRefresh(contended.store, unavailableSource, {
        appScope: 'astrolabe',
        throughDay: '2026-08-31',
      })
    ).resolves.toMatchObject({ acquired: false, refreshed: false });
    expect(firstAvailableDay).not.toHaveBeenCalled();
    expect(loadRange).not.toHaveBeenCalled();
  });

  it('replays the trailing overlap so late billing corrections replace the same primary key', async () => {
    const fake = refreshStore({ watermark: '2026-08-31' });
    const load = vi.fn().mockResolvedValue({
      rows: [row({ spendUsd: '0.75' })],
      sourceThrough: '2026-09-02T03:00:00Z',
      billingCompleteThrough: '2026-08-31',
    });
    await runUserSpendReadModelRefresh(fake.store, source({ loadRange: load }), {
      appScope: 'astrolabe',
      overlapDays: 7,
      throughDay: '2026-08-31',
    });
    expect(load.mock.calls[0][0]).toEqual({ from: '2026-08-25', to: '2026-08-31' });
    expect(fake.statements.some((entry) => entry.sql.includes('ON CONFLICT (app_scope, user_key'))).toBe(true);
  });

  it('rolls back a failed batch and records only a bounded error class while preserving old rows', async () => {
    const fake = refreshStore();
    const failing = source({ loadRange: vi.fn().mockRejectedValue(new TypeError('secret SQL and user data')) });
    await expect(
      runUserSpendReadModelRefresh(fake.store, failing, {
        appScope: 'astrolabe',
        throughDay: '2026-08-31',
      })
    ).rejects.toThrow('secret SQL and user data');
    const failure = fake.statements.find((entry) => entry.sql.includes("SET status = 'failed'"));
    expect(failure?.params[3]).toBe('TypeError');
    expect(JSON.stringify(failure?.params)).not.toContain('secret SQL');
    expect(fake.statements.some((entry) => entry.sql.includes(`DELETE FROM ${USER_SPEND_DAILY_TABLE}`))).toBe(false);
  });
});

describe('fast read semantics', () => {
  it('scopes non-admins in SQL and preserves zero separately from missing values', async () => {
    const store = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            display_email: 'user@example.test',
            submitted_questions: '2',
            completed_questions: '2',
            run_count: '2',
            active_minutes: '4',
            total_tokens: null,
            covered_days: '1',
            app_covered_days: '1',
            spend_usd: '0',
            spend_dbu: null,
            spend_usd_quality: 'direct',
            spend_dbu_quality: 'unavailable',
            app_spend_usd: '0',
            app_spend_dbu: null,
            activity_complete: true,
            billing_complete: true,
            app_role: 'consumer',
            source_through: '2026-09-01T03:00:00Z',
            computed_at: '2026-09-01T04:00:00Z',
            total_users: '1',
            refresh_status: 'ready',
            refresh_completed_at: '2026-09-01T04:00:00Z',
            refresh_source_through: '2026-09-01T03:00:00Z',
            billing_complete_through: '2026-08-31',
          },
        ],
      }),
    };
    const page = await readUserSpendReadModelPage(store, {
      appScope: 'astrolabe',
      range: { from: '2026-08-31', to: '2026-08-31' },
      principal: 'USER@EXAMPLE.TEST',
      allowBrowse: false,
      unit: 'USD',
      now: Date.parse('2026-09-01T04:30:00Z'),
    });
    expect(store.query).toHaveBeenCalledWith(
      READ_USER_SPEND_SUMMARY_QUERY,
      expect.arrayContaining([false, 'user@example.test'])
    );
    expect(page.rows[0].spendUsd).toBe(0);
    expect(page.rows[0].spendDbu).toBeNull();
    expect(page.freshness).toMatchObject({
      isRefreshing: false,
      isStale: false,
      calculationVersion: 1,
      billingCompleteThrough: '2026-08-31',
    });
    expect(READ_USER_SPEND_SUMMARY_QUERY).toContain('($5::boolean OR user_key = lower($6))');
    expect(READ_USER_SPEND_SUMMARY_QUERY).toContain('BOOL_AND(billing_complete)');
    expect(READ_USER_SPEND_SUMMARY_QUERY).toContain('LIMIT $11 OFFSET $12');
  });

  it('starts only one local timer and shutdown prevents its immediate warm', async () => {
    vi.useFakeTimers();
    const fake = refreshStore();
    const firstAvailableDay = vi.fn().mockResolvedValue('2026-08-31');
    const loader = source({ firstAvailableDay });
    const firstStop = startUserSpendReadModelScheduler(fake.store, loader, { intervalMs: 60_000, jitterMs: 0 });
    const secondStop = startUserSpendReadModelScheduler(fake.store, loader, { intervalMs: 60_000, jitterMs: 0 });
    firstStop();
    secondStop();
    await vi.runAllTimersAsync();
    expect(firstAvailableDay).not.toHaveBeenCalled();
  });
});
