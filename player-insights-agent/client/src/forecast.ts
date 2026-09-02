import type { CostTile, OpsCostPayload, OpsTrafficPayload } from '../../shared/ops-contract';
import type { CostBudgetUnit } from '../../shared/cost-budgets';

const DAY_MS = 86_400_000;

export const FORECAST_HORIZONS = [
  { days: 7, label: 'Next 7 days' },
  { days: 30, label: 'Next 30 days' },
  { days: 180, label: 'Six months' },
] as const;
const GENIE_PROMOTION_END = '2027-01-31';

export interface ForecastAssumptions {
  averageDailyUsers: number;
  questionsPerUserPerDay: number;
  activeAppMinutesPerUserPerDay: number;
  averageModelTokensPerQuestion: number;
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
  evidence: Record<keyof ForecastAssumptions, ForecastSuggestionEvidence>;
  observed: {
    servingCostPerQuestion: number | null;
    foundationCostPerQuestion: number | null;
    averageModelTokensPerQuestion: number | null;
    sqlCostPerQuestion: number | null;
    appCostPerActiveMinute: number | null;
  };
  /**
   * Canonical app-level Apps billing rate.
   *
   * This is deliberately independent of active-minute coverage. Active minutes
   * support per-user allocation, but they do not decide whether the app's own
   * measured billing total can be projected.
   */
  appComputeDaily: number | null;
  /** Why the required App compute projection row has no numeric rate. */
  appComputeUnavailable: string;
  fixedDailyCosts: Array<{ id: string; label: string; amount: number }>;
  exclusions: ForecastExclusion[];
  caveats: string[];
  noActivityHistory: boolean;
  /** New payloads use completed interactive Ask evidence; absent legacy payloads retain their old projection semantics. */
  marginalInteractive: boolean;
}

export interface ForecastSuggestionEvidence {
  calculation: string;
  period: string;
  range: { label: string; min: number; max: number } | null;
}

export interface ForecastComponent {
  id: string;
  label: string;
  dailyAmount: number | null;
  formula: string;
  unavailable: string;
}

export interface ForecastHorizon {
  days: number;
  label: string;
  total: number | null;
  components: Array<{ id: string; label: string; amount: number | null; unavailable: string }>;
}

