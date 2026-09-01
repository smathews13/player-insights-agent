import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CostBudgets, CostBudgetUnit } from '../../shared/cost-budgets';
import { forgetCostBudgets } from './cost-budgets-store';
import { forgetAppBudgetStatus, readAppBudgetStatus } from './app-budget-guard';

const NOW = Date.parse('2026-09-15T12:00:00Z');

function budgets(unit: CostBudgetUnit, value: number | null): CostBudgets {
  return {
    total: { USD: unit === 'USD' ? value : null, DBU: unit === 'DBU' ? value : null },
    resources: {},
  };
}

function appkitFor(settings: CostBudgets, approval: Record<string, unknown> | null = null) {
  const query = vi.fn((sql: string, _params: unknown[] = []) => {
    if (sql.includes('cost_budgets')) return Promise.resolve({ rows: [{ settings }] });
    if (sql.includes('app_budget_approvals')) return Promise.resolve({ rows: approval ? [approval] : [] });
    return Promise.resolve({ rows: [] });
  });
  return { lakebase: { query }, server: { extend: vi.fn() } };
}

function measured(amount: number, unit: CostBudgetUnit, delayed = false) {
  return () =>
    Promise.resolve({
      readAt: '2026-09-15T12:00:00.000Z',
      payload: {
        state: 'ready' as const,
        range: { from: '2026-09-01', to: '2026-09-14' },
        currency: 'USD',
        throughDay: delayed ? '2026-09-13' : '2026-09-14',
        honesty: {
          priceSource: 'list_prices' as const,
          contractRates: 'unavailable' as const,
          dataThrough: delayed ? '2026-09-13' : '2026-09-14',
          rangeMayStillFill: delayed,
          currencyConsistent: true,
        },
        tiles: [
          {
            id: 'app-compute',
            label: 'App compute',
            resourceId: 'astrolabe',
            resourceKind: 'app' as const,
            quality: 'real' as const,
            amount: unit === 'USD' ? amount : 1,
            dbus: unit === 'DBU' ? amount : 1,
            basis: 'total-in-range' as const,
            population: 'This app',
            attribution: 'deployment' as const,
            pricing: {
              source: 'list_prices' as const,
              match: 'priced' as const,
              currency: 'USD',
              pricedQuantity: 1,
              unpricedQuantity: 0,
              pricedRows: 1,
              unpricedRows: 0,
              unpricedSkus: [],
              duplicateMatches: 0,
              correctionRows: 0,
              priceEffectiveAt: '2026-09-01',
            },
            unavailable: '',
            remedy: '',
            note: '',
          },
        ],
      },
    });
}

