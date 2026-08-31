/**
 * A small insertion-ordered TTL cache with deterministic expiry and LRU eviction.
 *
 * Callers supply `now` at the operation boundary so fake-clock tests can advance
 * without replacing global timers. Expired entries are swept on every read and
 * write, including entries other than the requested key.
 */
export class ExpiringLruCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: T }>();

  constructor(
    readonly maxEntries: number,
    readonly ttlMs: number
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('ttlMs must be a non-negative finite number');
  }

  get(key: string, now = Date.now()): T | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now(), ttlMs = this.ttlMs): void {
    this.prune(now);
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: now + Math.max(0, ttlMs), value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
