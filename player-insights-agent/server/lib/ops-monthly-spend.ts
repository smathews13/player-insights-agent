import type { AppMonthlySpend, AppSpendFigure } from '../../shared/ops-contract';
import type { CostRange } from './ops-billing';

export const RECENT_MONTHLY_SPEND_CACHE_MS = 15 * 60_000;
export const RECENT_MONTHLY_SPEND_UNAVAILABLE =
  'Recent monthly spend is unavailable because the app’s first successful deployment could not be proven.';

export interface CompletedMonth {
  month: string;
  from: string;
  to: string;
  /** Exact lower bound for the first partial deployment month. */
  fromTimestamp?: string;
}

type CachedMonthlySpend =
  | { at: number; value: AppMonthlySpend[] }
  | { at: number; pending: Promise<AppMonthlySpend[]> };

const cache = new Map<string, CachedMonthlySpend>();

function day(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * Up to three completed UTC calendar months that intersect the proven app
 * lifetime, newest first. Months wholly before deployment are omitted rather
 * than rendered as invented zeroes.
 */
export function recentCompletedMonths(now: number, firstDeployedAt?: string): CompletedMonth[] {
  const instant = new Date(now);
  const deployment = firstDeployedAt ? Date.parse(firstDeployedAt) : Number.NaN;
  if (firstDeployedAt && !Number.isFinite(deployment)) return [];
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const candidates = [1, 2, 3].map((offset) => {
    const start = Date.UTC(year, month - offset, 1);
    const endExclusive = Date.UTC(year, month - offset + 1, 1);
    return {
      month: day(start).slice(0, 7),
      from: day(start),
      to: day(endExclusive - 1),
      start,
      endExclusive,
    };
  });
  return candidates.flatMap((candidate): CompletedMonth[] => {
    if (Number.isFinite(deployment) && deployment >= candidate.endExclusive) return [];
    const fromTimestamp =
      Number.isFinite(deployment) && deployment > candidate.start ? new Date(deployment).toISOString() : undefined;
    return [
      {
        month: candidate.month,
        from: fromTimestamp?.slice(0, 10) ?? candidate.from,
        to: candidate.to,
        ...(fromTimestamp ? { fromTimestamp } : {}),
      },
    ];
  });
}

export function recentMonthlySpendPlaceholders(now: number, firstDeployedAt?: string): AppMonthlySpend[] {
  if (!firstDeployedAt) return [];
  return recentCompletedMonths(now, firstDeployedAt).map(({ month }) => ({
    month,
    amount: null,
    dbus: null,
    currency: '',
  }));
}

/**
 * Read every displayed month through the canonical app-spend snapshot builder.
 * That builder owns SQL Query History allocation, serving/Foundation evidence,
 * per-space Genie accounting, Vector Search allocation and dedicated app
 * compute. Keeping this orchestration here prevents a second, broader billing
 * definition from drifting away from Total app spend.
 */
export async function readRecentMonthlySpend(input: {
  now: number;
  firstDeployedAt: string;
  read: (range: CostRange) => Promise<AppSpendFigure>;
}): Promise<AppMonthlySpend[]> {
  const months = recentCompletedMonths(input.now, input.firstDeployedAt);
  return Promise.all(
    months.map(async ({ month, from, to, fromTimestamp }) => {
      const figure = await input.read({ from, to, ...(fromTimestamp ? { fromTimestamp } : {}) });
      return {
        month,
        amount: figure.amount,
        dbus: figure.dbus,
        currency: figure.currency,
      };
    })
  );
}

/** Coalesce concurrent reads and reuse the snapshot with the Cost payload. */
export async function cachedRecentMonthlySpend(
  key: string,
  now: number,
  read: () => Promise<AppMonthlySpend[]>
): Promise<AppMonthlySpend[]> {
  const existing = cache.get(key);
  if (existing && now - existing.at < RECENT_MONTHLY_SPEND_CACHE_MS) {
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

export function forgetRecentMonthlySpend(): void {
  cache.clear();
}
