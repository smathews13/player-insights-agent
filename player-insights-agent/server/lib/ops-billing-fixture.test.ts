/**
 * Deterministic billing-fixture suite for the SME cost-tracking audit (F10).
 *
 * These cases run through the same TypeScript price-join and tile builders the
 * Cost route uses. They do not hit a warehouse, and they do not import the
 * client graph (server typecheck cannot see Vite `?raw` modules).
 */
import { describe, expect, it } from 'vitest';

import {
  BILLING_TAG_KEY,
  buildCostStatement,
  buildCoverage,
  buildHonesty,
  buildQuestionAttribution,
  buildTiles,
  pricingFromRow,
  spendAmountFor,
  type ComponentRow,
  type CostIdentifiers,
} from './ops-billing';

const IDS: CostIdentifiers = {
  appName: 'player-insights',
  endpointName: 'player-insights-agent',
  warehouseId: 'warehouse-1',
  vectorEndpoint: 'vs-endpoint',
  vectorIndex: 'cat.schema.index',
  genieSpaces: [{ id: 'space-data', label: 'Data Genie space' }],
  workspaceId: 'workspace-1',
  telemetryEnabled: false,
  appBillingTag: 'matched',
};
const RANGE = { from: '2026-08-10', to: '2026-08-16' };

function row(overrides: Partial<ComponentRow> & Pick<ComponentRow, 'component'>): ComponentRow {
  return {
    kind: 'component',
    spend: 12,
    currency: 'USD',
    currencyCount: 1,
    billedDays: 2,
    jobRuns: null,
    lastDay: RANGE.to,
    pricedQuantity: 10,
    unpricedQuantity: 0,
    pricedRows: 1,
    unpricedRows: 0,
    unpricedSkus: [],
    priceMatchStatus: 'priced',
    correctionRows: 0,
    duplicateMatches: 0,
    priceEffectiveAt: '2026-01-01T00:00:00Z',
    taggedRows: 1,
    untaggedRows: 0,
    ...overrides,
  };
}

describe('billing SQL contract', () => {
  const query = buildCostStatement(IDS, RANGE);

  it('does not coalesce a missing list price to zero', () => {
    expect(query?.statement).not.toContain('COALESCE(p.pricing.default, 0)');
    expect(query?.statement).toContain(
      'WHEN unit_price IS NOT NULL AND price_match_count = 1 THEN usage_quantity * unit_price'
    );
    expect(query?.statement).toContain('ELSE CAST(NULL AS DOUBLE)');
  });

  it('joins list prices on sku, cloud, usage unit, and the validity window', () => {
    expect(query?.statement).toContain('t.sku_name = p.sku_name');
    expect(query?.statement).toContain('t.cloud = p.cloud');
    expect(query?.statement).toContain('t.usage_unit = p.usage_unit');
    expect(query?.statement).toContain('t.usage_end_time >= p.price_start_time');
  });

  it('returns priced and unpriced quantities instead of a silent zero', () => {
    expect(query?.statement).toContain('priced_quantity');
    expect(query?.statement).toContain('unpriced_quantity');
    expect(query?.statement).toContain('priced_rows');
    expect(query?.statement).toContain('unpriced_rows');
    expect(query?.statement).toContain('unpriced_skus');
    expect(query?.statement).toContain('price_match_status');
  });

  it('flags duplicate price matches and mixed currencies', () => {
    expect(query?.statement).toContain("THEN 'duplicate'");
    expect(query?.statement).toContain("THEN 'mixed-currency'");
  });

  it('keeps correction metadata and does not reduce currency with a bare MAX', () => {
    expect(query?.statement).toContain("record_type ILIKE '%CORRECT%'");
    expect(query?.statement).toContain('COUNT(DISTINCT CASE WHEN currency_code IS NOT NULL THEN currency_code END)');
  });

  it('filters tagged usage and still looks for untagged leakage on known resources', () => {
    expect(query?.statement).toContain(`u.custom_tags['${BILLING_TAG_KEY}'] = 'astrolabe'`);
    expect(query?.statement).toContain("'propagation'");
    expect(query?.statement).toContain('untagged_rows');
  });
});

describe('price join golden outputs', () => {
  it('treats a fully priced serving row as measured spend', () => {
    const serving = buildTiles(IDS, [row({ component: 'serving-endpoint' })]).find(
      (tile) => tile.id === 'serving-endpoint'
    );
    expect(serving?.amount).toBe(12);
    expect(serving?.quality).toBe('real');
    expect(serving?.pricing?.match).toBe('priced');
    expect(serving?.attribution).toBe('deployment');
  });

  it('does not render unmatched prices as a measured zero', () => {
    const serving = buildTiles(IDS, [
      row({
        component: 'serving-endpoint',
        spend: 0,
        pricedRows: 0,
        unpricedRows: 1,
        unpricedQuantity: 40,
        unpricedSkus: ['PREMIUM_SQL'],
        priceMatchStatus: 'unpriced',
      }),
    ]).find((tile) => tile.id === 'serving-endpoint');
    expect(serving?.amount).toBeNull();
    expect(serving?.quality).toBe('unknown');
    expect(serving?.unavailable).toContain('PREMIUM_SQL');
    expect(serving?.pricing?.match).toBe('unpriced');
  });

  it('withholds spend when two list prices match one usage row', () => {
    const pricing = pricingFromRow(
      row({
        component: 'sql-warehouse',
        spend: 24,
        duplicateMatches: 2,
        priceMatchStatus: 'duplicate',
      })
    );
    expect(pricing.match).toBe('duplicate');
    expect(
      spendAmountFor(
        row({ component: 'sql-warehouse', spend: 24, duplicateMatches: 2, priceMatchStatus: 'duplicate' }),
        'total-in-range'
      )
    ).toBeNull();
  });

  it('withholds a mixed-currency total rather than taking MAX(currency)', () => {
    const tile = buildTiles(IDS, [
      row({
        component: 'serving-endpoint',
        spend: 12,
        currency: 'USD',
        currencyCount: 2,
        priceMatchStatus: 'mixed-currency',
      }),
    ]).find((item) => item.id === 'serving-endpoint');
    expect(tile?.amount).toBeNull();
    expect(tile?.unavailable).toMatch(/Mixed currencies/);
  });

  it('keeps a partial priced amount and names the unpriced SKUs', () => {
    const tile = buildTiles(IDS, [
      row({
        component: 'serving-endpoint',
        spend: 12,
        pricedRows: 1,
        unpricedRows: 1,
        unpricedSkus: ['NEW_SKU'],
        priceMatchStatus: 'partial',
      }),
    ]).find((item) => item.id === 'serving-endpoint');
    expect(tile?.amount).toBe(12);
    expect(tile?.pricing?.match).toBe('partial');
    expect(tile?.note).toContain('NEW_SKU');
  });

  it('counts correction rows without turning them into a silent zero', () => {
    const pricing = pricingFromRow(
      row({
        component: 'sql-warehouse',
        spend: 9,
        correctionRows: 2,
        pricedRows: 3,
      })
    );
    expect(pricing.correctionRows).toBe(2);
    expect(pricing.match).toBe('priced');
  });
});

