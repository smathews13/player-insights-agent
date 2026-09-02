

// server/lib/expiring-lru.ts
var ExpiringLruCache = class {
  constructor(maxEntries, ttlMs) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error("ttlMs must be a non-negative finite number");
  }
  entries = /* @__PURE__ */ new Map();
  get(key, now = Date.now()) {
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) return void 0;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, now = Date.now(), ttlMs = this.ttlMs) {
    this.prune(now);
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: now + Math.max(0, ttlMs), value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === void 0) break;
      this.entries.delete(oldest);
    }
  }
  delete(key) {
    return this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
  get size() {
    return this.entries.size;
  }
  prune(now) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
};

export {
  ExpiringLruCache
};
