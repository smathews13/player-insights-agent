import type { CostBudgetUnit } from './cost-budgets';
import type { OpsDayRange } from './ops-contract';
import type { Role } from './user-roster-contract';
import type { UserSpendAmount, UserSpendQuality, UserSpendReconciliation } from './user-spend-contract';

export interface UserMonitoringRow {
  email: string;
  role: Role;
  /** Current assignment only. Historical run persona remains immutable elsewhere. */
  persona: { id: string; name: string } | null;
  lastActive: string;
  questions: number;
  runs: number;
  spend: {
    usd: UserSpendAmount;
    dbu: UserSpendAmount;
  };
  coverage: UserSpendQuality;
}

export interface UserMonitoringPayload {
  readAt: string;
  range: OpsDayRange;
  unit: CostBudgetUnit;
  state: 'ready' | 'partial' | 'unavailable';
  reason: string;
  users: UserMonitoringRow[];
  personas: Array<{ id: string; name: string; count: number }>;
  dataRevision: number;
  pagination: {
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
  reconciliation: {
    usd: UserSpendReconciliation;
    dbu: UserSpendReconciliation;
  };
}
