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
  dbuAmountFor,
  pricingFromRow,
  readComponentRows,
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
  vectorEndpointIndexCount: 1,
  vectorIdentityError: '',
  genieSpaces: [
    { id: 'space-data', label: 'Data Genie', tool: 'data_genie', tileId: 'genie:data' },
    {
      id: 'space-dictionary',
      label: 'Dictionary Genie',
      tool: 'dictionary_genie',
      tileId: 'genie:dictionary',
    },
  ],
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

  it('returns a DBU row count so mixed DBU and storage units do not erase measured DBUs', () => {
    expect(query?.statement).toContain(
      "COUNT(priced.record_id) FILTER (WHERE UPPER(TRIM(priced.usage_unit)) = 'DBU') AS dbu_rows"
    );
    expect(query?.statement).toContain("SUM(CASE WHEN UPPER(TRIM(priced.usage_unit)) = 'DBU'");
  });

  it('flags duplicate price matches and mixed currencies', () => {
    expect(query?.statement).toContain("THEN 'duplicate'");
    expect(query?.statement).toContain("THEN 'mixed-currency'");
  });

  it('keeps correction metadata and does not reduce currency with a bare MAX', () => {
    expect(query?.statement).toContain("record_type ILIKE '%CORRECT%'");
    expect(query?.statement).toContain(
      'COUNT(DISTINCT CASE WHEN priced.currency_code IS NOT NULL THEN priced.currency_code END)'
    );
  });

  it('measures exact untagged resources, including the configured Vector Search endpoint', () => {
    expect(query?.statement).toContain(`u.custom_tags['${BILLING_TAG_KEY}'] = 'astrolabe'`);
    expect(query?.statement).toContain(
      "u.billing_origin_product = 'VECTOR_SEARCH' AND u.usage_metadata.endpoint_name = :vectorEndpoint"
    );
    expect(query?.parameters).toContainEqual({ name: 'vectorEndpoint', value: 'vs-endpoint', type: 'STRING' });
    expect(query?.statement).toContain(
      "OR (u.billing_origin_product = 'APPS' AND u.usage_metadata.app_name = :appName)"
    );
    expect(query?.statement).toContain("'propagation'");
    expect(query?.statement).toContain('untagged_rows');
  });
});

describe('Vector Search measured-unit fixtures', () => {
  it('retains DBUs when a realistic endpoint aggregate also contains storage units', () => {
    const [parsed] = readComponentRows([
      [
        'component',
        'vector-search',
        '14.00',
        'USD',
        '1',
        '2',
        null,
        RANGE.to,
        '8',
        '0',
        '2',
        '0',
        '',
        'priced',
        '0',
        '0',
        '2026-01-01T00:00:00Z',
        '2',
        '0',
        '2',
        '6.00',
        '1',
      ],
    ]);
    expect(parsed).toMatchObject({ usageUnitCount: 2, dbuQuantity: 6, dbuRows: 1 });
    expect(dbuAmountFor(parsed, 'per-day')).toBe(3);
  });

  it('distinguishes a proven zero DBU from missing DBU evidence', () => {
    expect(dbuAmountFor(row({ component: 'vector-search', dbuRows: 1, dbuQuantity: 0 }), 'total-in-range')).toBe(0);
    expect(dbuAmountFor(row({ component: 'vector-search', dbuRows: 0, dbuQuantity: 0 }), 'total-in-range')).toBeNull();
  });

  it('uses the full dedicated endpoint meter without query-share apportionment', () => {
    const vector = buildTiles(
      IDS,
      [row({ component: 'vector-search', spend: 12, billedDays: 2, dbuRows: 1, dbuQuantity: 10 })],
      undefined,
      [{ tileId: 'vector-search', calls: 2, observedCalls: 10 }]
    ).find((tile) => tile.id === 'vector-search');
    expect(vector).toMatchObject({
      amount: 6,
      dbus: 5,
      quality: 'rate',
      population: 'Hosting endpoint',
      attribution: 'deployment',
    });
    expect(vector?.note).toContain('endpoint hosts only the active index');
  });

  it('renders a measured zero only when the exact endpoint query returned no billable rows', () => {
    const vector = buildTiles(IDS, [
      row({
        component: 'vector-search',
        spend: 0,
        billedDays: 0,
        pricedRows: 0,
        unpricedRows: 0,
        priceMatchStatus: 'none',
        dbuRows: 0,
        dbuQuantity: 0,
      }),
    ]).find((tile) => tile.id === 'vector-search');
    expect(vector).toMatchObject({ amount: 0, dbus: 0, attribution: 'deployment' });
    expect(vector?.note).toBe('No billable usage in this period');
  });

  it('does not attribute endpoint spend when the active index identity is unavailable', () => {
    const vector = buildTiles({ ...IDS, vectorIndex: '' }, [
      row({ component: 'vector-search', spend: 12, billedDays: 2, dbuRows: 1, dbuQuantity: 10 }),
    ]).find((tile) => tile.id === 'vector-search');
    expect(vector).toMatchObject({
      resourceId: 'vs-endpoint',
      resourceKind: 'vector-endpoint',
      amount: null,
      attribution: 'unavailable',
    });
    expect(vector?.unavailable).toContain('active Vector Search index was not carried');
    expect(vector?.secondaryResourceId).toBeUndefined();
  });

  it('withholds a shared endpoint meter instead of inventing per-index precision', () => {
    const vector = buildTiles({ ...IDS, vectorEndpointIndexCount: 2 }, [
      row({ component: 'vector-search', spend: 12, billedDays: 2, dbuRows: 1, dbuQuantity: 10 }),
    ]).find((tile) => tile.id === 'vector-search');
    expect(vector).toMatchObject({ amount: null, attribution: 'unavailable', resourceId: 'cat.schema.index' });
    expect(vector?.unavailable).toContain('serves 2 indexes');
  });
});

