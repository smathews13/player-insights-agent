import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { OpsCostPayload } from '../../shared/ops-contract';
import { tileAttribution } from './ops-view';

const DAY_MS = 86_400_000;

function completeDays(payload: Pick<OpsCostPayload, 'range'>): number {
  const from = Date.parse(`${payload.range.from}T00:00:00Z`);
  const to = Date.parse(`${payload.range.to}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? Math.round((to - from) / DAY_MS) + 1 : 0;
}

export function costSpendSummary(payload: Pick<OpsCostPayload, 'range' | 'tiles' | 'currency'>) {
  const days = completeDays(payload);
  // Genie-space amounts are allocations of the SQL warehouse tile, not another
  // meter. Keep them visible per space, but never add them back into the app total.
  const directTiles = payload.tiles.filter((tile) => !tile.id.startsWith('genie:'));
  const included = directTiles.filter(
    (tile) =>
      tileAttribution(tile) === 'deployment' &&
      tile.quality !== 'unknown' &&
      typeof tile.amount === 'number' &&
      Number.isFinite(tile.amount) &&
      (tile.pricing?.match === undefined || tile.pricing.match === 'priced' || tile.pricing.match === 'none')
  );
  const amount = included.reduce((sum, tile) => sum + (tile.amount ?? 0) * (tile.basis === 'per-day' ? days : 1), 0);
  const dbuTiles = directTiles.filter(
    (tile) => tileAttribution(tile) === 'deployment' && typeof tile.dbus === 'number' && Number.isFinite(tile.dbus)
  );
  const dbus = dbuTiles.reduce((sum, tile) => sum + (tile.dbus ?? 0) * (tile.basis === 'per-day' ? days : 1), 0);
  const activeMissing = directTiles.some(
    (tile) => Boolean(tile.resourceId.trim()) && tile.attribution !== 'deployment'
  );
  const currency = payload.currency.trim();
  return {
    amount: included.length > 0 ? amount : null,
    dbus: dbuTiles.length > 0 ? dbus : null,
    label:
      included.length > 0
        ? `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${
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
    ? `e.g. ${baseline.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    : 'No observed value';
}