export interface ForecastResult {
  dailyQuestions: number;
  dailyActiveMinutes: number;
  components: ForecastComponent[];
  horizons: ForecastHorizon[];
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function oneDecimal(value: number | undefined): number {
  return Math.round(finiteNonNegative(value) * 10) / 10;
}

export function normalizeForecastAssumptions(assumptions: Partial<ForecastAssumptions>): ForecastAssumptions {
  return {
    averageDailyUsers: Math.round(finiteNonNegative(assumptions.averageDailyUsers)),
    questionsPerUserPerDay: oneDecimal(assumptions.questionsPerUserPerDay),
    activeAppMinutesPerUserPerDay: oneDecimal(assumptions.activeAppMinutesPerUserPerDay),
    averageModelTokensPerQuestion: Math.round(finiteNonNegative(assumptions.averageModelTokensPerQuestion)),
  };
}

export function stepForecastAssumption(field: keyof ForecastAssumptions, value: number, direction: -1 | 1): number {
  const step = field === 'questionsPerUserPerDay' || field === 'activeAppMinutesPerUserPerDay' ? 0.1 : 1;
  return normalizeForecastAssumptions({ [field]: Math.max(0, value + direction * step) })[field];
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

function windowValues(series: Array<{ day: string; count: number }>, from: string, to: string): Map<string, number> {
  return new Map(
    series
      .filter((point) => inWindow(point.day, from, to) && Number.isFinite(point.count) && point.count >= 0)
      .map((point) => [point.day, point.count])
  );
}

function rangeOf(values: Iterable<number>, label: string): ForecastSuggestionEvidence['range'] {
  const finite = [...values].filter((value) => Number.isFinite(value) && value >= 0);
  return finite.length > 0 ? { label, min: Math.min(...finite), max: Math.max(...finite) } : null;
}

function usableAmount(tile: CostTile | undefined, unit: CostBudgetUnit): number | null {
  const amount = unit === 'DBU' ? tile?.dbus : tile?.amount;
  if (!tile || amount === null || amount === undefined || !Number.isFinite(amount) || amount < 0) return null;
  if (tile.attribution === 'shared-upper-bound' || tile.attribution === 'unavailable') return null;
  if (unit === 'USD' && tile.pricing && tile.pricing.match !== 'priced') return null;
  return amount;
}

function totalInWindow(tile: CostTile | undefined, days: number, unit: CostBudgetUnit): number | null {
  const amount = usableAmount(tile, unit);
  if (amount === null || days <= 0) return null;
  return tile?.basis === 'per-day' ? amount * days : amount;
}

function dailyInWindow(tile: CostTile | undefined, days: number, unit: CostBudgetUnit): number | null {
  const amount = usableAmount(tile, unit);
  if (amount === null || days <= 0) return null;
  return tile?.basis === 'per-day' ? amount : amount / days;
}

function tileReason(tile: CostTile | undefined, fallback: string, unit: CostBudgetUnit): string {
  if (!tile) return fallback;
  if (tile.attribution === 'shared-upper-bound') return 'Shared workspace or warehouse spend is not summed.';
  if (unit === 'USD' && tile.pricing && tile.pricing.match !== 'priced') {
    return tile.unavailable || `List-price coverage is ${tile.pricing.match}; this amount is withheld.`;
  }
  return unit === 'DBU' ? 'No measured, attributable DBU amount is available.' : tile.unavailable || fallback;
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
  traffic: OpsTrafficPayload | null,
  unit: CostBudgetUnit = 'USD'
): ForecastBaseline {
  const emptyDefaults: ForecastAssumptions = {
    averageDailyUsers: 0,
    questionsPerUserPerDay: 0,
    activeAppMinutesPerUserPerDay: 0,
    averageModelTokensPerQuestion: 0,
  };
  const unavailableEvidence = (label: string): ForecastSuggestionEvidence => ({
    calculation: `${label} unavailable`,
    period: '',
    range: null,
  });
  const empty: ForecastBaseline = {
    available: false,
    unavailableReason: 'Cost has not established a priced baseline yet.',
    currency: unit === 'DBU' ? 'DBU' : cost?.currency || 'USD',
    window: { from: cost?.range.from ?? '', to: cost?.range.to ?? '', days: 0 },
    source:
      'Ops Cost (billing list prices and Query History) plus Ops Traffic (stored questions, askers, and active minutes)',
    defaults: emptyDefaults,
    evidence: {
      averageDailyUsers: unavailableEvidence('daily users'),
      questionsPerUserPerDay: unavailableEvidence('questions per user'),
      activeAppMinutesPerUserPerDay: unavailableEvidence('active minutes per user'),
      averageModelTokensPerQuestion: unavailableEvidence('model tokens'),
    },
    observed: {
      servingCostPerQuestion: null,
      foundationCostPerQuestion: null,
      averageModelTokensPerQuestion: null,
      sqlCostPerQuestion: null,
      appCostPerActiveMinute: null,
    },
    appComputeDaily: null,
    appComputeUnavailable: 'No measured, attributable App compute rate is available.',
    fixedDailyCosts: [],
    exclusions: [],
    caveats:
      unit === 'USD'
        ? ['Forecasts use Databricks list prices, not contracted rates, invoices, budgets, or commitments.']
        : ['Forecasts use measured Databricks units and do not apply a USD conversion rate.'],
    noActivityHistory: false,
    marginalInteractive: false,
  };

  if (!cost) return empty;

  const days = rangeDays(cost.range.from, cost.range.to);
  const marginalInteractive = cost.perQuestion.complete === true;
  const baseline: ForecastBaseline = {
    ...empty,
    currency: unit === 'DBU' ? 'DBU' : cost.currency || 'USD',
    window: { ...cost.range, days },
    unavailableReason: '',
    caveats: [...empty.caveats],
    marginalInteractive,
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
  const period = `${days} complete ${days === 1 ? 'day' : 'days'} · ${cost.range.from}–${cost.range.to}`;
  const dailyUsers = windowValues(
    askersReadable ? (traffic?.distinctAskersPerDay ?? []) : [],
    cost.range.from,
    cost.range.to
  );
  const dailyQuestions = windowValues(
    questionsReadable ? (traffic?.questionsPerDay ?? []) : [],
    cost.range.from,
    cost.range.to
  );
  const dailyMinutes = windowValues(
    activeMinutesReadable ? (traffic?.activeMinutesPerDay ?? []) : [],
    cost.range.from,
    cost.range.to
  );
  const questionRatios = [...dailyQuestions].flatMap(([day, count]) => {
    const users = dailyUsers.get(day);
    return users && users > 0 ? [count / users] : [];
  });
  const activeMinuteRatios = [...dailyMinutes].flatMap(([day, count]) => {
    const users = dailyUsers.get(day);
    return users && users > 0 ? [count / users] : [];
  });

  baseline.defaults = normalizeForecastAssumptions({
    ...baseline.defaults,
    averageDailyUsers: userDays / days,
    questionsPerUserPerDay: userDays > 0 ? questionCount / userDays : 0,
    activeAppMinutesPerUserPerDay: userDays > 0 ? activeMinutes / userDays : 0,
  });
  baseline.evidence.averageDailyUsers = {
    calculation: `${userDays.toLocaleString()} user-days ÷ ${days} complete ${days === 1 ? 'day' : 'days'}`,
    period,
    range: rangeOf(dailyUsers.values(), 'daily users'),
  };
  baseline.evidence.questionsPerUserPerDay = {
    calculation: `${questionCount.toLocaleString()} questions ÷ ${userDays.toLocaleString()} user-days`,
    period,
    range: rangeOf(questionRatios, 'daily questions/user'),
  };
  baseline.evidence.activeAppMinutesPerUserPerDay = {
    calculation: `${activeMinutes.toLocaleString()} active minutes ÷ ${userDays.toLocaleString()} user-days`,
    period,
    range: rangeOf(activeMinuteRatios, 'daily minutes/user'),
  };
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
  const servingTotal = totalInWindow(serving, days, unit);
  const tokenRuns = finiteNonNegative(cost.perQuestion.tokenCoveredRuns);
  const recordedTokens = finiteNonNegative(cost.perQuestion.totalRecordedTokens);
  const completedRuns = finiteNonNegative(cost.perQuestion.runsInRange);
  const averageTokens = tokenRuns > 0 && recordedTokens > 0 ? recordedTokens / tokenRuns : null;
  if (averageTokens !== null) {
    const normalizedAverageTokens = oneDecimal(averageTokens);
    baseline.observed.averageModelTokensPerQuestion = normalizedAverageTokens;
    baseline.defaults.averageModelTokensPerQuestion = normalizedAverageTokens;
    const tokenObservations = cost.perQuestion.runs.flatMap((run) =>
      typeof run.totalTokens === 'number' && Number.isFinite(run.totalTokens) && run.totalTokens >= 0
        ? [run.totalTokens]
        : []
    );
    baseline.evidence.averageModelTokensPerQuestion = {
      calculation: `${recordedTokens.toLocaleString()} tokens ÷ ${tokenRuns.toLocaleString()} covered ${
        tokenRuns === 1 ? 'question' : 'questions'
      }`,
      period,
      range: rangeOf(tokenObservations, 'observed tokens/question'),
    };
  }
  const servingQuestions = marginalInteractive ? completedRuns : questionCount;
  if (servingTotal !== null && servingQuestions > 0 && (marginalInteractive || averageTokens !== null)) {
    // Traffic defines a question as one stored user message. Amortizing the
    // measured endpoint total over that same population keeps the rate and the
    // editable "questions per user" assumption on one denominator, including
    // questions whose runs later failed or were refused.
    baseline.observed.servingCostPerQuestion = servingTotal / servingQuestions;
  } else {
    baseline.exclusions.push({
      component: serving?.label || 'Serving endpoint',
      reason:
        servingTotal === null
          ? tileReason(serving, 'No priced serving spend was measured.', unit)
          : 'No completed interactive Ask overlaps the Cost window.',
    });
  }

  const foundation = cost.tiles.find((tile) => tile.id === 'foundation-model');
  const foundationTotal = totalInWindow(foundation, days, unit);
  if (foundation && foundationTotal !== null && completedRuns > 0 && averageTokens !== null) {
    baseline.observed.foundationCostPerQuestion = foundationTotal / completedRuns;
    if (tokenRuns < completedRuns) {
      pushUnique(
        baseline.caveats,
        `Foundation-model token coverage is partial (${tokenRuns} of ${completedRuns} completed questions).`
      );
    }
  } else if (foundation) {
    baseline.exclusions.push({
      component: foundation?.label || 'Foundation model tokens',
      reason:
        foundationTotal === null
          ? tileReason(foundation, 'No priced foundation-model token spend was measured.', unit)
          : averageTokens === null
            ? 'Recorded model tokens do not cover any completed question.'
            : 'No completed interactive Ask overlaps the Cost window.',
    });
  }

  const sql = cost.tiles.find((tile) => tile.id === 'sql-warehouse');
  const sqlTotal = totalInWindow(sql, days, unit);
  const queryHistoryComplete = sql?.evidence?.queryHistoryComplete !== false;
  if (sqlTotal !== null && questionCount > 0 && queryHistoryComplete) {
    baseline.observed.sqlCostPerQuestion = sqlTotal / questionCount;
  } else {
    baseline.exclusions.push({
      component: 'Astrolabe SQL',
      reason: !queryHistoryComplete
        ? 'Query History is incomplete, so attributed SQL spend is withheld.'
        : sqlTotal === null
          ? tileReason(sql, 'No priced, attributable SQL spend was measured.', unit)
          : 'No stored user questions overlap the Cost window.',
    });
  }

  const app = cost.tiles.find((tile) => tile.id === 'app-compute');
  const appDaily = dailyInWindow(app, days, unit);
  baseline.appComputeDaily = appDaily;
  if (appDaily !== null) {
    baseline.appComputeUnavailable = '';
    if (activeMinutesReadable && activeMinutesComplete && activeMinutes > 0) {
      baseline.observed.appCostPerActiveMinute = (appDaily * days) / activeMinutes;
    }
  } else {
    baseline.appComputeUnavailable = tileReason(app, 'No priced app-compute spend was measured.', unit);
  }

  const vector = cost.tiles.find((tile) => tile.id === 'vector-search');
  const vectorDaily = dailyInWindow(vector, days, unit);
  if (vectorDaily !== null && vector?.resourceId) {
    baseline.fixedDailyCosts.push({
      id: 'vector-search',
      label: vector.label || 'Vector Search',
      amount: vectorDaily,
    });
  } else if (vector?.resourceId) {
    baseline.exclusions.push({
      component: vector?.label || 'Vector Search',
      reason: tileReason(vector, 'No measured, attributable Vector Search spend is available.', unit),
    });
  }

  const known = new Set(['serving-endpoint', 'foundation-model', 'sql-warehouse', 'app-compute', 'vector-search']);
  for (const tile of cost.tiles) {
    if (known.has(tile.id) || tile.id === 'genie:unattributed') continue;
    const amount = dailyInWindow(tile, days, unit);
    if (amount !== null) {
      baseline.fixedDailyCosts.push({ id: tile.id, label: tile.label, amount });
    } else {
      baseline.exclusions.push({
        component: tile.label,
        reason: tileReason(tile, 'No priced, deployment-attributable daily baseline is available.', unit),
      });
    }
  }

  if (unit === 'USD' && cost.honesty?.currencyConsistent === false) {
    baseline.unavailableReason = 'The Cost window contains mixed currencies, so no total can be formed.';
    return baseline;
  }

  const hasMeasuredRate =
    baseline.observed.servingCostPerQuestion !== null ||
    baseline.observed.foundationCostPerQuestion !== null ||
    baseline.observed.sqlCostPerQuestion !== null ||
    baseline.appComputeDaily !== null ||
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

/** Apply editable assumptions to a prepared baseline. */
export function calculateForecast(baseline: ForecastBaseline, assumptions: ForecastAssumptions): ForecastResult {
  const safe = normalizeForecastAssumptions(assumptions);
  const dailyQuestions = safe.averageDailyUsers * safe.questionsPerUserPerDay;
  const dailyActiveMinutes = safe.averageDailyUsers * safe.activeAppMinutesPerUserPerDay;
  const components: ForecastComponent[] = [];

  if (baseline.observed.servingCostPerQuestion !== null) {
    const tokenRatio =
      !baseline.marginalInteractive &&
      baseline.observed.averageModelTokensPerQuestion !== null &&
      baseline.observed.averageModelTokensPerQuestion > 0
        ? safe.averageModelTokensPerQuestion / baseline.observed.averageModelTokensPerQuestion
        : 1;
    components.push({
      id: 'serving-endpoint',
      label: baseline.marginalInteractive ? 'Agent serving' : 'Serving endpoint',
      dailyAmount: dailyQuestions * baseline.observed.servingCostPerQuestion * tokenRatio,
      formula: baseline.marginalInteractive
        ? 'daily interactive Asks × observed marginal serving cost/Ask'
        : 'daily stored questions × observed serving cost/stored question × assumed-to-observed token ratio',
      unavailable: '',
    });
  }
  if (
    baseline.observed.foundationCostPerQuestion !== null &&
    baseline.observed.averageModelTokensPerQuestion !== null &&
    baseline.observed.averageModelTokensPerQuestion > 0
  ) {
    const tokenRatio = safe.averageModelTokensPerQuestion / baseline.observed.averageModelTokensPerQuestion;
    components.push({
      id: 'foundation-model',
      label: 'Foundation model tokens',
      dailyAmount: dailyQuestions * baseline.observed.foundationCostPerQuestion * tokenRatio,
      formula: 'daily interactive Asks × observed token cost/Ask × assumed-to-observed token ratio',
      unavailable: '',
    });
  }
  if (baseline.observed.sqlCostPerQuestion !== null) {
    components.push({
      id: 'sql-warehouse',
      label: baseline.marginalInteractive ? 'Ask SQL' : 'Astrolabe SQL',
      dailyAmount: dailyQuestions * baseline.observed.sqlCostPerQuestion,
      formula: 'daily stored questions × observed attributed SQL cost/stored question',
      unavailable: '',
    });
  }
  components.push({
    id: 'app-compute',
    label: 'App compute',
    dailyAmount: baseline.appComputeDaily,
    formula: 'observed attributable app-compute daily baseline (held fixed)',
    unavailable: baseline.appComputeUnavailable,
  });
  for (const fixed of baseline.fixedDailyCosts) {
    components.push({
      ...fixed,
      dailyAmount: fixed.amount,
      formula: 'observed attributable daily baseline (held fixed)',
      unavailable: '',
    });
  }

  const numeric = components.filter(
    (component): component is ForecastComponent & { dailyAmount: number } =>
      component.dailyAmount !== null && Number.isFinite(component.dailyAmount)
  );
  const projectedAmount = (component: ForecastComponent, days: number): number | null => {
    if (component.dailyAmount === null) return null;
    if (!component.id.startsWith('genie:') || baseline.window.to > GENIE_PROMOTION_END) {
      return component.dailyAmount * days;
    }
    const firstForecastDay = new Date(`${baseline.window.to}T00:00:00Z`);
    firstForecastDay.setUTCDate(firstForecastDay.getUTCDate() + 1);
    const promotionEnd = Date.parse(`${GENIE_PROMOTION_END}T00:00:00Z`);
    const promoDays = Math.min(days, Math.max(0, Math.floor((promotionEnd - firstForecastDay.getTime()) / DAY_MS) + 1));
    const postPromotionDays = days - promoDays;
    // Charged Genie rows during the promotion are effective DBUs after the 25%
    // promotion. At the boundary the same raw usage is 75% of that rate.
    return component.dailyAmount * (promoDays + postPromotionDays * 0.75);
  };
  const horizons = FORECAST_HORIZONS.map((horizon): ForecastHorizon => {
    if (!baseline.available || numeric.length === 0) {
      return { ...horizon, total: null, components: [] };
    }
    const breakdown = components.map((component) => ({
      id: component.id,
      label: component.label,
      amount: projectedAmount(component, horizon.days),
      unavailable: component.unavailable,
    }));
    return {
      ...horizon,
      total: breakdown.reduce((total, component) => total + (component.amount ?? 0), 0),
      components: breakdown,
    };
  });

  return { dailyQuestions, dailyActiveMinutes, components, horizons };
}
