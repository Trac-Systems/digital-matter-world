import { availableParallelism } from 'node:os';
import { check } from './util.mjs';

// Local gateway settings; never part of a consensus document or digest.
export const PUBLIC_READ_DEFAULTS = Object.freeze({
  threads: Math.max(1, Math.min(4, availableParallelism() - 1)),
  queuePerWorker: 64, restartDelayMs: 100, startupTimeoutMs: 10000,
  sqliteCacheKiB: 4096, streamChunkBytes: 65536,
  identityCacheEntries: 8192, bindingCacheEntries: 4096,
  // A batch marks public scopes pending for a moment while it projects them.
  pendingWaitMs: 3000, pendingPollMs: 100,
});
export function publicReadSettings(overrides = {}) {
  check(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'public_read_settings');
  const settings = { ...PUBLIC_READ_DEFAULTS, ...overrides };
  check(Object.entries(settings).every(([key, value]) => Object.hasOwn(PUBLIC_READ_DEFAULTS, key) &&
    Number.isSafeInteger(value) && value >= (key.endsWith('CacheEntries') ? 0 : 1)), 'public_read_settings');
  check(['restartDelayMs', 'startupTimeoutMs', 'pendingWaitMs', 'pendingPollMs'].every(k => settings[k] <= 0x7fffffff), 'public_read_settings');
  return settings;
}
export class BoundedLRU {
  constructor(capacity) { this.capacity = capacity; this.entries = new Map(); }
  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key); this.entries.delete(key); this.entries.set(key, value); return value;
  }
  set(key, value) {
    if (!this.capacity) return value;
    this.entries.delete(key);
    while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, value); return value;
  }
}
