import type { AppSpendFigure } from '../../shared/ops-contract';

const DAY_MS = 86_400_000;
export const LIFETIME_SPEND_LOOKBACK_DAYS = 366;
export const LIFETIME_SPEND_CACHE_MS = 15 * 60_000;

type CachedLifetime = { at: number; value: AppSpendFigure } | { at: number; pending: Promise<AppSpendFigure> };

const cache = new Map<string, CachedLifetime>();

/** System billing history is bounded; the returned range never asks beyond its available annual window. */
export function lifetimeSpendRange(throughDay: string): { from: string; to: string } {
  const through = Date.parse(`${throughDay}T00:00:00Z`);
  if (!Number.isFinite(through)) return { from: throughDay, to: throughDay };
  return {
    from: new Date(through - (LIFETIME_SPEND_LOOKBACK_DAYS - 1) * DAY_MS).toISOString().slice(0, 10),
    to: throughDay,
  };
}

/** Cache successful lifetime snapshots and coalesce concurrent Ops opens for the same caller and source day. */
export async function cachedLifetimeSpend(
  key: string,
  now: number,
  read: () => Promise<AppSpendFigure>
): Promise<AppSpendFigure> {
  const existing = cache.get(key);
  if (existing && now - existing.at < LIFETIME_SPEND_CACHE_MS) {
    return 'value' in existing ? existing.value : existing.pending;
  }
  const pending = read();
  cache.set(key, { at: now, pending });
  try {
    const value = await pending;
    cache.set(key, { at: now, value });
    return value;
  } catch (error) {
    if (cache.get(key)?.at === now) cache.delete(key);
    throw error;
  }
}

export function forgetLifetimeSpend(): void {
  cache.clear();
}
