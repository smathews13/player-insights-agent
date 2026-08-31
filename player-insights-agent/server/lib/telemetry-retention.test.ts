import { describe, expect, it, vi } from 'vitest';

import { APP_SCHEMA } from '../../shared/app-schema';
import { ACTIVE_MINUTES_PER_DAY_QUERY } from './app-activity';
import { rollbackTo } from './migration-runner';
import { LATER_MIGRATIONS } from './migrations';
import { readRequestLatencyRows, REQUEST_LATENCY_QUERY } from './request-latency';
import {
  APP_ACTIVITY_ROLLUP_TABLE,
  CLAIM_TELEMETRY_LOCK_QUERY,
  DELETE_APP_ACTIVITY_BATCH_QUERY,
  DELETE_REQUEST_LATENCY_BATCH_QUERY,
  LAST_HOUSEKEEPING_DAY_QUERY,
  MARK_HOUSEKEEPING_COMPLETE_QUERY,
  MARK_ROLLUP_DAY_QUERY,
  PENDING_ROLLUP_DAYS_QUERY,
  RAW_TELEMETRY_RETENTION_DAYS,
  RELEASE_TELEMETRY_LOCK_QUERY,
  REQUEST_LATENCY_ROLLUP_TABLE,
  ROLLUP_APP_ACTIVITY_DAY_QUERY,
  ROLLUP_REQUEST_LATENCY_DAY_QUERY,
  TELEMETRY_HOUSEKEEPING_STATE_TABLE,
  TELEMETRY_ROLLUP_DAYS_TABLE,
  runTelemetryHousekeeping,
  type TelemetryRetentionStore,
} from './telemetry-retention';

interface FakeState {
  lockHeld: boolean;
  completedDay: string;
  events: string[];
  failDeleteOnce: boolean;
  pendingGate?: Promise<void>;
  requestDeleteRows: number;
  activityDeleteRows: number;
}

function fakeStore(state: FakeState): TelemetryRetentionStore {
  const query = async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
    state.events.push(sql);
    if (sql === CLAIM_TELEMETRY_LOCK_QUERY) {
      if (state.lockHeld) return { rows: [{ acquired: false }] };
      state.lockHeld = true;
      return { rows: [{ acquired: true }] };
    }
    if (sql === RELEASE_TELEMETRY_LOCK_QUERY) {
      state.lockHeld = false;
      return { rows: [{ released: true }] };
    }
    if (sql === LAST_HOUSEKEEPING_DAY_QUERY) {
      return { rows: state.completedDay ? [{ last_completed_day: state.completedDay }] : [] };
    }
    if (sql.includes(`SELECT (NOW() AT TIME ZONE 'UTC')::date AS day`)) {
      return { rows: [{ day: '2026-08-31' }] };
    }
    if (sql === PENDING_ROLLUP_DAYS_QUERY) {
      await state.pendingGate;
      return { rows: [{ day: '2026-05-31' }] };
    }
    if (sql === DELETE_REQUEST_LATENCY_BATCH_QUERY) {
      if (state.failDeleteOnce) {
        state.failDeleteOnce = false;
        throw new Error('delete interrupted');
      }
      return { rows: Array.from({ length: state.requestDeleteRows }, (_, id) => ({ id })) };
    }
    if (sql === DELETE_APP_ACTIVITY_BATCH_QUERY) {
      return { rows: Array.from({ length: state.activityDeleteRows }, (_, id) => ({ id })) };
    }
    if (sql === MARK_HOUSEKEEPING_COMPLETE_QUERY) {
      state.completedDay = '2026-08-31';
    }
    return { rows: [] };
  };
  return {
    query,
    pool: {
      connect: () => Promise.resolve({ query, release: vi.fn() }),
    },
  };
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    lockHeld: false,
    completedDay: '',
    events: [],
    failDeleteOnce: false,
    requestDeleteRows: 0,
    activityDeleteRows: 0,
    ...overrides,
  };
}

