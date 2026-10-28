import { HttpSource, requireValue as check, AdapterError } from './http.mjs';
import { tapEndpoint } from './config.mjs';
import { rules } from '../src/rules.mjs';
import { ByteCache, sourcePolicy, sourceScope } from './source-cache.mjs';
import { GENESIS } from '../../contract/beacon/bitcoin.js';
const segment = value => encodeURIComponent(String(value));
export function ordContent(text) { check(typeof text === 'string', 'inscription_content'); try { return JSON.parse(text); } catch { return text; } }
export class TapReader {
  constructor({ sources, agreement = 2, bitcoin, sharedTransport = false, policy }) { check(sources.length >= agreement && agreement >= 1, 'tap_sources'); Object.assign(this, { sources, agreement, bitcoin, sharedTransport }); this.policy = sourcePolicy(policy); this.contents = new ByteCache(this.policy.contentBytes); this.indexed = new ByteCache(this.policy.indexedBytes); }
  scope() { const scope = sourceScope.getStore(); return scope?.indexer === this ? scope : null; }
  async agree(path, options) {
    const replies = await Promise.allSettled(this.sources.map(source => source.request(path, options)));
    const values = replies.filter(r => r.status === 'fulfilled').map(r => r.value);
    check(values.length >= this.agreement, 'tap_quorum_unavailable');
    check(values.every(value => rules.stableJSON(value) === rules.stableJSON(values[0])), 'tap_source_disagreement');
    return values[0];
  }
  async tap(path) {
    const load = async () => { const value = await this.agree('/r/tap/' + path); check(value && Object.hasOwn(value, 'result'), 'tap_response'); return value.result; };
    const scope = this.scope();
    return scope && path !== 'getCurrentBlock' ? scope.memo.read('tap/' + path, load) : load();
  }
  async indexedRow(path) {
    const scope = this.scope();
    if (!scope?.history) return this.tap(path);
    const prior = this.indexed.get(path);
    if (prior && scope.history.hashAt(prior.anchor.height) === prior.anchor.hash) return prior.value;
    const value = await this.tap(path);
    if (value && (!Array.isArray(value) || value.length)) scope.staged.set(path, { anchor: scope.stamp, value });
    return value;
  }
  async verifyNetwork() { check(await this.agree('/r/blockhash/0') === GENESIS.hash, 'tap_network'); }
  async stamp() {
    const height = await this.tap('getCurrentBlock'); check(Number.isSafeInteger(height) && height >= 0, 'tap_height');
    const hash = await this.agree('/r/blockhash/' + height); if (!this.sharedTransport) check(hash === await this.bitcoin.blockHash(height), 'tap_canonical');
    this.observedTip = { height, hash, checkedAt: Date.now() };
    return { height, hash };
  }
  async at(view, read) {
    const parent = this.scope();
    if (parent) {
      check(!parent.closed && Date.now() - parent.started <= this.policy.maxScopeMs, 'tap_scope_expired');
      if (view) check(view.tip === parent.stamp.height && view.tipHash === parent.stamp.hash, 'tap_historical_snapshot_unavailable');
      return read();
    }
    const before = await this.stamp(), started = Date.now();
    if (view) check(view.tip === before.height && view.tipHash === before.hash, 'tap_historical_snapshot_unavailable');
    const scope = { indexer: this, bitcoin: this.bitcoin, stamp: before, started, staged: new ByteCache(this.policy.indexedBytes), content: new ByteCache(this.policy.contentBytes),
      memo: new ByteCache(this.policy.scopeBytes), history: await this.history?.(before.height, before.hash) };
    try {
      const value = await sourceScope.run(scope, read);
      check(rules.stableJSON(before) === rules.stableJSON(await this.stamp()), 'tap_snapshot_changed');
      check(Date.now() - started <= this.policy.maxScopeMs, 'tap_scope_expired');
      for (const [key, row] of scope.staged.rows) this.indexed.set(key, row.value);
      for (const [key, row] of scope.content.rows) this.contents.set(key, row.value);
      return value;
    } finally { scope.closed = true; }
  }
  async content(id) {
    check(/^[0-9a-f]{64}i[0-9]+$/.test(id), 'inscription_id');
    const scope = this.scope(), load = async () => ordContent(await this.agree('/content/' + id, { format: 'rawText', maxBytes: this.policy.contentMaxBytes }));
    if (!scope?.history) return load();
    const prior = this.contents.get(id);
    if (prior && scope.history.hashAt(prior.anchor.height) === prior.anchor.hash) return prior.value;
    const value = await scope.memo.read('content/' + id, load);
    scope.content.set(id, { anchor: scope.stamp, value }); return value;
  }
  inscription(id) { check(/^[0-9a-f]{64}i[0-9]+$/.test(id), 'inscription_id'); const load = () => this.agree('/inscription/' + id); return this.scope()?.memo.read('inscription/' + id, load) ?? load(); }
  block(n) { check(Number.isSafeInteger(n) && n >= 0, 'tap_block'); return this.agree('/r/blockinfo/' + n); }
  balance(address, tick) { return this.tap('getBalance/' + segment(address) + '/' + segment(tick)); }
  holders(tick, { offset = 0, limit = 100 } = {}) { check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, 'tap_page'); return this.tap('getHolders/' + segment(tick) + '?offset=' + offset + '&max=' + limit); }
  async all(path, { pageSize = 100, maxRows = 10000 } = {}) {
    const result = [];
    check(Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 1000 && Number.isSafeInteger(maxRows) && maxRows >= pageSize && maxRows <= 10000, 'tap_page');
    for (let offset = 0; offset < maxRows; offset += pageSize) { const page = await this.tap(path + '?offset=' + offset + '&max=' + pageSize); check(Array.isArray(page) && page.length <= pageSize, 'tap_page'); result.push(...page); if (page.length < pageSize) return result; }
    throw new AdapterError('tap_list_limit');
  }
}
export async function createTap(config, bitcoin, policy, readsPolicy) {
  const limits = sourcePolicy(readsPolicy);
  check(config.endpoints.length === 1 && config.agreement === 1, 'tap_sources');
  const sources = await Promise.all(config.endpoints.map(async spec => new HttpSource({ ...policy, ...await tapEndpoint(spec), maxBytes: limits.tapMaxBytes })));
  check(sources[0].sameOrigin(bitcoin.source), 'tap_bitcoin_source');
  // Share the pinned transport and pacing budget with Bitcoin reads, while
  // retaining the smaller bound for TAP responses.
  const reader = new TapReader({ sources: [{ request: (path, options = {}) => bitcoin.source.request(path, { ...options, maxBytes: Math.min(options.maxBytes ?? limits.tapMaxBytes, limits.tapMaxBytes) }) }], agreement: config.agreement, bitcoin, sharedTransport: true, policy: readsPolicy }); await reader.verifyNetwork(); return reader;
}
