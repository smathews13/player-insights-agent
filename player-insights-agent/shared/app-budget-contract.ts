/**
 * Dependency-free browser contract for the server-authoritative app budget guard.
 *
 * Runtime validation remains in app-budget-guard.ts for server and lazy admin
 * surfaces. The eager Ask client uses these plain values and a narrow decoder
 * so opening the composer does not load Zod.
 */
export const APP_BUDGET_WARNING_PERCENT = 80;
export const BUDGET_APPROVAL_REQUIRED = 'BUDGET_APPROVAL_REQUIRED' as const;

export const APP_BUDGET_LEVELS = [
  'unset',
  'below',
  'warning',
  'approval-required',
  'approved-overage',
  'unavailable/partial',
] as const;
export type AppBudgetLevel = (typeof APP_BUDGET_LEVELS)[number];

export const APP_BUDGET_COVERAGES = ['complete', 'partial', 'unavailable'] as const;
export type AppBudgetCoverage = (typeof APP_BUDGET_COVERAGES)[number];
export type AppBudgetUnit = 'USD' | 'DBU';

export interface AppBudgetApproval {
  approved: boolean;
  approvedAt: string;
  approvedBy: string;
  through: string;
  revokedAt: string;
}

export interface AppBudgetStatus {
  level: AppBudgetLevel;
  measured: number | null;
  budget: number | null;
  unit: AppBudgetUnit | null;
  ratio: number | null;
  percent: number | null;
  monthStart: string;
  monthEnd: string;
  measuredThrough: string;
  readAt: string;
  coverage: AppBudgetCoverage;
  approval: AppBudgetApproval | null;
  budgetFingerprint: string;
  code: string;
  detail: string;
}

export interface AppBudgetPeriod {
  monthStart: string;
  monthEnd: string;
  measurementThrough: string;
}

/** UTC calendar bounds. Billing reads complete days only, so day one has no enforceable observation. */
export function appBudgetPeriod(now: number): AppBudgetPeriod {
  const instant = new Date(now);
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const day = (value: number) => new Date(value).toISOString().slice(0, 10);
  return {
    monthStart: day(Date.UTC(year, month, 1)),
    monthEnd: day(Date.UTC(year, month + 1, 0)),
    measurementThrough: day(Date.UTC(year, month, instant.getUTCDate() - 1)),
  };
}

export function emptyAppBudgetStatus(
  period: AppBudgetPeriod,
  readAt: string,
  overrides: Partial<AppBudgetStatus> = {}
): AppBudgetStatus {
  return {
    level: 'unset',
    measured: null,
    budget: null,
    unit: null,
    ratio: null,
    percent: null,
    monthStart: period.monthStart,
    monthEnd: period.monthEnd,
    measuredThrough: period.measurementThrough,
    readAt,
    coverage: 'unavailable',
    approval: null,
    budgetFingerprint: '',
    code: 'APP_BUDGET_UNSET',
    detail: '',
    ...overrides,
  };
}
