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
        dbus: 7,
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
        dbus: 3.5,
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
        dbus: 1,
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
    expect(markup).toContain('type="text"');
    expect(markup.match(/ops-number-ticker ops-forecast-number-control/g)).toHaveLength(4);
    expect(markup).toContain('aria-label="Increase average daily users"');
    expect(markup).toContain('aria-label="Decrease average daily users"');
    expect(markup.match(/ops-forecast-steppers/g)).toHaveLength(4);
    expect(markup.match(/aria-controls="ops-forecast-/g)).toHaveLength(8);
    expect(markup).toMatch(/id="ops-forecast-averageDailyUsers"[^>]*inputMode="decimal"/);
    expect(markup).toMatch(/id="ops-forecast-questionsPerUserPerDay"[^>]*inputMode="decimal"/);
    expect(markup).toMatch(/id="ops-forecast-averageModelTokensPerQuestion"[^>]*inputMode="decimal"/);
    expect(markup).not.toContain('$');
    expect(markup).not.toContain('List-price estimate only');
    expect(markup).not.toContain('Baseline:');
    expect(markup).not.toContain('Source:');
    expect(markup).not.toContain('Assumption baselines');
    expect(markup).not.toContain('complete days');
    expect(markup).toContain('Observed baseline');
    expect(markup).toContain('2026-08-08–2026-08-14 (selected Cost period)');
    expect(markup).not.toContain('ops-period-pill');
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
    expect(markup).toContain('Projected breakdown');
    expect(markup).toContain('Projected cost breakdown by horizon');
    expect(markup).toMatch(/<th scope="col">Component<\/th>/);
    expect(markup).toMatch(/<th scope="col">Next 7 days<\/th>/);
    expect(markup).toMatch(/<th scope="col">Next 30 days<\/th>/);
    expect(markup).toMatch(/<th scope="col">Six months<\/th>/);
    expect(markup).toMatch(/<tfoot>[\s\S]*?<th scope="row">Total<\/th>/);
  });

  it('renders exact calculated component horizons, omits unpriced rows, and matches headline subtotals', () => {
    const payload = cost();
    payload.tiles.push(
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
        resourceId: 'data-space',
        quality: 'rate',
        amount: 4,
        basis: 'per-day',
        population: 'This space',
        attribution: 'deployment',
        unavailable: '',
        remedy: '',
        note: '',
      },
      {
        id: 'genie:dictionary',
        label: 'Dictionary Genie',
        resourceId: 'dictionary-space',
        quality: 'unknown',
        amount: null,
        basis: 'total-in-range',
        population: 'This space',
        attribution: 'unavailable',
        unavailable: 'Dictionary Genie pricing is unavailable.',
        remedy: '',
        note: '',
      }
    );
    const daily = Array.from({ length: 7 }, (_, index) => `2026-08-${String(index + 8).padStart(2, '0')}`);
    const trafficPayload = traffic();
    trafficPayload.questionsPerDay = daily.map((day) => ({ day, count: 7 }));
    trafficPayload.distinctAskersPerDay = daily.map((day) => ({ day, count: 2 }));
    trafficPayload.activeMinutesPerDay = daily.map((day) => ({ day, count: 40 }));

    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ForecastingBody cost={block(payload)} traffic={block(trafficPayload)} />
      </MemoryRouter>
    );
    const breakdown = markup.slice(markup.indexOf('ops-forecast-breakdown'), markup.indexOf('ops-forecast-method'));

    for (const component of ['Serving endpoint', 'Astrolabe SQL', 'App compute', 'Vector Search', 'Data Genie']) {
      expect(breakdown).toContain(`<th scope="row">${component}</th>`);
    }
    expect(breakdown).not.toContain('Dictionary Genie');
    expect(markup).toContain('Dictionary Genie pricing is unavailable.');
    expect(breakdown).toContain('<th scope="row">Subtotal</th>');
    expect(markup.match(/84\.00 USD/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup.match(/360\.00 USD/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup.match(/2,160\.00 USD/g)?.length).toBeGreaterThanOrEqual(2);
    expect(breakdown.match(/<th scope="row">Astrolabe SQL<\/th>/g)).toHaveLength(1);
  });

  it('uses the shared DBU selection for every projection without a currency conversion', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ForecastingBody cost={block(cost())} traffic={block(traffic())} unit="DBU" />
      </MemoryRouter>
    );
    const projection = markup.slice(markup.indexOf('ops-forecast-horizons'), markup.indexOf('ops-forecast-method'));
    expect(projection).toContain('DBU');
    expect(projection).not.toContain(' USD');
    expect(markup).toContain('do not apply a USD conversion rate');
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

  it('uses compact responsive rows and the shared methodology structure', () => {
    const payload = cost();
    payload.perQuestion = { ...payload.perQuestion, runsInRange: 8, tokenCoveredRuns: 2 };
    const trafficPayload = traffic();
    trafficPayload.activeMinutesRecordedFrom = '2026-08-12T00:00:00Z';
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ForecastingBody cost={block(payload)} traffic={block(trafficPayload)} periodLabel="30 days" />
      </MemoryRouter>
    );
    expect(markup).toContain('Next 30 days');
    expect(markup).not.toContain('ops-period-pill');
    expect(markup).toContain('Serving token coverage is partial');
    expect(markup.match(/Active-minute/g)).toHaveLength(1);
    expect(OPS_CSS).toMatch(/\.ops-methodology-rows > div\s*\{[\s\S]*grid-template-columns:/);
    expect(OPS_CSS).toMatch(
      /\.ops-forecast-assumption-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(12rem,\s*100%\),\s*13\.5rem\)\)/
    );
    expect(OPS_CSS).toMatch(
      /\.ops-number-ticker\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*7rem\)\s+20px[^}]*width:\s*min\(100%,\s*8\.25rem\)/
    );
    expect(OPS_CSS).toMatch(
      /\.ops-number-ticker input\s*\{[^}]*font-size:\s*var\(--text-base\)[^}]*font-weight:\s*700/
    );
    expect(OPS_CSS).toMatch(/\.ops-forecast-breakdown-scroll\s*\{[^}]*overflow-x:\s*auto/);
    expect(OPS_CSS).toMatch(/\.ops-forecast-breakdown table\s*\{[^}]*min-width:\s*620px/);
    expect(RESPONSIVE_CSS).toMatch(/\.ops-methodology-rows > div\s*\{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(FORECAST_SOURCE).toContain('<MethodologySections groups={methodologyGroups} />');
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
