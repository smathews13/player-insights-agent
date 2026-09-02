import type { CostBudgetUnit } from '../../shared/cost-budgets';
import type { UserSpendProfile, UserSpendQuality } from '../../shared/user-spend-contract';

export const USER_SPEND_TOTAL_CACHE_TTL_MS = 60_000;
export const USER_SPEND_TOTAL_CACHE_MAX = 48;

export interface UserSpendTotalCoordinates {
  scope: string;
  email: string;
  from: string;
  to: string;
  unit: CostBudgetUnit;
}

export interface CachedUserSpendTotal {
  amount: number | null;
  quality: UserSpendQuality;
  currency: string;
  profile: UserSpendProfile | null;
  dataRevision: number;
  snapshot: string;
  seeded: boolean;
  expiresAt: number;
}

interface InflightSpendTotal {
  token: symbol;
  promise: Promise<CachedUserSpendTotal>;
}

const totals = new Map<string, CachedUserSpendTotal>();
const latest = new Map<string, string>();
const inflight = new Map<string, InflightSpendTotal>();

function normalizedCoordinates(coordinates: UserSpendTotalCoordinates): UserSpendTotalCoordinates {
  return {
    ...coordinates,
    scope: coordinates.scope.trim().toLowerCase(),
    email: coordinates.email.trim().toLowerCase(),
  };
}

export function userSpendTotalBaseKey(coordinates: UserSpendTotalCoordinates): string {
  const value = normalizedCoordinates(coordinates);
  return [value.scope, value.email, value.from, value.to, value.unit].join('|');
}

export function userSpendTotalKey(
  coordinates: UserSpendTotalCoordinates,
  dataRevision: number,
  snapshot: string
): string {
  return [userSpendTotalBaseKey(coordinates), dataRevision, snapshot].join('|');
}

function isNewer(candidate: CachedUserSpendTotal, current: CachedUserSpendTotal | undefined): boolean {
  if (!current) return true;
  const candidateObservedAt = candidate.snapshot.split('|')[0] ?? '';
  const currentObservedAt = current.snapshot.split('|')[0] ?? '';
  return (
    candidate.dataRevision > current.dataRevision ||
    (candidate.dataRevision === current.dataRevision &&
      (candidateObservedAt > currentObservedAt ||
        (candidateObservedAt === currentObservedAt && current.seeded && !candidate.seeded)))
  );
}

export function cacheUserSpendTotal(
  coordinates: UserSpendTotalCoordinates,
  value: Omit<CachedUserSpendTotal, 'expiresAt'>,
  now = Date.now()
): CachedUserSpendTotal {
  const base = userSpendTotalBaseKey(coordinates);
  const currentKey = latest.get(base);
  const current = currentKey ? totals.get(currentKey) : undefined;
  const candidate = { ...value, expiresAt: now + USER_SPEND_TOTAL_CACHE_TTL_MS };
  if (current && current.expiresAt > now && !isNewer(candidate, current)) return current;
  const key = userSpendTotalKey(coordinates, value.dataRevision, value.snapshot);
  if (currentKey) totals.delete(currentKey);
  totals.delete(key);
  totals.set(key, candidate);
  latest.set(base, key);
  while (totals.size > USER_SPEND_TOTAL_CACHE_MAX) {
    const oldest = totals.keys().next().value;
    if (!oldest) break;
    totals.delete(oldest);
    for (const [indexedBase, indexedKey] of latest) {
      if (indexedKey === oldest) latest.delete(indexedBase);
    }
  }
  return candidate;
}

export function cachedUserSpendTotal(
  coordinates: UserSpendTotalCoordinates,
  now = Date.now()
): CachedUserSpendTotal | null {
  const base = userSpendTotalBaseKey(coordinates);
  const key = latest.get(base);
  const value = key ? totals.get(key) : undefined;
  if (!value) return null;
  if (value.expiresAt <= now) return { ...value, expiresAt: 0 };
  totals.delete(key!);
  totals.set(key!, value);
  return value;
}

export function requestUserSpendTotal(
  coordinates: UserSpendTotalCoordinates,
  load: () => Promise<Omit<CachedUserSpendTotal, 'expiresAt'>>,
  now = Date.now()
): Promise<CachedUserSpendTotal> {
  const base = userSpendTotalBaseKey(coordinates);
  const existing = inflight.get(base);
  if (existing) return existing.promise;
  const token = Symbol(base);
  const promise = load()
    .then((value) => {
      if (inflight.get(base)?.token !== token) return cacheUserSpendTotal(coordinates, value, now);
      return cacheUserSpendTotal(coordinates, value, now);
    })
    .finally(() => {
      if (inflight.get(base)?.token === token) inflight.delete(base);
    });
  inflight.set(base, { token, promise });
  return promise;
}

export function clearUserSpendTotalCache(): void {
  totals.clear();
  latest.clear();
  inflight.clear();
}
