import { describe, expect, it } from 'vitest';

import {
  APP_BUDGET_APPROVAL_PERCENT,
  APP_BUDGET_GUARDRAILS,
  APP_BUDGET_WARNING_PERCENT,
  appBudgetPeriod,
  budgetLevelFor,
} from './app-budget-guard';

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

  it('publishes methodology from the same enforcement thresholds', () => {
    expect(APP_BUDGET_WARNING_PERCENT).toBe(80);
    expect(APP_BUDGET_APPROVAL_PERCENT).toBe(100);
    expect(APP_BUDGET_GUARDRAILS).toContainEqual({
      label: 'Warning',
      value: `${APP_BUDGET_WARNING_PERCENT}% — questions continue`,
    });
    expect(APP_BUDGET_GUARDRAILS).toContainEqual({
      label: 'Approval required',
      value: `${APP_BUDGET_APPROVAL_PERCENT}% — new questions pause until an administrator approves`,
    });
    expect(APP_BUDGET_GUARDRAILS).toContainEqual({ label: 'Resource budgets', value: 'Advisory only' });
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
