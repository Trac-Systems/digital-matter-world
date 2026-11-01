import { mintPlotKey } from './per-ticker-supply-activation.js';
import { hex } from './core.js';
import { patternCatalogId } from './public-claims.js';
import { POINT_BATCH_SIZE } from './point-read-batch.js';

const CAPACITY = 4096;
// Hints only schedule reads; they never supply answers or enter evidence. A
// fresh cache belongs to one replay snapshot, including its fixed draft overlay.
// The rules still consume every lookup and charge every authenticated access.
export class PublicMintPrefetch {
  constructor(snapshot, fetch, enabled = true) {
    this.snapshot = snapshot; this.fetch = fetch; this.enabled = enabled;
    this.answers = new Map(); this.hints = new Map(); this.assets = new Map();
    this.observed = new WeakSet();
  }
  put(map, key, value) {
    map.delete(key); map.set(key, value);
    if (map.size > CAPACITY) map.delete(map.keys().next().value);
  }
  hint(asset, block) {
    if (typeof asset !== 'string' || typeof block !== 'string' || asset.length + block.length > 200 ||
      !patternCatalogId(asset) || !/^(0|[1-9][0-9]*)$/.test(block)) return;
    const key = asset + '/' + block;
    if (!this.answers.has(key)) this.put(this.hints, key, [asset, block]);
  }
  plot(plot) {
    if (!plot || !Array.isArray(plot.patterns)) return;
    for (const n of plot.patterns) if (typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n)) {
      const asset = this.assets.get(n), block = String(plot.block);
      this.hint(asset ?? 'p2:' + n, block);
      // Closure pages may omit catalog records. Keep both possible ledger
      // identities as hints; demand selects the family and answers never alias.
      if (!asset && n.length < 40) this.hint('p' + BigInt(n).toString(36), block);
    }
  }
  node(row) {
    if (!this.enabled || !row || typeof row !== 'object' || this.observed.has(row)) return;
    this.observed.add(row);
    const value = row?.value;
    if (!value || typeof value !== 'object') return;
    if (typeof value.number === 'string') this.put(this.assets, value.number, value.legacy?.asset ?? 'p2:' + value.number);
    if (value.asset && value.block !== undefined) this.hint(value.asset, String(value.block));
    this.plot(value); this.plot(value.claim);
    for (const claim of Array.isArray(value.claims) ? value.claims : []) this.plot(claim);
  }
  seed(input) {
    if (!this.enabled) return;
    for (const [, row] of input.namedEvidence?.nodes ?? []) this.node(row);
    for (const [, row] of input.claimEvidence?.nodes ?? []) this.node(row);
    for (const { move } of input.entries ?? []) for (const plot of move.p?.plots ?? []) this.plot(plot);
    for (const round of input.state?.rounds ?? []) this.plot(round.closing?.current?.claim);
  }
  get(asset, block, deployment = null) {
    const key = mintPlotKey(asset, block, deployment);
    if (!this.answers.has(key)) {
      const pairs = [[asset, block, ...(deployment ? [deployment] : [])]];
      const family = pair => pair[0].startsWith('p2:') === asset.startsWith('p2:');
      for (const [hint, pair] of this.hints) {
        if (pairs.length === POINT_BATCH_SIZE) break;
        if (hint !== key && pair[1] === block && family(pair) && !this.answers.has(hint)) pairs.push(pair);
      }
      for (const [hint, pair] of this.hints) {
        if (pairs.length === POINT_BATCH_SIZE) break;
        if (hint !== key && pair[1] !== block && family(pair) && !this.answers.has(hint)) pairs.push(pair);
      }
      const rows = this.fetch(pairs, this.snapshot);
      if (!Array.isArray(rows) || rows.length !== pairs.length) throw Error('public_mint_evidence_missing');
      for (let i = 0; i < pairs.length; i++) {
        const k = pairs[i].join('/'), row = rows[i]; this.hints.delete(k);
        // Failures for unused hints cannot change replay. A demanded failure
        // still aborts; failures are not cached and may be retried on demand.
        if (row && !row.error && (row.value === null || hex(row.value, 32))) this.put(this.answers, k, row.value);
      }
      if (!this.answers.has(key)) throw Error(rows[0]?.error ?? 'public_mint_evidence_missing');
    }
    return this.answers.get(key);
  }
}
