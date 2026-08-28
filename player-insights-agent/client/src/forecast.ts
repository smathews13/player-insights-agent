import type { CostTile, OpsCostPayload, OpsTrafficPayload } from '../../shared/ops-contract';

const DAY_MS = 86_400_000;

export const FORECAST_HORIZONS = [
  { days: 7, label: 'Next 7 days' },
  { days: 30, label: 'Next 30 days' },
  { days: 180, label: 'Six months' },
] as const;

export interface ForecastAssumptions {
  averageDailyUsers: number;
  questionsPerUserPerDay: number;
  activeAppMinutesPerUserPerDay: number;
  averageModelTokensPerQuestion: number;
  governedTableCount: number;
  vectorSearchCostPerTableDay: number;
  contingencyPercent: number;
}

export interface ForecastExclusion {
  component: string;
  reason: string;
}

export interface ForecastBaseline {
  available: boolean;
  unavailableReason: string;
  currency: string;
  window: { from: string; to: string; days: number };
  source: string;
  defaults: ForecastAssumptions;
  observed: {
    servingCostPerQuestion: number | null;
    averageModelTokensPerQuestion: number | null;
    sqlCostPerQuestion: number | null;
    appCostPerActiveMinute: number | null;
    vectorSearchCostPerTableDay: number | null;
  };
  fixedDailyCosts: Array<{ id: string; label: string; amount: number }>;
  exclusions: ForecastExclusion[];
  caveats: string[];
  noActivityHistory: boolean;
}

export interface ForecastComponent {
  id: string;
  label: string;
  dailyAmount: number;
  formula: string;
}

export interface ForecastHorizon {
  days: number;
  label: string;
  total: number | null;
  components: Array<{ id: string; label: string; amount: number }>;
}

export interface ForecastResult {
  dailyQuestions: number;
  dailyActiveMinutes: number;
  components: ForecastComponent[];
  contingencyDaily: number;
  horizons: ForecastHorizon[];
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function rangeDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / DAY_MS) + 1;
}

function inWindow(day: string, from: string, to: string): boolean {
  return Boolean(day) && day >= from && day <= to;
}

function sumWindow(series: Array<{ day: string; count: number }>, from: string, to: string): number {
  return series
    .filter((point) => inWindow(point.day, from, to))
    .reduce((total, point) => total + finiteNonNegative(point.count), 0);
}

function usableAmount(tile: CostTile | undefined): number | null {
  if (!tile || tile.amount === null || !Number.isFinite(tile.amount) || tile.amount < 0) return null;
  if (tile.attribution === 'shared-upper-bound' || tile.attribution === 'unavailable') return null;
  if (tile.pricing && tile.pricing.match !== 'priced') return null;
  return tile.amount;
}

function totalInWindow(tile: CostTile | undefined, days: number): number | null {
  const amount = usableAmount(tile);
  if (amount === null || days <= 0) return null;
  return tile?.basis === 'per-day' ? amount * days : amount;
}

function dailyInWindow(tile: CostTile | undefined, days: number): number | null {
  const amount = usableAmount(tile);
  if (amount === null || days <= 0) return null;
  return tile?.basis === 'per-day' ? amount : amount / days;
}

function tileReason(tile: CostTile | undefined, fallback: string): string {
  if (!tile) return fallback;
  if (tile.attribution === 'shared-upper-bound') return 'Shared workspace or warehouse spend is not summed.';
  if (tile.pricing && tile.pricing.match !== 'priced') {
    return tile.unavailable || `List-price coverage is ${tile.pricing.match}; this amount is withheld.`;
  }
  return tile.unavailable || fallback;
}

function pushUnique(items: string[], value: string): void {
  if (value && !items.includes(value)) items.push(value);
}

/**
 * Build a forecasting baseline only from the already-loaded Cost and Traffic
 * payloads. This function performs no reads and treats every missing denominator
 * as an exclusion rather than as a zero-dollar rate.
 */
