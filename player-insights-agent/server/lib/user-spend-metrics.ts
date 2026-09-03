import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { OpsDayRange } from '../../shared/ops-contract';
import type { UserSpendKpi, UserSpendMetrics } from '../../shared/user-spend-contract';
import { deriveCoreUserSpendMetrics, deriveUserTokenAverages } from '../../shared/user-spend-metrics';

const DAY_MS = 86_400_000;

interface MetricSnapshot {
  amount: number | null;
  comparable: boolean;
  estimated?: boolean;
}

export interface UserSpendMetricInput {
  unit: CostBudgetUnit;
  current: MetricSnapshot & {
    questions: number | null;
    coveredDays: number | null;
    appTotal: number | null;
    appComparable: boolean;
    totalTokens?: number | null;
    tokenCoveredRuns?: number | null;
    tokenCoveredQuestions?: number | null;
  };
  week: { current: MetricSnapshot; prior: MetricSnapshot };
  month: { current: MetricSnapshot; prior: MetricSnapshot };
  comparisonFreshness: string;
}

function unavailable(subtitle: string): UserSpendKpi {
  return { value: null, state: 'unavailable', subtitle };
}

export function spendGrowth(current: MetricSnapshot, prior: MetricSnapshot, subtitle: string): UserSpendKpi {
  if (!current.comparable || !prior.comparable || current.amount === null || prior.amount === null) {
    return unavailable('No comparable period');
  }
  if (prior.amount === 0) {
    return current.amount > 0
      ? { value: null, state: 'new', subtitle, estimated: current.estimated || prior.estimated }
      : { value: 0, state: 'value', subtitle, estimated: current.estimated || prior.estimated };
  }
  return {
    value: ((current.amount - prior.amount) / Math.abs(prior.amount)) * 100,
    state: 'value',
    subtitle,
    estimated: current.estimated || prior.estimated,
  };
}

export function buildUserSpendMetrics(input: UserSpendMetricInput): UserSpendMetrics {
  const current = input.current;
  const core = deriveCoreUserSpendMetrics({
    amount: current.amount,
    questions: current.questions,
    coveredDays: current.coveredDays,
    unit: input.unit,
    estimated: current.estimated,
  });
  return {
    unit: input.unit,
    questions: current.questions,
    coveredDays: current.coveredDays,
    costPerQuestion: core.costPerQuestion,
    averageDaily: core.averageDaily,
    averageTokens: deriveUserTokenAverages({
      totalTokens: current.totalTokens ?? null,
      coveredRuns: current.tokenCoveredRuns ?? null,
      coveredQuestions: current.tokenCoveredQuestions ?? null,
    }),
    appShare:
      current.appComparable && current.amount !== null && current.appTotal !== null && current.appTotal > 0
        ? {
            value: (current.amount / current.appTotal) * 100,
            state: 'value',
            subtitle: 'of attributable app spend',
            estimated: current.estimated,
          }
        : unavailable('No comparable app total'),
    weekOverWeek: spendGrowth(input.week.current, input.week.prior, 'vs prior 7 days'),
    monthOverMonth: spendGrowth(input.month.current, input.month.prior, 'vs prior matched month days'),
    comparisonFreshness: input.comparisonFreshness,
  };
}

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function addDays(day: string, offset: number): string {
  return isoDay(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS);
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function previousMonthStart(day: string): string {
  const date = new Date(`${monthStart(day)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return isoDay(date.getTime());
}

function daysInMonth(day: string): number {
  const date = new Date(`${monthStart(day)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return date.getUTCDate();
}

export function userSpendComparisonWindows(latestCompleteDay: string): {
  week: { current: OpsDayRange; prior: OpsDayRange };
  month: { current: OpsDayRange; prior: OpsDayRange };
} | null {
  if (!Number.isFinite(Date.parse(`${latestCompleteDay}T00:00:00Z`))) return null;
  const currentMonth = monthStart(latestCompleteDay);
  const priorMonth = previousMonthStart(latestCompleteDay);
  const elapsed = Number(latestCompleteDay.slice(8, 10));
  const matchedDays = Math.min(elapsed, daysInMonth(priorMonth));
  return {
    week: {
      current: { from: addDays(latestCompleteDay, -6), to: latestCompleteDay },
      prior: { from: addDays(latestCompleteDay, -13), to: addDays(latestCompleteDay, -7) },
    },
    month: {
      current: { from: currentMonth, to: addDays(currentMonth, matchedDays - 1) },
      prior: { from: priorMonth, to: addDays(priorMonth, matchedDays - 1) },
    },
  };
}
