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
 * The three dedicated meters that bill by wall-clock time.
 *
 * These are the only tiles that carry an active/standing split: everything else
 * (foundation-model tokens, Ask SQL, Genie) is caused by a question outright, so
 * its whole figure is active and it has no standing remainder.
 */
const UPTIME_TILE_IDS = new Set<string>(['serving-endpoint', 'app-compute', 'vector-search']);

/**
 * Which slice of a tile a summary counts.
 *
 * `total` is the real billed figure (active + standing). `active` is the share
 * attributable to interactive questions/users -- the marginal share for the
 * always-on meters, the whole figure for everything else. `standing` is the
 * idle remainder of the always-on meters that keeps the resource online whether
 * or not anyone asks anything.
 */
export type CostPortion = 'total' | 'active' | 'standing';

function portionValue(tile: CostTile, unit: CostBudgetUnit, portion: CostPortion): number | null {
  const full = unit === 'USD' ? tile.amount : (tile.dbus ?? null);
  if (portion === 'total') return full;
  const uptime = UPTIME_TILE_IDS.has(tile.id);
  if (portion === 'active') {
    if (!uptime) return full;
    const marginal = unit === 'USD' ? tile.marginalAmount : tile.marginalDbus;
    return typeof marginal === 'number' && Number.isFinite(marginal) ? marginal : null;
  }
  if (!uptime) return typeof full === 'number' && Number.isFinite(full) ? 0 : null;
  const standing = unit === 'USD' ? tile.standingAmount : tile.standingDbus;
  return typeof standing === 'number' && Number.isFinite(standing) ? standing : null;
}

/**
 * The app-attributable subtotal used by Cost Tracking and budget enforcement.
 *
 * Keep this server-safe: Cost and the guard both call this exact function after
 * the same billing statement has built the same tiles. `portion` decomposes the
 * real bill into the part questions caused and the fixed part that keeps the
 * deployment online; the default stays the full billed total so budget
 * enforcement is unchanged.
 */
export function appCostSummary(
  payload: Pick<OpsCostPayload, 'range' | 'tiles' | 'currency'>,
  unit: CostBudgetUnit = 'USD',
  portion: CostPortion = 'total'
) {
  const days = completeDays(payload);
  const value = (tile: CostTile) => portionValue(tile, unit, portion);
  const included = payload.tiles.filter((tile) => {
    if (tile.id === 'genie:unattributed' || !deploymentAttribution(tile)) return false;
    const amount = value(tile);
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return false;
    if (unit === 'DBU') return true;
    return (
      tile.quality !== 'unknown' &&
      (tile.pricing?.match === undefined || tile.pricing.match === 'priced' || tile.pricing.match === 'none')
    );
  });
  const total = included.reduce((sum, tile) => sum + (value(tile) ?? 0) * (tile.basis === 'per-day' ? days : 1), 0);
  const activeMissing = payload.tiles.some(
    (tile) =>
      tile.id !== 'genie:unattributed' &&
      Boolean(tile.resourceId.trim()) &&
      (tile.attribution !== 'deployment' || typeof value(tile) !== 'number' || !Number.isFinite(value(tile)))
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
  sourceFrom = payload.range.from,
  portion: CostPortion = 'total'
): AppSpendFigure {
  const usd = appCostSummary(payload, 'USD', portion);
  const dbu = appCostSummary(payload, 'DBU', portion);
  const knownTotal = (unit: CostBudgetUnit): number | null => {
    const known = payload.tiles.filter((tile) => {
      if (tile.id === 'genie:unattributed' || !deploymentAttribution(tile)) return false;
      const value = portionValue(tile, unit, portion);
      return typeof value === 'number' && Number.isFinite(value);
    });
    if (known.length === 0) return null;
    return known.reduce((total, tile) => {
      const value = portionValue(tile, unit, portion) ?? 0;
      return total + value * (tile.basis === 'per-day' ? usd.days : 1);
    }, 0);
  };
  const amount = knownTotal('USD');
  const measuredDbus = knownTotal('DBU');
  const hasKnown = amount !== null || measuredDbus !== null;
  const displayIncomplete = payload.tiles.some((tile) => {
    if (tile.id === 'genie:unattributed' || !tile.resourceId.trim()) return false;
    const priceMatch = tile.pricing?.match;
    const value = portionValue(tile, 'USD', portion);
    return (
      !deploymentAttribution(tile) ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
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

/**
 * The real bill decomposed into what questions caused and what merely keeps the
 * deployment online.
 *
 * `attributed + standing` reconciles to the full billed total, so nothing is
 * lost: the always-on meters are split into their active and idle shares and
 * every other component sits entirely in `attributed`. The page leads with
 * `attributed` and shows `standing` as a separate fixed line so a reader never
 * takes uptime nobody caused for per-question cost.
 */
export function appCostBreakdown(
  payload: Pick<OpsCostPayload, 'range' | 'tiles' | 'currency' | 'throughDay' | 'honesty'>,
  sourceFrom = payload.range.from
): { attributed: AppSpendFigure; standing: AppSpendFigure } {
  return {
    attributed: appSpendFigure(payload, sourceFrom, 'active'),
    standing: appSpendFigure(payload, sourceFrom, 'standing'),
  };
}
