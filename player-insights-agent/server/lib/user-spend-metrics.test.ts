import { describe, expect, it } from 'vitest';
import { buildUserSpendMetrics, spendGrowth, userSpendComparisonWindows } from './user-spend-metrics';

describe('user spend metrics', () => {
  it('derives selected-unit aggregates from comparable server totals', () => {
    const metrics = buildUserSpendMetrics({
      unit: 'USD',
      current: {
        amount: 120,
        comparable: true,
        questions: 24,
        coveredDays: 6,
        appTotal: 600,
        appComparable: true,
      },
      week: {
        current: { amount: 120, comparable: true },
        prior: { amount: 100, comparable: true },
      },
      month: {
        current: { amount: 90, comparable: true },
        prior: { amount: 120, comparable: true },
      },
      comparisonFreshness: '2026-09-01',
    });
    expect(metrics.costPerQuestion.value).toBe(5);
    expect(metrics.averageDaily.value).toBe(20);
    expect(metrics.appShare.value).toBe(20);
    expect(metrics.weekOverWeek.value).toBe(20);
    expect(metrics.monthOverMonth.value).toBe(-25);
    expect(metrics.comparisonFreshness).toBe('2026-09-01');
  });

  it('does not invent ratios from zero, missing, or incomparable values', () => {
    expect(spendGrowth({ amount: 4, comparable: true }, { amount: 0, comparable: true }, 'prior').state).toBe('new');
    expect(spendGrowth({ amount: 0, comparable: true }, { amount: 0, comparable: true }, 'prior').value).toBe(0);
    expect(spendGrowth({ amount: 4, comparable: false }, { amount: 2, comparable: true }, 'prior').state).toBe(
      'unavailable'
    );
    const metrics = buildUserSpendMetrics({
      unit: 'DBU',
      current: {
        amount: 10,
        comparable: true,
        questions: 0,
        coveredDays: 0,
        appTotal: null,
        appComparable: false,
      },
      week: {
        current: { amount: null, comparable: false },
        prior: { amount: null, comparable: false },
      },
      month: {
        current: { amount: null, comparable: false },
        prior: { amount: null, comparable: false },
      },
      comparisonFreshness: '2026-09-01',
    });
    expect(metrics.costPerQuestion.state).toBe('unavailable');
    expect(metrics.averageDaily.state).toBe('unavailable');
    expect(metrics.appShare.state).toBe('unavailable');
  });

  it('builds complete-week and matched MTD windows across month, leap, and year boundaries', () => {
    expect(userSpendComparisonWindows('2026-01-03')).toEqual({
      week: {
        current: { from: '2025-12-28', to: '2026-01-03' },
        prior: { from: '2025-12-21', to: '2025-12-27' },
      },
      month: {
        current: { from: '2026-01-01', to: '2026-01-03' },
        prior: { from: '2025-12-01', to: '2025-12-03' },
      },
    });
    expect(userSpendComparisonWindows('2024-03-31')?.month.prior).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
    expect(userSpendComparisonWindows('not-a-day')).toBeNull();
  });
});
