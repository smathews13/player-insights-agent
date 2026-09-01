import { describe, expect, it } from 'vitest';

import { appBudgetPeriod, budgetLevelFor } from './app-budget-guard';

describe('app budget threshold math', () => {
  it.each([
    [79.99, 'below'],
    [80, 'warning'],
    [99.99, 'warning'],
    [100, 'approval-required'],
    [125, 'approval-required'],
  ] as const)('classifies %s%% deterministically', (measured, level) => {
    expect(budgetLevelFor(measured, 100).level).toBe(level);
  });

  it('rounds binary-float noise before equality decisions', () => {
    expect(budgetLevelFor(0.799999999999, 1).level).toBe('warning');
    expect(budgetLevelFor(0.999999999999, 1).level).toBe('approval-required');
  });

  it('uses UTC calendar months and complete billing days', () => {
    expect(appBudgetPeriod(Date.parse('2026-09-15T23:59:00Z'))).toEqual({
      monthStart: '2026-09-01',
      monthEnd: '2026-09-30',
      measurementThrough: '2026-09-14',
    });
    expect(appBudgetPeriod(Date.parse('2026-10-01T00:01:00Z'))).toEqual({
      monthStart: '2026-10-01',
      monthEnd: '2026-10-31',
      measurementThrough: '2026-09-30',
    });
  });
});
