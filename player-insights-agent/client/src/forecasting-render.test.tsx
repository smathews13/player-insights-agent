import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsCostPayload, OpsTrafficPayload } from '../../shared/ops-contract';
import { NO_EXPERIMENTS, type ExperimentalFeatures } from './experimental-features';
import { ForecastingBody } from './ForecastingPanel';
import { OpsPage, type Block } from './OpsPage';
import { autoLoadOpsBlock, forgetOpsSession, opsAutoLoadClaimed } from './ops-session';

const OPS_CSS = readFileSync(new URL('./styles/ops.css', import.meta.url), 'utf8');
const RESPONSIVE_CSS = readFileSync(new URL('./styles/responsive.css', import.meta.url), 'utf8');
const FORECAST_SOURCE = readFileSync(new URL('./ForecastingPanel.tsx', import.meta.url), 'utf8');

function block<T>(data: T | null, overrides: Partial<Block<T>> = {}): Block<T> {
  return { data, busy: false, failed: '', refresh: () => {}, ...overrides };
}

function cost(): OpsCostPayload {
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
    ],
    perQuestion: {
      runs: [],
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
  };
}

function traffic(): OpsTrafficPayload {
  return {
    readAt: '2026-08-15T12:00:00Z',
    reason: '',
    unread: '',
    questionsPerDay: [{ day: '2026-08-14', count: 7 }],
    distinctAskersPerDay: [{ day: '2026-08-14', count: 2 }],
    activeMinutesPerDay: [{ day: '2026-08-14', count: 40 }],
    failuresByCause: [],
    refusalsByCause: [],
    toolCalls: [],
    runsInRange: 7,
  };
}

