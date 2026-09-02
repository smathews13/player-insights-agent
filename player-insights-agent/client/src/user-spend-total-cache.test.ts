import { beforeEach, describe, expect, it } from 'vitest';
import {
  cacheUserSpendTotal,
  cachedUserSpendTotal,
  clearUserSpendTotalCache,
  requestUserSpendTotal,
  USER_SPEND_TOTAL_CACHE_MAX,
  USER_SPEND_TOTAL_CACHE_TTL_MS,
  type UserSpendTotalCoordinates,
} from './user-spend-total-cache';

const base: UserSpendTotalCoordinates = {
  scope: 'admin@example.test|session-1',
  email: 'person@example.test',
  from: '2026-08-26',
  to: '2026-09-01',
  unit: 'USD',
};

function value(amount: number, snapshot = '2026-09-01T12:00:00Z|2026-08-31') {
  return {
    amount,
    quality: 'allocated' as const,
    questions: 25,
    coveredDays: 7,
    currency: 'USD',
    profile: null,
    dataRevision: 3,
    snapshot,
    seeded: false,
    complete: true,
  };
}

describe('user spend total cache', () => {
  beforeEach(clearUserSpendTotalCache);

  it('isolates auth, user, range, and unit coordinates', () => {
    cacheUserSpendTotal(base, value(5), 1_000);
    expect(cachedUserSpendTotal(base, 1_001)?.amount).toBe(5);
    expect(cachedUserSpendTotal({ ...base, scope: 'other-admin|session-2' }, 1_001)).toBeNull();
    expect(cachedUserSpendTotal({ ...base, email: 'other@example.test' }, 1_001)).toBeNull();
    expect(cachedUserSpendTotal({ ...base, unit: 'DBU' }, 1_001)).toBeNull();
    expect(cachedUserSpendTotal({ ...base, from: '2026-08-01' }, 1_001)).toBeNull();
  });

  it('retains expired data for a non-jumping refresh and replaces it', () => {
    cacheUserSpendTotal(base, value(5), 1_000);
    expect(cachedUserSpendTotal(base, 1_000 + USER_SPEND_TOTAL_CACHE_TTL_MS)?.expiresAt).toBe(0);
    cacheUserSpendTotal(base, value(7), 1_000 + USER_SPEND_TOTAL_CACHE_TTL_MS);
    expect(cachedUserSpendTotal(base, 1_000 + USER_SPEND_TOTAL_CACHE_TTL_MS)?.amount).toBe(7);
  });

  it('does not let an incomplete detail response erase seeded totals or denominators', () => {
    cacheUserSpendTotal(base, { ...value(62.61), seeded: true, complete: false }, 1_000);
    cacheUserSpendTotal(
      base,
      {
        ...value(0, '2026-09-01T13:00:00Z|partial'),
        amount: null,
        questions: 0,
        coveredDays: 0,
        complete: false,
      },
      1_001
    );
    expect(cachedUserSpendTotal(base, 1_002)).toMatchObject({
      amount: 62.61,
      questions: 25,
      coveredDays: 7,
    });
    cacheUserSpendTotal(
      base,
      { ...value(0, '2026-09-01T14:00:00Z|complete'), questions: 0, coveredDays: 0, complete: true },
      1_003
    );
    expect(cachedUserSpendTotal(base, 1_004)).toMatchObject({ amount: 0, questions: 0, coveredDays: 0 });
  });

  it('deduplicates concurrent reads and rejects an older snapshot overwrite', async () => {
    let loads = 0;
    let resolve!: (result: ReturnType<typeof value>) => void;
    const pending = () =>
      requestUserSpendTotal(base, () => {
        loads += 1;
        return new Promise<ReturnType<typeof value>>((done) => {
          resolve = done;
        });
      });
    const one = pending();
    const two = pending();
    expect(loads).toBe(1);
    resolve(value(8));
    await expect(one).resolves.toMatchObject({ amount: 8 });
    await expect(two).resolves.toMatchObject({ amount: 8 });

    cacheUserSpendTotal(base, value(10, '2026-09-01T13:00:00Z|2026-09-01'), 2_000);
    cacheUserSpendTotal(base, value(2, '2026-09-01T11:00:00Z|2026-08-31'), 2_001);
    expect(cachedUserSpendTotal(base, 2_002)?.amount).toBe(10);
  });

  it('bounds the LRU', () => {
    for (let index = 0; index <= USER_SPEND_TOTAL_CACHE_MAX; index += 1) {
      cacheUserSpendTotal({ ...base, email: `person-${index}@example.test` }, value(index), 1_000 + index);
    }
    expect(cachedUserSpendTotal({ ...base, email: 'person-0@example.test' }, 1_100)).toBeNull();
    expect(
      cachedUserSpendTotal({ ...base, email: `person-${USER_SPEND_TOTAL_CACHE_MAX}@example.test` }, 1_100)
    ).not.toBeNull();
  });
});
