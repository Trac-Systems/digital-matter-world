import { check } from './util.mjs';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { IndexedRows, pageArray } from './paging.mjs';
import { collectionSpecs } from './read-specs.mjs';

// Public projections only. Refresh on the gateway poll, never on an HTTP read;
// payment, consensus and receipt readers continue to use their live adapters.
export class PublicSnapshot {
  constructor(load) { this.load = load; }
  read() {
    if (this.error) throw this.error;
    check(this.value !== undefined, 'public_snapshot_pending', 503);
    return this.value;
  }
  async refresh() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try { const value = await this.load(); this.value = value; this.error = null; return value; }
      catch (error) { this.error = error; throw error; }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
}

export function cachePublicReads(views, checkout) {
  const status = new PublicSnapshot(views.status.bind(views));
  const loadCatalog = views.catalog.bind(views);
  const catalog = new PublicSnapshot(async () => {
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
  });
  const records = new PublicSnapshot(checkout.records.bind(checkout));
  views.status = async () => status.read();
  views.catalog = async () => catalog.read();
  checkout.records = async () => records.read();
  // The existing read index is maintained by the poll as well. Cold starts or
  // pattern backfills must not make a browser request walk the whole history.
  views.refreshOnRead = false;
  return { status, catalog, records };
}
