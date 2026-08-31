import { describe, expect, it } from 'vitest';

import { budgetPlaceholder, costSpendSummary } from './cost-budget-view';
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
