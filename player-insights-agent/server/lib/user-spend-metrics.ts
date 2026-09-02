import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { OpsDayRange } from '../../shared/ops-contract';
import type { UserSpendKpi, UserSpendMetrics } from '../../shared/user-spend-contract';

const DAY_MS = 86_400_000;

interface MetricSnapshot {
  amount: number | null;
  comparable: boolean;
}

export interface UserSpendMetricInput {
  unit: CostBudgetUnit;
  current: MetricSnapshot & {
    questions: number;
    coveredDays: number;
    appTotal: number | null;
    appComparable: boolean;
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
    return unavailable(subtitle);
  }
  if (prior.amount === 0) {
    return current.amount > 0 ? { value: null, state: 'new', subtitle } : { value: 0, state: 'value', subtitle };
  }
  return { value: ((current.amount - prior.amount) / Math.abs(prior.amount)) * 100, state: 'value', subtitle };
}

export function buildUserSpendMetrics(input: UserSpendMetricInput): UserSpendMetrics {
  const current = input.current;
  return {
    unit: input.unit,
    questions: current.questions,
    coveredDays: current.coveredDays,
    costPerQuestion:
      current.comparable && current.amount !== null && current.questions > 0
        ? {
            value: current.amount / current.questions,
            state: 'value',
            subtitle: `${current.questions.toLocaleString()} submitted questions`,
          }
        : unavailable(
            current.questions > 0
              ? `${current.questions.toLocaleString()} submitted questions`
              : 'No submitted questions'
          ),
    averageDaily:
      current.comparable && current.amount !== null && current.coveredDays > 0
        ? {
            value: current.amount / current.coveredDays,
            state: 'value',
            subtitle: `${current.coveredDays.toLocaleString()} covered days`,
          }
        : unavailable(
            current.coveredDays > 0 ? `${current.coveredDays.toLocaleString()} covered days` : 'No covered billing days'
          ),
    appShare:
      current.appComparable && current.amount !== null && current.appTotal !== null && current.appTotal > 0
        ? { value: (current.amount / current.appTotal) * 100, state: 'value', subtitle: 'of comparable app spend' }
        : unavailable('App total not comparable'),
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
