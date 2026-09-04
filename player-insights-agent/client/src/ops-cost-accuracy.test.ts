import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { CostTile, GenieInstanceAccounting, OpsCostPayload } from '../../shared/ops-contract';
import { costCardView, genieCostCardViews, questionCostCardView } from './ops-view';

function tile(overrides: Partial<CostTile> & Pick<CostTile, 'id'>): CostTile {
  return {
    label: overrides.id,
    resourceId: 'configured-resource',
    quality: 'real',
    amount: 0,
    dbus: 0,
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
      priceEffectiveAt: '2026-01-01T00:00:00Z',
    },
    unavailable: '',
    remedy: '',
    note: '',
    ...overrides,
  };
}

function payload(tiles: CostTile[]): OpsCostPayload {
  return {
    tiles,
    currency: 'USD',
    throughDay: '2026-09-02',
    perQuestion: {
      runs: [],
      runsInRange: 4,
      tokenCoveredRuns: 4,
      totalRecordedTokens: 400,
      complete: true,
      requestCoveredRuns: 4,
      traceCoveredRuns: 4,
      timingCoveredRuns: 4,
      reason: '',
    },
  } as unknown as OpsCostPayload;
}

function genie(overrides: Partial<GenieInstanceAccounting> & Pick<GenieInstanceAccounting, 'tileId'>) {
  return {
    spaceId: `space-${overrides.tileId}`,
    label: overrides.tileId,
    attribution: 'query-history-exact',
    sourceDbus: 10,
    allowanceUsedDbus: 0,
    promotionalDbus: 0,
    chargedEffectiveDbus: 10,
    chargedRawEquivalentDbus: 7.5,
    unknownDbus: 0,
    paidUsd: 7.5,
    freeEquivalentUsd: 0,
    underlyingTotalDbus: 10,
    pricingState: 'priced',
    surfaces: [],
    ...overrides,
  } satisfies GenieInstanceAccounting;
}

describe('Cost component accuracy presentation', () => {
  it('shows concise total tokens and distinguishes unavailable from true zero', () => {
    const foundation = tile({
      id: 'foundation-model',
      amount: 4.2,
      evidence: {
        billingRows: 2,
        astrolabeQueries: null,
        tokens: { input: 800, output: 200, total: 1000, requests: 4, coveredRequests: 4 },
      },
    });
    expect(costCardView(foundation, payload([foundation]))).toMatchObject({
      secondaryMetric: '1,000 total tokens',
      evidence: '',
    });
    const unavailable = { ...foundation, evidence: { ...foundation.evidence!, tokens: null } };
    expect(costCardView(unavailable, payload([unavailable])).secondaryMetric).toBe('— total tokens');
    const zero = {
      ...foundation,
      evidence: {
        ...foundation.evidence!,
        tokens: { input: 0, output: 0, total: 0, requests: 0, coveredRequests: 0 },
      },
    };
    expect(costCardView(zero, payload([zero])).secondaryMetric).toBe('0 total tokens');
  });

  it('keeps endpoint total off the marginal average numerator and removes request-count copy', () => {
    const serving = tile({
      id: 'serving-endpoint',
      amount: 64,
      marginalAmount: 0.2,
      evidence: { billingRows: 8, astrolabeQueries: null, interactiveRequests: 4, coveredRequests: 4 },
    });
    const foundation = tile({ id: 'foundation-model', amount: 0.4 });
    const sql = tile({ id: 'sql-warehouse', amount: 0.2 });
    const current = payload([serving, foundation, sql]);
    expect(costCardView(serving, current)).toMatchObject({ amount: '64.00 USD', evidence: '' });
    expect(questionCostCardView(current).amount).toBe('0.20 USD');
    expect(costCardView(serving, current).evidence).not.toMatch(/interactive requests/);
  });

  it('keeps Free and Charged per-space and comparable in either ordering', () => {
    const chargedHigher = genie({
      tileId: 'genie:data',
      allowanceUsedDbus: 1,
      chargedEffectiveDbus: 9,
      paidUsd: 4.51,
      freeEquivalentUsd: 0.53,
    });
    const freeHigher = genie({
      tileId: 'genie:dictionary',
      allowanceUsedDbus: 9,
      chargedEffectiveDbus: 1,
      paidUsd: 1.21,
      freeEquivalentUsd: 7.85,
    });
    const views = genieCostCardViews(
      payload([
        tile({ id: chargedHigher.tileId, genieInstanceAccounting: chargedHigher }),
        tile({ id: freeHigher.tileId, genieInstanceAccounting: freeHigher }),
      ])
    );
    expect(views).toEqual([
      { id: 'genie:data', title: 'Data Genie', charged: '$4.51', free: '$0.53' },
      { id: 'genie:dictionary', title: 'Dictionary Genie', charged: '$1.21', free: '$7.85' },
    ]);
    const dbus = genieCostCardViews(
      payload([
        tile({ id: chargedHigher.tileId, genieInstanceAccounting: chargedHigher }),
        tile({ id: freeHigher.tileId, genieInstanceAccounting: freeHigher }),
      ]),
      'DBU'
    );
    expect(dbus[0]).toMatchObject({ charged: '9.00 DBU', free: '1.00 DBU' });
    expect(dbus[1]).toMatchObject({ charged: '1.00 DBU', free: '9.00 DBU' });
  });

  it('keeps the exact Free versus Charged distinction in methodology only', () => {
    const source = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain(
      'Free is waived list-price value. Charged is usage actually billed after allowance and promotion rules. Either can be larger.'
    );
  });
});
