import { DatabaseSync } from 'node:sqlite';
import { HeaderHistory } from '../../rules/src/headers.js';

// Descriptors come only from the signer's validated local BitcoinViews, never
// from the proposal. Read the immutable, hash-addressed branch in one walk;
// the ordinary paged reader walks from the tip again for every old page.
export class ReplayHistories {
  constructor() { this.cached = null; }
  load({ filename, tip, tipHash }) {
    const cached = this.cached;
    if (cached?.filename === filename && tip < cached.history.length && cached.history.get(tip).hash === tipHash) return cached.history;
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const bytes = new Uint8Array((tip + 1) * 80);
      const base = cached?.filename === filename && cached.history.length <= tip + 1 ? cached.history : null;
      const bottom = base ? base.length - 1 : 0;
      const rows = db.prepare(`WITH RECURSIVE branch AS (
        SELECT hash,height,parent,raw FROM headers WHERE hash=? UNION ALL
        SELECT h.hash,h.height,h.parent,h.raw FROM headers h JOIN branch b ON h.hash=b.parent WHERE b.height>?
      ) SELECT hash,height,raw FROM branch`);
      let expected = tip, boundary;
      for (const row of rows.iterate(tipHash, bottom)) {
        if (row.height !== expected-- || !/^[0-9a-f]{160}$/.test(row.raw)) throw Error('bitcoin_history_missing');
        bytes.set(Buffer.from(row.raw, 'hex'), row.height * 80);
        boundary = row.hash;
      }
      if (expected !== bottom - 1) throw Error('bitcoin_history_missing');
      if (base) {
        if (boundary !== base.get(bottom).hash) {
          // A fork cannot inherit the cached prefix. Walk its own ancestry.
          this.cached = null;
          return this.load({ filename, tip, tipHash });
        }
        bytes.set(base.bytes);
      }
      const history = new HeaderHistory(bytes);
      if (history.get(tip).hash !== tipHash) throw Error('bitcoin_header_height');
      this.cached = { filename, history };
      return history;
    } finally { db.close(); }
  }
  views(sources) {
    const views = [];
    // Newest first lets all ancestor observations share the same byte array.
    for (const { source, index } of sources.map((source, index) => ({ source, index })).filter(v => v.source)
      .sort((a, b) => b.source.tip - a.source.tip)) {
      const full = this.load(source), length = source.tip + 1;
      const valid = h => Number.isSafeInteger(h) && h >= 0 && h < length;
      const requireHeight = h => { if (!valid(h)) throw Error('bitcoin_history_missing'); };
      const history = { length, get: h => { requireHeight(h); return full.get(h); },
        field: (h, f, dt) => { requireHeight(h); return full.field(h, f, dt); } };
      views[index] = { history, hashAt: h => valid(h) ? full.get(h).hash : null };
    }
    return views;
  }
}
