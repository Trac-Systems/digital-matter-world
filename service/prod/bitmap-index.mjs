import { check, heightKey, serial } from '../src/util.mjs';
import { bitmapLinkSchema } from '../src/bitmap-link-changes.mjs';
import { pageCursor } from '../src/paging.mjs';

// Wallet history is bootstrapped once in bounded pages. Afterwards the shared
// canonical Bitmap event cursor updates ownership, including transfers back to
// an address whose historical list already contains the inscription.
export class BitmapIndex {
  constructor({ lookups, store }) {
    this.lookups = lookups; this.db = lookups.db; this.indexer = lookups.indexer; this.store = store; this.limits = lookups.settings; this.gate = serial();
    this.db.exec(`CREATE TABLE IF NOT EXISTS bitmap_clock(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER,height INTEGER,hash TEXT,offset INTEGER,seenHeight INTEGER,seenHash TEXT,revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS bitmap_wallets(address TEXT PRIMARY KEY,epoch INTEGER,imported INTEGER,turn INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS bitmap_inventory(inscription TEXT PRIMARY KEY,owner TEXT,height INTEGER,linked INTEGER,epoch INTEGER);
      CREATE INDEX IF NOT EXISTS bitmap_by_height ON bitmap_inventory(owner,epoch,height,inscription);
      CREATE INDEX IF NOT EXISTS bitmap_by_id ON bitmap_inventory(owner,epoch,inscription);
      CREATE INDEX IF NOT EXISTS bitmap_by_link ON bitmap_inventory(owner,epoch,linked,inscription);
      CREATE INDEX IF NOT EXISTS bitmap_by_link_height ON bitmap_inventory(owner,epoch,linked,height,inscription);`);
    if (store?.db && !store.acknowledgeBitmapLinks) bitmapLinkSchema(store.db);
  }
  clock() { return this.db.prepare('SELECT * FROM bitmap_clock WHERE id=1').get(); }
  async watch(address) {
    if (!this.clock()) {
      const at = await this.indexer.stamp();
      this.db.prepare('INSERT OR IGNORE INTO bitmap_clock(id,epoch,height,hash,offset,seenHeight,seenHash) VALUES(1,1,?,?,0,?,?)').run(at.height, at.hash, at.height, at.hash);
    }
    this.db.prepare('INSERT OR IGNORE INTO bitmap_wallets(address,epoch,imported) VALUES(?,0,0)').run(address);
    return this.lookups.watch('bitmap', [address]);
  }
  async put(bitmap, epoch) {
    if (!bitmap) return;
    check(typeof bitmap.ins === 'string' && typeof bitmap.ownr === 'string' && Number.isSafeInteger(bitmap.bm) && bitmap.bm >= 0, 'bitmap_row');
    const linked = !!await this.store.get('links', heightKey(bitmap.bm));
    const old = this.db.prepare('SELECT * FROM bitmap_inventory WHERE inscription=?').get(bitmap.ins);
    if (old?.owner === bitmap.ownr && old.height === bitmap.bm && old.linked === Number(linked) && old.epoch === epoch) return;
    this.db.prepare('UPDATE bitmap_clock SET revision=revision+1 WHERE id=1').run();
    this.db.prepare('INSERT OR REPLACE INTO bitmap_inventory VALUES(?,?,?,?,?)').run(bitmap.ins, bitmap.ownr, bitmap.bm, Number(linked), epoch);
  }
  async tick() { return this.gate(async () => {
    let clock = this.clock(); if (!clock) return;
    const at = await this.indexer.stamp();
    if (at.height < clock.seenHeight || await this.indexer.bitcoin.blockHash(clock.seenHeight) !== clock.seenHash) {
      this.db.prepare('UPDATE bitmap_clock SET epoch=epoch+1,height=?,hash=?,offset=0,seenHeight=?,seenHash=? WHERE id=1').run(at.height, at.hash, at.height, at.hash);
      clock = this.clock(); // Old cache generations are never served after reorg.
    }
    // Persist the branch before any ownership writes. A crash halfway through
    // this tick must still invalidate those rows if this snapshot reorganizes.
    this.db.prepare('UPDATE bitmap_clock SET seenHeight=?,seenHash=? WHERE id=1').run(at.height, at.hash);
    const wallet = this.db.prepare('SELECT * FROM bitmap_wallets ORDER BY turn,address LIMIT 1').get();
    if (wallet) {
      const stream = await this.watch(wallet.address); await this.lookups.advance(stream, 1);
      const state = this.lookups.stream(stream);
      if (await this.lookups.canonical(state)) {
        const imported = wallet.epoch === clock.epoch && wallet.imported <= state.offset ? wallet.imported : 0;
        const page = this.db.prepare('SELECT pos,value FROM lookup_rows WHERE stream=? AND pos>=? ORDER BY pos LIMIT ?').all(stream, imported, this.limits.walletItemsPerTick);
        const rows = await this.indexer.at({ tip: at.height, tipHash: at.hash }, async () => {
          const out = [];
          for (const row of page) {
            const id = JSON.parse(row.value), bitmap = await this.indexer.tap('getBitmapByInscription/' + encodeURIComponent(id));
            check(!bitmap || bitmap.ins === id, 'bitmap_binding'); out.push(bitmap);
          }
          return out;
        });
        for (const row of rows) await this.put(row, clock.epoch);
        this.db.prepare('UPDATE bitmap_wallets SET imported=?,epoch=?,turn=(SELECT coalesce(max(turn),0)+1 FROM bitmap_wallets) WHERE address=?').run(page.length ? page.at(-1).pos + 1 : imported, clock.epoch, wallet.address);
      }
    }
    for (let work = 0; clock.height < at.height && work < this.limits.walletBlocksPerTick; work++) {
      const block = clock.height + 1, hash = await this.indexer.bitcoin.blockHash(block);
      const total = Number(await this.indexer.tap('getBitmapEventByBlockLength/' + block));
      check(Number.isSafeInteger(total) && total >= clock.offset, 'bitmap_event_count');
      const limit = Math.min(this.limits.pageRows, this.limits.walletItemsPerTick, total - clock.offset);
      const events = limit ? await this.indexer.tap(`getBitmapEventByBlock/${block}?offset=${clock.offset}&max=${limit}`) : [];
      check(Array.isArray(events) && events.length === limit, 'bitmap_event_page');
      const current = await this.indexer.at({ tip: at.height, tipHash: at.hash }, async () => {
        const rows = []; for (const event of events) {
          check(typeof event.ins === 'string', 'bitmap_event');
          const row = await this.indexer.tap('getBitmapByInscription/' + encodeURIComponent(event.ins));
          check(!row || row.ins === event.ins, 'bitmap_binding'); rows.push(row);
        } return rows;
      });
      check(await this.indexer.bitcoin.blockHash(block) === hash && await this.indexer.bitcoin.blockHash(clock.height) === clock.hash, 'bitmap_reorg');
      for (const row of current) await this.put(row, clock.epoch);
      const offset = clock.offset + limit;
      if (offset === total) this.db.prepare('UPDATE bitmap_clock SET height=?,hash=?,offset=0 WHERE id=1').run(block, hash);
      else this.db.prepare('UPDATE bitmap_clock SET offset=? WHERE id=1').run(offset);
      clock = this.clock();
    }
    check(await this.indexer.bitcoin.blockHash(at.height) === at.hash, 'bitmap_reorg');
    this.db.prepare('UPDATE bitmap_clock SET seenHeight=?,seenHash=? WHERE id=1').run(at.height, at.hash);
    const acknowledged = [];
    if (this.store.db) for (const { id } of this.store.db.prepare('SELECT id FROM bitmap_link_changes ORDER BY id LIMIT ?').all(this.limits.walletItemsPerTick)) {
      const linked = Number(!!this.store.get('links', id));
      const changed = this.db.prepare('UPDATE bitmap_inventory SET linked=? WHERE height=? AND linked<>?').run(linked, Number(id), linked);
      if (changed.changes) this.db.prepare('UPDATE bitmap_clock SET revision=revision+1 WHERE id=1').run();
      if (this.store.acknowledgeBitmapLinks) acknowledged.push({ id, linked: !!linked });
      else this.store.db.prepare('DELETE FROM bitmap_link_changes WHERE id=?').run(id);
    }
    if (acknowledged.length) await this.store.acknowledgeBitmapLinks(acknowledged);
  }); }
  async source(address) {
    const stream = await this.watch(address), at = await this.indexer.stamp(), clock = this.clock();
    check(at.height >= clock.seenHeight && await this.indexer.bitcoin.blockHash(clock.seenHeight) === clock.seenHash, 'bitmap_index_reorg');
    const wallet = this.db.prepare('SELECT * FROM bitmap_wallets WHERE address=?').get(address), state = this.lookups.stream(stream);
    const syncing = wallet.epoch !== clock.epoch || wallet.imported < state.offset || !await this.lookups.complete(stream) || clock.height < at.height;
    const db = this.db;
    return { page(query) {
      const { sortKey, direction, selectedFilters, anchor, limit, scope, route } = query;
      const current = db.prepare('SELECT epoch,revision FROM bitmap_clock WHERE id=1').get();
      check(current.epoch === clock.epoch && current.revision === clock.revision, 'bitmap_cursor_changed');
      check(['height', 'inscription', 'linked'].includes(sortKey) && ['asc', 'desc'].includes(direction), 'bitmap_page');
      const where = ['owner=?', 'epoch=?'], args = [address, clock.epoch];
      for (const key of ['height', 'linked']) if (selectedFilters[key] !== undefined) { where.push(`${key}=?`); args.push(Number(selectedFilters[key])); }
      if (anchor) {
        const [epoch, revision, inscription] = JSON.parse(anchor.tie); check(epoch === clock.epoch && revision === clock.revision, 'bitmap_cursor_changed');
        where.push(`(${sortKey},inscription) ${direction === 'asc' ? '>' : '<'} (?,?)`); args.push(sortKey === 'linked' ? Number(anchor.key) : anchor.key, inscription);
      }
      const rows = db.prepare(`SELECT * FROM bitmap_inventory WHERE ${where.join(' AND ')} ORDER BY ${sortKey} ${direction},inscription ${direction} LIMIT ?`).all(...args, limit + 1);
      const more = rows.length > limit, entries = rows.slice(0, limit).map(r => ({ row: { height: r.height, inscription: r.inscription, linked: !!r.linked }, key: sortKey === 'linked' ? !!r.linked : r[sortKey], tie: JSON.stringify([clock.epoch, clock.revision, r.inscription]) }));
      return { entries, meta: { total: null, next: more ? pageCursor(scope, entries.at(-1)) : null, limit, sort: sortKey, order: direction, route, syncing, indexedHeight: clock.height, snapshotHash: clock.hash } };
    } };
  }
}
