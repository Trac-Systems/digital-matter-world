import { lookupSettings } from './lookup-settings.mjs';
import { HttpSource, requireValue as check } from './http.mjs';
import { tapEndpoint } from './config.mjs';
import { rules } from '../src/rules.mjs';
import { GENESIS } from '../../contract/beacon/bitcoin.js';
import { AsyncLocalStorage } from 'node:async_hooks';
const segment = value => encodeURIComponent(String(value));
export function ordContent(text) { check(typeof text === 'string', 'inscription_content'); try { return JSON.parse(text); } catch { return text; } }
export class TapReader {
  bulkScope = new AsyncLocalStorage();
  bulkCache = { key: null, rows: new Map(), bytes: 0 };
  constructor({ sources, agreement = 2, bitcoin, settings }) { check(sources.length >= agreement && agreement >= 1, 'tap_sources'); Object.assign(this, { sources, agreement, bitcoin }); this.settings = lookupSettings(settings); }
  rememberBulk(cache, key, value) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || cache.rows.has(key)) return;
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(encoded), cap = this.settings;
    if (bytes > cap.bulkReadCacheBytes) return;
    cache.rows.set(key, { value, bytes }); cache.bytes += bytes;
    while (cache.rows.size > cap.bulkReadCacheEntries || cache.bytes > cap.bulkReadCacheBytes) {
      const first = cache.rows.keys().next().value; cache.bytes -= cache.rows.get(first).bytes; cache.rows.delete(first);
    }
  }
  async agree(path, options) {
    const scope = this.bulkScope.getStore();
    if (scope?.active) {
      const key = JSON.stringify([path, options ?? null]);
      const saved = scope.staged.rows.get(key) ?? scope.cache.rows.get(key);
      if (saved) return structuredClone(saved.value);
      let pending = scope.pending.get(key);
      if (!pending) {
        pending = this.bulkScope.exit(() => this.agree(path, options))
          .then(value => { this.rememberBulk(scope.staged, key, value); return value; })
          .finally(() => { if (scope.pending.get(key) === pending) scope.pending.delete(key); });
        scope.pending.set(key, pending);
      }
      return structuredClone(await pending);
    }
    const replies = await Promise.allSettled(this.sources.map(source => source.request(path, options)));
    const values = replies.filter(r => r.status === 'fulfilled').map(r => r.value);
    check(values.length >= this.agreement, 'tap_quorum_unavailable');
    check(values.every(value => rules.stableJSON(value) === rules.stableJSON(values[0])), 'tap_source_disagreement');
    return values[0];
  }
  async tap(path) { const value = await this.agree('/r/tap/' + path); check(value && Object.hasOwn(value, 'result'), 'tap_response'); return value.result; }
  async verifyNetwork() { check(await this.agree('/r/blockhash/0') === GENESIS.hash, 'tap_network'); }
  async stamp() {
    // Explicit fences always hit the source, including inside a bulk scope.
    if (this.bulkScope.getStore()) return this.bulkScope.exit(() => this.stamp());
    const height = await this.tap('getCurrentBlock'); check(rules.ordinalCodec(typeof height === 'string').valid(height), 'tap_height');
    const hash = await this.agree('/r/blockhash/' + height); check(hash === await this.bitcoin.blockHash(height), 'tap_canonical');
    return { height, hash };
  }
  async at(view, read) {
    const scope = this.bulkScope.getStore();
    if (scope?.active) {
      if (view) check(rules.compareOrdinal(view.tip, scope.stamp.height) === 0 && view.tipHash === scope.stamp.hash, 'tap_historical_snapshot_unavailable');
      return read(scope.stamp);
    }
    const before = await this.stamp();
    if (view) check(rules.compareOrdinal(view.tip, before.height) === 0 && view.tipHash === before.hash, 'tap_historical_snapshot_unavailable');
    // The reader receives the snapshot's block, so a per-block cache can key on it.
    const value = await read(before); check(rules.stableJSON(before) === rules.stableJSON(await this.stamp()), 'tap_snapshot_changed'); return value;
  }
  // A whole candidate scan shares one TAP fence. Only source responses that
  // passed its closing fence survive a Trac batch change. Mutable Trac facts
  // (rights, bindings, links, account locks) are never stored here.
  async bulkAt(view, read) {
    if (this.bulkScope.getStore()?.active) return this.at(view, read);
    let scope;
    const outcome = await this.at(view, async stamp => {
      const key = rules.stableJSON([rules.decimalV2(stamp.height), stamp.hash]);
      if (this.bulkCache.key !== key) this.bulkCache = { key, rows: new Map(), bytes: 0 };
      scope = { stamp, cache: this.bulkCache, staged: { rows: new Map(), bytes: 0 }, pending: new Map(), active: true };
      try { return await this.bulkScope.run(scope, async () => {
        try { return { value: await read(stamp) }; } catch (error) { return { error }; }
      }); } finally {
        scope.active = false;
        await Promise.allSettled([...scope.pending.values()]);
      }
    }).catch(error => { this.bulkCache = { key: null, rows: new Map(), bytes: 0 }; throw error; });
    // Do not publish a partially read snapshot, or unbounded response data.
    if (scope.cache === this.bulkCache) for (const [key, entry] of scope.staged.rows) this.rememberBulk(scope.cache, key, entry.value);
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }
  async content(id) { check(/^[0-9a-f]{64}i[0-9]+$/.test(id), 'inscription_id'); return ordContent(await this.agree('/content/' + id, { format: 'rawText', maxBytes: this.settings.contentBytes })); }
  inscription(id) { check(/^[0-9a-f]{64}i[0-9]+$/.test(id), 'inscription_id'); return this.agree('/inscription/' + id); }
  block(n) { check(rules.ordinalCodec(typeof n === 'string').valid(n), 'tap_block'); return this.agree('/r/blockinfo/' + n); }
  balance(address, tick) { return this.tap('getBalance/' + segment(address) + '/' + segment(tick)); }
  holders(tick, { offset = 0, limit = this.settings.pageRows } = {}) { return this.page('getHolders/' + segment(tick), { offset, limit }); }
  async page(path, { offset = 0, limit = this.settings.pageRows } = {}) {
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= this.settings.pageRows, 'tap_page');
    const rows = await this.tap(path + '?offset=' + offset + '&max=' + limit);
    check(Array.isArray(rows) && rows.length <= limit, 'tap_page'); return rows;
  }
  async *pages(path, { offset = 0, pageSize = this.settings.pageRows } = {}) {
    for (;;) {
      const rows = await this.page(path, { offset, limit: pageSize }); yield { offset, rows };
      if (rows.length < pageSize) return; offset += rows.length;
      check(Number.isSafeInteger(offset), 'tap_page_offset');
    }
  }

}
export async function createTap(config, bitcoin, policy, settings) {
  const limits = lookupSettings(settings);
  check(config.endpoints.length === 1 && config.agreement === 1, 'tap_sources');
  const sources = await Promise.all(config.endpoints.map(async spec => new HttpSource({ ...policy, ...await tapEndpoint(spec), maxBytes: limits.pageBytes })));
  check(sources[0].sameOrigin(bitcoin.source), 'tap_bitcoin_source');
  // Share the pinned transport and pacing budget with Bitcoin reads, while
  // retaining the smaller bound for TAP responses.
  const reader = new TapReader({ sources: [{ request: (path, options = {}) => bitcoin.source.request(path, { ...options, maxBytes: Math.min(options.maxBytes ?? limits.pageBytes, limits.pageBytes) }) }], agreement: config.agreement, bitcoin, settings }); await reader.verifyNetwork(); return reader;
}
