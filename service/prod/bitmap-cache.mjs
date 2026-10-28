import { requireValue, withPublicReads } from './http.mjs';
import { walletBitmaps } from '../src/bitmaps.mjs';
import { check, heightKey } from '../src/util.mjs';

export function bitmapCachePolicy(input = {}) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'bitmap_cache_policy');
  const policy = { maxEntries: 128, maxRows: 10000, maxInscriptions: 10000, maxConcurrentLoads: 2, ttlMs: 600000, tipMaxAgeMs: 5000, ...input };
  const ceilings = { maxEntries: 10000, maxRows: 1000000, maxInscriptions: 1000000, maxConcurrentLoads: 16, ttlMs: 86400000, tipMaxAgeMs: 60000 };
  requireValue(Object.keys(policy).every(key => Object.hasOwn(ceilings, key) && Number.isSafeInteger(policy[key]) && policy[key] > 0 && policy[key] <= ceilings[key]), 'bitmap_cache_policy');
  return policy;
}
const sameTip = (a, b) => a && b && a.height === b.height && a.hash === b.hash;

// Public ownership snapshots only. Transaction/consensus bitmap reads stay live.
export class BitmapCache {
  #entries = new Map(); #pending = new Map(); #checking; #rows = 0;
  constructor({ indexer, bindings, store, policy }) {
    Object.assign(this, { indexer, bindings, store, policy: bitmapCachePolicy(policy) });
  }
  #drop(address) { this.#rows -= this.#entries.get(address).rows.length; this.#entries.delete(address); }
  #cached(address, tip) {
    const now = Date.now();
    for (const [key, entry] of this.#entries) if (now - entry.createdAt >= this.policy.ttlMs) this.#drop(key);
    const entry = this.#entries.get(address);
    if (!entry) return;
    if (!sameTip(entry.tip, tip)) { this.#drop(address); return; }
    this.#entries.delete(address); this.#entries.set(address, entry);
    return this.#result(entry, tip, true);
  }
  #result(entry, tip, cached) {
    return { bitmaps: entry.rows.map(row => ({ ...row, linked: !!this.store.get('links', heightKey(row.height)) })),
      bitmapContext: { state: 'snapshot', tip: { height: entry.tip.height, hash: entry.tip.hash },
        checkedAt: tip.checkedAt, loadedAt: entry.createdAt, cached } };
  }
  #recentTip() {
    const tip = this.indexer.observedTip;
    return tip && Date.now() - tip.checkedAt < this.policy.tipMaxAgeMs ? tip : null;
  }
  async #tip() {
    const recent = this.#recentTip(); if (recent) return recent;
    if (!this.#checking) this.#checking = this.indexer.stamp().then(tip => ({ ...tip, checkedAt: Date.now() })).finally(() => { this.#checking = null; });
    return this.#checking;
  }
  snapshot(owner) {
    // Binding must precede even the first tip check. Capture the wallet so a
    // binding replacement cannot mislabel a scan already in flight.
    const address = this.bindings.current(owner, 'tap')?.request.address;
    if (!address) return Promise.resolve({ bitmaps: [], bitmapContext: { state: 'unbound', tip: null } });
    const recent = this.#recentTip(), tip = recent ?? this.indexer.observedTip, cached = tip && this.#cached(address, tip);
    if (cached) {
      if (!recent) {
        // Keep a cached route fast even when the tip check is due. This is
        // explicitly the old tip's snapshot until revalidation finishes.
        if (!this.#pending.has(address) && this.#pending.size < this.policy.maxConcurrentLoads) this.#load(owner, address).catch(() => {});
        cached.bitmapContext.tipCheckDue = true;
        cached.bitmapContext.refreshing = this.#pending.has(address);
      }
      return Promise.resolve(cached);
    }
    if (this.#pending.has(address)) return this.#pending.get(address);
    check(this.#pending.size < this.policy.maxConcurrentLoads, 'bitmap_cache_busy', 503);
    return this.#load(owner, address);
  }
  #load(owner, address) {
    const pending = withPublicReads(async () => {
      const before = await this.#tip(), cached = this.#cached(address, before);
      if (cached) return cached;
      const reads = { bindings: { current: () => ({ request: { address } }) }, tap: path => this.indexer.tap(path) };
      const rows = await walletBitmaps({ reads, store: this.store }, owner,
        (_manifest, wallet, offset) => this.indexer.tap('getBitmapWalletHistoricList/' + encodeURIComponent(wallet) + '?offset=' + offset + '&max=500'),
        { maxInscriptions: this.policy.maxInscriptions });
      const after = await this.indexer.stamp();
      check(sameTip(before, after), 'tap_snapshot_changed', 503);
      const entry = { rows, tip: after, createdAt: Date.now() };
      // Large snapshots can still be returned without retaining them. Both
      // retained rows and concurrent scan memory have independent bounds.
      if (rows.length <= this.policy.maxRows) {
        while (this.#entries.size >= this.policy.maxEntries || this.#rows + rows.length > this.policy.maxRows) this.#drop(this.#entries.keys().next().value);
        this.#entries.set(address, entry); this.#rows += rows.length;
      }
      return this.#result(entry, { ...after, checkedAt: entry.createdAt }, false);
    }).finally(() => this.#pending.delete(address));
    this.#pending.set(address, pending); return pending;
  }
}
