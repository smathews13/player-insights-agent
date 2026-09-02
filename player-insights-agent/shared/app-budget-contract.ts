/**
 * Dependency-free browser contract for the server-authoritative app budget guard.
 *
 * Runtime validation remains in app-budget-guard.ts for server and lazy admin
 * surfaces. The eager Ask client uses these plain values and a narrow decoder
 * so opening the composer does not load Zod.
 */
export const APP_BUDGET_WARNING_PERCENT = 80;
export const APP_BUDGET_APPROVAL_PERCENT = 100;
export const BUDGET_APPROVAL_REQUIRED = 'BUDGET_APPROVAL_REQUIRED' as const;

/** Shared copy for enforcement documentation; values derive from the same threshold constants as the guard. */
export const APP_BUDGET_GUARDRAILS = [
  { label: 'Scope', value: 'Monthly app budget only' },
  { label: 'Measurement window', value: 'Paid, attributable month-to-date spend' },
  { label: 'Warning', value: `${APP_BUDGET_WARNING_PERCENT}% — questions continue` },
  {
    label: 'Approval required',
    value: `${APP_BUDGET_APPROVAL_PERCENT}% — new questions pause until an administrator approves`,
  },
  {
    label: 'Approval duration',
    value: 'Through month end, for the exact current budget value, unit and revision; changing budget invalidates it',
  },
  { label: 'In-flight work', value: 'Continues' },
  { label: 'Resource budgets', value: 'Advisory only' },
  {
    label: 'Billing freshness',
    value:
      'Authoritative system billing can lag by hours; concurrent requests may pass before the threshold is observed',
  },
] as const;

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

export interface AppBudgetDisplaySpend {
  amount: number | null;
  budget: number;
  coverage: AppBudgetCoverage;
  sourceThrough: string;
}

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
  /**
   * Display-only canonical MTD estimates by unit. Enforcement continues to use
   * the top-level measured/coverage decision and fails open unless complete.
   */
  displayMtdSpend?: Partial<Record<AppBudgetUnit, AppBudgetDisplaySpend>>;
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
