import { AsyncLocalStorage } from 'node:async_hooks';
import { check } from '../src/util.mjs';

// A scope is private to one reader/action. Never reuse mutable results by time.
export const sourceScope = new AsyncLocalStorage();
export const actionScope = new AsyncLocalStorage();
export const SOURCE_DEFAULTS = Object.freeze({ contentBytes: 8_000_000, transactionBytes: 16_000_000,
  blockBytes: 32_000_000, proofBytes: 8_000_000, indexedBytes: 4_000_000,
  scopeBytes: 8_000_000, contentMaxBytes: 200_000, tapMaxBytes: 2_000_000, bitcoinMaxBytes: 16_000_000, maxScopeMs: 120_000, pageSize: 500, maxItems: 64 });
export function sourcePolicy(value = {}) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => Object.hasOwn(SOURCE_DEFAULTS, k)), 'source_policy');
  const p = { ...SOURCE_DEFAULTS, ...value };
  for (const [k, n] of Object.entries(p)) check(Number.isSafeInteger(n) && n >= (k.endsWith('Bytes') ? 0 : 1)
    && n <= (k.endsWith('Bytes') ? 256_000_000 : k === 'pageSize' ? 500 : k === 'maxItems' ? 4096 : 600_000), 'source_policy');
  check(p.contentMaxBytes > 0 && p.contentMaxBytes <= p.tapMaxBytes && p.tapMaxBytes <= p.bitcoinMaxBytes && p.bitcoinMaxBytes <= 16_000_000, 'source_policy');
  return p;
}
export class ByteCache {
  constructor(budget) { this.budget = budget; this.bytes = 0; this.rows = new Map(); this.pending = new Map(); }
  get(key) { const row = this.rows.get(key); if (!row) return undefined; this.rows.delete(key); this.rows.set(key, row); return structuredClone(row.value); }
  set(key, value) {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key);
    if (this.rows.has(key)) { this.bytes -= this.rows.get(key).bytes; this.rows.delete(key); }
    if (bytes > this.budget) return value;
    while (this.bytes + bytes > this.budget) { const first = this.rows.keys().next().value; this.bytes -= this.rows.get(first).bytes; this.rows.delete(first); }
    this.rows.set(key, { bytes, value: structuredClone(value) }); this.bytes += bytes; return value;
  }
  async read(key, load) {
    const hit = this.get(key); if (hit !== undefined) return hit;
    let work = this.pending.get(key);
    if (!work) { work = Promise.resolve().then(load); this.pending.set(key, work); }
    try { const value = await work; if (value !== null && value !== undefined) this.set(key, value); return structuredClone(value); }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }
}