export function deriveForecastBaseline(
  cost: OpsCostPayload | null,
  traffic: OpsTrafficPayload | null
): ForecastBaseline {
  const emptyDefaults: ForecastAssumptions = {
    averageDailyUsers: 0,
    questionsPerUserPerDay: 0,
    activeAppMinutesPerUserPerDay: 0,
    averageModelTokensPerQuestion: 0,
    governedTableCount: 0,
    vectorSearchCostPerTableDay: 0,
    contingencyPercent: 0,
  };
  const empty: ForecastBaseline = {
    available: false,
    unavailableReason: 'Cost has not established a priced baseline yet.',
    currency: cost?.currency || 'USD',
    window: { from: cost?.range.from ?? '', to: cost?.range.to ?? '', days: 0 },
    source:
      'Ops Cost (billing list prices and Query History) plus Ops Traffic (stored questions, askers, and active minutes)',
    defaults: emptyDefaults,
    observed: {
      servingCostPerQuestion: null,
      averageModelTokensPerQuestion: null,
      sqlCostPerQuestion: null,
      appCostPerActiveMinute: null,
      vectorSearchCostPerTableDay: null,
    },
    fixedDailyCosts: [],
    exclusions: [],
    caveats: ['Forecasts use Databricks list prices, not contracted rates, invoices, budgets, or commitments.'],
    noActivityHistory: false,
  };

  if (!cost) return empty;

  const days = rangeDays(cost.range.from, cost.range.to);
  const baseline: ForecastBaseline = {
    ...empty,
    currency: cost.currency || 'USD',
    window: { ...cost.range, days },
    unavailableReason: '',
    caveats: [...empty.caveats],
  };
  if (cost.state === 'no-grant' || cost.state === 'unreadable' || cost.state === 'no-warehouse') {
    baseline.unavailableReason = cost.reason || 'Cost could not establish a priced baseline.';
    return baseline;
  }
  if (days <= 0) {
    baseline.unavailableReason = 'The Cost baseline window is invalid.';
    return baseline;
  }

  const trafficReadable = Boolean(traffic && !traffic.reason);
  const unread = traffic?.unread.toLowerCase() ?? '';
  const questionsReadable = trafficReadable && !unread.includes('questions per day');
  const askersReadable = trafficReadable && !unread.includes('distinct askers per day');
  const activeMinutesReadable = trafficReadable && !unread.includes('active app minutes');
  const questionCount = questionsReadable
    ? sumWindow(traffic?.questionsPerDay ?? [], cost.range.from, cost.range.to)
    : 0;
  const userDays = askersReadable ? sumWindow(traffic?.distinctAskersPerDay ?? [], cost.range.from, cost.range.to) : 0;
  const activeMinutes = activeMinutesReadable
    ? sumWindow(traffic?.activeMinutesPerDay ?? [], cost.range.from, cost.range.to)
    : 0;

  baseline.defaults.averageDailyUsers = userDays / days;
  baseline.defaults.questionsPerUserPerDay = userDays > 0 ? questionCount / userDays : 0;
  baseline.defaults.activeAppMinutesPerUserPerDay = userDays > 0 ? activeMinutes / userDays : 0;
  baseline.noActivityHistory = questionCount === 0 && userDays === 0 && activeMinutes === 0;

  if (!trafficReadable) {
    pushUnique(
      baseline.caveats,
      traffic?.reason
        ? `Traffic defaults are unavailable: ${traffic.reason}`
        : 'Traffic has not loaded; usage assumptions start at zero.'
    );
  } else if (traffic?.unread) {
    pushUnique(baseline.caveats, `Traffic is partial: ${traffic.unread}`);
  }
  if (baseline.noActivityHistory) {
    pushUnique(
      baseline.caveats,
      'No activity was recorded in the Cost window. Usage assumptions start at zero until edited.'
    );
  }
  const activeCoverageStart = traffic?.activeMinutesRecordedFrom?.slice(0, 10) ?? '';
  const activeMinutesComplete = !activeCoverageStart || activeCoverageStart <= cost.range.from;
  if (!activeMinutesComplete) {
    pushUnique(baseline.caveats, `Active-minute history is partial from ${activeCoverageStart}; it does not backfill.`);
  }

  const serving = cost.tiles.find((tile) => tile.id === 'serving-endpoint');
  const servingTotal = totalInWindow(serving, days);
  const tokenRuns = finiteNonNegative(cost.perQuestion.tokenCoveredRuns);
  const recordedTokens = finiteNonNegative(cost.perQuestion.totalRecordedTokens);
  const completedRuns = finiteNonNegative(cost.perQuestion.runsInRange);
  const averageTokens = tokenRuns > 0 && recordedTokens > 0 ? recordedTokens / tokenRuns : null;
  if (servingTotal !== null && questionCount > 0 && averageTokens !== null) {
    // Traffic defines a question as one stored user message. Amortizing the
    // measured endpoint total over that same population keeps the rate and the
    // editable "questions per user" assumption on one denominator, including
    // questions whose runs later failed or were refused.
    baseline.observed.servingCostPerQuestion = servingTotal / questionCount;
    baseline.observed.averageModelTokensPerQuestion = averageTokens;
    baseline.defaults.averageModelTokensPerQuestion = averageTokens;
    if (tokenRuns < completedRuns) {
      pushUnique(
        baseline.caveats,
        `Serving token coverage is partial (${tokenRuns} of ${completedRuns} completed questions); the observed rate uses covered questions only.`
      );
    }
  } else {
    baseline.exclusions.push({
      component: serving?.label || 'Serving endpoint',
      reason:
        servingTotal === null
          ? tileReason(serving, 'No priced serving spend was measured.')
          : questionCount === 0
            ? 'No stored user questions overlap the Cost window.'
            : 'Recorded model tokens do not cover any completed question.',
    });
  }

  const sql = cost.tiles.find((tile) => tile.id === 'sql-warehouse');
  const sqlTotal = totalInWindow(sql, days);
  const queryHistoryComplete = sql?.evidence?.queryHistoryComplete !== false;
  if (sqlTotal !== null && questionCount > 0 && queryHistoryComplete) {
    baseline.observed.sqlCostPerQuestion = sqlTotal / questionCount;
  } else {
    baseline.exclusions.push({
      component: 'Astrolabe SQL',
      reason: !queryHistoryComplete
        ? 'Query History is incomplete, so attributed SQL spend is withheld.'
        : sqlTotal === null
          ? tileReason(sql, 'No priced, attributable SQL spend was measured.')
          : 'No stored user questions overlap the Cost window.',
    });
  }

  const app = cost.tiles.find((tile) => tile.id === 'app-compute');
  const appTotal = totalInWindow(app, days);
  if (appTotal !== null && activeMinutesReadable && activeMinutesComplete && activeMinutes > 0) {
    baseline.observed.appCostPerActiveMinute = appTotal / activeMinutes;
  } else {
    baseline.exclusions.push({
      component: app?.label || 'App compute',
      reason:
        appTotal === null
          ? tileReason(app, 'No priced app-compute spend was measured.')
          : activeMinutesReadable
            ? activeMinutesComplete
              ? 'No active app minutes overlap the Cost window.'
              : 'Active-minute history starts after the Cost window begins, so cost per active minute is withheld.'
            : 'Active app minutes could not be read.',
    });
  }

  const vector = cost.tiles.find((tile) => tile.id === 'vector-search');
  const vectorDaily = dailyInWindow(vector, days);
  if (vectorDaily !== null && vector?.resourceId) {
    baseline.defaults.governedTableCount = 1;
    baseline.defaults.vectorSearchCostPerTableDay = vectorDaily;
    baseline.observed.vectorSearchCostPerTableDay = vectorDaily;
    pushUnique(
      baseline.caveats,
      'One governed table is inferred from the one configured Vector Search index; edit the count if the design differs.'
    );
  } else {
    baseline.exclusions.push({
      component: vector?.label || 'Vector Search',
      reason: tileReason(
        vector,
        'No measured Vector Search daily rate is available; the editable rate defaults to 0 and is not summed.'
      ),
    });
    pushUnique(
      baseline.caveats,
      'Vector Search cost per table per day defaults to 0 because no measured rate is available; 0 is not a price claim.'
    );
  }

  const known = new Set(['serving-endpoint', 'sql-warehouse', 'app-compute', 'vector-search']);
  for (const tile of cost.tiles) {
    if (known.has(tile.id)) continue;
    if (tile.id === 'genie' || tile.id.startsWith('genie:')) {
      baseline.exclusions.push({
        component: tile.label || 'Genie / Data Dictionary',
        reason: 'Direct Genie and Data Dictionary dollars are unavailable and are not treated as zero cost.',
      });
      continue;
    }
    const amount = dailyInWindow(tile, days);
    if (amount !== null) {
      baseline.fixedDailyCosts.push({ id: tile.id, label: tile.label, amount });
    } else {
      baseline.exclusions.push({
        component: tile.label,
        reason: tileReason(tile, 'No priced, deployment-attributable daily baseline is available.'),
      });
    }
  }

  if (cost.honesty?.currencyConsistent === false) {
    baseline.unavailableReason = 'The Cost window contains mixed currencies, so no total can be formed.';
    return baseline;
  }

  const hasMeasuredRate =
    baseline.observed.servingCostPerQuestion !== null ||
    baseline.observed.sqlCostPerQuestion !== null ||
    baseline.observed.appCostPerActiveMinute !== null ||
    baseline.observed.vectorSearchCostPerTableDay !== null ||
    baseline.fixedDailyCosts.length > 0;
  baseline.available = hasMeasuredRate;
  if (!hasMeasuredRate) {
    baseline.unavailableReason =
      cost.state === 'no-rows'
        ? cost.reason || 'No tracked billing rows filled this window.'
        : 'No priced, attributable component has a forecasting baseline.';
  }
  return baseline;
}

