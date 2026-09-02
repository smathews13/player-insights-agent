import type { CostBudgetUnit } from './cost-budgets';
import type { OpsDayRange } from './ops-contract';

export type UserSpendQuality = 'direct' | 'joined' | 'allocated' | 'unattributed' | 'unavailable' | 'partial';

export interface UserSpendAmount {
  amount: number | null;
  quality: UserSpendQuality;
}

export interface UserSpendComponent {
  id: string;
  label: string;
  usd: UserSpendAmount;
  dbu: UserSpendAmount;
  reason: string;
}

export interface UserSpendKpi {
  value: number | null;
  state: 'value' | 'new' | 'unavailable';
  subtitle: string;
}

export interface UserTokenAverages {
  totalTokens: number | null;
  coveredRuns: number | null;
  coveredQuestions: number | null;
  perRun: number | null;
  perQuestion: number | null;
}

export interface UserSpendMetrics {
  unit: CostBudgetUnit;
  questions: number | null;
  coveredDays: number | null;
  costPerQuestion: UserSpendKpi;
  averageDaily: UserSpendKpi;
  averageTokens?: UserTokenAverages;
  appShare: UserSpendKpi;
  weekOverWeek: UserSpendKpi;
  monthOverMonth: UserSpendKpi;
  comparisonFreshness: string;
}

export interface UserSpendProfile {
  email: string;
  total: {
    usd: UserSpendAmount;
    dbu: UserSpendAmount;
  };
  metrics?: UserSpendMetrics;
  components: UserSpendComponent[];
  /** Human-only calendar-month Genie allowance and promotion figures. */
  genieAllowance?: {
    month: string;
    usedDbus: number;
    remainingDbus: number;
    promotionalDbus: number;
    unclassifiedFreeDbus: number;
    chargedEffectiveDbus: number;
    chargedRawEquivalentDbus: number;
  } | null;
}

export interface UserSpendReconciliation {
  unit: CostBudgetUnit;
  appTotal: number | null;
  users: number | null;
  unattributed: number | null;
  difference: number | null;
}

export interface SpendByUserPayload {
  dataRevision: number;
  readAt: string;
  requestedRange: OpsDayRange;
  range: OpsDayRange;
  state: 'ready' | 'partial' | 'unavailable';
  reason: string;
  /** Persisted Identity-settings revision used to fence roster-derived caches. */
  identityRevision?: string;
  users: UserSpendProfile[];
  unattributed: UserSpendComponent[];
  reconciliation: {
    usd: UserSpendReconciliation;
    dbu: UserSpendReconciliation;
  };
  /** Durable read-model freshness; absent only from older deployments/caches. */
  freshness?: {
    computedAt: string | null;
    sourceThrough: string | null;
    billingCompleteThrough: string | null;
    isRefreshing: boolean;
    isStale: boolean;
    calculationVersion: number;
  };
}