function renderOps(features: ExperimentalFeatures): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/ops']}>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                features,
                setFeature: () => {},
                role: { state: 'admin', addedAdminsReadable: true },
              }}
            />
          }
        >
          <Route path="/ops" element={<OpsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  forgetOpsSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Forecasting visibility and placement', () => {
  it('keeps Forecasting hidden by default while Cost remains visible', () => {
    const markup = renderOps({ ...NO_EXPERIMENTS });
    expect(markup).toContain('ops-cost-heading');
    expect(markup).not.toContain('data-testid="ops-forecasting"');
    expect(markup).toContain('ops-traffic-heading');
  });

  it('places enabled Forecasting directly below Cost and above Traffic', () => {
    const markup = renderOps({ ...NO_EXPERIMENTS, forecasting: true });
    const costAt = markup.indexOf('ops-cost-heading');
    const forecastAt = markup.indexOf('data-testid="ops-forecasting"');
    const trafficAt = markup.indexOf('ops-traffic-heading');
    expect(costAt).toBeGreaterThan(-1);
    expect(forecastAt).toBeGreaterThan(costAt);
    expect(trafficAt).toBeGreaterThan(forecastAt);
  });

  it('renders editable assumptions and all deterministic horizons', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ForecastingBody cost={block(cost())} traffic={block(traffic())} />
      </MemoryRouter>
    );
    for (const label of [
      'Average daily users',
      'Questions per user per day',
      'Active app minutes per user per day',
      'Average model tokens per question',
      'Next 7 days',
      'Next 30 days',
      'Six months',
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('type="number"');
    expect(markup).not.toContain('List-price estimate only');
    expect(markup).not.toContain('Baseline:');
    expect(markup).not.toContain('Source:');
    expect(markup).not.toContain('Assumption baselines');
    expect(markup).not.toContain('complete days');
    expect(markup).not.toContain('2026-08-08');
    expect(markup).toContain('How totals are calculated');
    expect(markup).toContain('Daily questions × observed serving cost per question');
    const helpers = [...markup.matchAll(/class="ops-forecast-assumption-evidence">([^<]*)<\/small>/g)].map(
      (match) => match[1]
    );
    expect(helpers).toHaveLength(4);
    expect(helpers).toEqual([
      'Example range: 2–2 users',
      'Example range: 3.5–3.5 questions/user/day',
      'Example range: 20–20 min/user/day',
      'Example range: 800–1,200 tokens/question',
    ]);
    expect(helpers.join(' ')).not.toMatch(/Suggested|complete days|2026-|÷|default/i);
    expect(markup).not.toMatch(/Cost buffer|contingency/i);
    expect(markup).not.toContain('Use observed defaults');
    expect(markup).not.toContain('Daily questions =');
    expect(markup).not.toContain('Governed table count');
    expect(markup).not.toContain('Vector Search cost per table per day');
    expect(markup.indexOf('experimental-pane-badge')).toBeLessThan(markup.indexOf('>Forecasting</h3>'));
  });

  it('renders loading, unavailable, and partial states without inventing totals', () => {
    const loading = renderToStaticMarkup(
      <ForecastingBody
        cost={block<OpsCostPayload>(null, { busy: true })}
        traffic={block<OpsTrafficPayload>(null, { busy: true })}
      />
    );
    expect(loading).toContain('ops-skeleton');

    const unavailable = renderToStaticMarkup(
      <ForecastingBody
        cost={block<OpsCostPayload>(null, { failed: 'The server answered 403.' })}
        traffic={block(traffic())}
      />
    );
    expect(unavailable).toContain('Forecast unavailable');
    expect(unavailable).toContain('The server answered 403');
    expect(unavailable).not.toContain('estimated total');

    const partialCost = cost();
    partialCost.tiles = partialCost.tiles.map((tile) =>
      tile.id === 'serving-endpoint'
        ? { ...tile, amount: null, quality: 'unknown', unavailable: 'Partial list-price coverage; spend withheld.' }
        : tile
    );
    const partial = renderToStaticMarkup(
      <MemoryRouter>
        <ForecastingBody cost={block(partialCost)} traffic={block(traffic())} />
      </MemoryRouter>
    );
    expect(partial).not.toContain('Partial estimate');
    expect(partial).toContain('Partial list-price coverage; spend withheld.');
    expect(partial).toContain('Not included');
    expect(partial).toContain('estimated subtotal');
    expect(partial).not.toContain('<span>Serving endpoint</span>');
  });

  it('uses compact responsive rows and caps the initially visible limits', () => {
    const payload = cost();
    payload.perQuestion = { ...payload.perQuestion, runsInRange: 8, tokenCoveredRuns: 2 };
    const trafficPayload = traffic();
    trafficPayload.activeMinutesRecordedFrom = '2026-08-12T00:00:00Z';
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ForecastingBody cost={block(payload)} traffic={block(trafficPayload)} periodLabel="30 days" />
      </MemoryRouter>
    );
    expect(markup).toContain('30 days');
    expect(markup).toContain('Serving token coverage is partial');
    expect(markup.match(/Active-minute/g)).toHaveLength(1);
    expect(OPS_CSS).toMatch(/\.ops-forecast-formulas > div,[\s\S]*grid-template-columns:/);
    expect(RESPONSIVE_CSS).toMatch(/\.ops-forecast-formulas > div,[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(FORECAST_SOURCE).toContain('limits.slice(0, VISIBLE_LIMITS)');
    expect(FORECAST_SOURCE).toContain('ops-forecast-more-limits');
  });
});

describe('Cost after retiring its experiment', () => {
  it('always mounts the cost read with no feature gate', () => {
    const source = readFileSync(new URL('./OpsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain("useOpsBlock<OpsCostPayload>('/api/ops/cost', costSearch, opsCostRangeId(params))");
    expect(source).not.toContain('showsCostEstimates');
    expect(source).not.toContain('costEstimatesShown');
  });

  it('fetches and claims Cost on its first admin visit', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ readAt: '2026-08-28T12:00:00.000Z' }),
    });
    vi.stubGlobal('fetch', fetch);
    const key = '/api/ops/cost:7d';

    await autoLoadOpsBlock(true, key, '/api/ops/cost?from=a&to=b');
    expect(fetch).toHaveBeenCalledOnce();
    expect(opsAutoLoadClaimed(key)).toBe(true);
  });
});
