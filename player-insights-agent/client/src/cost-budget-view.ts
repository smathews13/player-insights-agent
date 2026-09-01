import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { CostTile, OpsCostPayload } from '../../shared/ops-contract';
import { appCostSummary } from '../../shared/app-cost-summary';

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
  if (typeof baseline !== 'number' || !Number.isFinite(baseline)) return 'No monthly run-rate baseline';
  const format = (value: number) =>
    value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `30-day run rate: ${format(baseline)} ${unit}`;
}

function inclusiveDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round((end - start) / 86_400_000) + 1
    : 0;
}

/** Complete source days represented by the selected Cost range. */
export function costCoveredDays(payload: Pick<OpsCostPayload, 'range' | 'throughDay'>): number {
  const through = payload.throughDay && payload.throughDay < payload.range.to ? payload.throughDay : payload.range.to;
  return inclusiveDays(payload.range.from, through);
}

/** A monthly calibration from paid attributable selected-period spend, never a saved value. */
export function resourceBudgetBaseline(
  payload: Pick<OpsCostPayload, 'state' | 'range' | 'throughDay' | 'honesty'>,
  tile: CostTile,
  unit: CostBudgetUnit
): number | null {
  if (payload.state !== 'ready' || payload.honesty?.rangeMayStillFill === true || tile.attribution === 'unavailable') {
    return null;
  }
  const amount = unit === 'DBU' ? (tile.dbus ?? null) : tile.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (unit === 'USD') {
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
  }
  if (tile.basis === 'per-day') return amount * 30;
  const days = costCoveredDays(payload);
  return days > 0 ? (amount / days) * 30 : null;
}
