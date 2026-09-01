import { describe, expect, it, vi } from 'vitest';

import { LATER_MIGRATIONS } from './migrations';
import {
  APP_BUDGET_APPROVALS_TABLE,
  approveAppBudget,
  readAppBudgetApproval,
  revokeAppBudgetApproval,
} from './app-budget-approval-store';

const period = {
  monthStart: '2026-09-01',
  monthEnd: '2026-09-30',
  measurementThrough: '2026-09-14',
};
const key = {
  period,
  budgetFingerprint: 'a'.repeat(64),
  unit: 'USD' as const,
  budget: 100,
};

describe('durable app budget approvals', () => {
  it('ships an additive migration with a bounded unique approval key', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.name === 'app budget approvals');
    expect(migration?.version).toBe(30);
    const ddl = migration?.statements.join('\n') ?? '';
    expect(ddl).toContain(APP_BUDGET_APPROVALS_TABLE);
    expect(ddl).toContain('UNIQUE (period_start, budget_fingerprint, budget_unit, budget_value)');
    expect(ddl).toContain('revoked_at IS NULL');
    expect(ddl).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bALTER TABLE\b/i);
  });

  it('stores measured coverage and makes duplicate concurrent approval idempotent', async () => {
    const query = vi.fn((_sql: string, _params: unknown[] = []) =>
      Promise.resolve({
        rows: [
          {
            id: 'budget-approval-1',
            approved_by: 'admin@example.com',
            approved_at: '2026-09-15T12:00:00Z',
            revoked_by: null,
            revoked_at: null,
          },
        ],
      })
    );
    const approval = await approveAppBudget({ lakebase: { query } } as never, {
      ...key,
      actor: 'admin@example.com',
      measured: 110,
      coverage: 'complete',
      readAt: '2026-09-15T12:00:00Z',
      measuredThrough: '2026-09-14',
    });
    expect(approval.approvedBy).toBe('admin@example.com');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('revoked_at = NULL');
    expect(JSON.parse(String(params?.[7]))).toEqual({
      quality: 'complete',
      measuredThrough: '2026-09-14',
      readAt: '2026-09-15T12:00:00Z',
    });
  });

  it('reads only a current unrevoked exact-key approval', async () => {
    const query = vi.fn((_sql: string, _params: unknown[] = []) => Promise.resolve({ rows: [] }));
    await readAppBudgetApproval({ lakebase: { query } } as never, key);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('revoked_at IS NULL');
    expect(params).toEqual(['2026-09-01', 'a'.repeat(64), 'USD', 100]);
  });

  it('revokes with an optimistic exact-key update and retains the audit row', async () => {
    const query = vi.fn((_sql: string, _params: unknown[] = []) =>
      Promise.resolve({
        rows: [
          {
            id: 'budget-approval-1',
            approved_by: 'admin@example.com',
            approved_at: '2026-09-15T12:00:00Z',
            revoked_by: 'other-admin@example.com',
            revoked_at: '2026-09-16T12:00:00Z',
          },
        ],
      })
    );
    const revoked = await revokeAppBudgetApproval({ lakebase: { query } } as never, {
      ...key,
      actor: 'other-admin@example.com',
    });
    expect(revoked?.revokedBy).toBe('other-admin@example.com');
    expect(query.mock.calls[0]?.[0]).toMatch(/UPDATE[\s\S]*revoked_at = now\(\)/);
    expect(query.mock.calls[0]?.[0]).not.toMatch(/\bDELETE\b/);
  });
});
