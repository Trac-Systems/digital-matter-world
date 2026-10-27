import { HttpSource, requireValue as check, AdapterError } from './http.mjs';
import { tapEndpoint } from './config.mjs';
import { rules } from '../src/rules.mjs';
import { GENESIS } from '../../contract/beacon/bitcoin.js';
const segment = value => encodeURIComponent(String(value));
export function ordContent(text) { check(typeof text === 'string', 'inscription_content'); try { return JSON.parse(text); } catch { return text; } }
export class TapReader {
  constructor({ sources, agreement = 2, bitcoin }) { check(sources.length >= agreement && agreement >= 1, 'tap_sources'); Object.assign(this, { sources, agreement, bitcoin }); }
  async agree(path, options) {
    const replies = await Promise.allSettled(this.sources.map(source => source.request(path, options)));
    const values = replies.filter(r => r.status === 'fulfilled').map(r => r.value);
    check(values.length >= this.agreement, 'tap_quorum_unavailable');
    check(values.every(value => rules.stableJSON(value) === rules.stableJSON(values[0])), 'tap_source_disagreement');
    return values[0];
  }
  async tap(path) { const value = await this.agree('/r/tap/' + path); check(value && Object.hasOwn(value, 'result'), 'tap_response'); return value.result; }
  async verifyNetwork() { check(await this.agree('/r/blockhash/0') === GENESIS.hash, 'tap_network'); }
  async stamp() {
    const height = await this.tap('getCurrentBlock'); check(Number.isSafeInteger(height) && height >= 0, 'tap_height');
    const hash = await this.agree('/r/blockhash/' + height); check(hash === await this.bitcoin.blockHash(height), 'tap_canonical');
    return { height, hash };
  }
  async at(view, read) {
    const before = await this.stamp();
    if (view) check(view.tip === before.height && view.tipHash === before.hash, 'tap_historical_snapshot_unavailable');
    const value = await read(); check(rules.stableJSON(before) === rules.stableJSON(await this.stamp()), 'tap_snapshot_changed'); return value;
  }
  async content(id) { check(/^[0-9a-f]{64}i[0-9]+$/.test(id), 'inscription_id'); return ordContent(await this.agree('/content/' + id, { format: 'rawText', maxBytes: 200000 })); }
  inscription(id) { check(/^[0-9a-f]{64}i[0-9]+$/.test(id), 'inscription_id'); return this.agree('/inscription/' + id); }
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
export async function createTap(config, bitcoin, policy) {
  check(config.endpoints.length === 1 && config.agreement === 1, 'tap_sources');
  const sources = await Promise.all(config.endpoints.map(async spec => new HttpSource({ ...policy, ...await tapEndpoint(spec), maxBytes: 2000000 })));
  check(sources[0].sameOrigin(bitcoin.source), 'tap_bitcoin_source');
  // Share the pinned transport and pacing budget with Bitcoin reads, while
  // retaining the smaller bound for TAP responses.
  const reader = new TapReader({ sources: [{ request: (path, options = {}) => bitcoin.source.request(path, { ...options, maxBytes: Math.min(options.maxBytes ?? 2000000, 2000000) }) }], agreement: config.agreement, bitcoin }); await reader.verifyNetwork(); return reader;
}
