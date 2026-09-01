import { describe, expect, it } from 'vitest';

import { budgetPlaceholder, costSpendSummary, resourceBudgetBaseline } from './cost-budget-view';
import type { CostTile, OpsCostPayload } from '../../shared/ops-contract';

function tile(overrides: Partial<CostTile>): CostTile {
  return {
    id: 'component',
    label: 'Component',
    resourceId: 'resource',
    resourceKind: '',
    quality: 'real',
    amount: 0,
    dbus: null,
    basis: 'total-in-range',
    population: 'This app',
    attribution: 'deployment',
    pricing: {
      source: 'list_prices',
      match: 'priced',
      currency: 'USD',
      pricedQuantity: 1,
      unpricedQuantity: 0,
      pricedRows: 1,
      unpricedRows: 0,
      unpricedSkus: [],
      duplicateMatches: 0,
      correctionRows: 0,
      priceEffectiveAt: '',
    },
    unavailable: '',
    remedy: '',
    note: '',
    evidence: { billingRows: 1, astrolabeQueries: null },
    ...overrides,
  };
}

describe('cost budget placeholders', () => {
  it('selects only the observed value for the active unit', () => {
    const observed = { USD: 12.345, DBU: 98.765 };
    expect(budgetPlaceholder(observed, 'USD')).toBe('12.35');
    expect(budgetPlaceholder(observed, 'DBU')).toBe('98.77');
  });

  it('does not invent a baseline for an unavailable unit', () => {
    expect(budgetPlaceholder({ USD: 8, DBU: null }, 'DBU')).toBe('');
  });

  it('keeps a successful zero Vector Search read as an editable zero baseline', () => {
    const vector = tile({
      id: 'vector-search',
      amount: 0,
      dbus: 0,
      basis: 'per-day',
      note: 'No billable usage in this period',
      evidence: { billingRows: 0, astrolabeQueries: null },
    });
    expect(resourceBudgetBaseline(vector, 'USD')).toBe(0);
    expect(resourceBudgetBaseline(vector, 'DBU')).toBe(0);
    expect(budgetPlaceholder({ USD: 0, DBU: 0 }, 'USD')).toBe('0');
  });

  it('withholds unavailable and partial USD baselines while preserving measured DBUs', () => {
    const partial = tile({
      amount: 9,
      dbus: 3,
      pricing: { ...tile({}).pricing!, match: 'partial' },
    });
    expect(resourceBudgetBaseline(partial, 'USD')).toBeNull();
    expect(resourceBudgetBaseline(partial, 'DBU')).toBe(3);
    expect(resourceBudgetBaseline(tile({ amount: null, dbus: null }), 'USD')).toBeNull();
  });

  it('uses mutually exclusive SQL and Genie allocations, each tile basis, and the selected unit', () => {
    const payload = {
      range: { from: '2026-08-01', to: '2026-08-03' },
      currency: 'USD',
      tiles: [
        tile({ id: 'serving-endpoint', amount: 4, dbus: 2 }),
        tile({ id: 'vector-search', amount: 3, dbus: 5, basis: 'per-day' }),
        tile({ id: 'sql-warehouse', amount: 6 }),
        tile({ id: 'genie:data', amount: 7 }),
        tile({ id: 'genie:dictionary', amount: 8 }),
      ],
    } as Pick<OpsCostPayload, 'range' | 'currency' | 'tiles'>;
    expect(costSpendSummary(payload, 'USD')).toMatchObject({ amount: 34, dbus: null });
    expect(costSpendSummary(payload, 'DBU')).toMatchObject({ amount: null, dbus: 17 });

    const refreshed = {
      ...payload,
      tiles: payload.tiles.map((item) => (item.id === 'vector-search' ? { ...item, amount: 10, dbus: 8 } : item)),
    };
    expect(costSpendSummary(refreshed, 'USD')).toMatchObject({ amount: 55, dbus: null });
    expect(costSpendSummary(refreshed, 'DBU')).toMatchObject({ amount: null, dbus: 26 });
  });
});
