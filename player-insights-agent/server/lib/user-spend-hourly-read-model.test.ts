import { afterEach, describe, expect, it, vi } from 'vitest';

import { LATER_MIGRATIONS } from './migrations';
import {
  READ_USER_SPEND_HOURLY_SOURCE_QUERY,
  READ_USER_SPEND_HOURLY_SUMMARY_QUERY,
  USER_SPEND_HOURLY_READ_MODEL_DDL,
  USER_SPEND_HOURLY_REFRESH_TABLE,
  USER_SPEND_HOURLY_RETENTION_DAYS,
  USER_SPEND_HOURLY_TABLE,
  materializeUserSpendHours,
  readUserSpendHourlyPage,
  rollingCompleteHours,
  runUserSpendHourlyRefresh,
  startUserSpendHourlyScheduler,
  stopUserSpendHourlyScheduler,
} from './user-spend-hourly-read-model';
import type { UserSpendReadModelStore } from './user-spend-read-model';

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    user_key: 'person@example.test',
    display_email: 'person@example.test',
    activity_hour: '2026-09-02T10:00:00Z',
    submitted_questions: '2',
    completed_questions: '1',
    run_count: '1',
    active_minutes: '3',
    total_tokens: '120',
    token_covered_runs: '1',
    token_covered_questions: '1',
    source_through: '2026-09-02T10:42:00Z',
    billing_basis_day: '2026-09-01',
    basis_questions: '8',
    basis_completed: '4',
    basis_active_minutes: '12',
    basis_spend_usd: '24',
    basis_spend_dbu: '12',
    basis_components: {
      warehouse: {
        label: 'SQL warehouse',
        usd: '12',
        dbu: '6',
        usdQuality: 'allocated',
        dbuQuality: 'allocated',
      },
    },
    ...overrides,
  };
}

function store(rows = [sourceRow()]) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn((sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    if (sql.includes('pg_try_advisory_lock')) return Promise.resolve({ rows: [{ acquired: true }] });
    if (sql.includes('RETURNING watermark_hour')) return Promise.resolve({ rows: [{ watermark_hour: null }] });
    if (sql === READ_USER_SPEND_HOURLY_SOURCE_QUERY) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
  const connection = { query, release: vi.fn() };
  return {
    value: { query, pool: { connect: vi.fn().mockResolvedValue(connection) } } satisfies UserSpendReadModelStore,
    statements,
    query,
    connection,
  };
}

afterEach(() => {
  stopUserSpendHourlyScheduler();
  vi.useRealTimers();
});

describe('hourly user spend schema migration', () => {
  it('adds a minimal app-owned UTC-hour projection at v32', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.version === 32);
    const ddl = migration?.statements.join('\n') ?? '';
    expect(migration?.name).toBe('hourly user spend read model');
    expect(ddl).toContain(USER_SPEND_HOURLY_TABLE);
    expect(ddl).toContain(USER_SPEND_HOURLY_REFRESH_TABLE);
    expect(ddl).toContain('PRIMARY KEY (app_scope, user_key, activity_hour, calculation_version)');
    expect(ddl).toContain('(activity_hour, app_scope, calculation_version)');
    expect(ddl).not.toMatch(/prompt_text|answer_text|sql_text|trace_id|credential/i);
    expect(USER_SPEND_HOURLY_READ_MODEL_DDL.filter((statement) => /CREATE INDEX/i.test(statement))).toHaveLength(1);
    expect(migration?.statements.every((statement) => /IF NOT EXISTS/i.test(statement))).toBe(true);
    expect(migration?.down).toEqual([
      `DROP TABLE IF EXISTS ${USER_SPEND_HOURLY_REFRESH_TABLE}`,
      expect.stringContaining('user_spend_hourly_hour_scope_idx'),
      `DROP TABLE IF EXISTS ${USER_SPEND_HOURLY_TABLE}`,
    ]);
  });
});

describe('rolling UTC-hour boundaries', () => {
  it.each([
    ['spring-forward', '2026-03-08T10:37:00Z'],
    ['fall-back', '2026-11-01T09:37:00Z'],
    ['ordinary day', '2026-09-02T17:23:00Z'],
  ])('keeps exactly 24 complete hours through %s', (_label, now) => {
    const window = rollingCompleteHours(undefined, undefined, Date.parse(now));
    expect(Date.parse(window.to) - Date.parse(window.from)).toBe(24 * 60 * 60 * 1_000);
    expect(window.from).toMatch(/:00:00\.000Z$/);
    expect(window.to).toMatch(/:00:00\.000Z$/);
  });

  it('clamps a wider request to 24 hours and never includes the current partial hour', () => {
    const now = Date.parse('2026-09-02T17:23:45Z');
    expect(rollingCompleteHours('2026-08-31T00:00:00Z', '2026-09-03T00:00:00Z', now)).toEqual({
      from: '2026-09-01T17:00:00.000Z',
      to: '2026-09-02T17:00:00.000Z',
    });
  });
});

