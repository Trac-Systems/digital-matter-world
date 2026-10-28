// Offline migration only. Never materialize the complete gateway as JSON.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { rules as r } from './rules.mjs';
import { check } from './util.mjs';

export const MIGRATION_DEFAULTS = Object.freeze({ pageRows: 1024, pageBytes: 1_000_000 });
export const EMPTY_MIGRATION_ROOT = r.hashObject(['dmw-migration-pages-v2']);
export const migrationPageRoot = (previous, rows) => r.hashObject(['dmw-migration-page-v2', previous, rows]);
export function migrationSettings(value = {}) {
  const settings = { ...MIGRATION_DEFAULTS, ...value };
  check(Object.keys(settings).every(k => k in MIGRATION_DEFAULTS) && Object.values(settings).every(n => Number.isSafeInteger(n) && n > 0), 'migration_settings');
  return settings;
}
export const compareRowKey = (a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) || Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1]));
export function orderedRow(previous, row) {
  check(Array.isArray(row) && row.length === 3 && row.slice(0, 2).every(v => typeof v === 'string') &&
    (!previous || compareRowKey(row, previous) > 0), 'migration_row_order');
}
export function* migrationPages(rows, options) {
  const { pageRows, pageBytes } = migrationSettings(options);
  let page = [], bytes = 2, previous = null;
  for (const row of rows) {
    orderedRow(previous, row); previous = row;
    const size = Buffer.byteLength(r.stableJSON(row));
    check(size + 2 <= pageBytes, 'migration_row_bytes');
    if (page.length && (page.length >= pageRows || bytes + size + 1 > pageBytes)) { yield page; page = []; bytes = 2; }
    bytes += size + (page.length ? 1 : 0); page.push(row);
  }
  if (page.length) yield page;
}
// Identical to the old canonical commitment, including Unicode validation,
// with only one row encoded at a time. Existing accepted roots stay valid.
export function iterableRoot(domain, rows) {
  const h = createHash('sha256'); h.update('[' + r.stableJSON(domain) + ',['); let count = 0;
  for (const row of rows) { if (count++) h.update(','); h.update(r.stableJSON(row)); }
  return h.update(']]').digest('hex');
}
export function iterableArrayRoot(rows) {
  const h = createHash('sha256'); h.update('['); let count = 0;
  for (const row of rows) { if (count++) h.update(','); h.update(r.stableJSON(row)); }
  return h.update(']').digest('hex');
}
export function gatewayRowsRoot(rows) { return rows instanceof MigrationRows ? (rows.commitment?.legacyRoot ?? (rows.legacyRoot ??= iterableRoot('dmw-legacy-gateway-v1', rows))) : iterableRoot('dmw-legacy-gateway-v1', rows); }
export function migrationCommitment(rows, options) {
  const settings = migrationSettings(options); let root = EMPTY_MIGRATION_ROOT, count = 0, pages = 0;
  const h = createHash('sha256'); h.update('["dmw-legacy-gateway-v1",[');
  for (const page of migrationPages(rows, settings)) {
    root = migrationPageRoot(root, page); pages++;
    for (const row of page) { if (count++) h.update(','); h.update(r.stableJSON(row)); }
  }
  return { version: 2, ...settings, rows: count, pages, root, legacyRoot: h.update(']]').digest('hex') };
}
export class MigrationRows {
  constructor(db, { owned = false, commitment = null, working = false } = {}) { this.db = db; this.owned = owned; this.commitment = commitment; this.working = working; }
  *[Symbol.iterator]() {
    for (const row of this.db.prepare(this.working ? "SELECT space,id,value FROM records WHERE space NOT IN ('headers','headerObjects') ORDER BY space,id" : 'SELECT space,id,value FROM records ORDER BY space,id').iterate()) yield [row.space, row.id, JSON.parse(row.value)];
  }
  get length() { return this.commitment?.rows ?? this.db.prepare('SELECT count(*) AS n FROM records').get().n; }
  // Compatibility for the offline pending transforms. They retain selected
  // work only; the complete history is always an iterator backed by SQLite.
  filter(fn) { const out = []; for (const row of this) if (fn(row)) out.push(row); return out; }
  find(fn) { for (const row of this) if (fn(row)) return row; }
  flatMap(fn) { const out = []; for (const row of this) out.push(...fn(row)); return out; }
  get(space, id) { const row = this.db.prepare('SELECT value FROM records WHERE space=? AND id=?').get(space, id); return row ? JSON.parse(row.value) : null; }
  hasRows(space) { return !!this.db.prepare('SELECT 1 FROM records WHERE space=? LIMIT 1').get(space); }
  close() { if (this.owned) { this.db.close(); this.owned = false; } }
}
export const migrationGatewayRows = store => store.migrationRowsView ?? new MigrationRows(store.db);
export function createMigrationRows(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE records (space TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(space,id)) WITHOUT ROWID');
  return new MigrationRows(db, { owned: true });
}
export function appendMigrationPage(rows, page) {
  const put = rows.db.prepare('INSERT INTO records VALUES(?,?,?)'); rows.db.exec('BEGIN');
  try { for (const [space, id, value] of page) put.run(space, id, r.stableJSON(value)); rows.db.exec('COMMIT'); }
  catch (error) { rows.db.exec('ROLLBACK'); throw error; }
}

// Only pending-work analysis ignores header caches; the source commitment and
// exported pages still include both spaces verbatim. They have no work items.
export function pendingRows(rows) {
  return rows instanceof MigrationRows ? new MigrationRows(rows.db, { working: true, commitment: { legacyRoot: gatewayRowsRoot(rows) } }) : rows;
}
