import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { CostTile, OpsCostPayload } from '../../shared/ops-contract';
import { tileAttribution } from './ops-view';

const DAY_MS = 86_400_000;

function completeDays(payload: Pick<OpsCostPayload, 'range'>): number {
  const from = Date.parse(`${payload.range.from}T00:00:00Z`);
  const to = Date.parse(`${payload.range.to}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round((to - from) / DAY_MS) + 1 : 0;
}

/** Exact 30-day run rate from a complete measured selected-period total. */
export function monthlyAppBudgetBaseline(payload: OpsCostPayload, unit: CostBudgetUnit): number | null {
  if (payload.state !== 'ready' || payload.honesty?.rangeMayStillFill === true) return null;
  const summary = costSpendSummary(payload, unit);
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
  const days = completeDays(payload);
  // The SQL tile is Astrolabe-tagged SQL only; each Genie tile is a mutually
  // exclusive Query History allocation from the same warehouse denominator.
  const included = payload.tiles.filter(
    (tile) =>
      tileAttribution(tile) === 'deployment' &&
      (unit === 'DBU'
        ? typeof tile.dbus === 'number' && Number.isFinite(tile.dbus)
        : tile.quality !== 'unknown' &&
          typeof tile.amount === 'number' &&
          Number.isFinite(tile.amount) &&
          (tile.pricing?.match === undefined || tile.pricing.match === 'priced' || tile.pricing.match === 'none'))
  );
  const total = included.reduce(
    (sum, tile) =>
      sum + (unit === 'DBU' ? (tile.dbus ?? 0) : (tile.amount ?? 0)) * (tile.basis === 'per-day' ? days : 1),
    0
  );
  const activeMissing = payload.tiles.some(
    (tile) =>
      Boolean(tile.resourceId.trim()) &&
      (tile.attribution !== 'deployment' ||
        (unit === 'DBU'
          ? typeof tile.dbus !== 'number' || !Number.isFinite(tile.dbus)
          : typeof tile.amount !== 'number' || !Number.isFinite(tile.amount)))
  );
  const currency = payload.currency.trim();
  return {
    amount: unit === 'USD' && included.length > 0 ? total : null,
    dbus: unit === 'DBU' && included.length > 0 ? total : null,
    label:
      included.length > 0
        ? unit === 'DBU'
          ? `${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DBU`
          : `${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${
              currency ? ` ${currency}` : ''
            }`
        : 'Unavailable',
    days,
    partial: activeMissing,
    estimated: included.some((tile) => tile.quality !== 'real'),
  };
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
