import { describe, expect, it } from 'vitest';

import { ExpiringLruCache } from './expiring-lru';

describe('the bounded TTL cache', () => {
  it('expires deterministically and sweeps unrelated stale entries', () => {
    const cache = new ExpiringLruCache<string>(3, 10);
    cache.set('first', 'a', 0);
    cache.set('second', 'b', 5);

    expect(cache.get('second', 10)).toBe('b');
    expect(cache.size).toBe(1);
    expect(cache.get('first', 10)).toBeUndefined();
  });

  it('evicts the least recently used entry at its explicit maximum', () => {
    const cache = new ExpiringLruCache<string>(2, 100);
    cache.set('first', 'a', 0);
    cache.set('second', 'b', 0);
    expect(cache.get('first', 1)).toBe('a');

    cache.set('third', 'c', 2);

    expect(cache.get('second', 2)).toBeUndefined();
    expect(cache.get('first', 2)).toBe('a');
    expect(cache.get('third', 2)).toBe('c');
    expect(cache.size).toBe(2);
  });

  it('supports a shorter per-entry lifetime', () => {
    const cache = new ExpiringLruCache<string>(2, 100);
    cache.set('short', 'value', 10, 5);

    expect(cache.get('short', 14)).toBe('value');
    expect(cache.get('short', 15)).toBeUndefined();
  });
});
