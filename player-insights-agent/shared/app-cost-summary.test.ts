import { describe, expect, it } from 'vitest';

import { appCostSummary, appSpendFigure } from './app-cost-summary';
import type { OpsCostPayload } from './ops-contract';

const payload = {
  range: { from: '2026-09-01', to: '2026-09-02' },
  throughDay: '2026-09-02',
  currency: 'USD',
  honesty: {
    priceSource: 'list_prices',
    contractRates: 'unavailable',
    dataThrough: '2026-09-02',
    rangeMayStillFill: false,
    currencyConsistent: true,
  },
  tiles: [
    {
      id: 'genie:data',
      label: 'Data Genie',
      resourceId: 'space-data',
      quality: 'estimate',
      amount: 0.7,
      dbus: 15,
      basis: 'total-in-range',
      population: 'This Genie space',
      attribution: 'deployment',
      pricing: {
        source: 'list_prices',
        match: 'partial',
        currency: 'USD',
        pricedQuantity: 10,
        unpricedQuantity: 5,
        pricedRows: 1,
        unpricedRows: 1,
        unpricedSkus: ['UNPRICED'],
        duplicateMatches: 0,
        correctionRows: 0,
        priceEffectiveAt: '2026-01-01',
      },
      unavailable: '',
      remedy: '',
      note: '',
    },
  ],
} satisfies Pick<OpsCostPayload, 'range' | 'throughDay' | 'currency' | 'honesty' | 'tiles'>;

describe('app spend figures', () => {
  it('shows a known paid subtotal while enforcement keeps incomplete pricing fail-open', () => {
    expect(appCostSummary(payload, 'USD')).toMatchObject({ amount: null });
    expect(appSpendFigure(payload)).toMatchObject({
      amount: 0.7,
      dbus: 15,
      completeness: 'partial',
      estimated: true,
    });
  });
});
