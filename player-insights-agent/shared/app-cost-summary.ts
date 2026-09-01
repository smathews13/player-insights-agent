import type { CostBudgetUnit } from './cost-budgets';
import type { CostTile, OpsCostPayload } from './ops-contract';

const DAY_MS = 86_400_000;

function completeDays(payload: Pick<OpsCostPayload, 'range'>): number {
  const from = Date.parse(`${payload.range.from}T00:00:00Z`);
  const to = Date.parse(`${payload.range.to}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round((to - from) / DAY_MS) + 1 : 0;
}

function deploymentAttribution(tile: CostTile): boolean {
  if (tile.attribution) return tile.attribution === 'deployment';
  return tile.population !== 'Whole warehouse' && tile.population !== 'Whole workspace' && tile.amount !== null;
}

/**
 * The app-attributable subtotal used by Cost Tracking and budget enforcement.
 *
 * Keep this server-safe: Cost and the guard both call this exact function after
 * the same billing statement has built the same tiles.
 */
export function appCostSummary(
  payload: Pick<OpsCostPayload, 'range' | 'tiles' | 'currency'>,
  unit: CostBudgetUnit = 'USD'
) {
  const days = completeDays(payload);
  const included = payload.tiles.filter(
    (tile) =>
      deploymentAttribution(tile) &&
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
