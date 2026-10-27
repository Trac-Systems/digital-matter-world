import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';
export class History {
  constructor(store) { this.store = store; }
  get length() { return (this.store.get('meta', 'headerHeight') ?? -1) + 1; }
  raw(height) { check(Number.isSafeInteger(height) && height >= 0 && height < this.length, 'header_missing', 503); const row = this.store.get('headers', heightKey(height)); check(row, 'header_missing', 503); return row.raw; }
  get(height) { return rules.parseHeader(this.raw(height), height); }
  hashAt = height => Number.isSafeInteger(height) && height >= 0 && height < this.length ? this.store.get('headers', heightKey(height))?.hash ?? null : null;
  field(height, field, dt = 'n') { const h = this.get(height); return (field === 4 ? height : field === 10 ? h.nonce : h.bits).toString(dt === 'h' ? 16 : 10); }
  async append(height, raw) {
    return (await this.appendMany(height, [raw]))[0];
  }
  async appendMany(start, raws) {
    check(Number.isSafeInteger(start) && start >= 0 && start <= this.length, 'header_gap');
    check(Array.isArray(raws), 'headers');
    const headers = [];
    // Bound each journal frame and commit only a fully checked group. Links
    // within the group use the preceding parsed header, before SQLite sees it.
    for (let offset = 0; offset < raws.length; offset += 2048) {
      const end = Math.min(raws.length, offset + 2048), operations = [];
      let parent = start + offset === 0 ? null : this.hashAt(start + offset - 1);
      for (let i = offset; i < end; i++) {
        const height = start + i, raw = raws[i], header = rules.parseHeader(raw, height);
        check(BigInt('0x' + header.hash) <= rules.targetFromBits(header.bits), 'header_pow');
        check(height === 0 || header.prev === parent, 'header_link');
        operations.push({ space: 'headers', id: heightKey(height), value: { raw, hash: header.hash, fields: { height, hash: header.hash, time: header.time, nonce: header.nonce, bits: header.bits } } },
          { space: 'headerObjects', id: header.hash, value: { raw, height, parent: header.prev } });
        headers.push(header); parent = header.hash;
      }
      operations.push({ space: 'meta', id: 'headerHeight', value: Math.max(this.length - 1, start + end - 1) });
      await this.store.transact(operations);
    }
    return headers;
  }
  async setTip(height) { check(this.hashAt(height), 'header_missing'); await this.store.put('meta', 'headerHeight', height); }
  view(tip, hash) {
    check(/^[0-9a-f]{64}$/.test(hash), 'branch_hash');
    const canonical = this.hashAt(tip) === hash, table = 'branch_' + hash;
    this.views ??= new Map();
    const query = () => {
      if (!this.views.has(table)) {
        if (this.views.size >= 4) { const old = this.views.keys().next().value; this.store.db.exec('DROP TABLE temp.' + old); this.views.delete(old); }
        this.store.db.exec(`CREATE TEMP TABLE ${table}(height INTEGER PRIMARY KEY, raw TEXT NOT NULL)`);
        this.store.db.prepare(`INSERT INTO ${table} WITH RECURSIVE ancestors(value) AS (
          SELECT value FROM records WHERE space='headerObjects' AND id=? UNION ALL
          SELECT r.value FROM records r JOIN ancestors a ON r.space='headerObjects' AND r.id=json_extract(a.value,'$.parent'))
          SELECT json_extract(value,'$.height'),json_extract(value,'$.raw') FROM ancestors`).run(hash);
        this.views.set(table, this.store.db.prepare(`SELECT raw FROM ${table} WHERE height=?`));
      }
      return this.views.get(table);
    };
    const raw = height => {
      check(Number.isSafeInteger(height) && height >= 0 && height <= tip, 'header_missing', 503);
      if (canonical && this.hashAt(tip) === hash) return this.raw(height);
      const row = query().get(height); check(row, 'branch_header_missing', 503); return row.raw;
    };
    return { store: this.store, ...(canonical ? {} : { branch: hash }), length: tip + 1, raw, get: h => rules.parseHeader(raw(h), h),
      hashAt: h => Number.isSafeInteger(h) && h >= 0 && h <= tip ? rules.parseHeader(raw(h), h).hash : null };
  }
}
