import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { CostTile, OpsCostPayload } from '../../shared/ops-contract';
import { appCostSummary } from '../../shared/app-cost-summary';

/** Exact 30-day run rate from a complete measured selected-period total. */
export function monthlyAppBudgetBaseline(payload: OpsCostPayload, unit: CostBudgetUnit): number | null {
  if (payload.state !== 'ready' || payload.honesty?.rangeMayStillFill === true) return null;
  const summary = appCostSummary(payload, unit);
  const selected = unit === 'USD' ? summary.amount : summary.dbus;
  if (summary.partial || summary.days <= 0 || selected === null || !Number.isFinite(selected) || selected <= 0) {
    return null;
  }
  return (selected / summary.days) * 30;
}

/** A two-significant-digit human increment, with no hidden contingency. */
export function monthlyBudgetSuggestion(monthly: number | null): number | null {
  if (monthly === null || !Number.isFinite(monthly) || monthly <= 0) return null;
  const increment = Math.max(0.01, 10 ** (Math.floor(Math.log10(monthly)) - 1));
  return Math.round(monthly / increment) * increment;
}

export function costSpendSummary(
  payload: Pick<OpsCostPayload, 'range' | 'tiles' | 'currency'>,
  unit: CostBudgetUnit = 'USD'
) {
  return appCostSummary(payload, unit);
}

export function budgetPlaceholder(observed: Record<CostBudgetUnit, number | null>, unit: CostBudgetUnit): string {
  const baseline = observed[unit];
  return typeof baseline === 'number' && Number.isFinite(baseline)
    ? baseline.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '';
}

/** A concise dynamic guide derived from measured spend, never an invented budget. */
export function budgetHelper(observed: Record<CostBudgetUnit, number | null>, unit: CostBudgetUnit): string {
  const baseline = observed[unit];
  if (typeof baseline !== 'number' || !Number.isFinite(baseline)) return 'No measured baseline';
  const format = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `Observed: ${format(baseline)} ${unit}`;
}

/** Only a usable measured amount may guide an editable resource assumption. */
export function resourceBudgetBaseline(tile: CostTile, unit: CostBudgetUnit): number | null {
  const amount = unit === 'DBU' ? (tile.dbus ?? null) : tile.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (unit === 'DBU') return amount;
  const match = tile.pricing?.match;
  if (
    tile.quality === 'unknown' ||
    match === 'unpriced' ||
    match === 'duplicate' ||
    match === 'mixed-currency' ||
    match === 'partial'
  ) {
    return null;
  }
  return amount;
}