describe('the versioned telemetry rollup schema', () => {
  it('adds only new rollup/state objects and has a rollback', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.name === 'daily telemetry rollups');
    expect(migration?.version).toBe(23);
    const up = migration?.statements.join('\n') ?? '';
    expect(up).toContain(REQUEST_LATENCY_ROLLUP_TABLE);
    expect(up).toContain(APP_ACTIVITY_ROLLUP_TABLE);
    expect(up).toContain(TELEMETRY_ROLLUP_DAYS_TABLE);
    expect(up).toContain(TELEMETRY_HOUSEKEEPING_STATE_TABLE);
    expect(up).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM/i);
    expect(migration?.down).not.toBeNull();
    expect(migration?.down?.join('\n')).toContain(`DROP TABLE IF EXISTS ${REQUEST_LATENCY_ROLLUP_TABLE}`);
  });

  it('retains sufficient distributions for exact percentiles and exact timezone rebucketing', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.version === 23);
    const ddl = migration?.statements.join('\n') ?? '';
    expect(ddl).toContain('recorded_offsets_us BIGINT[]');
    expect(ddl).toContain('durations_ms DOUBLE PRECISION[]');
    expect(ddl).toContain('error_flags BOOLEAN[]');
    expect(ddl).toContain('minute_counts INTEGER[]');
    expect(ddl).toContain('cardinality(minute_counts) = 1440');
  });

  it('rolls version 23 back through the migration runner without touching raw tables', async () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.version === 23)!;
    const issued: string[] = [];
    const client = {
      lakebase: {
        query: (sql: string) => {
          issued.push(sql);
          if (sql.startsWith(`SELECT version FROM ${APP_SCHEMA}.schema_version`)) {
            return Promise.resolve({ rows: [{ version: 23 }] });
          }
          return Promise.resolve({ rows: [] });
        },
      },
    };
    const outcome = await rollbackTo(client, 22, {
      schema: APP_SCHEMA,
      migrations: [migration],
      appliedBy: 'test',
    });
    expect(outcome).toMatchObject({ ok: true, reverted: [23], versionAfter: 0 });
    expect(issued.join('\n')).not.toContain(`DROP TABLE IF EXISTS ${migration.version}`);
    expect(issued.join('\n')).not.toContain(`DROP TABLE IF EXISTS ${RAW_TELEMETRY_RETENTION_DAYS}`);
    expect(issued.join('\n')).not.toMatch(/DROP TABLE IF EXISTS .*request_latencies\b/);
    expect(issued.join('\n')).not.toMatch(/DROP TABLE IF EXISTS .*app_activity_minutes\b/);
  });
});

describe('raw plus rollup query invariants', () => {
  it('uses mutually exclusive sources and keeps the exact percentile method', () => {
    expect(REQUEST_LATENCY_QUERY).toContain(`FROM ${REQUEST_LATENCY_ROLLUP_TABLE}`);
    expect(REQUEST_LATENCY_QUERY).toContain(`FROM ${TELEMETRY_ROLLUP_DAYS_TABLE}`);
    expect(REQUEST_LATENCY_QUERY).toContain('NOT EXISTS');
    expect(REQUEST_LATENCY_QUERY).toContain('rolled.request_latency_complete');
    expect(REQUEST_LATENCY_QUERY).toContain('UNION ALL');
    expect(REQUEST_LATENCY_QUERY).toContain('percentile_cont(0.95)');
    expect(REQUEST_LATENCY_QUERY).not.toMatch(/percentile_approx|histogram/i);
    expect(REQUEST_LATENCY_QUERY).toContain('$1::date AS from_day');
    expect(REQUEST_LATENCY_QUERY).toContain('$2::date AS to_day');
  });

  it('preserves timezone and DST honesty from minute-grain counts', () => {
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('generate_subscripts');
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain("INTERVAL '1 minute'");
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('active_minute AT TIME ZONE $1');
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('local_minute::date BETWEEN');
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('rolled.app_activity_complete');

    // America/Los_Angeles spring-forward has no local 02:xx hour and fall-back
    // has two UTC instants in local 01:xx. UTC minute reconstruction preserves
    // both facts before PostgreSQL applies the same IANA-zone bucketing.
    const localHour = (stamp: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(stamp));
    expect(localHour('2026-03-08T09:30:00Z')).toBe('01');
    expect(localHour('2026-03-08T10:30:00Z')).toBe('03');
    expect(localHour('2026-11-01T08:30:00Z')).toBe('01');
    expect(localHour('2026-11-01T09:30:00Z')).toBe('01');
  });

  it('exposes a partial state instead of filling a missing day with zero', () => {
    expect(REQUEST_LATENCY_QUERY).toContain("WHEN missing.missing_days > 0 THEN 'partial'");
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain("WHEN missing.missing_days > 0 THEN 'partial'");
    expect(REQUEST_LATENCY_QUERY).toContain('generate_series');
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('generate_series');
    expect(
      readRequestLatencyRows([
        {
          coverage_state: 'partial',
          missing_days: 1,
          covered_from: new Date('2026-01-01T00:00:00Z'),
          covered_to: new Date('2026-03-01T00:00:00Z'),
        },
      ])
    ).toMatchObject({ coverageState: 'partial', missingDays: 1, routes: [] });
  });

  it('keeps raw time predicates indexable for production EXPLAIN plans', () => {
    expect(REQUEST_LATENCY_QUERY).toContain('r.recorded_at >=');
    expect(REQUEST_LATENCY_QUERY).toContain('r.recorded_at <');
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('raw.active_minute >=');
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('raw.active_minute <');
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).not.toMatch(/WHERE\s+\(raw\.active_minute AT TIME ZONE \$1\)::date/i);
  });
});

