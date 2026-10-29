import { DatabaseSync } from 'node:sqlite';
import { lookupSettings } from './lookup-settings.mjs';
import { check } from '../src/util.mjs';
import { KeyedWork, parallelPage } from '../src/keyed-work.mjs';
import { rules } from '../src/rules.mjs';

const segment = value => encodeURIComponent(value);
const countOf = value => { check(typeof value === 'number' || typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'tap_lookup_count'); const n = Number(value); check(Number.isSafeInteger(n) && n >= 0, 'tap_lookup_count'); return n; };
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const definitions = {
  privilege: () => ['getPrivilegeAuthList', 'getPrivilegeAuthListLength'],
  element: () => ['getDmtElementsList', 'getDmtElementsListLength'],
  auth: ([address]) => ['getAccountAuthList/' + segment(address), 'getAccountAuthListLength/' + segment(address)],
  redeem: ([address]) => ['getAccountRedeemList/' + segment(address), 'getAccountRedeemListLength/' + segment(address)],
  mint: ([address, tick]) => ['getAccountMintList/' + segment(address) + '/' + segment(tick), 'getAccountMintListLength/' + segment(address) + '/' + segment(tick)],
  minted: ([tx]) => ['getMintedList/' + tx, 'getMintedListLength/' + tx],
  transfer: ([tx]) => ['getTransferredList/' + tx, 'getTransferredListLength/' + tx],
  bitmap: ([address]) => ['getBitmapWalletHistoricList/' + segment(address), 'getBitmapWalletHistoricListLength/' + segment(address)]
};
export const elementDefinitionKey = (pat, fld) => JSON.stringify(['definition', pat, Number(fld)]);
export const elementNameKey = name => JSON.stringify(['name', name.toLowerCase()]);
export const permitKey = (dta, amount) => JSON.stringify(['permit', dta, amount]);
const idKey = id => JSON.stringify(['inscription', id]);
function keys(kind, row) {
  if (kind === 'bitmap') { check(typeof row === 'string', 'tap_lookup_row'); return [idKey(row)]; }
  check(row && typeof row.ins === 'string', 'tap_lookup_row');
  const out = [idKey(row.ins)];
  if (kind === 'element') {
    check(typeof row.tick === 'string' && Number.isSafeInteger(Number(row.fld)), 'tap_lookup_element');
    out.push(elementDefinitionKey(row.pat, row.fld), elementNameKey(row.tick));
  }
  if (kind === 'mint' && row.fail === false) out.push(permitKey(row.dta, row.amt));
  if (kind === 'redeem') for (const item of row.rdm?.items ?? []) {
    const request = /^dmw-pay-v2\|([0-9a-f]{64})\|/.exec(item.dta ?? '')?.[1];
    if (request) out.push(JSON.stringify(['request', request]));
  }
  return [...new Set(out)];
}

