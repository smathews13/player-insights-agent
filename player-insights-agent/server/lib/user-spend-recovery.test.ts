import { describe, expect, it, vi } from 'vitest';

import type { UserSpendReadModelPage, UserSpendRefreshResult } from './user-spend-read-model';
import { isMissingUserSpendSchema, recoverInitialUserSpendRead } from './user-spend-recovery';

function page(available: boolean): UserSpendReadModelPage {
  return {
    available,
    rows: [],
    total: 0,
    identityRevision: '',
    freshness: {
      computedAt: available ? '2026-09-03T20:00:00.000Z' : null,
      sourceThrough: available ? '2026-09-03T19:00:00.000Z' : null,
      billingCompleteThrough: available ? '2026-09-02' : null,
      isRefreshing: false,
      isStale: !available,
      calculationVersion: 1,
    },
  };
}

const refreshed: UserSpendRefreshResult = {
  acquired: true,
  refreshed: true,
  from: '2026-09-02',
  to: '2026-09-02',
  rows: 1,
  users: 1,
  days: 1,
};

describe('initial user-spend recovery barrier', () => {
  it('maps only a missing PostgreSQL table to Lakebase migration recovery', async () => {
    expect(isMissingUserSpendSchema({ code: '42P01', message: 'private database text' })).toBe(true);
    expect(isMissingUserSpendSchema({ code: '42501' })).toBe(false);

    await expect(
      recoverInitialUserSpendRead({
        read: vi.fn().mockRejectedValue({ code: '42P01', message: 'relation is private' }),
        refresh: vi.fn(),
      })
    ).resolves.toEqual({ diagnosis: 'lakebase_update_required', page: null });
  });

  it('awaits the first single-flight refresh and re-reads before answering', async () => {
    const read = vi.fn().mockResolvedValueOnce(page(false)).mockResolvedValueOnce(page(true));
    const refresh = vi.fn().mockResolvedValue(refreshed);

    await expect(recoverInitialUserSpendRead({ read, refresh })).resolves.toEqual({
      diagnosis: 'ready',
      page: page(true),
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('separates missing billing access from another replica preparing the model', async () => {
    await expect(
      recoverInitialUserSpendRead({ read: () => Promise.resolve(page(false)), refresh: null })
    ).resolves.toEqual({ diagnosis: 'billing_access_required', page: page(false) });

    await expect(
      recoverInitialUserSpendRead({
        read: () => Promise.resolve(page(false)),
        refresh: () => Promise.resolve({ ...refreshed, acquired: false, refreshed: false }),
      })
    ).resolves.toEqual({ diagnosis: 'preparing_user_spend', page: page(false) });
  });

  it('refuses an unrostered profile before billing refresh work', async () => {
    const refresh = vi.fn();
    await expect(
      recoverInitialUserSpendRead({
        read: () => Promise.resolve(page(false)),
        isRostered: vi.fn().mockResolvedValue(false),
        refresh,
      })
    ).resolves.toEqual({ diagnosis: 'user_not_rostered', page: page(false) });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not refresh an existing populated or genuine-zero model', async () => {
    const refresh = vi.fn();
    await expect(recoverInitialUserSpendRead({ read: () => Promise.resolve(page(true)), refresh })).resolves.toEqual({
      diagnosis: 'ready',
      page: page(true),
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
