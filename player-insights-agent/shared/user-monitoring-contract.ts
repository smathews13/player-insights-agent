import type { CostBudgetUnit } from './cost-budgets';
import type { OpsDayRange } from './ops-contract';
import type { Role } from './user-roster-contract';
import type { UserSpendAmount, UserSpendQuality, UserSpendReconciliation } from './user-spend-contract';

export const USER_MONITORING_SCHEMA_REVISION = 3;

export interface UserMonitoringRow {
  email: string;
  role: Role;
  /** Current assignment only. Historical run persona remains immutable elsewhere. */
  persona: { id: string; name: string } | null;
  lastActive: string;
  questions: number;
  runs: number;
  coveredDays: number;
  spend: {
    usd: UserSpendAmount;
    dbu: UserSpendAmount;
  };
  coverage: UserSpendQuality;
}

export interface UserMonitoringPayload {
  schemaRevision: typeof USER_MONITORING_SCHEMA_REVISION;
  readAt: string;
  range: OpsDayRange;
  unit: CostBudgetUnit;
  state: 'ready' | 'partial' | 'unavailable';
  reason: string;
  users: UserMonitoringRow[];
  personas: Array<{ id: string; name: string; count: number }>;
  dataRevision: number;
  pagination: {
    total: number;
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  reconciliation: {
    usd: UserSpendReconciliation;
    dbu: UserSpendReconciliation;
  };
  /** Serving-layer freshness; optional for rolling deploys with older servers. */
  freshness?: {
    computedAt: string | null;
    sourceThrough: string | null;
    billingCompleteThrough: string | null;
    isRefreshing: boolean;
    isStale: boolean;
    calculationVersion: number;
    completeness: {
      activity: 'complete' | 'partial';
      billing: 'complete' | 'partial';
      usd: 'complete' | 'partial';
      dbu: 'complete' | 'partial';
    };
  };
}
