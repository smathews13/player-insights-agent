import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSpendFigure } from '../../shared/ops-contract';
import {
  cachedRecentMonthlySpend,
  forgetRecentMonthlySpend,
  readRecentMonthlySpend,
  RECENT_MONTHLY_SPEND_CACHE_MS,
  recentCompletedMonths,
  recentMonthlySpendPlaceholders,
} from './ops-monthly-spend';

function figure(amount: number | null, dbus: number | null): AppSpendFigure {
  return {
    amount,
    dbus,
    currency: 'USD',
    sourceFrom: '2026-08-28T18:42:11.000Z',
    sourceThrough: '2026-08-31',
    completeness: amount === null && dbus === null ? 'unavailable' : 'complete',
    estimated: false,
  };
}

describe('recent completed monthly app spend', () => {
  beforeEach(forgetRecentMonthlySpend);

  it('uses full UTC calendar boundaries newest-first across year rollover', () => {
    expect(recentCompletedMonths(Date.parse('2026-01-15T12:00:00Z'), '2025-01-01T00:00:00Z')).toEqual([
      { month: '2025-12', from: '2025-12-01', to: '2025-12-31' },
      { month: '2025-11', from: '2025-11-01', to: '2025-11-30' },
      { month: '2025-10', from: '2025-10-01', to: '2025-10-31' },
    ]);
    expect(recentCompletedMonths(Date.parse('2026-09-01T00:30:00+14:00'), '2025-01-01T00:00:00Z')[0]?.month).toBe(
      '2026-07'
    );
  });

  it('omits pre-deployment months and clips the first partial month to the exact first instant', () => {
    expect(recentCompletedMonths(Date.parse('2026-09-03T12:00:00Z'), '2026-08-28T18:42:11Z')).toEqual([
      {
        month: '2026-08',
        from: '2026-08-28',
        to: '2026-08-31',
        fromTimestamp: '2026-08-28T18:42:11.000Z',
      },
    ]);
    expect(recentMonthlySpendPlaceholders(Date.parse('2026-09-03T12:00:00Z'))).toEqual([]);
  });

  it('excludes the current partial month and returns fewer than three honest months', () => {
    expect(recentCompletedMonths(Date.parse('2026-09-30T23:59:59Z'), '2026-09-01T00:00:00Z')).toEqual([]);
    expect(recentCompletedMonths(Date.parse('2027-01-02T00:00:00Z'), '2026-11-15T08:00:00Z')).toEqual([
      { month: '2026-12', from: '2026-12-01', to: '2026-12-31' },
      {
        month: '2026-11',
        from: '2026-11-15',
        to: '2026-11-30',
        fromTimestamp: '2026-11-15T08:00:00.000Z',
      },
    ]);
  });

  it('reuses canonical app-spend snapshots and preserves missing, zero, USD, and DBU values', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(figure(0, 0))
      .mockResolvedValueOnce(figure(null, null))
      .mockResolvedValueOnce(figure(12.5, 6.25));
    const rows = await readRecentMonthlySpend({
      now: Date.parse('2026-09-03T12:00:00Z'),
      firstDeployedAt: '2026-06-15T07:30:00Z',
      read,
    });
    expect(read).toHaveBeenNthCalledWith(1, { from: '2026-08-01', to: '2026-08-31' });
    expect(read).toHaveBeenNthCalledWith(2, { from: '2026-07-01', to: '2026-07-31' });
    expect(read).toHaveBeenNthCalledWith(3, {
      from: '2026-06-15',
      to: '2026-06-30',
      fromTimestamp: '2026-06-15T07:30:00.000Z',
    });
    expect(rows).toEqual([
      { month: '2026-08', amount: 0, dbus: 0, currency: 'USD' },
      { month: '2026-07', amount: null, dbus: null, currency: 'USD' },
      { month: '2026-06', amount: 12.5, dbus: 6.25, currency: 'USD' },
    ]);
  });

  it('coalesces and caches the canonical snapshots with Cost payload reads', async () => {
    const value = [{ month: '2026-08', amount: 2, dbus: 1, currency: 'USD' }];
    const read = vi.fn(() => Promise.resolve(value));
    const [first, second] = await Promise.all([
      cachedRecentMonthlySpend('caller|workspace|2026-09', 1_000, read),
      cachedRecentMonthlySpend('caller|workspace|2026-09', 1_000, read),
    ]);
    expect(first).toEqual(value);
    expect(second).toEqual(value);
    await cachedRecentMonthlySpend('caller|workspace|2026-09', 1_000 + RECENT_MONTHLY_SPEND_CACHE_MS - 1, read);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