/** Apply editable assumptions to a prepared baseline, with contingency last. */
export function calculateForecast(baseline: ForecastBaseline, assumptions: ForecastAssumptions): ForecastResult {
  const safe = {
    averageDailyUsers: finiteNonNegative(assumptions.averageDailyUsers),
    questionsPerUserPerDay: finiteNonNegative(assumptions.questionsPerUserPerDay),
    activeAppMinutesPerUserPerDay: finiteNonNegative(assumptions.activeAppMinutesPerUserPerDay),
    averageModelTokensPerQuestion: finiteNonNegative(assumptions.averageModelTokensPerQuestion),
    governedTableCount: Math.floor(finiteNonNegative(assumptions.governedTableCount)),
    vectorSearchCostPerTableDay: finiteNonNegative(assumptions.vectorSearchCostPerTableDay),
    contingencyPercent: finiteNonNegative(assumptions.contingencyPercent),
  };
  const dailyQuestions = safe.averageDailyUsers * safe.questionsPerUserPerDay;
  const dailyActiveMinutes = safe.averageDailyUsers * safe.activeAppMinutesPerUserPerDay;
  const components: ForecastComponent[] = [];

  if (
    baseline.observed.servingCostPerQuestion !== null &&
    baseline.observed.averageModelTokensPerQuestion !== null &&
    baseline.observed.averageModelTokensPerQuestion > 0
  ) {
    const tokenRatio = safe.averageModelTokensPerQuestion / baseline.observed.averageModelTokensPerQuestion;
    components.push({
      id: 'serving-endpoint',
      label: 'Serving endpoint',
      dailyAmount: dailyQuestions * baseline.observed.servingCostPerQuestion * tokenRatio,
      formula: 'daily stored questions × observed serving cost/stored question × assumed-to-observed token ratio',
    });
  }
  if (baseline.observed.sqlCostPerQuestion !== null) {
    components.push({
      id: 'sql-warehouse',
      label: 'Astrolabe SQL',
      dailyAmount: dailyQuestions * baseline.observed.sqlCostPerQuestion,
      formula: 'daily stored questions × observed attributed SQL cost/stored question',
    });
  }
  if (baseline.observed.appCostPerActiveMinute !== null) {
    components.push({
      id: 'app-compute',
      label: 'App compute',
      dailyAmount: dailyActiveMinutes * baseline.observed.appCostPerActiveMinute,
      formula: 'daily active app minutes × observed app cost/active minute',
    });
  }
  if (baseline.observed.vectorSearchCostPerTableDay !== null || safe.vectorSearchCostPerTableDay > 0) {
    components.push({
      id: 'vector-search',
      label: 'Vector Search',
      dailyAmount: safe.governedTableCount * safe.vectorSearchCostPerTableDay,
      formula: 'governed table count × Vector Search cost/table/day',
    });
  }
  for (const fixed of baseline.fixedDailyCosts) {
    components.push({
      ...fixed,
      dailyAmount: fixed.amount,
      formula: 'observed attributable daily baseline (held fixed)',
    });
  }

  const baseDaily = components.reduce((total, component) => total + component.dailyAmount, 0);
  const contingencyDaily = baseDaily * (safe.contingencyPercent / 100);
  const horizons = FORECAST_HORIZONS.map((horizon): ForecastHorizon => {
    if (!baseline.available || components.length === 0) {
      return { ...horizon, total: null, components: [] };
    }
    const breakdown = components.map((component) => ({
      id: component.id,
      label: component.label,
      amount: component.dailyAmount * horizon.days,
    }));
    if (safe.contingencyPercent > 0) {
      breakdown.push({
        id: 'contingency',
        label: `Contingency (${safe.contingencyPercent}%)`,
        amount: contingencyDaily * horizon.days,
      });
    }
    return {
      ...horizon,
      total: (baseDaily + contingencyDaily) * horizon.days,
      components: breakdown,
    };
  });

  return { dailyQuestions, dailyActiveMinutes, components, contingencyDaily, horizons };
}
