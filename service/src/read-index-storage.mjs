import { rules } from './rules.mjs';
import { check, heightKey } from './util.mjs';
import { IndexedRows, pageCursor, tieFor } from './paging.mjs';

// These tables are disposable projections, outside the authoritative journal.
// Persistent triggers also capture writes before PublicViews is constructed and
// during journal recovery. A failed refresh never consumes its invalidations.
export function readIndexSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS claimedBlocksV2(asset TEXT,heightKey TEXT,value TEXT,found INTEGER,minted INTEGER,PRIMARY KEY(asset,heightKey)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS claimedBlocksV2Found ON claimedBlocksV2(asset,found,heightKey);
    CREATE INDEX IF NOT EXISTS claimedBlocksV2Minted ON claimedBlocksV2(asset,minted,heightKey);
    CREATE INDEX IF NOT EXISTS claimedBlocksV2Status ON claimedBlocksV2(asset,found,minted,heightKey);`);
  for (const operation of ['INSERT', 'UPDATE']) db.exec(`CREATE TRIGGER IF NOT EXISTS claimedBlocksV2${operation} AFTER ${operation} ON records WHEN new.space LIKE 'claimed2/%'
    BEGIN INSERT INTO claimedBlocksV2 VALUES(substr(new.space,10),new.id,new.value,coalesce(json_extract(new.value,'$.found'),0),coalesce(json_extract(new.value,'$.minted'),0))
    ON CONFLICT(asset,heightKey) DO UPDATE SET value=excluded.value,found=excluded.found,minted=excluded.minted; END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS claimedBlocksV2DELETE AFTER DELETE ON records WHEN old.space LIKE 'claimed2/%'
    BEGIN DELETE FROM claimedBlocksV2 WHERE asset=substr(old.space,10) AND heightKey=old.id; END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS claimedBlocks(asset TEXT,height INTEGER,value TEXT,found INTEGER,minted INTEGER,PRIMARY KEY(asset,height)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS claimedBlocksFound ON claimedBlocks(asset,found,height);
    CREATE INDEX IF NOT EXISTS claimedBlocksMinted ON claimedBlocks(asset,minted,height);
    CREATE INDEX IF NOT EXISTS claimedBlocksStatus ON claimedBlocks(asset,found,minted,height);`);
  for (const operation of ['INSERT', 'UPDATE']) db.exec(`CREATE TRIGGER IF NOT EXISTS claimedBlocks${operation} AFTER ${operation} ON records WHEN new.space LIKE 'claimed/%'
    BEGIN INSERT INTO claimedBlocks VALUES(substr(new.space,9),CAST(new.id AS INTEGER),new.value,coalesce(json_extract(new.value,'$.found'),0),coalesce(json_extract(new.value,'$.minted'),0))
    ON CONFLICT(asset,height) DO UPDATE SET value=excluded.value,found=excluded.found,minted=excluded.minted; END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS claimedBlocksDELETE AFTER DELETE ON records WHEN old.space LIKE 'claimed/%'
    BEGIN DELETE FROM claimedBlocks WHERE asset=substr(old.space,9) AND height=CAST(old.id AS INTEGER); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS publicReadChanges(space TEXT,id TEXT,PRIMARY KEY(space,id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS publicReadState(kind TEXT,id TEXT,value TEXT,PRIMARY KEY(kind,id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS publicReadRows(kind TEXT,id TEXT,value TEXT,position,PRIMARY KEY(kind,id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS publicReadPlots(height INTEGER PRIMARY KEY,found INTEGER NOT NULL DEFAULT 0,linked INTEGER NOT NULL DEFAULT 0,minted INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS publicReadPlotRegion ON publicReadPlots((height/2016),('['||height||',null]'));
    CREATE INDEX IF NOT EXISTS publicReadPlotHalving ON publicReadPlots((height/210000),('['||height||',null]'));
    CREATE TABLE IF NOT EXISTS publicReadPatternRows(asset TEXT,block INTEGER,value TEXT,tie TEXT,PRIMARY KEY(asset,block)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS publicReadOldHashes(height INTEGER PRIMARY KEY,hash TEXT);
    CREATE TRIGGER IF NOT EXISTS publicReadOldHashUpdate BEFORE UPDATE ON records WHEN old.space='headers' AND EXISTS(SELECT 1 FROM publicReadState WHERE kind='meta' AND id='cursor')
      BEGIN INSERT INTO publicReadOldHashes VALUES(CAST(old.id AS INTEGER),json_extract(old.value,'$.hash')) ON CONFLICT DO NOTHING; END;
    CREATE TRIGGER IF NOT EXISTS publicReadOldHashDelete BEFORE DELETE ON records WHEN old.space='headers' AND EXISTS(SELECT 1 FROM publicReadState WHERE kind='meta' AND id='cursor')
      BEGIN INSERT INTO publicReadOldHashes VALUES(CAST(old.id AS INTEGER),json_extract(old.value,'$.hash')) ON CONFLICT DO NOTHING; END;
    CREATE TABLE IF NOT EXISTS publicReadHeaderFields(height INTEGER PRIMARY KEY,value TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS publicReadHeaderFieldsDelete AFTER DELETE ON records WHEN old.space='headers'
      BEGIN DELETE FROM publicReadHeaderFields WHERE height=CAST(old.id AS INTEGER); END;
    CREATE TRIGGER IF NOT EXISTS publicReadHeaderFieldsInsert AFTER INSERT ON records WHEN new.space='headers'
      BEGIN DELETE FROM publicReadHeaderFields WHERE height=CAST(new.id AS INTEGER);
        INSERT INTO publicReadHeaderFields SELECT CAST(new.id AS INTEGER),json_extract(new.value,'$.fields') WHERE json_type(new.value,'$.fields')='object'; END;
    CREATE TRIGGER IF NOT EXISTS publicReadHeaderFieldsUpdate AFTER UPDATE ON records WHEN new.space='headers'
      BEGIN DELETE FROM publicReadHeaderFields WHERE height=CAST(new.id AS INTEGER);
        INSERT INTO publicReadHeaderFields SELECT CAST(new.id AS INTEGER),json_extract(new.value,'$.fields') WHERE json_type(new.value,'$.fields')='object'; END;`);
  const watched = "('headers','links','finds','findProvenance','minted','holds','replay/mints/holds','publicEvents','receiptObservations','batches','mints','publicClaims','publicDraws','feedVersions')";
  for (const [suffix, operation, row] of [['Insert', 'INSERT', 'new'], ['Update', 'UPDATE', 'new'], ['Delete', 'DELETE', 'old']])
    db.exec(`CREATE TRIGGER IF NOT EXISTS publicRead${suffix} AFTER ${operation} ON records
      WHEN ${row}.space IN ${watched} OR (${row}.space='meta' AND ${row}.id IN ('patterns','ruleState','headerHeight'))
      BEGIN INSERT INTO publicReadChanges VALUES(${row}.space,${row}.id) ON CONFLICT DO NOTHING; END;`);
  for (const key of ['count', 'finder', 'findHeight']) db.exec(`CREATE INDEX IF NOT EXISTS publicReadPattern_${key}
    ON publicReadPatternRows(asset,json_extract(value,'$.${key}'),tie)`);
}

export class ReadState {
  constructor(db) {
    this.db = db;
    this.put = db.prepare('INSERT INTO publicReadState VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value');
    this.del = db.prepare('DELETE FROM publicReadState WHERE kind=? AND id=?');
  }
  get(kind, id) { const r = this.db.prepare('SELECT value FROM publicReadState WHERE kind=? AND id=?').get(kind, String(id)); return r ? JSON.parse(r.value) : null; }
  set(kind, id, value) { if (value === undefined) this.del.run(kind, String(id)); else this.put.run(kind, String(id), JSON.stringify(value)); }
  rows(kind) { return this.db.prepare('SELECT id,value FROM publicReadState WHERE kind=? ORDER BY id').all(kind).map(r => [r.id, JSON.parse(r.value)]); }
}

export function persistedRows(db, kind, spec, options) {
  const index = new IndexedRows(spec, options);
  for (const r of db.prepare('SELECT id,value,position FROM publicReadRows WHERE kind=?').all(kind)) index.set(r.id, JSON.parse(r.value), r.position);
  const set = index.set.bind(index), del = index.delete.bind(index);
  const put = db.prepare('INSERT INTO publicReadRows VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,position=excluded.position');
  const remove = db.prepare('DELETE FROM publicReadRows WHERE kind=? AND id=?');
  index.set = (id, row, position = id) => { set(id, row, position); put.run(kind, String(id), JSON.stringify(row), position); };
  index.delete = id => { del(id); remove.run(kind, String(id)); };
  return index;
}

// Plot coordinates and claimability depend only on height/the committed clock.
// Materialize integer keys without reading headers; hydrate hashes for the page.
export class PlotRows {
  constructor(index) {
    this.index = index; this.db = index.db;
    this.rows = { get: id => { const row = this.db.prepare('SELECT * FROM publicReadPlots WHERE height=?').get(Number(id)); return row && { entry: { row: this.row(row) } }; } };
  }
  row(r) { return { height: r.height, ...rules.plotRegion(r.height), hash: this.db.prepare('SELECT hash FROM publicReadOldHashes WHERE height=?').get(r.height)?.hash ?? this.index.store.get('headers', heightKey(r.height))?.hash ?? this.index.views.history.hashAt(r.height),
    claimable: r.height <= this.index.counted, found: !!r.found, linked: !!r.linked, minted: !!r.minted }; }
  fill(from, to) {
    if (from >= to) return;
    this.db.prepare(`INSERT OR IGNORE INTO publicReadPlots(height) WITH RECURSIVE heights(h) AS
      (SELECT ? UNION ALL SELECT h+1 FROM heights WHERE h+1<?) SELECT h FROM heights`).run(from, to);
  }
  set(id, row) { this.db.prepare('INSERT INTO publicReadPlots VALUES(?,?,?,?) ON CONFLICT(height) DO UPDATE SET found=excluded.found,linked=excluded.linked,minted=excluded.minted').run(Number(id), +row.found, +row.linked, +row.minted); }
  delete(id) { this.db.prepare('DELETE FROM publicReadPlots WHERE height=?').run(Number(id)); }
  page(q) {
    const expressions = { height: 'height', region: '(height/2016)', halving: '(height/210000)' }, key = expressions[q.sortKey];
    const where = ['height<?'], args = [this.index.length];
    for (const [k, v] of Object.entries(q.selectedFilters)) {
      if (k === 'from' || k === 'to') { where.push(`height${k === 'from' ? '>=' : '<='}?`); args.push(v); }
      else if (k === 'claimable') { where.push(`height${v ? '<=' : '>'}?`); args.push(this.index.counted); }
      else if (['found', 'linked', 'minted'].includes(k)) { where.push(`${k}=?`); args.push(+v); }
    }
    const tie = "('['||height||',null]')";
    return sqlPage(this.db, 'publicReadPlots', where, args, key, tie, q, r => this.row(r), q.sortKey === 'height' ? '' : ' INDEXED BY publicReadPlot' + (q.sortKey === 'region' ? 'Region' : 'Halving'));
  }
}

export class PatternRows {
  constructor(index, asset) { this.index = index; this.db = index.db; this.asset = asset; }
  set(id, row) {
    const tie = tieFor(row, Number(id));
    this.db.prepare('INSERT INTO publicReadPatternRows VALUES(?,?,?,?) ON CONFLICT(asset,block) DO UPDATE SET value=excluded.value,tie=excluded.tie').run(this.asset, Number(id), JSON.stringify(row), tie);
  }
  delete(id) { this.db.prepare('DELETE FROM publicReadPatternRows WHERE asset=? AND block=?').run(this.asset, Number(id)); }
  page(q) {
    check(this.index.patternComplete(this.asset), 'index_catching_up', 503);
    const where = ['asset=?', 'block>=?', 'block<=?'], args = [this.asset, q.selectedFilters.from ?? 0, Math.min(this.index.length - 1, q.selectedFilters.to ?? Infinity)];
    for (const [k, v] of Object.entries(q.selectedFilters)) {
      if (k === 'from' || k === 'to') continue;
      else if (['found', 'minted', 'linked'].includes(k)) {
        where.push(`(coalesce(json_extract(value,'$.${k === 'linked' ? 'link' : k}'),0)!=0)=?`); args.push(+v);
      }
    }
    const key = q.sortKey === 'block' ? 'block' : `json_extract(value,'$.${q.sortKey}')`;
    const narrow = Number.isFinite(q.selectedFilters.from) && Number.isFinite(q.selectedFilters.to) && q.selectedFilters.to - q.selectedFilters.from <= 4096;
    return sqlPage(this.db, 'publicReadPatternRows', where, args, key, 'tie', q, r => JSON.parse(r.value), narrow ? ' INDEXED BY sqlite_autoindex_publicReadPatternRows_1' : '');
  }
}

function sqlPage(db, table, where, args, key, tie, q, row, orderingIndex = '') {
  const total = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where.join(' AND ')}`).get(...args).n;
  const direction = q.direction === 'asc' ? 'ASC' : 'DESC', op = direction === 'ASC' ? '>' : '<';
  if (q.anchor) {
    const anchorTie = q.anchor.tie.replace(/\u00000$/, '');
    // SQLite's NULL ordering matches paging.compare; explicit branches preserve
    // nullable finder/findHeight cursors in both directions.
    if (q.anchor.key === null) {
      where.push(direction === 'ASC' ? `(${key} IS NOT NULL OR (${key} IS NULL AND ${tie}>?))` : `(${key} IS NULL AND ${tie}<?)`);
      args.push(anchorTie);
    } else {
      where.push(`(${direction === 'DESC' ? `${key} IS NULL OR ` : ''}${key}${op}? OR (${key}=? AND ${tie}${op}?))`);
      args.push(q.anchor.key, q.anchor.key, anchorTie);
    }
  }
  const entries = db.prepare(`SELECT *,${key} AS pageKey,${tie} AS pageTie FROM ${table}${orderingIndex} WHERE ${where.join(' AND ')} ORDER BY ${key} ${direction},${tie} ${direction} LIMIT ?`)
    .all(...args, q.limit + 1).map(r => ({ row: row(r), key: r.pageKey, tie: r.pageTie + '\u00000', index: r.height ?? r.block }));
  const more = entries.length > q.limit; entries.length = Math.min(entries.length, q.limit);
  return { entries, meta: { total, next: more ? pageCursor(q.scope, entries.at(-1)) : null, limit: q.limit, sort: q.sortKey, order: q.direction, route: q.route } };
}
