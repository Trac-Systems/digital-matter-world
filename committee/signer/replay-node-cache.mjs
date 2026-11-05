import { IndexRowCache, immutableIndexRow, indexRowBytes } from '../../rules/src/index-row-cache.js';

// Report only membership changes, not LRU refreshes. Both replay cache tiers
// share the eviction set; moving a row between them cancels its removal.
export class ReplayNodeCache extends IndexRowCache {
  constructor(entries, bytes, evicted) { super(entries, bytes); this.evicted = evicted; }
  delete(id) { if (this.has(id)) this.evicted.add(id); super.delete(id); }
  set(id, value) {
    try {
      const row = immutableIndexRow(value), bytes = row && indexRowBytes(row);
      this.delete(id);
      if (!row || bytes > this.limit) { this.evicted.add(id); return row; }
      // Make room through delete(), so the bridge can stop suppressing rows
      // that this worker has actually released, including byte-limit evictions.
      while (this.rows.size && (this.rows.size >= this.entries || this.bytes + bytes > this.limit)) this.delete(this.rows.keys().next().value);
      const result = super.set(id, row); this.evicted.delete(id); return result;
    } catch (error) { this.evicted.add(id); throw error; }
  }
}

export function replayNodeCaches(entries, bytes, evicted) {
  // Give demanded rows the larger share of the same total entry/byte pool.
  // Speculative siblings must not crowd repeatedly authenticated paths out.
  const neighborEntries = Math.min(65536, entries * 4), neighborBytes = Math.min(67108864, bytes * 4);
  return { nodes: new ReplayNodeCache(Math.max(entries, neighborEntries), neighborBytes, evicted),
    prefetched: new ReplayNodeCache(Math.min(entries, neighborEntries), bytes, evicted) };
}
