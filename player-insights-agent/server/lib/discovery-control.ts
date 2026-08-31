/**
 * Shared bounds for user-scoped resource discovery.
 *
 * Every Connections picker reaches the same workspace APIs. A single shared
 * limiter prevents several open pickers (or several browser tabs) from turning
 * into an unbounded burst. Queued work observes the request signal, so a closed
 * route never starts another workspace call.
 */
export const DISCOVERY_MAX_CONCURRENCY = 4;
export const DISCOVERY_CACHE_TTL_MS = 10_000;
export const DISCOVERY_CACHE_MAX_ENTRIES = 128;

interface QueuedWork<T> {
  signal?: AbortSignal;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  removeAbort?: () => void;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

export class DiscoveryLimiter {
  private active = 0;
  private readonly queue: QueuedWork<unknown>[] = [];

  constructor(readonly concurrency = DISCOVERY_MAX_CONCURRENCY) {}

  run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedWork<T> = { signal, run: work, resolve, reject };
      if (signal) {
        const abort = () => {
          const index = this.queue.indexOf(queued as QueuedWork<unknown>);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', abort, { once: true });
        queued.removeAbort = () => signal.removeEventListener('abort', abort);
      }
      this.queue.push(queued as QueuedWork<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const queued = this.queue.shift()!;
      if (queued.signal?.aborted) {
        queued.removeAbort?.();
        queued.reject(abortError(queued.signal));
        continue;
      }
      queued.removeAbort?.();
      this.active += 1;
      void queued
        .run()
        .then(queued.resolve, queued.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

export const discoveryLimiter = new DiscoveryLimiter();

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/** Small insertion-ordered TTL cache. Reads promote entries for LRU eviction. */
export class DiscoveryPageCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    readonly maxEntries = DISCOVERY_CACHE_MAX_ENTRIES,
    readonly ttlMs = DISCOVERY_CACHE_TTL_MS
  ) {}

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, value: T, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: now + this.ttlMs, value: structuredClone(value) });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
