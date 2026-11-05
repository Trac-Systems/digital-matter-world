import { immutableIndexRow } from '../../rules/src/index-row-cache.js';

// One SQLite snapshot and draft overlay. The bounded backing cache may survive
// replays and predecessor roots: each stored row is addressed by its hash.
// Staged rows take precedence and never enter the shared cache. Local point
// reads avoid parsing speculative siblings that would displace demanded rows.
export class ReplayNodeReader {
  constructor(db, { cache, staged = {} }) {
    this.cache = cache; this.staged = staged;
    this.points = Object.fromEntries(['claimNodes', 'namedNodes'].map(space => [space,
      db.prepare(`SELECT value FROM records WHERE space='${space}' AND id=?`)]));
  }
  get(space, id) {
    const staged = this.staged[space], key = space + '/' + id;
    if (staged?.has(id)) return immutableIndexRow(staged.get(id));
    const cached = this.cache.get(key); if (cached) return cached;
    const row = this.points[space].get(id);
    return row && this.cache.set(key, JSON.parse(row.value));
  }
}