describe('coverage, shared meters, and Genie', () => {
  it('reports tagged usage that has no Cost tile', () => {
    const coverage = buildCoverage({
      inventoryCount: 11,
      range: RANGE,
      coverageRows: [
        row({ kind: 'coverage', component: 'JOBS', taggedRows: 4, pricedRows: 4, unpricedRows: 0 }),
        row({ kind: 'coverage', component: 'SQL', taggedRows: 8, pricedRows: 8, unpricedRows: 0 }),
      ],
      propagationRows: [
        row({ kind: 'propagation', component: 'APPS', taggedRows: 0, untaggedRows: 3 }),
        row({ kind: 'propagation', component: 'SQL', taggedRows: 8, untaggedRows: 0 }),
      ],
    });
    expect(coverage.costModelCount).toBe(5);
    expect(coverage.inventoryCount).toBe(11);
    expect(coverage.products.find((product) => product.product === 'JOBS')).toMatchObject({
      tiled: false,
      taggedRows: 4,
    });
    expect(coverage.propagation.find((item) => item.product === 'APPS')?.status).toBe('unsupported');
    expect(coverage.propagation.find((item) => item.product === 'SQL')?.status).toBe('propagated');
  });

  it('labels a whole-warehouse meter as a shared upper bound', () => {
    const tile = buildTiles(IDS, [row({ component: 'sql-warehouse', spend: 50 })]).find(
      (item) => item.id === 'sql-warehouse'
    );
    expect(tile?.population).toBe('Whole warehouse');
    expect(tile?.attribution).toBe('shared-upper-bound');
  });

  it('keeps Genie space cards dollar-free and names LLM spend as not attributable', () => {
    const genie = buildTiles(IDS, [row({ component: 'genie', spend: 99 })]).filter((tile) =>
      tile.id.startsWith('genie:')
    );
    expect(genie).toHaveLength(1);
    expect(genie[0].amount).toBeNull();
    expect(genie[0].unavailable).toContain('Genie LLM spend not attributable');
    expect(genie[0].note).toContain('not the complete Genie cost');
  });

  it('says list prices, not contracted rates, and when the range may still fill', () => {
    const tiles = buildTiles(IDS, [row({ component: 'serving-endpoint' })]);
    const honesty = buildHonesty(RANGE, row({ kind: 'range', component: '__range', lastDay: '2026-08-14' }), tiles);
    expect(honesty.priceSource).toBe('list_prices');
    expect(honesty.contractRates).toBe('unavailable');
    expect(honesty.rangeMayStillFill).toBe(true);
    expect(honesty.dataThrough).toBe('2026-08-14');
  });
});

describe('per-question average eligibility', () => {
  it('keeps a dedicated this-endpoint measurement priced', () => {
    const serving = buildTiles(IDS, [row({ component: 'serving-endpoint' })]).find(
      (tile) => tile.id === 'serving-endpoint'
    );
    expect(serving?.population).toBe('This endpoint');
    expect(serving?.attribution).toBe('deployment');
    expect(serving?.quality).toBe('real');
  });

  it('widens a missing endpoint name to a whole-workspace estimate', () => {
    const serving = buildTiles(
      { ...IDS, endpointName: '' },
      [row({ kind: 'component', component: 'serving-endpoint:workspace', spend: 12 })]
    ).find((tile) => tile.id === 'serving-endpoint');
    expect(serving?.population).toBe('Whole workspace');
    expect(serving?.attribution).toBe('shared-upper-bound');
    expect(serving?.quality).toBe('estimate');
  });

  it('does not count a zero-token run in the denominator', () => {
    const attribution = buildQuestionAttribution(
      [
        {
          runId: 'run-1',
          correlationId: 'req-1',
          traceId: 'trace-1',
          completedAt: '2026-08-16T10:00:00Z',
          totalTokens: 0,
          runsInRange: 1,
          tokenCoveredRuns: 0,
          totalRecordedTokens: 0,
        },
      ],
      buildTiles(IDS, [row({ component: 'serving-endpoint' })]),
      100
    );
    expect(attribution.tokenCoveredRuns).toBe(0);
    expect(attribution.totalRecordedTokens).toBe(0);
  });
});
