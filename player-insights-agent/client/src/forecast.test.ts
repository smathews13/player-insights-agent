import { describe, expect, it } from 'vitest';
import type { OpsCostPayload, OpsTrafficPayload } from '../../shared/ops-contract';
import { calculateForecast, deriveForecastBaseline } from './forecast';
import { FORECAST_ASSUMPTIONS_KEY, persistForecastAssumptions, readForecastAssumptions } from './forecast-preferences';
import type { PreferenceStore } from './experimental-features';

function cost(overrides: Partial<OpsCostPayload> = {}): OpsCostPayload {
  return {
    state: 'ready',
    grant: null,
    reason: '',
    currency: 'USD',
    throughDay: '2026-08-14',
    range: { from: '2026-08-08', to: '2026-08-14' },
    billingLagDays: 0,
    readAt: '2026-08-15T12:00:00Z',
    tiles: [
      {
        id: 'serving-endpoint',
        label: 'Serving endpoint',
        resourceId: 'agent',
        quality: 'real',
        amount: 14,
        basis: 'total-in-range',
        population: 'This endpoint',
        attribution: 'deployment',
        unavailable: '',
        remedy: '',
        note: '',
      },
      {
        id: 'sql-warehouse',
        label: 'SQL warehouse',
        resourceId: 'warehouse',
        quality: 'estimate',
        amount: 7,
        basis: 'total-in-range',
        population: 'Astrolabe query share',
        attribution: 'deployment',
        unavailable: '',
        remedy: '',
        note: '',
        evidence: {
          billingRows: 2,
          astrolabeQueries: 7,
          warehouseQueries: 10,
          queryHistoryComplete: true,
        },
      },
      {
        id: 'app-compute',
        label: 'App compute',
        resourceId: 'app',
        quality: 'rate',
        amount: 2,
        basis: 'per-day',
        population: 'This app',
        attribution: 'deployment',
        unavailable: '',
        remedy: '',
        note: '',
      },
      {
        id: 'vector-search',
        label: 'Vector Search',
        resourceId: 'catalog.schema.index',
        quality: 'rate',
        amount: 3,
        basis: 'per-day',
        population: 'This endpoint',
        attribution: 'deployment',
        unavailable: '',
        remedy: '',
        note: '',
      },
      {
        id: 'genie:data',
        label: 'Data Genie',
        resourceId: 'space',
        quality: 'unknown',
        amount: null,
        basis: 'total-in-range',
        population: 'This space',
        attribution: 'unavailable',
        unavailable: 'Genie LLM dollars unavailable',
        remedy: '',
        note: '',
      },
    ],
    perQuestion: {
      runs: [],
      runsInRange: 7,
      tokenCoveredRuns: 7,
      totalRecordedTokens: 7_000,
      limited: false,
      reason: '',
    },
    budgets: { total: null, resources: {} },
    budgetsReadable: true,
    honesty: {
      priceSource: 'list_prices',
      contractRates: 'unavailable',
      dataThrough: '2026-08-14',
      rangeMayStillFill: false,
      currencyConsistent: true,
    },
    ...overrides,
  };
}

function traffic(overrides: Partial<OpsTrafficPayload> = {}): OpsTrafficPayload {
  return {
    readAt: '2026-08-15T12:00:00Z',
    reason: '',
    unread: '',
    questionsPerDay: [{ day: '2026-08-14', count: 28 }],
    distinctAskersPerDay: [{ day: '2026-08-14', count: 14 }],
    activeMinutesPerDay: [{ day: '2026-08-14', count: 140 }],
    failuresByCause: [],
    refusalsByCause: [],
    toolCalls: [],
    runsInRange: 7,
    ...overrides,
  };
}

describe('forecast arithmetic', () => {
  it('scales measured rates, applies contingency last, and uses fixed horizons', () => {
    const baseline = deriveForecastBaseline(cost(), traffic());
    const assumptions = { ...baseline.defaults, contingencyPercent: 10 };
    const result = calculateForecast(baseline, assumptions);

    expect(assumptions).toMatchObject({
      averageDailyUsers: 2,
      questionsPerUserPerDay: 2,
      activeAppMinutesPerUserPerDay: 10,
      averageModelTokensPerQuestion: 1000,
      governedTableCount: 1,
      vectorSearchCostPerTableDay: 3,
    });
    expect(result.dailyQuestions).toBe(4);
    expect(result.components.map((component) => [component.id, component.dailyAmount])).toEqual([
      ['serving-endpoint', 2],
      ['sql-warehouse', 1],
      ['app-compute', 2],
      ['vector-search', 3],
    ]);
    expect(result.contingencyDaily).toBeCloseTo(0.8);
    expect(result.horizons.map((horizon) => horizon.days)).toEqual([7, 30, 180]);
    expect(result.horizons[0].total).toBeCloseTo(61.6);
    expect(result.horizons[1].total).toBeCloseTo(264);
    expect(result.horizons[2].total).toBeCloseTo(1584);
    expect(result.horizons[0].components.at(-1)?.id).toBe('contingency');
    expect(result.horizons[0].components.at(-1)?.amount).toBeCloseTo(5.6);
  });

  it('uses the editable token ratio for serving without changing SQL', () => {
    const baseline = deriveForecastBaseline(cost(), traffic());
    const result = calculateForecast(baseline, {
      ...baseline.defaults,
      averageModelTokensPerQuestion: 500,
    });
    expect(result.components.find((component) => component.id === 'serving-endpoint')?.dailyAmount).toBe(1);
    expect(result.components.find((component) => component.id === 'sql-warehouse')?.dailyAmount).toBe(1);
  });
});