describe('authoritative app budget status', () => {
  beforeEach(() => {
    forgetCostBudgets();
    forgetAppBudgetStatus();
  });

  it.each([
    [79.99, 'below'],
    [80, 'warning'],
    [99.99, 'warning'],
    [100, 'approval-required'],
    [120, 'approval-required'],
  ] as const)('classifies USD month-to-date spend %s', async (amount, level) => {
    const appkit = appkitFor(budgets('USD', 100));
    const status = await readAppBudgetStatus(appkit as never, {} as never, {
      now: NOW,
      measure: measured(amount, 'USD'),
    });
    expect(status).toMatchObject({ level, unit: 'USD', budget: 100, measured: amount, coverage: 'complete' });
  });

  it('compares a DBU budget only with attributable DBUs', async () => {
    const appkit = appkitFor(budgets('DBU', 50));
    const status = await readAppBudgetStatus(appkit as never, {} as never, {
      now: NOW,
      measure: measured(50, 'DBU'),
    });
    expect(status).toMatchObject({ level: 'approval-required', unit: 'DBU', budget: 50, measured: 50 });
  });

  it('treats an unset or cleared budget as unset without reading billing', async () => {
    const appkit = appkitFor(budgets('USD', null));
    const measure = vi.fn(measured(100, 'USD'));
    const status = await readAppBudgetStatus(appkit as never, {} as never, { now: NOW, measure });
    expect(status.level).toBe('unset');
    expect(measure).not.toHaveBeenCalled();
  });

  it('fails open visibly for partial coverage, delayed data, and query errors', async () => {
    const partialMeasure = async () => {
      const result = await measured(120, 'USD')();
      const tile = result.payload.tiles[0] as {
        amount: number | null;
        attribution: 'deployment' | 'unavailable';
      };
      tile.amount = null;
      tile.attribution = 'unavailable';
      return result;
    };
    for (const measure of [
      partialMeasure,
      measured(120, 'USD', true),
      () => Promise.reject(new Error('warehouse timeout')),
    ]) {
      forgetAppBudgetStatus();
      const status = await readAppBudgetStatus(appkitFor(budgets('USD', 100)) as never, {} as never, {
        now: NOW,
        measure,
      });
      expect(status.level).toBe('unavailable/partial');
      expect(status.code).toMatch(/PARTIAL|FAILED/);
      expect(status.detail).toMatch(/New questions remain available/);
    }
  });

  it('uses the fixed UTC MTD range independently of any Cost page range', async () => {
    let seenPeriod: unknown;
    const base = measured(40, 'USD');
    const measure = vi.fn(async (_app: unknown, _req: unknown, period: unknown) => {
      seenPeriod = period;
      return base();
    });
    const status = await readAppBudgetStatus(appkitFor(budgets('USD', 100)) as never, {} as never, {
      now: NOW,
      measure,
    });
    expect(status).toMatchObject({
      monthStart: '2026-09-01',
      monthEnd: '2026-09-30',
      measuredThrough: '2026-09-14',
    });
    expect(seenPeriod).toMatchObject({
      monthStart: '2026-09-01',
      measurementThrough: '2026-09-14',
    });
  });

  it('accepts only an approval for the exact month, fingerprint, unit, and value', async () => {
    const approval = {
      id: 'approval-1',
      approved_by: 'admin@example.com',
      approved_at: '2026-09-15T12:01:00Z',
      revoked_by: '',
      revoked_at: '',
    };
    const appkit = appkitFor(budgets('USD', 100), approval);
    const status = await readAppBudgetStatus(appkit as never, {} as never, {
      now: NOW,
      measure: measured(110, 'USD'),
    });
    expect(status.level).toBe('approved-overage');
    expect(status.approval).toMatchObject({
      approvedBy: 'An administrator',
      through: '2026-09-30',
    });
    expect(JSON.stringify(status)).not.toContain('admin@example.com');
    const approvalRead = appkit.lakebase.query.mock.calls.find(([sql]) => String(sql).includes('app_budget_approvals'));
    expect(approvalRead?.[1]).toEqual(['2026-09-01', status.budgetFingerprint, 'USD', 100]);
  });

  it('invalidates approval matching on budget value/unit changes and month rollover', async () => {
    const september = await readAppBudgetStatus(
      appkitFor(budgets('USD', 100), {
        id: 'approval-1',
        approved_by: 'admin@example.com',
        approved_at: '2026-09-15T12:01:00Z',
        revoked_by: '',
        revoked_at: '',
      }) as never,
      {} as never,
      { now: NOW, measure: measured(110, 'USD') }
    );
    expect(september.level).toBe('approved-overage');

    forgetAppBudgetStatus();
    forgetCostBudgets();
    const changed = await readAppBudgetStatus(appkitFor(budgets('DBU', 100)) as never, {} as never, {
      now: NOW,
      measure: measured(110, 'DBU'),
    });
    expect(changed.level).toBe('approval-required');
    expect(changed.budgetFingerprint).not.toBe(september.budgetFingerprint);

    forgetAppBudgetStatus();
    forgetCostBudgets();
    const october = await readAppBudgetStatus(appkitFor(budgets('USD', 100)) as never, {} as never, {
      now: Date.parse('2026-10-15T12:00:00Z'),
      measure: measured(110, 'USD'),
    });
    expect(october.monthStart).toBe('2026-10-01');
    expect(october.level).toBe('approval-required');
  });

  it('coalesces current reads for at most sixty seconds and invalidation forces a new read', async () => {
    const appkit = appkitFor(budgets('USD', 100));
    const measure = vi.fn(measured(10, 'USD'));
    await Promise.all([
      readAppBudgetStatus(appkit as never, {} as never, { now: NOW, measure }),
      readAppBudgetStatus(appkit as never, {} as never, { now: NOW, measure }),
    ]);
    expect(measure).toHaveBeenCalledTimes(1);
    forgetAppBudgetStatus();
    await readAppBudgetStatus(appkit as never, {} as never, { now: NOW + 1, measure });
    expect(measure).toHaveBeenCalledTimes(2);
  });
});
