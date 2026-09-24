import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { kickWarehouseWarmup, waitForWarehouseReady, type WarehouseWarmupFetch } from './warehouse-warmup';

const HOME = readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8');

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

  it('waits on the ready endpoint before planning starts', async () => {
    const fetcher = vi.fn(() => Promise.resolve({ ok: true })) as WarehouseWarmupFetch;
    await expect(waitForWarehouseReady(fetcher)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith('/api/warehouse-ready', { method: 'POST' });
    expect(HOME.indexOf('await waitForWarehouseReady()')).toBeLessThan(HOME.indexOf('setAskStartedAt(Date.now())'));
    expect(HOME).toContain('busyLabel="Starting warehouse"');
  });
});
