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
    expect(EMPTY_COST_BUDGETS.total).toEqual({ USD: null, DBU: null });
    expect(resourceBudget(EMPTY_COST_BUDGETS, 'app-compute')).toEqual({ USD: null, DBU: null });
    expect(CostBudgetsSchema.parse({ total: 0, resources: { 'app-compute': 0 } })).toEqual({
      total: { USD: 0, DBU: null },
      resources: { 'app-compute': { USD: 0, DBU: null } },
    });
  });

  it('accepts a total and a per-tile amount independently', () => {
    const stored = parseCostBudgets({
      total: 400,
      resources: { 'app-compute': 40, 'genie:space-data': 12.5 },
    });
    expect(stored?.total).toEqual({ USD: 400, DBU: null });
    expect(resourceBudget(stored!, 'app-compute')).toEqual({ USD: 40, DBU: null });
    expect(resourceBudget(stored!, 'genie:space-data')).toEqual({ USD: 12.5, DBU: null });
    expect(resourceBudget(stored!, 'sql-warehouse')).toEqual({ USD: null, DBU: null });
  });

  it('refuses a negative or non-finite amount rather than storing it', () => {
    expect(parseCostBudgets({ total: -1, resources: {} })).toBeNull();
    expect(parseCostBudgets({ total: Number.POSITIVE_INFINITY, resources: {} })).toBeNull();
    expect(parseCostBudgets({ total: 10, resources: { 'app-compute': -0.01 } })).toBeNull();
  });

  it('drops keys that are no longer on the Cost grid', () => {
    const stored = withResourceBudget(withTotalBudget(EMPTY_COST_BUDGETS, 100), 'genie:old-space', 25);
    expect(budgetsForVisibleTiles(stored, ['app-compute', 'serving-endpoint'])).toEqual({
      total: { USD: 100, DBU: null },
      resources: {
        'app-compute': { USD: null, DBU: null },
        'serving-endpoint': { USD: null, DBU: null },
      },
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
    ).toEqual({
      total: { USD: 100, DBU: null },
      resources: {
        'foundation-model': { USD: 50, DBU: null },
        'app-compute': { USD: 25, DBU: null },
      },
    });
  });

  it('keeps a typed amount inside the schema ceiling', () => {
    expect(parseCostBudgets({ total: COST_BUDGET_MAX, resources: {} })?.total.USD).toBe(COST_BUDGET_MAX);
    expect(parseCostBudgets({ total: COST_BUDGET_MAX + 1, resources: {} })).toBeNull();
  });

  it('migrates a legacy unit into one slot and preserves dual-unit values without conversion', () => {
    expect(parseCostBudgets({ total: { value: 7, unit: 'DBU' }, resources: {} })?.total).toEqual({
      USD: null,
      DBU: 7,
    });
    expect(parseCostBudgets({ total: { USD: 54.81, DBU: 78.25 }, resources: {} })?.total).toEqual({
      USD: 54.81,
      DBU: 78.25,
    });
  });
});
