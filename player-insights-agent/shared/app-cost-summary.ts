import type { CostBudgetUnit } from './cost-budgets';
import type { AppSpendFigure, CostTile, OpsCostPayload } from './ops-contract';

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
      tile.id !== 'genie:unattributed' &&
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
      tile.id !== 'genie:unattributed' &&
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

/** Build a wire-ready paid-spend figure without discarding a usable known subtotal. */
export function appSpendFigure(
  payload: Pick<OpsCostPayload, 'range' | 'tiles' | 'currency' | 'throughDay' | 'honesty'>,
  sourceFrom = payload.range.from
): AppSpendFigure {
  const usd = appCostSummary(payload, 'USD');
  const dbu = appCostSummary(payload, 'DBU');
  const knownTotal = (unit: CostBudgetUnit): number | null => {
    const known = payload.tiles.filter((tile) => {
      if (tile.id === 'genie:unattributed' || !deploymentAttribution(tile)) return false;
      const value = unit === 'USD' ? tile.amount : tile.dbus;
      return typeof value === 'number' && Number.isFinite(value);
    });
    if (known.length === 0) return null;
    return known.reduce((total, tile) => {
      const value = unit === 'USD' ? (tile.amount ?? 0) : (tile.dbus ?? 0);
      return total + value * (tile.basis === 'per-day' ? usd.days : 1);
    }, 0);
  };
  const amount = knownTotal('USD');
  const measuredDbus = knownTotal('DBU');
  const hasKnown = amount !== null || measuredDbus !== null;
  const displayIncomplete = payload.tiles.some((tile) => {
    if (tile.id === 'genie:unattributed' || !tile.resourceId.trim()) return false;
    const priceMatch = tile.pricing?.match;
    return (
      !deploymentAttribution(tile) ||
      typeof tile.amount !== 'number' ||
      !Number.isFinite(tile.amount) ||
      (priceMatch !== undefined && !['priced', 'none'].includes(priceMatch))
    );
  });
  const partial =
    usd.partial ||
    dbu.partial ||
    displayIncomplete ||
    payload.honesty?.rangeMayStillFill === true ||
    payload.honesty?.currencyConsistent === false;
  return {
    amount,
    dbus: measuredDbus,
    currency: payload.currency,
    sourceFrom,
    sourceThrough: payload.throughDay,
    completeness: !hasKnown ? 'unavailable' : partial ? 'partial' : 'complete',
    estimated: usd.estimated || dbu.estimated || partial,
  };
}
