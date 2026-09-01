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

export interface UserSpendProfile {
  email: string;
  total: {
    usd: UserSpendAmount;
    dbu: UserSpendAmount;
  };
  components: UserSpendComponent[];
  /** Human-only calendar-month Genie allowance and promotion figures. */
  genieAllowance?: {
    month: string;
    usedDbus: number;
    remainingDbus: number;
    promotionalDbus: number;
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
  readAt: string;
  requestedRange: OpsDayRange;
  range: OpsDayRange;
  state: 'ready' | 'partial' | 'unavailable';
  reason: string;
  users: UserSpendProfile[];
  unattributed: UserSpendComponent[];
  reconciliation: {
    usd: UserSpendReconciliation;
    dbu: UserSpendReconciliation;
  };
}
