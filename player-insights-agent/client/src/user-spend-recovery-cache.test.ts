import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cachedUserSpendTotal,
  clearUserSpendTotalCache,
  requestUserSpendTotal,
  type UserSpendTotalCoordinates,
} from './user-spend-total-cache';

const coordinates: UserSpendTotalCoordinates = {
  scope: 'admin@example.test|admin',
  email: 'spend.user@example.test',
  from: '2026-09-02',
  to: '2026-09-02',
  unit: 'USD',
};

afterEach(clearUserSpendTotalCache);

describe('user-spend recovery cache', () => {
  it('does not retain a pre-migration unavailable response or failed initial refresh', async () => {
    const first = vi.fn().mockRejectedValue(new Error('Lakebase update required'));
    await expect(requestUserSpendTotal(coordinates, first)).rejects.toThrow('Lakebase update required');
    expect(cachedUserSpendTotal(coordinates)).toBeNull();

    const second = vi.fn().mockResolvedValue({
      amount: 12,
      quality: 'direct',
      questions: 4,
      coveredDays: 1,
      currency: 'USD',
      profile: null,
      dataRevision: 2,
      snapshot: '2026-09-03T00:05:00Z|identity-1',
      seeded: false,
      complete: true,
    });
    await expect(requestUserSpendTotal(coordinates, second)).resolves.toMatchObject({ amount: 12, complete: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
