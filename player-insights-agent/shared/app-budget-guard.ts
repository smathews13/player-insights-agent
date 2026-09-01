import { z } from 'zod';

import { CostBudgetUnitSchema } from './cost-budgets';
import {
  APP_BUDGET_COVERAGES,
  APP_BUDGET_LEVELS,
  APP_BUDGET_WARNING_PERCENT,
  type AppBudgetApproval,
  type AppBudgetStatus,
} from './app-budget-contract';
export * from './app-budget-contract';

export const AppBudgetLevelSchema = z.enum(APP_BUDGET_LEVELS);

export const AppBudgetCoverageSchema = z.enum(APP_BUDGET_COVERAGES);

export const AppBudgetApprovalSchema: z.ZodType<AppBudgetApproval> = z.strictObject({
  approved: z.boolean(),
  approvedAt: z.string(),
  approvedBy: z.string(),
  through: z.string(),
  revokedAt: z.string(),
});

export const AppBudgetStatusSchema: z.ZodType<AppBudgetStatus> = z.strictObject({
  level: AppBudgetLevelSchema,
  measured: z.number().finite().nonnegative().nullable(),
  budget: z.number().finite().nonnegative().nullable(),
  unit: CostBudgetUnitSchema.nullable(),
  ratio: z.number().finite().nonnegative().nullable(),
  percent: z.number().finite().nonnegative().nullable(),
  monthStart: z.string(),
  monthEnd: z.string(),
  measuredThrough: z.string(),
  readAt: z.string(),
  coverage: AppBudgetCoverageSchema,
  approval: AppBudgetApprovalSchema.nullable(),
  budgetFingerprint: z.string(),
  code: z.string(),
  detail: z.string(),
});

const DECIMAL_SCALE = 1_000_000n;

/**
 * Fixed-point comparison for threshold decisions.
 *
 * Billing values arrive as binary floats. Converting both sides to six decimal
 * places before comparing keeps 80% and 100% equality deterministic without an
 * epsilon that changes with the size of the budget.
 */
export function budgetLevelFor(
  measured: number,
  budget: number
): { level: 'below' | 'warning' | 'approval-required'; ratio: number; percent: number } {
  const fixed = (value: number): bigint => {
    if (!Number.isFinite(value) || value < 0) throw new Error('Budget comparisons require finite non-negative values.');
    return BigInt(Math.round(value * Number(DECIMAL_SCALE)));
  };
  const used = fixed(measured);
  const limit = fixed(budget);
  const approvalRequired = limit === 0n ? true : used >= limit;
  const warning = approvalRequired || used * 100n >= limit * BigInt(APP_BUDGET_WARNING_PERCENT);
  const ratio = limit === 0n ? (used === 0n ? 1 : Number.POSITIVE_INFINITY) : Number(used) / Number(limit);
  const finiteRatio = Number.isFinite(ratio) ? ratio : Number.MAX_SAFE_INTEGER;
  return {
    level: approvalRequired ? 'approval-required' : warning ? 'warning' : 'below',
    ratio: finiteRatio,
    percent: Math.round(finiteRatio * 10_000) / 100,
  };
}