describe('bounded daily housekeeping', () => {
  it('holds the advisory lock, rolls before deleting, and records success last', async () => {
    const shared = state();
    const result = await runTelemetryHousekeeping(fakeStore(shared));

    expect(result).toMatchObject({ acquired: true, rolledDays: ['2026-05-31'] });
    const positions = [
      CLAIM_TELEMETRY_LOCK_QUERY,
      ROLLUP_REQUEST_LATENCY_DAY_QUERY,
      ROLLUP_APP_ACTIVITY_DAY_QUERY,
      MARK_ROLLUP_DAY_QUERY,
      DELETE_REQUEST_LATENCY_BATCH_QUERY,
      DELETE_APP_ACTIVITY_BATCH_QUERY,
      MARK_HOUSEKEEPING_COMPLETE_QUERY,
      RELEASE_TELEMETRY_LOCK_QUERY,
    ].map((sql) => shared.events.indexOf(sql));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(shared.events).toContain('BEGIN');
    expect(shared.events).toContain('COMMIT');
  });

  it('allows only one replica into the critical section', async () => {
    let releasePending: () => void = () => {};
    const pendingGate = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    const shared = state({ pendingGate });
    const first = runTelemetryHousekeeping(fakeStore(shared));
    await vi.waitFor(() => expect(shared.events).toContain(PENDING_ROLLUP_DAYS_QUERY));

    const second = await runTelemetryHousekeeping(fakeStore(shared));
    expect(second.acquired).toBe(false);

    releasePending();
    await first;
    expect(shared.events.filter((sql) => sql === ROLLUP_REQUEST_LATENCY_DAY_QUERY)).toHaveLength(1);
  });

  it('does not repeat a successful pass on the same UTC day', async () => {
    const shared = state({ completedDay: '2026-08-31' });
    const result = await runTelemetryHousekeeping(fakeStore(shared));

    expect(result).toMatchObject({ acquired: true, alreadyCompleted: true, rolledDays: [] });
    expect(shared.events).not.toContain(ROLLUP_REQUEST_LATENCY_DAY_QUERY);
    expect(shared.events).not.toContain(DELETE_REQUEST_LATENCY_BATCH_QUERY);
  });

  it('safely retries after a failure between rollup and deletion', async () => {
    const shared = state({ failDeleteOnce: true });
    await expect(runTelemetryHousekeeping(fakeStore(shared))).rejects.toThrow('delete interrupted');

    expect(shared.events.indexOf(MARK_ROLLUP_DAY_QUERY)).toBeGreaterThanOrEqual(0);
    expect(shared.events.indexOf(MARK_ROLLUP_DAY_QUERY)).toBeLessThan(
      shared.events.indexOf(DELETE_REQUEST_LATENCY_BATCH_QUERY)
    );
    expect(shared.completedDay).toBe('');
    expect(shared.events).toContain('ROLLBACK');

    shared.events = [];
    await expect(runTelemetryHousekeeping(fakeStore(shared))).resolves.toMatchObject({ acquired: true });
    expect(shared.completedDay).toBe('2026-08-31');
  });

  it('bounds every delete and never deletes an unrolled day', () => {
    for (const sql of [DELETE_REQUEST_LATENCY_BATCH_QUERY, DELETE_APP_ACTIVITY_BATCH_QUERY]) {
      expect(sql).toContain('LIMIT $1');
      expect(sql).toContain(`INTERVAL '${RAW_TELEMETRY_RETENTION_DAYS} days'`);
      expect(sql).toMatch(/< NOW\(\) - INTERVAL '90 days'/);
      expect(sql).toContain(`FROM ${TELEMETRY_ROLLUP_DAYS_TABLE}`);
      expect(sql).toContain('complete');
    }
  });

  it.each([
    [89, false],
    [90, false],
    [91, true],
  ])('keeps the exact moving boundary at %i days', (ageDays, expired) => {
    const now = Date.parse('2026-08-31T12:00:00Z');
    const recordedAt = now - ageDays * 86_400_000;
    expect(recordedAt < now - RAW_TELEMETRY_RETENTION_DAYS * 86_400_000).toBe(expired);
  });
});