describe('price join golden outputs', () => {
  it('emits exact components once and excludes shared meters without an attribution denominator', () => {
    const tiles = buildTiles(IDS, [
      row({ component: 'serving-endpoint', spend: 1, billedDays: 1 }),
      row({ component: 'sql-warehouse', spend: 3, billedDays: 1 }),
      row({ component: 'vector-search', spend: 4, billedDays: 1 }),
      row({ component: 'app-compute', spend: 5, billedDays: 1 }),
    ]);
    const measured = tiles.filter((tile) => tile.amount !== null);
    expect(new Set(measured.map((tile) => tile.id)).size).toBe(measured.length);
    expect(measured.reduce((sum, tile) => sum + (tile.amount ?? 0), 0)).toBe(10);
    expect(tiles.some((tile) => tile.id === 'foundation-model')).toBe(false);
    expect(tiles.find((tile) => tile.id === 'sql-warehouse')?.amount).toBeNull();
    expect(tiles.some((tile) => tile.id === 'index-rebuild-job')).toBe(false);
  });

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

  it('withholds a partial priced lower bound and names the unpriced SKUs', () => {
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
    expect(tile?.amount).toBeNull();
    expect(tile?.quality).toBe('unknown');
    expect(tile?.pricing?.match).toBe('partial');
    expect(tile?.unavailable).toContain('NEW_SKU');
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
      appBillingTag: 'matched',
    });
    expect(coverage.costModelCount).toBe(5);
    expect(coverage.inventoryCount).toBe(11);
    expect(coverage.products.find((product) => product.product === 'JOBS')).toBeUndefined();
    expect(coverage.propagation.find((item) => item.product === 'APPS')?.status).toBe('unsupported');
    expect(coverage.propagation.find((item) => item.product === 'SQL')?.status).toBe('propagated');
  });

  it('withholds a warehouse meter until Query History proves the Astrolabe share', () => {
    const tile = buildTiles(IDS, [row({ component: 'sql-warehouse', spend: 50 })]).find(
      (item) => item.id === 'sql-warehouse'
    );
    expect(tile?.population).toBe('Astrolabe query share');
    expect(tile?.attribution).toBe('unavailable');
  });

  it('does not reuse generated-SQL estimates as per-space Genie charged billing', () => {
    const genie = buildTiles(IDS, [row({ component: 'genie', spend: 99 })]).filter((tile) =>
      tile.id.startsWith('genie:')
    );
    expect(genie).toHaveLength(2);
    expect(genie.every((tile) => tile.amount === null)).toBe(true);
    expect(genie.every((tile) => tile.unavailable.includes('Genie billing could not be classified'))).toBe(true);
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

  it('does not widen a missing endpoint name to a whole-workspace estimate', () => {
    const serving = buildTiles({ ...IDS, endpointName: '' }, [
      row({ kind: 'component', component: 'serving-endpoint:workspace', spend: 12 }),
    ]).find((tile) => tile.id === 'serving-endpoint');
    expect(serving?.amount).toBeNull();
    expect(serving?.quality).toBe('unknown');
    expect(serving?.unavailable).toBe('Resource identifier unavailable');
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
