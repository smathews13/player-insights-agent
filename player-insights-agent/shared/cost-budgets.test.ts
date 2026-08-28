import { describe, expect, it } from 'vitest';

import {
  COST_BUDGET_MAX,
  CostBudgetsSchema,
  EMPTY_COST_BUDGETS,
  budgetsForVisibleTiles,
  parseCostBudgets,
  resourceBudget,
  withResourceBudget,
  withTotalBudget,
} from './cost-budgets';

describe('nominal cost budgets', () => {
  it('treats a missing amount as unset rather than zero', () => {
    expect(EMPTY_COST_BUDGETS.total).toBeNull();
    expect(resourceBudget(EMPTY_COST_BUDGETS, 'app-compute')).toBeNull();
    expect(CostBudgetsSchema.parse({ total: 0, resources: { 'app-compute': 0 } })).toEqual({
      total: 0,
      resources: { 'app-compute': 0 },
    });
  });

  it('accepts a total and a per-tile amount independently', () => {
    const stored = parseCostBudgets({
      total: 400,
      resources: { 'app-compute': 40, 'genie:space-data': 12.5 },
    });
    expect(stored?.total).toBe(400);
    expect(resourceBudget(stored!, 'app-compute')).toBe(40);
    expect(resourceBudget(stored!, 'genie:space-data')).toBe(12.5);
    expect(resourceBudget(stored!, 'sql-warehouse')).toBeNull();
  });

  it('refuses a negative or non-finite amount rather than storing it', () => {
    expect(parseCostBudgets({ total: -1, resources: {} })).toBeNull();
    expect(parseCostBudgets({ total: Number.POSITIVE_INFINITY, resources: {} })).toBeNull();
    expect(parseCostBudgets({ total: 10, resources: { 'app-compute': -0.01 } })).toBeNull();
  });

  it('drops keys that are no longer on the Cost grid', () => {
    const stored = withResourceBudget(withTotalBudget(EMPTY_COST_BUDGETS, 100), 'genie:old-space', 25);
    expect(budgetsForVisibleTiles(stored, ['app-compute', 'serving-endpoint'])).toEqual({
      total: 100,
      resources: { 'app-compute': null, 'serving-endpoint': null },
    });
  });

  it('removes retired rebuild and unproven shared-endpoint budgets from stored payloads', () => {
    expect(
      parseCostBudgets({
        total: 100,
        resources: {
          'app-compute': 25,
          'foundation-model': 50,
          'index-rebuild-job': 75,
        },
      })
    ).toEqual({ total: 100, resources: { 'app-compute': 25 } });
  });

  it('keeps a typed amount inside the schema ceiling', () => {
    expect(parseCostBudgets({ total: COST_BUDGET_MAX, resources: {} })?.total).toBe(COST_BUDGET_MAX);
    expect(parseCostBudgets({ total: COST_BUDGET_MAX + 1, resources: {} })).toBeNull();
  });
});
