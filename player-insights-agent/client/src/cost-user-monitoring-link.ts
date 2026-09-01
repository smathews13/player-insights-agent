import type { CostBudgetUnit } from '../../shared/cost-budgets';

/** Carry only compatible shared range state and the selected display unit. */
export function perUserSpendHref(search: string, unit: CostBudgetUnit): string {
  const current = new URLSearchParams(search);
  const next = new URLSearchParams();
  const selectedRange = current.get('range');
  if (selectedRange === '24h' || selectedRange === '30d' || selectedRange === 'all') {
    next.set('range', selectedRange);
  }
  next.set('users', '1');
  next.set('userUnit', unit);
  return `/monitoring?${next.toString()}`;
}
