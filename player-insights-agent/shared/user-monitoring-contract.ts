import type { CostBudgetUnit } from './cost-budgets';
import type { OpsDayRange } from './ops-contract';
import type { Role } from './user-roster-contract';
import type { UserSpendAmount, UserSpendQuality, UserSpendReconciliation } from './user-spend-contract';

export interface UserMonitoringRow {
  email: string;
  role: Role;
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
