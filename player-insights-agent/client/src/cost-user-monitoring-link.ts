import type { CostBudgetUnit } from '../../shared/cost-budgets';

/** Carry compatible Monitoring state and the Ops surface that opened the modal. */
export function perUserSpendHref(search: string, unit: CostBudgetUnit, returnTo = '/ops'): string {
  const current = new URLSearchParams(search);
  const next = new URLSearchParams();
  const selectedRange = current.get('range');
  if (selectedRange === '24h' || selectedRange === '30d' || selectedRange === 'all') {
    next.set('range', selectedRange);
  }
  next.set('users', '1');
  next.set('userUnit', unit);
  next.set('returnTo', returnTo);
  return `/monitoring?${next.toString()}`;
}