// All offsets are locations in source indexes, not trusted facts. Point reads
// re-fetch those exact locations within a current canonical TAP snapshot. A
// request never implicitly enumerates a global element/authority catalog.
export class TapLookupIndex {
  constructor({ filename = ':memory:', indexer, settings }) {
    this.indexer = indexer; this.settings = lookupSettings(settings); this.work = new KeyedWork();
    this.db = new DatabaseSync(filename); this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS lookup_streams(id TEXT PRIMARY KEY,kind TEXT,args TEXT,offset INTEGER,height INTEGER,hash TEXT,turn INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS lookup_due ON lookup_streams(turn,id);
      CREATE TABLE IF NOT EXISTS lookup_rows(stream TEXT,pos INTEGER,value TEXT,PRIMARY KEY(stream,pos));
      CREATE TABLE IF NOT EXISTS lookup_keys(stream TEXT,key TEXT,pos INTEGER,PRIMARY KEY(stream,key,pos));
      CREATE INDEX IF NOT EXISTS lookup_keys_pos ON lookup_keys(stream,pos);
      CREATE TABLE IF NOT EXISTS lookup_checkpoints(stream TEXT,pos INTEGER,height INTEGER,hash TEXT,PRIMARY KEY(stream,pos));`);
    this.watch('privilege'); this.watch('element');
  }
  watch(kind, args = []) {
    check(Object.hasOwn(definitions, kind), 'tap_lookup_kind');
    const id = JSON.stringify([kind, ...args]);
    this.db.prepare('INSERT OR IGNORE INTO lookup_streams(id,kind,args,offset) VALUES(?,?,?,0)').run(id, kind, JSON.stringify(args)); return id;
  }
  stream(id) { const row = this.db.prepare('SELECT * FROM lookup_streams WHERE id=?').get(id); check(row, 'tap_lookup_stream'); return row; }
  paths(row) { return definitions[row.kind](JSON.parse(row.args)); }
  async canonical(row) {
    if (row.height === null || row.height === undefined) return true;
    try { return await this.indexer.bitcoin.blockHash(row.height) === row.hash; }
    catch (e) { if (e.status === 404) return false; throw e; }
  }
  async advance(id, budget = this.settings.pagesPerTick) { return this.work.run(id, async () => {
    let row = this.stream(id);
    for (let step = 0; step < budget; step++) {
      if (!await this.canonical(row)) {
        const previous = this.db.prepare('SELECT * FROM lookup_checkpoints WHERE stream=? AND pos<? ORDER BY pos DESC LIMIT 1').get(id, row.offset);
        const offset = previous?.pos ?? 0;
        this.db.exec('BEGIN');
        try {
          this.db.prepare('DELETE FROM lookup_rows WHERE stream=? AND pos>=?').run(id, offset);
          this.db.prepare('DELETE FROM lookup_keys WHERE stream=? AND pos>=?').run(id, offset);
          this.db.prepare('DELETE FROM lookup_checkpoints WHERE stream=? AND pos>?').run(id, offset);
          this.db.prepare('UPDATE lookup_streams SET offset=?,height=?,hash=? WHERE id=?').run(offset, previous?.height ?? null, previous?.hash ?? null, id);
          this.db.exec('COMMIT');
        } catch (e) { this.db.exec('ROLLBACK'); throw e; }
        row = this.stream(id); continue;
      }
      const [path, lengthPath] = this.paths(row), before = await this.indexer.stamp(), total = countOf(await this.indexer.tap(lengthPath));
      check(total >= row.offset, 'tap_lookup_source_rewound');
      const size = Math.min(this.settings.pageRows, total - row.offset);
      const values = size ? await this.indexer.tap(`${path}?offset=${row.offset}&max=${size}`) : [];
      check(Array.isArray(values) && values.length === size && Buffer.byteLength(JSON.stringify(values)) <= this.settings.pageBytes, 'tap_lookup_page');
      const mapped = values.map(value => keys(row.kind, value));
      check(same(before, await this.indexer.stamp()) && await this.canonical(row), 'tap_snapshot_changed');
      this.db.exec('BEGIN');
      try {
        for (let i = 0; i < size; i++) {
          const pos = row.offset + i;
          this.db.prepare('INSERT INTO lookup_rows VALUES(?,?,?)').run(id, pos, JSON.stringify(values[i]));
          for (const key of mapped[i]) this.db.prepare('INSERT INTO lookup_keys VALUES(?,?,?)').run(id, key, pos);
        }
        const offset = row.offset + size;
        if (size) this.db.prepare('INSERT OR REPLACE INTO lookup_checkpoints VALUES(?,?,?,?)').run(id, offset, before.height, before.hash);
        this.db.prepare('UPDATE lookup_streams SET offset=?,height=?,hash=? WHERE id=?').run(offset, before.height, before.hash, id);
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      row = this.stream(id);
      if (row.offset === total) return true;
    }
    return false;
  }, { join: true }); }
  async tick({ submittedBitmapsOnly = false } = {}) {
    let failure;
    const rows = this.db.prepare(`SELECT id FROM lookup_streams ${submittedBitmapsOnly ? "WHERE kind<>'bitmap'" : ''} ORDER BY turn,id LIMIT ?`).all(this.settings.pagesPerTick);
    for (const row of rows) {
      this.db.prepare('UPDATE lookup_streams SET turn=(SELECT coalesce(max(turn),0)+1 FROM lookup_streams) WHERE id=?').run(row.id);
    }
    await parallelPage(rows, async row => {
      try { await this.advance(row.id, Math.max(1, Math.floor(this.settings.pagesPerTick / rows.length))); } catch (error) { failure ??= error; }
    });
    if (failure) throw failure;
  }
  async complete(id) {
    const row = this.stream(id); check(await this.canonical(row), 'tap_lookup_reorg');
    return row.offset === countOf(await this.indexer.tap(this.paths(row)[1]));
  }
  async find(id, key, { discover = false, many = false, requireComplete = false } = {}) {
    if (discover) await this.advance(id);
    return this.indexer.at(undefined, async () => {
      const stream = this.stream(id); check(await this.canonical(stream), 'tap_lookup_reorg');
      const positions = this.db.prepare('SELECT pos FROM lookup_keys WHERE stream=? AND key=? ORDER BY pos LIMIT ?').all(id, key, this.settings.pageRows + 1);
      check(positions.length <= this.settings.pageRows, 'tap_lookup_item_page_required');
      if (!positions.length || requireComplete) check(await this.complete(id), 'tap_lookup_index_catching_up');
      const [path] = this.paths(stream), result = [];
      for (const { pos } of positions) {
        const page = await this.indexer.tap(`${path}?offset=${pos}&max=1`);
        check(Array.isArray(page) && page.length === 1 && keys(stream.kind, page[0]).includes(key), 'tap_lookup_location_changed');
        result.push({ index: pos, value: page[0] });
      }
      if (many) return result;
      check(result.length <= 1, 'tap_lookup_ambiguous'); return result[0]?.value ?? null;
    });
  }
  authority(id) { return this.find(this.watch('privilege'), idKey(id)); }
  element(id) { return this.find(this.watch('element'), idKey(id)); }
  elementDefinition(pat, fld) { return this.find(this.watch('element'), elementDefinitionKey(pat, fld)); }
  elementName(name) { return this.find(this.watch('element'), elementNameKey(name)); }
  auth(address, id) { return this.find(this.watch('auth', [address]), idKey(id), { discover: true }); }
  transfers(id) { return this.find(this.watch('transfer', [id.slice(0, 64)]), idKey(id), { discover: true, many: true, requireComplete: true }); }
  minted(id) { return this.find(this.watch('minted', [id.slice(0, 64)]), idKey(id), { discover: true }); }
  paymentIds(address, request) { return this.find(this.watch('redeem', [address]), JSON.stringify(['request', request]), { discover: true, many: true }); }
  mint(address, tick, dta, amount) { return this.find(this.watch('mint', [address, tick]), permitKey(dta, amount), { discover: true }); }
  close() { this.db.close(); }
}

export function installTapLookups(reads, index) {
  reads.lookups = index;
  reads.withTapSnapshot = (view, fn) => index.indexer.at(view, fn);
  reads.privilegeAuthority = id => index.authority(id);
  reads.element = id => index.element(id);
  reads.elementByDefinition = (pat, fld) => index.elementDefinition(pat, fld);
  reads.elementByName = name => index.elementName(name);
  reads.paymentAuthority = (address, id) => index.auth(address, id);
  reads.paymentTransfers = id => index.transfers(id);
  reads.discoverPaymentIds = async (address, request) => (await index.paymentIds(address, request)).map(r => r.value.ins);
  reads.mintedInscription = id => index.minted(id);
  reads.mintByPermit = (address, tick, dta, amount) => index.mint(address, tick, dta, amount);
  return reads;
}

// Explicit operator/bootstrap work; its cursor survives an interrupted launch.
export async function indexedAuthority(indexer, filename, id, settings) {
  const index = new TapLookupIndex({ indexer, filename, settings });
  try { await index.advance(index.watch('privilege')); return await index.authority(id); }
  finally { index.close(); }
}
