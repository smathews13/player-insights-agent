import { describe, expect, it } from 'vitest';
import { DiscoveryLimiter, DiscoveryPageCache } from './discovery-control';

describe('DiscoveryLimiter', () => {
  it('bounds active work and drops aborted queued work', async () => {
    const limiter = new DiscoveryLimiter(2);
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const work = () =>
      limiter.run(undefined, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return 'done';
      });
    const first = work();
    const second = work();
    const controller = new AbortController();
    const cancelled = limiter.run(controller.signal, () => Promise.resolve('must-not-run'));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    releases.splice(0).forEach((release) => release());
    await Promise.all([first, second]);
    expect(maximum).toBe(2);
  });
});

describe('DiscoveryPageCache', () => {
  it('expires pages, evicts the least recently used page, and returns copies', () => {
    const cache = new DiscoveryPageCache<{ items: string[] }>(2, 10);
    cache.set('a', { items: ['a'] }, 0);
    cache.set('b', { items: ['b'] }, 0);
    const first = cache.get('a', 1)!;
    first.items.push('mutated');
    cache.set('c', { items: ['c'] }, 2);

    expect(cache.get('a', 3)).toEqual({ items: ['a'] });
    expect(cache.get('b', 3)).toBeUndefined();
    expect(cache.get('c', 12)).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});
