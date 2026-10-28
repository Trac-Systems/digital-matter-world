import { check } from './util.mjs';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { IndexedRows, pageArray } from './paging.mjs';
import { collectionSpecs } from './read-specs.mjs';
import { recordPage } from './claimed-public.mjs';
import { projectionReady } from './claimed-v2.mjs';
import { rankingHighlights } from './public-rankings.mjs';
import { projectionRevision } from './projection-state.mjs';

// Public projections only. Refresh on the gateway poll, never on an HTTP read;
// payment, consensus and receipt readers continue to use their live adapters.
export class PublicSnapshot {
  constructor(load, revision) { this.load = load; this.revision = revision; }
  read() {
    if (this.error && this.value === undefined) throw this.error;
    check(this.value !== undefined, 'public_snapshot_pending', 503);
    // A public projection a few seconds old beats a 503 on every reload; refresh in the background.
    if (this.revision && this.savedRevision !== this.revision()) this.refresh().catch(() => {});
    return this.value;
  }
  async refresh() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try { const before = this.revision?.(), value = await this.load(); check(!this.revision || before === this.revision(), 'public_snapshot_changed', 503); this.value = value; this.savedRevision = before; this.error = null; return value; }
      catch (error) { this.error = error; throw error; }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
}

export function cachePublicReads(views, checkout) {
  const revision = () => views.store?.get('meta', 'ruleState')?.batchVersion === 2 ?
    ['meta/head', 'meta/ruleState', 'meta/latest'].map(s => projectionRevision(views.store, s)).join('/') : '';
  const status = new PublicSnapshot(views.status.bind(views), revision);
  const loadCatalog = views.catalog.bind(views);
  const catalog = new PublicSnapshot(async () => {
    if (views.store?.get('meta', 'ruleState')?.batchVersion === 2) {
      projectionReady(views.store, 'catalogPatterns', 'catalogTypes');
      const p = recordPage(views.store, 'catalogPatterns', new URLSearchParams(), { key: 'patterns' }), c = recordPage(views.store, 'catalogTypes', new URLSearchParams(), { key: 'compounds' });
      return { v: 3, patterns: p.patterns, compounds: c.compounds, continuation: { patterns: p.nextCursor, compounds: c.nextCursor } };
    }
    const value = await loadCatalog();
    for (const key of ['patterns', 'compounds']) {
      const rows = value[key], spec = collectionSpecs[key];
      const index = new IndexedRows(spec, { facets: Object.keys(spec.filters).filter(k => k !== 'q') });
      for (let i = 0; i < rows.length; i++) {
        index.set(String(i), rows[i], i);
        if (i % 128 === 127) await yieldIO();
      }
      // Keep the raw array for /list aliases and nested source positions. The
      // normal catalog sorts/exact filters use precomputed counts and orders.
      Object.defineProperty(rows, 'page', { value: query =>
        query.match === spec.match && query.selectedFilters.q === undefined && spec.keys.includes(query.sortKey)
          ? index.page(query) : pageArray(rows, query) });
    }
    return value;
  }, () => views.store?.get('meta', 'ruleState')?.batchVersion === 2 ? ['catalogPatterns', 'catalogTypes'].map(s => projectionRevision(views.store, s)).join('/') : '');
  const records = new PublicSnapshot(async () => views.store?.get('meta', 'ruleState')?.batchVersion === 2 ?
    rankingHighlights(views.store) : checkoutRecords(), () => views.store?.get('meta', 'ruleState')?.batchVersion === 2 ?
      ['rankings', 'rankExpiry', 'meta/rankingClock', 'catalogTypes'].map(s => projectionRevision(views.store, s)).join('/') : '');
  const checkoutRecords = checkout.records.bind(checkout);
  views.status = async () => status.read();
  views.catalog = async () => catalog.read();
  checkout.records = async () => records.read();
  // The existing read index is maintained by the poll as well. Cold starts or
  // pattern backfills must not make a browser request walk the whole history.
  views.refreshOnRead = false;
  return { status, catalog, records };
}
