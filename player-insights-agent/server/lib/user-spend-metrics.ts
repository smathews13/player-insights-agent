import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { UserSpendKpi, UserSpendMetrics } from '../../shared/user-spend-contract';
import { deriveCoreUserSpendMetrics, deriveUserTokenAverages } from '../../shared/user-spend-metrics';

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
}

function unavailable(subtitle: string): UserSpendKpi {
  return { value: null, state: 'unavailable', subtitle };
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
  };
}
