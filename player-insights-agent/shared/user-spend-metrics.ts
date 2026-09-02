import type { CostBudgetUnit } from './cost-budgets';
import type { UserSpendKpi } from './user-spend-contract';

export interface CoreUserSpendMetricInput {
  amount: number | null;
  questions: number | null;
  coveredDays: number | null;
  unit: CostBudgetUnit;
}

function unavailable(subtitle: string): UserSpendKpi {
  return { value: null, state: 'unavailable', subtitle };
}

/**
 * Ratios that need no comparison query. Shared by the authoritative server
 * calculation and the client cache upgrader so a mixed-version response cannot
 * turn known totals and denominators into empty cards.
 */
export function deriveCoreUserSpendMetrics(input: CoreUserSpendMetricInput): {
  costPerQuestion: UserSpendKpi;
  averageDaily: UserSpendKpi;
} {
  const amount = input.amount;
  const amountKnown = amount !== null && Number.isFinite(amount);
  const questions =
    input.questions !== null && Number.isFinite(input.questions) ? Math.max(0, Math.trunc(input.questions)) : null;
  const coveredDays =
    input.coveredDays !== null && Number.isFinite(input.coveredDays)
      ? Math.max(0, Math.trunc(input.coveredDays))
      : null;
  return {
    costPerQuestion:
      amountKnown && questions !== null && questions > 0
        ? {
            value: amount / questions,
            state: 'value',
            subtitle: `${questions.toLocaleString()} submitted questions`,
          }
        : unavailable(
            questions === null
              ? 'Question count unavailable'
              : questions > 0
                ? `${questions.toLocaleString()} submitted questions`
                : 'No submitted questions'
          ),
    averageDaily:
      amountKnown && coveredDays !== null && coveredDays > 0
        ? {
            value: amount / coveredDays,
            state: 'value',
            subtitle: `${coveredDays.toLocaleString()} covered days`,
          }
        : unavailable(
            coveredDays === null
              ? 'Covered days unavailable'
              : coveredDays > 0
                ? `${coveredDays.toLocaleString()} covered days`
                : 'No covered billing days'
          ),
  };
}
