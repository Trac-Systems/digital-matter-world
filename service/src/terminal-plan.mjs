// Disk-backed offline terminal planner. Its supported scope includes all
// ordinary account balances, nonces, payments and locks. Detached external
// financial identities need the separately reconciled financial adapter.
import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { accountKey, accountLeaf, accountBranch, accountEmptyRoot } from '../../contract/account-tree.js';
import { EMPTY_IMPORT_ROOT, importPageRoot } from '../../contract/activation-v2.js';
import { reconcileLegacySignatures } from './pending-signatures.mjs';
import { rules as r } from './rules.mjs';
import { check } from './util.mjs';

export const TERMINAL_PLAN_DEFAULTS = Object.freeze({ cacheKiB: 4096, rowBytes: 1000000, pageBytes: 90000 });

class Rows {
  constructor(db, sql, decode, count) { Object.assign(this, { db, sql, decode, count }); }
  *[Symbol.iterator]() { for (const row of this.db.prepare(this.sql).iterate()) yield this.decode(row); }
  get length() { return this.db.prepare(this.count).get().n; }
  at(index) { if (index < 0) index += this.length; const row = this.db.prepare(this.sql + ' LIMIT 1 OFFSET ?').get(index); return row ? this.decode(row) : undefined; }
}
class RecordView extends Rows {
  constructor(db, table = 'records') { super(db, `SELECT id,value FROM ${table} ORDER BY sort`, row => [row.id, JSON.parse(row.value)], `SELECT count(*) AS n FROM ${table}`); this.table = table; }
  orderedEntries() { return this; }
  get size() { return this.length; }
  get(id) { const row = this.db.prepare(`SELECT value FROM ${this.table} WHERE id=?`).get(id); return row && JSON.parse(row.value); }
  has(id) { return !!this.db.prepare(`SELECT 1 FROM ${this.table} WHERE id=?`).get(id); }
  *keys() { for (const row of this.db.prepare(`SELECT id FROM ${this.table} ORDER BY id`).iterate()) yield row.id; }
}

