import { describe, expect, it } from 'vitest';
import type { OpsCostPayload, OpsTrafficPayload } from '../../shared/ops-contract';
import {
  calculateForecast,
  deriveForecastBaseline,
  normalizeForecastAssumptions,
  stepForecastAssumption,
} from './forecast';
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
        population: 'PIA query share',
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
      runs: [
        {
          runId: 'r1',
          correlationId: 'c1',
          traceId: 't1',
          completedAt: '2026-08-14T12:00:00Z',
          totalTokens: 420,
          parts: [],
        },
        {
          runId: 'r2',
          correlationId: 'c2',
          traceId: 't2',
          completedAt: '2026-08-14T13:00:00Z',
          totalTokens: 1900,
          parts: [],
        },
      ],
      runsInRange: 7,
      tokenCoveredRuns: 7,
      totalRecordedTokens: 7_000,
      limited: false,
      reason: '',
    },
    budgets: { total: { value: null, unit: 'USD' }, resources: {} },
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
    breakdownCoverage: {
      outcomes: { state: 'complete', coveredRuns: 7, reason: '' },
      toolCalls: { state: 'complete', coveredRuns: 7, reason: '' },
    },
    ...overrides,
  };
}

describe('forecast arithmetic', () => {
  it('recomputes observed defaults when the selected Cost baseline window changes', () => {
    const sevenDays = deriveForecastBaseline(cost(), traffic());
    const oneDay = deriveForecastBaseline(cost({ range: { from: '2026-08-14', to: '2026-08-14' } }), traffic());
    expect(sevenDays.window.days).toBe(7);
    expect(oneDay.window.days).toBe(1);
    expect(sevenDays.defaults.averageDailyUsers).toBe(2);
    expect(oneDay.defaults.averageDailyUsers).toBe(14);
  });

  it('uses the direct component sum with no hidden contingency and fixed horizons', () => {
    const baseline = deriveForecastBaseline(cost(), traffic());
    const assumptions = baseline.defaults;
    const result = calculateForecast(baseline, assumptions);

    expect(assumptions).toMatchObject({
      averageDailyUsers: 2,
      questionsPerUserPerDay: 2,
      activeAppMinutesPerUserPerDay: 10,
      averageModelTokensPerQuestion: 1000,
    });
    expect(result.dailyQuestions).toBe(4);
    expect(result.components.map((component) => [component.id, component.dailyAmount])).toEqual([
      ['serving-endpoint', 2],
      ['sql-warehouse', 1],
      ['app-compute', 2],
      ['vector-search', 3],
    ]);
    expect(result.horizons.map((horizon) => horizon.days)).toEqual([7, 30, 180]);
    expect(result.horizons[0].total).toBeCloseTo(56);
    expect(result.horizons[1].total).toBeCloseTo(240);
    expect(result.horizons[2].total).toBeCloseTo(1440);
    for (const horizon of result.horizons) {
      expect(horizon.components.reduce((total, component) => total + (component.amount ?? 0), 0)).toBeCloseTo(
        horizon.total!
      );
      expect(new Set(horizon.components.map((component) => component.id)).size).toBe(horizon.components.length);
    }
    expect(JSON.stringify(result)).not.toMatch(/buffer|contingency/i);
  });

  it('carries a measured zero Vector Search baseline through every horizon', () => {
    const base = cost();
    const withZero = cost({
      tiles: base.tiles.map((item) =>
        item.id === 'vector-search' ? { ...item, amount: 0, dbus: 0, note: 'No billable usage in this period' } : item
      ),
    });
    const baseline = deriveForecastBaseline(withZero, traffic());
    const result = calculateForecast(baseline, baseline.defaults);
    expect(baseline.fixedDailyCosts).toContainEqual({ id: 'vector-search', label: 'Vector Search', amount: 0 });
    expect(result.components.find((item) => item.id === 'vector-search')?.dailyAmount).toBe(0);
    expect(
      result.horizons.map((horizon) => horizon.components.find((item) => item.id === 'vector-search')?.amount)
    ).toEqual([0, 0, 0]);
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

  it('normalizes displayed assumptions before calculation', () => {
    const normalized = normalizeForecastAssumptions({
      averageDailyUsers: 1.428571,
      questionsPerUserPerDay: 4.8123,
      activeAppMinutesPerUserPerDay: 0.844,
      averageModelTokensPerQuestion: 52353.594,
    });
    expect(normalized).toEqual({
      averageDailyUsers: 1,
      questionsPerUserPerDay: 4.8,
      activeAppMinutesPerUserPerDay: 0.8,
      averageModelTokensPerQuestion: 52354,
    });
  });

  it('steps each assumption with field-specific precision and a zero floor', () => {
    expect(stepForecastAssumption('averageDailyUsers', 1, 1)).toBe(2);
    expect(stepForecastAssumption('averageDailyUsers', 0, -1)).toBe(0);
    expect(stepForecastAssumption('questionsPerUserPerDay', 4.4, 1)).toBe(4.5);
    expect(stepForecastAssumption('questionsPerUserPerDay', 0.3, -1)).toBe(0.2);
    expect(stepForecastAssumption('activeAppMinutesPerUserPerDay', 0.2, 1)).toBe(0.3);
    expect(stepForecastAssumption('activeAppMinutesPerUserPerDay', 0, -1)).toBe(0);
    expect(stepForecastAssumption('averageModelTokensPerQuestion', 48_528, 1)).toBe(48_529);
    expect(stepForecastAssumption('averageModelTokensPerQuestion', 0, -1)).toBe(0);
  });

  it('normalizes typed and stepped values through the same integer, decimal, and token rules', () => {
    const typed = normalizeForecastAssumptions({
      averageDailyUsers: 2.6,
      questionsPerUserPerDay: 4.449,
      activeAppMinutesPerUserPerDay: 9.749,
      averageModelTokensPerQuestion: 48_528.2,
    });
    expect(typed).toEqual({
      averageDailyUsers: 3,
      questionsPerUserPerDay: 4.4,
      activeAppMinutesPerUserPerDay: 9.7,
      averageModelTokensPerQuestion: 48_528,
    });
    expect(stepForecastAssumption('questionsPerUserPerDay', typed.questionsPerUserPerDay, 1)).toBe(4.5);
    expect(stepForecastAssumption('averageModelTokensPerQuestion', typed.averageModelTokensPerQuestion, 1)).toBe(
      48_529
    );
  });
});

describe('suggested assumption evidence', () => {
  it('uses the selected complete-day dates, aggregate formulas, and real observed ranges', () => {
    const baseline = deriveForecastBaseline(
      cost(),
      traffic({
        questionsPerDay: [
          { day: '2026-08-13', count: 6 },
          { day: '2026-08-14', count: 28 },
        ],
        distinctAskersPerDay: [
          { day: '2026-08-13', count: 1 },
          { day: '2026-08-14', count: 14 },
        ],
      })
    );

    expect(baseline.evidence.averageDailyUsers).toMatchObject({
      calculation: '15 user-days ÷ 7 complete days',
      period: '7 complete days · 2026-08-08–2026-08-14',
      range: { label: 'daily users', min: 1, max: 14 },
    });
    expect(baseline.evidence.questionsPerUserPerDay.range).toEqual({
      label: 'daily questions/user',
      min: 2,
      max: 6,
    });
    expect(baseline.evidence.averageModelTokensPerQuestion.range).toEqual({
      label: 'observed tokens/question',
      min: 420,
      max: 1900,
    });
  });

  it('keeps the aggregate formula without inventing a range when observations are unavailable', () => {
    const payload = cost();
    const baseline = deriveForecastBaseline(
      { ...payload, perQuestion: { ...payload.perQuestion, runs: [] } },
      traffic({ distinctAskersPerDay: [] })
    );

    expect(baseline.evidence.averageDailyUsers.calculation).toContain('0 user-days ÷ 7 complete days');
    expect(baseline.evidence.averageDailyUsers.range).toBeNull();
    expect(baseline.evidence.averageModelTokensPerQuestion.calculation).toContain('7,000 tokens ÷ 7 covered questions');
    expect(baseline.evidence.averageModelTokensPerQuestion.range).toBeNull();
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
              unavailable: 'Incomplete Query History',
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

    expect(result.components.map((component) => [component.id, component.dailyAmount])).toEqual([
      ['app-compute', null],
      ['vector-search', 3],
    ]);
    expect(baseline.exclusions.map((item) => item.component)).toEqual(
      expect.arrayContaining(['Serving endpoint', 'PIA SQL', 'Data Genie'])
    );
    expect(baseline.exclusions.map((item) => item.component)).not.toContain('App compute');
    expect(baseline.exclusions.find((item) => item.component === 'PIA SQL')?.reason).toContain(
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
      expect.arrayContaining(['Serving endpoint', 'PIA SQL'])
    );
  });

  it('projects app compute even when per-user heartbeat coverage does not span the Cost window', () => {
    const baseline = deriveForecastBaseline(cost(), traffic({ activeMinutesRecordedFrom: '2026-08-12T12:00:00.000Z' }));
    const result = calculateForecast(baseline, baseline.defaults);

    expect(baseline.observed.appCostPerActiveMinute).toBeNull();
    expect(baseline.appComputeDaily).toBe(2);
    expect(baseline.appComputeUnavailable).toBe('');
    const appCompute = result.components.find((item) => item.id === 'app-compute');
    expect(appCompute?.dailyAmount).toBe(2);
    expect(appCompute?.unavailable).toBe('');
    expect(
      result.horizons.map((horizon) => horizon.components.find((item) => item.id === 'app-compute')?.amount)
    ).toEqual([14, 60, 360]);
    expect(result.horizons[0].total).toBeCloseTo(56);
  });

  it.each([
    ['USD', 2, 56, 240],
    ['DBU', 1, 17.5, 75],
  ] as const)(
    'projects measured App compute in %s without conversion or double counting',
    (unit, appDaily, next7, next30) => {
      const payload = cost({ currency: unit });
      payload.tiles = payload.tiles.map((tile) =>
        tile.id === 'app-compute' ? { ...tile, amount: appDaily, dbus: unit === 'DBU' ? appDaily : tile.dbus } : tile
      );
      if (unit === 'DBU') {
        payload.tiles = payload.tiles.map((tile) => ({
          ...tile,
          dbus: tile.id === 'serving-endpoint' ? 7 : tile.id === 'sql-warehouse' ? 3.5 : tile.dbus,
        }));
      }
      const baseline = deriveForecastBaseline(payload, traffic(), unit);
      const result = calculateForecast(baseline, baseline.defaults);

      expect(result.components.find((item) => item.id === 'app-compute')?.dailyAmount).toBe(appDaily);
      expect(result.horizons[0].total).toBeCloseTo(next7);
      expect(result.horizons[1].total).toBeCloseTo(next30);
      for (const horizon of result.horizons) {
        const appProjection = horizon.components.find((item) => item.id === 'app-compute')?.amount;
        expect(appProjection).toBe(appDaily * horizon.days);
        const subtotalWithoutApp = horizon.components
          .filter((item) => item.id !== 'app-compute')
          .reduce((total, item) => total + (item.amount ?? 0), 0);
        expect((horizon.total ?? 0) - subtotalWithoutApp).toBeCloseTo(appProjection ?? 0);
      }
    }
  );

  it('keeps a measured zero App compute row and includes zero in reconciled totals', () => {
    const payload = cost();
    payload.tiles = payload.tiles.map((tile) => (tile.id === 'app-compute' ? { ...tile, amount: 0 } : tile));
    const baseline = deriveForecastBaseline(payload, traffic());
    const result = calculateForecast(baseline, baseline.defaults);

    expect(result.components.find((item) => item.id === 'app-compute')?.dailyAmount).toBe(0);
    expect(result.horizons[0].components.find((item) => item.id === 'app-compute')?.amount).toBe(0);
    expect(result.horizons[0].total).toBeCloseTo(42);
  });

  it('uses exact horizon days and removes the Genie promotion at the 2027 boundary', () => {
    const payload = cost({
      range: { from: '2027-01-24', to: '2027-01-30' },
      throughDay: '2027-01-30',
      tiles: [
        {
          id: 'genie:data',
          label: 'Data Genie',
          resourceId: 'space-data',
          quality: 'real',
          amount: 7,
          dbus: 7,
          basis: 'total-in-range',
          population: 'This workspace',
          attribution: 'deployment',
          unavailable: '',
          remedy: '',
          note: '',
        },
        {
          id: 'genie:dictionary',
          label: 'Dictionary Genie',
          resourceId: 'space-dictionary',
          quality: 'estimate',
          amount: 14,
          dbus: 14,
          basis: 'total-in-range',
          population: 'This Genie space',
          attribution: 'deployment',
          unavailable: '',
          remedy: '',
          note: 'Allocated',
        },
        {
          id: 'genie:unattributed',
          label: 'Unattributed Genie',
          resourceId: '',
          quality: 'real',
          amount: 10_000,
          dbus: 50_000,
          basis: 'total-in-range',
          population: 'This workspace',
          attribution: 'deployment',
          unavailable: '',
          remedy: '',
          note: '',
        },
      ],
    });
    const result = calculateForecast(
      deriveForecastBaseline(payload, traffic()),
      deriveForecastBaseline(payload, traffic()).defaults
    );
    const next7 = result.horizons[0];
    expect(next7.days).toBe(7);
    expect(next7.components.find((item) => item.id === 'genie:data')?.amount).toBeCloseTo(5.5);
    expect(next7.components.find((item) => item.id === 'genie:dictionary')?.amount).toBeCloseTo(11);
    expect(next7.components.some((item) => item.id === 'genie:unattributed')).toBe(false);
    expect(next7.total).toBeCloseTo(16.5);
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

  it('ignores old contingency and cost-buffer fields without discarding the remaining scenario', () => {
    const memory = store();
    memory.values.set(
      FORECAST_ASSUMPTIONS_KEY,
      JSON.stringify({
        averageDailyUsers: 2.2,
        questionsPerUserPerDay: 3.33,
        activeAppMinutesPerUserPerDay: 4.44,
        averageModelTokensPerQuestion: 1000.04,
        governedTableCount: 8,
        vectorSearchCostPerTableDay: 99,
        contingencyPercent: 5.55,
        costBufferPercent: 12,
      })
    );
    expect(readForecastAssumptions(memory)).toEqual({
      averageDailyUsers: 2,
      questionsPerUserPerDay: 3.3,
      activeAppMinutesPerUserPerDay: 4.4,
      averageModelTokensPerQuestion: 1000,
    });
  });
});
