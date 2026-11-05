import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';
export class History {
  constructor(store, { branchCache = 4, appendRows = 2048 } = {}) { this.store = store; this.branchCache = branchCache; this.appendRows = appendRows; }
  get cacheDB() { return this.store.scratchDatabase?.() ?? this.store.db; }
  get clock() { return rules.ordinalCodec(this.store.get('meta', 'ruleState')?.batchVersion === 2); }
  get length() { return this.clock.add(this.store.get('meta', 'headerHeight') ?? -1); }
  raw(height) { check(rules.compareOrdinal(height, 0) >= 0 && rules.compareOrdinal(height, this.length) < 0, 'header_missing', 503); const row = this.store.get('headers', heightKey(height)); check(row, 'header_missing', 503); return row.raw; }
  get(height) { return rules.parseHeader(this.raw(height), height); }
  hashAt = height => rules.compareOrdinal(height, 0) >= 0 && rules.compareOrdinal(height, this.length) < 0 ? this.store.get('headers', heightKey(height))?.hash ?? null : null;
  field(height, field, dt = 'n') { const h = this.get(height); return (field === 4 ? height : field === 10 ? h.nonce : h.bits).toString(dt === 'h' ? 16 : 10); }
  async append(height, raw) {
    return (await this.appendMany(height, [raw]))[0];
  }
  async appendMany(start, raws) {
    check(rules.compareOrdinal(start, 0) >= 0 && rules.compareOrdinal(start, this.length) <= 0, 'header_gap');
    check(Array.isArray(raws), 'headers');
    const headers = [], clock = this.clock; start = clock.value(start);
    // Bound each journal frame and commit only a fully checked group. Links
    // within the group use the preceding parsed header, before SQLite sees it.
    for (let offset = 0; offset < raws.length; offset += this.appendRows) {
      const end = Math.min(raws.length, offset + this.appendRows), operations = [];
      let parent = clock.compare(clock.add(start, offset), 0) === 0 ? null : this.hashAt(clock.add(start, offset - 1));
      for (let i = offset; i < end; i++) {
        const height = clock.add(start, i), raw = raws[i], header = rules.parseHeader(raw, height);
        check(BigInt('0x' + header.hash) <= rules.targetFromBits(header.bits), 'header_pow');
        check(clock.compare(height, 0) === 0 || header.prev === parent, 'header_link');
        operations.push({ space: 'headers', id: heightKey(height), value: { raw, hash: header.hash, fields: { height, hash: header.hash, time: header.time, nonce: header.nonce, bits: header.bits } } },
          { space: 'headerObjects', id: header.hash, value: { raw, height, parent: header.prev } });
        headers.push(header); parent = header.hash;
      }
      operations.push({ space: 'meta', id: 'headerHeight', value: clock.max(clock.add(this.length, -1), clock.add(start, end - 1)) });
      await this.store.transact(operations);
    }
    return headers;
  }
  async setTip(height) { check(this.hashAt(height), 'header_missing'); await this.store.put('meta', 'headerHeight', height); }
  view(tip, hash) {
    check(/^[0-9a-f]{64}$/.test(hash), 'branch_hash');
    if (this.clock.valid(String(tip)) && this.store.get('meta', 'ruleState')?.batchVersion === 2) return this.decimalView(String(tip), hash);
    const canonical = this.hashAt(tip) === hash, table = 'branch_' + hash, bounded = this.store.get('meta', 'ruleState')?.batchVersion === 2;
    this.views ??= new Map();
    const query = () => {
      const saved = this.views.get(table);
      if (saved && this.hashAt(saved.floor) !== saved.anchor) { this.cacheDB.exec('DROP TABLE temp.' + table); this.views.delete(table); }
      if (!this.views.has(table)) {
        if (this.views.size >= this.branchCache) { const old = this.views.keys().next().value; this.cacheDB.exec('DROP TABLE temp.' + old); this.views.delete(old); }
        this.cacheDB.exec(`CREATE TEMP TABLE ${table}(height INTEGER PRIMARY KEY, raw TEXT NOT NULL)`);
        const insert = this.cacheDB.prepare(`INSERT INTO ${table} VALUES(?,?)`);
        for (const row of this.store.db.prepare(`WITH RECURSIVE ancestors(hash,value) AS (
          SELECT id,value FROM records WHERE space='headerObjects' AND id=? UNION ALL
          SELECT r.id,r.value FROM records r JOIN ancestors a ON r.space='headerObjects' AND r.id=json_extract(a.value,'$.parent')
          ${bounded ? "WHERE NOT EXISTS(SELECT 1 FROM records c WHERE c.space='headers' AND c.id=printf('%016d',json_extract(a.value,'$.height')) AND json_extract(c.value,'$.hash')=a.hash)" : ''})
          SELECT json_extract(value,'$.height') AS height,json_extract(value,'$.raw') AS raw FROM ancestors`).iterate(hash)) insert.run(row.height, row.raw);
        const floor = this.cacheDB.prepare(`SELECT height,raw FROM ${table} ORDER BY height LIMIT 1`).get();
        if (!floor) this.cacheDB.exec('DROP TABLE temp.' + table);
        check(floor, 'branch_header_missing', 503);
        this.views.set(table, { query: this.cacheDB.prepare(`SELECT raw FROM ${table} WHERE height=?`), floor: floor.height, anchor: rules.parseHeader(floor.raw, floor.height).hash });
      }
      return this.views.get(table);
    };
    const raw = height => {
      check(Number.isSafeInteger(height) && height >= 0 && height <= tip, 'header_missing', 503);
      if (canonical && this.hashAt(tip) === hash) return this.raw(height);
      const view = query();
      if (height < view.floor) { check(this.hashAt(view.floor) === view.anchor, 'branch_prefix_missing', 503); return this.raw(height); }
      const row = view.query.get(height); check(row, 'branch_header_missing', 503); return row.raw;
    };
    return { store: this.store, ...(canonical ? {} : { branch: hash }), length: tip + 1, raw, get: h => rules.parseHeader(raw(h), h),
      hashAt: h => Number.isSafeInteger(h) && h >= 0 && h <= tip ? rules.parseHeader(raw(h), h).hash : null };
  }
  decimalView(tip, hash) {
    const table = 'decimal_branch_' + hash, clock = rules.ordinalCodec();
    this.views ??= new Map();
    const query = () => {
      const saved = this.views.get(table);
      if (saved && this.hashAt(saved.floor) !== saved.anchor) { this.cacheDB.exec('DROP TABLE temp.' + table); this.views.delete(table); }
      if (!this.views.has(table)) {
        if (this.views.size >= this.branchCache) { const old = this.views.keys().next().value; this.cacheDB.exec('DROP TABLE temp.' + old); this.views.delete(old); }
        this.cacheDB.exec(`CREATE TEMP TABLE ${table}(height TEXT PRIMARY KEY,raw TEXT NOT NULL) WITHOUT ROWID`);
        const insert = this.cacheDB.prepare(`INSERT INTO ${table} VALUES(?,?)`); let cursor = hash, floor, anchor;
        try {
          for (;;) {
            const row = this.store.get('headerObjects', cursor); check(row, 'branch_header_missing', 503);
            floor = rules.decimalV2(row.height); anchor = cursor;
            insert.run(heightKey(floor), row.raw);
            if (this.hashAt(floor) === cursor) break;
            const parent = this.store.get('headerObjects', row.parent);
            check(parent && rules.nextUint(rules.decimalV2(parent.height)) === floor, 'branch_header_link', 503);
            cursor = row.parent;
          }
          this.views.set(table, { floor, anchor, query: this.cacheDB.prepare(`SELECT raw FROM ${table} WHERE height=?`) });
        } catch (error) { this.cacheDB.exec('DROP TABLE temp.' + table); throw error; }
      }
      return this.views.get(table);
    };
    const raw = h => {
      h = rules.decimalV2(h); check(clock.compare(h, tip) <= 0, 'header_missing', 503);
      if (this.hashAt(tip) === hash) return this.raw(h);
      const view = query();
      if (clock.compare(h, view.floor) < 0) return this.raw(h);
      const row = view.query.get(heightKey(h)); check(row, 'branch_header_missing', 503); return row.raw;
    };
    return { store: this.store, branch: hash, length: rules.nextUint(tip), raw,
      get: h => rules.parseHeader(raw(h), rules.decimalV2(h)),
      hashAt: h => clock.compare(h, 0) >= 0 && clock.compare(h, tip) <= 0 ? rules.parseHeader(raw(h), rules.decimalV2(h)).hash : null };
  }

}
