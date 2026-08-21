import { describe, expect, it, vi } from 'vitest';

import { kickWarehouseWarmup, type WarehouseWarmupFetch } from './warehouse-warmup';

describe('splash warehouse warm-up', () => {
  it('kicks the start request without waiting for it', () => {
    const fetcher = vi.fn(() => new Promise<unknown>(() => {})) as WarehouseWarmupFetch;

    const result = kickWarehouseWarmup(fetcher);

    expect(result).toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith('/api/warehouse-warmup', { method: 'POST' });
  });

  it('swallows a failed start request', async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error('workspace unavailable'))) as WarehouseWarmupFetch;

    expect(() => kickWarehouseWarmup(fetcher)).not.toThrow();
    await Promise.resolve();
  });
});