export function prepareDiskTerminalImport({ file, records, height, network, document, pendingWork, gatewayRows, financialSnapshot, settings = {} }) {
  const limits = { ...TERMINAL_PLAN_DEFAULTS, ...settings };
  check(Object.keys(limits).every(k => k in TERMINAL_PLAN_DEFAULTS) && Object.values(limits).every(n => Number.isSafeInteger(n) && n > 0), 'terminal_plan_settings');
  check(Number.isSafeInteger(height) && height >= 0 && !financialSnapshot && !pendingWork?.financialMigration, 'terminal_plan_external_financial_adapter_required');
  closeSync(openSync(file, 'wx', 0o600)); const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA cache_size=-${limits.cacheKiB};
      CREATE TABLE original(id TEXT PRIMARY KEY,value TEXT NOT NULL,sort BLOB NOT NULL) WITHOUT ROWID; CREATE INDEX original_order ON original(sort);
      CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT NOT NULL,sort BLOB NOT NULL) WITHOUT ROWID; CREATE INDEX records_order ON records(sort);
      CREATE TABLE owners(id TEXT PRIMARY KEY,address TEXT UNIQUE NOT NULL) WITHOUT ROWID;
      CREATE TABLE leaves(owner TEXT,key TEXT,value TEXT,PRIMARY KEY(owner,key)) WITHOUT ROWID;
      CREATE TABLE nodes(id TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE balances(owner TEXT,asset TEXT,available TEXT,held TEXT,PRIMARY KEY(owner,asset)) WITHOUT ROWID;
      CREATE TABLE supply(asset TEXT PRIMARY KEY,amount TEXT) WITHOUT ROWID;
      CREATE TABLE writes(n INTEGER PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE pages(n INTEGER PRIMARY KEY,value TEXT NOT NULL); BEGIN`);
    const encode = value => { const text = r.stableJSON(value); check(Buffer.byteLength(text) <= limits.rowBytes, 'terminal_plan_row_budget'); return text; };
    const sortKey = id => Buffer.from(id, 'utf16le').swap16();
    const put = (id, value) => db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(id, encode(value), sortKey(id));
    for (const [id, value] of records) {
      check(typeof id === 'string', 'terminal_plan_key'); const text = encode(value);
      db.prepare('INSERT INTO original VALUES(?,?,?)').run(id, text, sortKey(id)); put(id, value);
      if (/^a\/[0-9a-f]{64}$/.test(id)) db.prepare('INSERT INTO owners VALUES(?,?)').run(String(value), id.slice(2));
      // No detached permits may disappear merely because gateway work is empty.
      check(!/^(?:m|cu|custody|fc|fi|fm|fd|dc|fl|bc)\//.test(id), 'terminal_plan_external_financial_adapter_required');
      check(id !== 'v2/ready', 'terminal_plan_already_activated');
    }
    const original = new RecordView(db, 'original'), imported = new RecordView(db);
    const owner = n => { const row = db.prepare('SELECT address FROM owners WHERE id=?').get(String(n)); check(row, 'account_import_owner'); return row.address; };
    const leaf = (who, key, value) => db.prepare('INSERT OR REPLACE INTO leaves VALUES(?,?,?)').run(who, key, encode(value));
    const change = (who, asset, available, held = 0n) => {
      check(available >= 0n && held >= 0n, 'account_import_amount');
      const address = owner(who), old = db.prepare('SELECT available,held FROM balances WHERE owner=? AND asset=?').get(address, asset);
      const a = BigInt(old?.available ?? '0') + available, h = BigInt(old?.held ?? '0') + held;
      db.prepare('INSERT OR REPLACE INTO balances VALUES(?,?,?,?)').run(address, asset, String(a), String(h));
      leaf(address, accountKey('balance', asset), { available: String(a), held: String(h) });
      const prior = db.prepare('SELECT amount FROM supply WHERE asset=?').get(asset);
      db.prepare('INSERT OR REPLACE INTO supply VALUES(?,?)').run(asset, String(BigInt(prior?.amount ?? '0') + available + held));
    };
    for (const [key, value] of original) {
      let match;
      if ((match = /^v\/([0-9]+)\/([0-9a-z]+)$/.exec(key))) change(match[1], match[2], BigInt(value));
      else if ((match = /^e\/([0-9]+)\/([0-9a-z]+)$/.exec(key))) for (const [expiry, amount] of value) {
        change(match[1], match[2], height > expiry ? BigInt(amount) : 0n, height > expiry ? 0n : BigInt(amount));
        // With no reconciled mint identities, live escrow must be empty.
        check(height > expiry || BigInt(amount) === 0n, 'account_import_escrow');
      }
      else if ((match = /^rq\/n\/([0-9]+)\/([0-9a-f]{64})$/.exec(key))) leaf(owner(match[1]), accountKey('nonce', match[2]), 'used');
      else if ((match = /^pay\/([0-9a-f]{64})$/.exec(key))) {
        check(/^[1-9][0-9]*$/.test(value.total) && /^(0|[1-9][0-9]*)$/.test(value.used) && BigInt(value.used) <= BigInt(value.total), 'account_import_payment');
        leaf('payments', accountKey('payment', match[1]), value);
      } else if ((match = /^l\/([0-9a-f]{64})$/.exec(key))) {
        for (const [asset, amount] of value.assets) change(value.o, asset, 0n, BigInt(amount));
        put('al/' + match[1], { state: 'locked', owner: owner(value.o), to: owner(value.to), assets: value.assets, hash: value.hash, refund: value.refund, legacy: value });
      }
    }
    for (const { asset, amount } of db.prepare('SELECT asset,amount FROM supply ORDER BY asset').iterate()) leaf('supply', accountKey('supply', asset), { issued: amount, burned: '0' });
    const keep = (root, value) => { db.prepare('INSERT OR IGNORE INTO nodes VALUES(?,?)').run(root, encode(value)); return root; };
    const tree = who => {
      const iterator = db.prepare('SELECT key,value FROM leaves WHERE owner=? ORDER BY key').iterate(who)[Symbol.iterator](); let current = iterator.next();
      const walk = (depth, prefix) => {
        if (current.done || !BigInt('0x' + current.value.key).toString(2).padStart(256, '0').startsWith(prefix)) return accountEmptyRoot(depth);
        if (depth === 256) { const key = current.value.key, value = JSON.parse(current.value.value); current = iterator.next(); return keep(accountLeaf(key, value), { key, value }); }
        const left = walk(depth + 1, prefix + '0'), right = walk(depth + 1, prefix + '1');
        return keep(accountBranch(left, right), { left, right });
      };
      const root = walk(0, ''); check(current.done, 'terminal_plan_leaf_order'); return root;
    };
    for (const { address } of db.prepare('SELECT address FROM owners ORDER BY address').iterate()) put('ar/' + address, { root: tree(address), revision: '0' });
    put('ar/supply', { root: tree('supply'), revision: '0' }); put('fp/usage', { root: tree('payments'), revision: '0' });
    const digest = createHash('sha256').update('dmw-financial-import-v2|{"height":' + height + ',"records":['); let count = 0;
    for (const row of original) if (/^(?:a|an|v|e|rq\/n|pay|m|l)\//.test(row[0])) { if (count++) digest.update(','); digest.update(r.stableJSON(row)); }
    let financialRoot = digest.update(']}').digest('hex');
    const signatures = pendingWork?.signatureReconciliation && reconcileLegacySignatures({ rows: gatewayRows, records: original, network });
    if (signatures) check(r.stableJSON(signatures) === r.stableJSON(pendingWork.signatureReconciliation), 'pending_signature_reconciliation');
    if (pendingWork) {
      check(pendingWork.commitment.network === network && pendingWork.commitment.anchor.height === String(height) &&
        pendingWork.root === r.hashObject(['dmw-pending-work-v1', pendingWork.commitment]), 'pending_import_root');
      put('v2-pending-work', pendingWork.commitment); financialRoot = r.hashObject(['dmw-terminal-pending-v1', financialRoot, pendingWork.root]);
    }
    put('v2-financial-root', financialRoot);
    const write = (space, id, value) => db.prepare('INSERT INTO writes(value) VALUES(?)').run(encode({ space, id, value }));
    for (const { owner, asset, available, held } of db.prepare('SELECT * FROM balances ORDER BY owner,asset').iterate())
      write('publicBalances', owner + '/' + asset, { owner, asset, amount: available, held, ...imported.get('ar/' + owner) });
    for (const { address } of db.prepare('SELECT address FROM owners ORDER BY address').iterate()) write('publicBalanceHeads', address, imported.get('ar/' + address));
    let issued = 0n;
    for (const { asset, amount } of db.prepare('SELECT asset,amount FROM supply ORDER BY asset').iterate()) {
      issued += BigInt(amount); write('publicSupply', asset, { asset, issued: amount, burned: '0', outstanding: amount, ...imported.get('ar/supply') });
    }
    write('publicSummaries', 'outstandingSupply', { matterIssued: String(issued), matterBurned: '0', matter: String(issued), matterHead: imported.get('ar/supply'), matterMeaning: 'materialized_account_units_including_holds' });
    for (const [key, value] of original) if (key.startsWith('k/link/')) {
      const row = typeof value === 'string' ? JSON.parse(value) : value; check(row?.block != null && row.linkHeight != null, 'public_import_link');
      write('links', String(row.block).padStart(16, '0'), row);
    }
    write('publicSummaries', 'burn', { tap: '0', ethereum: '0', meaning: 'verified_v2_payment_receipts', sinceHeight: String(height), legacyAllocations: '0', legacyBurn: '0' });
    let previous = EMPTY_IMPORT_ROOT, part = 0, page = [];
    const flush = final => { const value = { part, previous, records: page, final }; previous = importPageRoot(previous, page); db.prepare('INSERT INTO pages VALUES(?,?)').run(part++, r.stableJSON(value)); page = []; };
    for (const row of imported) {
      if (page.length && Buffer.byteLength(r.stableJSON({ part, previous, records: [...page, row], final: false })) > limits.pageBytes) flush(false);
      check(Buffer.byteLength(r.stableJSON(row)) + 256 <= limits.pageBytes, 'activation_import_record_budget'); page.push(row);
    }
    if (page.length) flush(true);
    db.exec('COMMIT; PRAGMA query_only=ON');
    const pages = new Rows(db, 'SELECT value FROM pages ORDER BY n', row => JSON.parse(row.value), 'SELECT count(*) AS n FROM pages');
    const availability = new Rows(db, 'SELECT id,value FROM nodes ORDER BY id', row => ({ space: 'accountNodes', id: row.id, value: JSON.parse(row.value) }), 'SELECT count(*) AS n FROM nodes');
    const accountRecords = new Rows(db, "SELECT id,value FROM records WHERE id GLOB 'ar/*' OR id GLOB 'ao/*' OR id GLOB 'al/*' OR id GLOB 'fp/*' ORDER BY id",
      row => ({ space: 'accountRecords', id: row.id, value: JSON.parse(row.value) }), "SELECT count(*) AS n FROM records WHERE id GLOB 'ar/*' OR id GLOB 'ao/*' OR id GLOB 'al/*' OR id GLOB 'fp/*'");
    const publicWrites = new Rows(db, 'SELECT value FROM writes ORDER BY n', row => JSON.parse(row.value), 'SELECT count(*) AS n FROM writes');
    return { financialRoot, importRoot: previous, importRows: imported.size, pages, availability, accountRecords, publicWrites,
      financialIdentities: [], records: imported, ...(pendingWork ? { pendingWork } : {}), ...(signatures ? { signatureRecords: original } : {}),
      file, limits, close: () => db.close() };
  } catch (error) { db.close(); throw error; }
}