describe('hourly materialization', () => {
  it('keeps exact hourly activity and estimates spend from the finest daily basis', () => {
    const [row] = materializeUserSpendHours([sourceRow()]);
    expect(row).toMatchObject({
      userKey: 'person@example.test',
      activityHour: '2026-09-02T10:00:00.000Z',
      questions: 2,
      completed: 1,
      runs: 1,
      activeMinutes: 3,
      totalTokens: 120,
      tokenCoveredRuns: 1,
      tokenCoveredQuestions: 1,
      spendUsd: 6,
      spendDbu: 3,
      usdQuality: 'partial',
      dbuQuality: 'partial',
      basisDay: '2026-09-01',
    });
    expect(row.components.warehouse).toMatchObject({
      usd: '3.000000000000',
      dbu: '1.500000000000',
      usdQuality: 'partial',
      dbuQuality: 'partial',
    });
  });

  it('preserves nonzero seeded totals and distinguishes unavailable billing from zero', () => {
    const [unavailable, zero] = materializeUserSpendHours([
      sourceRow({ user_key: 'missing@example.test', basis_spend_usd: null }),
      sourceRow({ user_key: 'free@example.test', basis_spend_usd: '0' }),
    ]);
    expect(unavailable.spendUsd).toBeNull();
    expect(unavailable.usdQuality).toBe('unavailable');
    expect(zero.spendUsd).toBe(0);
    expect(zero.usdQuality).toBe('partial');
  });
});

describe('transactional hourly refresh', () => {
  it('replaces a bounded overlap, advances state in the same transaction, and prunes only hourly rows', async () => {
    const fake = store();
    await runUserSpendHourlyRefresh(fake.value, {
      appScope: 'astrolabe',
      from: '2026-09-01T09:00:00Z',
      to: '2026-09-02T11:00:00Z',
      now: Date.parse('2026-09-02T11:30:00Z'),
    });
    const sql = fake.statements.map((entry) => entry.sql);
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('COMMIT');
    expect(sql.some((value) => value.includes(`DELETE FROM ${USER_SPEND_HOURLY_TABLE}`))).toBe(true);
    expect(sql.some((value) => value.includes(`INSERT INTO ${USER_SPEND_HOURLY_TABLE}`))).toBe(true);
    expect(sql.some((value) => value.includes(`UPDATE ${USER_SPEND_HOURLY_REFRESH_TABLE}`))).toBe(true);
    expect(sql.join('\n')).not.toMatch(/DELETE FROM .*user_spend_daily/i);
    expect(USER_SPEND_HOURLY_RETENTION_DAYS).toBe(8);
  });

  it('starts one unref scheduler and shutdown prevents its warm run', async () => {
    vi.useFakeTimers();
    const fake = store();
    const firstStop = startUserSpendHourlyScheduler(fake.value, { intervalMs: 60_000, jitterMs: 0 });
    const secondStop = startUserSpendHourlyScheduler(fake.value, { intervalMs: 60_000, jitterMs: 0 });
    firstStop();
    secondStop();
    await vi.runAllTimersAsync();
    expect(fake.connection.query).not.toHaveBeenCalled();
  });
});

describe('fast hourly reads', () => {
  it('scopes consumers in SQL and uses one bounded Lakebase aggregate', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          display_email: 'person@example.test',
          submitted_questions: '2',
          completed_questions: '1',
          run_count: '1',
          active_minutes: '3',
          total_tokens: '120',
          covered_hours: '24',
          spend_usd: '6',
          spend_dbu: '3',
          spend_usd_quality: 'partial',
          spend_dbu_quality: 'partial',
          app_spend_usd: '12',
          app_spend_dbu: '6',
          app_role: 'consumer',
          source_through: '2026-09-02T10:42:00Z',
          computed_at: '2026-09-02T11:00:00Z',
          total_users: '1',
          refresh_status: 'ready',
          refresh_completed_at: '2026-09-02T11:00:00Z',
          refresh_source_through: '2026-09-02T10:42:00Z',
          billing_basis_through: '2026-09-01',
        },
      ],
    });
    const page = await readUserSpendHourlyPage(
      { query },
      {
        appScope: 'astrolabe',
        window: { from: '2026-09-01T11:00:00Z', to: '2026-09-02T11:00:00Z' },
        principal: 'PERSON@EXAMPLE.TEST',
        allowBrowse: false,
        unit: 'USD',
        now: Date.parse('2026-09-02T11:15:00Z'),
      }
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      READ_USER_SPEND_HOURLY_SUMMARY_QUERY,
      expect.arrayContaining([false, 'person@example.test'])
    );
    expect(page.rows[0]).toMatchObject({ spendUsd: 6, questions: 2, coveredDays: 1, billingComplete: false });
    expect(READ_USER_SPEND_HOURLY_SUMMARY_QUERY).toContain('FROM player_insights.admin_emails');
    expect(READ_USER_SPEND_HOURLY_SUMMARY_QUERY).toContain('LEFT JOIN aggregated');
    expect(READ_USER_SPEND_HOURLY_SUMMARY_QUERY).toContain('WHERE $5::boolean AND $13::boolean');
    expect(READ_USER_SPEND_HOURLY_SOURCE_QUERY).not.toMatch(/system\.billing|sql\/history|\/api\/2\.0/i);
  });
});
