import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSpendFigure } from '../../shared/ops-contract';
import {
  cachedLifetimeSpend,
  forgetLifetimeSpend,
  LIFETIME_SPEND_CACHE_MS,
  lifetimeSpendRange,
} from './ops-lifetime-spend';

const FIGURE: AppSpendFigure = {
  amount: 500,
  dbus: 1_000,
  currency: 'USD',
  sourceFrom: '2026-08-04',
  sourceThrough: '2026-09-02',
  completeness: 'complete',
  estimated: true,
};

describe('lifetime app spend cache', () => {
  beforeEach(forgetLifetimeSpend);

  it('bounds the lifetime query to available annual billing history', () => {
    expect(lifetimeSpendRange('2026-09-02')).toEqual({ from: '2025-09-02', to: '2026-09-02' });
  });

  it('coalesces concurrent reads and reuses the completed snapshot until expiry', async () => {
    const read = vi.fn(() => Promise.resolve(FIGURE));
    const [first, second] = await Promise.all([
      cachedLifetimeSpend('caller|workspace|2026-09-02', 1_000, read),
      cachedLifetimeSpend('caller|workspace|2026-09-02', 1_000, read),
    ]);
    expect(first).toEqual(FIGURE);
    expect(second).toEqual(FIGURE);
    await cachedLifetimeSpend('caller|workspace|2026-09-02', 1_000 + LIFETIME_SPEND_CACHE_MS - 1, read);
    expect(read).toHaveBeenCalledTimes(1);
    await cachedLifetimeSpend('caller|workspace|2026-09-02', 1_000 + LIFETIME_SPEND_CACHE_MS, read);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