describe('missing and excluded baselines', () => {
  it('returns unavailable horizons for a missing or zero-priced baseline', () => {
    const missing = deriveForecastBaseline(null, null);
    expect(missing.available).toBe(false);
    expect(calculateForecast(missing, missing.defaults).horizons.every((horizon) => horizon.total === null)).toBe(true);

    const noRows = deriveForecastBaseline(
      cost({
        state: 'no-rows',
        reason: 'No matching billing rows.',
        tiles: [],
        perQuestion: { ...cost().perQuestion, runsInRange: 0, tokenCoveredRuns: 0, totalRecordedTokens: 0 },
      }),
      traffic()
    );
    expect(noRows.available).toBe(false);
    expect(noRows.unavailableReason).toContain('No matching billing rows');
  });

  it('does not sum shared, unpriced, incomplete, or direct-dollar-unavailable components', () => {
    const base = cost();
    const baseline = deriveForecastBaseline(
      cost({
        tiles: base.tiles.map((tile) => {
          if (tile.id === 'serving-endpoint') {
            return { ...tile, amount: null, quality: 'unknown' as const, unavailable: 'Unpriced SKU withheld' };
          }
          if (tile.id === 'sql-warehouse') {
            return {
              ...tile,
              amount: null,
              evidence: { ...tile.evidence!, queryHistoryComplete: false },
              unavailable: 'App spend withheld: complete Query History denominator unavailable',
            };
          }
          if (tile.id === 'app-compute') {
            return { ...tile, attribution: 'shared-upper-bound' as const, population: 'Whole workspace' };
          }
          return tile;
        }),
      }),
      traffic()
    );
    const result = calculateForecast(baseline, baseline.defaults);

    expect(result.components.map((component) => component.id)).toEqual(['vector-search']);
    expect(baseline.exclusions.map((item) => item.component)).toEqual(
      expect.arrayContaining(['Serving endpoint', 'Astrolabe SQL', 'App compute', 'Data Genie'])
    );
    expect(baseline.exclusions.find((item) => item.component === 'Astrolabe SQL')?.reason).toContain(
      'Query History is incomplete'
    );
  });

  it('keeps a no-activity history explicit instead of inventing usage', () => {
    const baseline = deriveForecastBaseline(
      cost(),
      traffic({ questionsPerDay: [], distinctAskersPerDay: [], activeMinutesPerDay: [] })
    );
    const result = calculateForecast(baseline, baseline.defaults);

    expect(baseline.noActivityHistory).toBe(true);
    expect(baseline.caveats.join(' ')).toContain('No activity was recorded');
    expect(result.dailyQuestions).toBe(0);
    expect(result.components.find((component) => component.id === 'serving-endpoint')).toBeUndefined();
    expect(baseline.exclusions.map((item) => item.component)).toEqual(
      expect.arrayContaining(['Serving endpoint', 'Astrolabe SQL'])
    );
  });

  it('withholds app cost per minute when heartbeat coverage does not span the Cost window', () => {
    const baseline = deriveForecastBaseline(cost(), traffic({ activeMinutesRecordedFrom: '2026-08-12T12:00:00.000Z' }));

    expect(baseline.observed.appCostPerActiveMinute).toBeNull();
    expect(baseline.exclusions.find((item) => item.component === 'App compute')?.reason).toContain(
      'starts after the Cost window begins'
    );
  });
});

describe('forecast assumption preferences', () => {
  function store(): PreferenceStore & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    };
  }

  it('round-trips a browser-local scenario and ignores malformed values', () => {
    const memory = store();
    const assumptions = deriveForecastBaseline(cost(), traffic()).defaults;
    expect(persistForecastAssumptions(assumptions, memory)).toBe(true);
    expect(readForecastAssumptions(memory)).toEqual(assumptions);

    memory.values.set(FORECAST_ASSUMPTIONS_KEY, '{"averageDailyUsers":-1}');
    expect(readForecastAssumptions(memory)).toBeNull();
  });
});
