import { randomBytes } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { rules } from './rules.mjs';
import { check, hash } from './util.mjs';
import { projectionStatement as statement, projectionReady } from './projection-state.mjs';
import { R3_RESOURCES } from './r3-settings.mjs';

// Disposable read indexes only. No authoritative records, operations or digests change.
export const TAKEN_READ_RESOURCES = Object.freeze({ changeRows: 16384, pageRows: 4096 });
export function takenReadResources(overrides = {}) {
  check(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'taken_read_settings');
  const value = { ...TAKEN_READ_RESOURCES, ...overrides };
  check(Object.keys(value).every(k => Object.hasOwn(TAKEN_READ_RESOURCES, k)) &&
    Object.values(value).every(n => Number.isSafeInteger(n) && n > 0), 'taken_read_settings');
  return value;
}
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = state => encode([state.epoch, state.sequence, state.hash]);
const control = store => statement(store.db, 'SELECT * FROM takenControl WHERE id=1').get();
const changeHash = (previous, sequence, asset, block, found) => hash(JSON.stringify([previous, sequence, asset, block, found]));
const isAsset = value => typeof value === 'string' && /^p2:(0|[1-9][0-9]*)$/.test(value);
function decode(text) {
  check(typeof text === 'string' && text.length <= 8192 && /^[A-Za-z0-9_-]+$/.test(text), 'taken_cursor');
  let value; try { value = JSON.parse(Buffer.from(text, 'base64url')); } catch { throw Error('taken_cursor'); }
  check(encode(value) === text, 'taken_cursor'); return value;
}
function revision(text) {
  const value = decode(text);
  check(Array.isArray(value) && value.length === 3 && /^[0-9a-f]{64}$/.test(value[0]) &&
    typeof value[1] === 'string' && /^(0|[1-9][0-9]*)$/.test(value[1]) && /^[0-9a-f]{64}$/.test(value[2]), 'taken_revision');
  return { epoch: value[0], sequence: value[1], hash: value[2] };
}

export function takenSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS takenControl(id INTEGER PRIMARY KEY,epoch TEXT,sequence TEXT,hash TEXT,ready INTEGER,space TEXT,after TEXT);
    CREATE TABLE IF NOT EXISTS takenSlots(asset TEXT,heightKey TEXT,block TEXT,PRIMARY KEY(asset,heightKey)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS takenChanges(sequenceKey TEXT PRIMARY KEY,sequence TEXT,previous TEXT,hash TEXT,asset TEXT,block TEXT,found INTEGER) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS takenDirty(asset TEXT,heightKey TEXT,PRIMARY KEY(asset,heightKey)) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS takenInsert AFTER INSERT ON claimedBlocksV2 WHEN new.found!=0 BEGIN
      INSERT OR IGNORE INTO takenDirty VALUES(new.asset,new.heightKey); END;
    CREATE TRIGGER IF NOT EXISTS takenUpdate AFTER UPDATE ON claimedBlocksV2 WHEN new.found!=old.found BEGIN
      INSERT OR IGNORE INTO takenDirty VALUES(new.asset,new.heightKey); END;
    CREATE TRIGGER IF NOT EXISTS takenDelete AFTER DELETE ON claimedBlocksV2 WHEN old.found!=0 BEGIN
      INSERT OR IGNORE INTO takenDirty VALUES(old.asset,old.heightKey); END;`);
  const epoch = randomBytes(32).toString('hex');
  statement(db, 'INSERT OR IGNORE INTO takenControl VALUES(1,?,?,?,0,?,?)').run(epoch, '0', hash('taken/v1/' + epoch), 'claimed2/', '');
}

// Called inside the original journal transaction, including journal replay.
// Only found membership matters: an occurrence, mint, link or attribution update
// does not make a previously free slot taken in the old found=true query.
export function projectTaken(store, op) {
  if (!op.space.startsWith('claimed2/')) return;
  const asset = op.space.slice(9), key = String(op.id);
  check(isAsset(asset), 'taken_asset');
  const old = statement(store.db, 'SELECT block FROM takenSlots WHERE asset=? AND heightKey=?').get(asset, key);
  const found = !!op.value?.found;
  statement(store.db, 'DELETE FROM takenDirty WHERE asset=? AND heightKey=?').run(asset, key);
  if (!!old === found) return;
  const block = found ? rules.uintV2(op.value.height) : old.block;
  check(key === rules.uintKeyV2(block), 'taken_height');
  if (found) statement(store.db, 'INSERT INTO takenSlots VALUES(?,?,?)').run(asset, key, block);
  else statement(store.db, 'DELETE FROM takenSlots WHERE asset=? AND heightKey=?').run(asset, key);
  const state = control(store), sequence = rules.nextUint(state.sequence), digest = changeHash(state.hash, sequence, asset, block, found);
  statement(store.db, 'INSERT INTO takenChanges VALUES(?,?,?,?,?,?,?)').run(rules.uintKeyV2(sequence), sequence, state.hash, digest, asset, block, +found);
  statement(store.db, 'UPDATE takenControl SET sequence=?,hash=? WHERE id=1').run(sequence, digest);
  const cutoff = BigInt(sequence) - BigInt(store.takenChangeRows);
  if (cutoff > 0n) statement(store.db, 'DELETE FROM takenChanges WHERE sequenceKey<=?').run(rules.uintKeyV2(String(cutoff)));
}

// A one-time, resumable migration from existing claimed records. Startup owns
// the writer lock; bounded pages yield between commits. No Bitcoin history scan.
export function fillTakenPage(store, pageRows = Math.min(1024, store.storePageRows)) {
  const state = control(store);
  if (state.ready) return true;
  check(Number.isSafeInteger(pageRows) && pageRows > 0 && pageRows <= store.storePageRows, 'taken_fill_settings');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const rows = statement(store.db, `SELECT space,id,value FROM records WHERE space>='claimed2/' AND space<'claimed20'
      AND (space,id)>(?,?) ORDER BY space,id LIMIT ?`).all(state.space, state.after, pageRows);
    for (const row of rows) {
      const value = JSON.parse(row.value), asset = row.space.slice(9);
      if (!value.found) continue;
      check(isAsset(asset) && row.id === rules.uintKeyV2(rules.uintV2(value.height)), 'taken_fill_row');
      statement(store.db, 'INSERT OR REPLACE INTO takenSlots VALUES(?,?,?)').run(asset, row.id, value.height);
    }
    const done = rows.length < pageRows;
    statement(store.db, 'UPDATE takenControl SET ready=?,space=?,after=? WHERE id=1').run(+done, rows.at(-1)?.space ?? state.space, rows.at(-1)?.id ?? state.after);
    store.db.exec('COMMIT'); return done;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
// Persistent SQL triggers also detect an older binary's writes. Catch up those
// keys before serving after an upgrade; never silently trust an old ready flag.
export function drainTakenPage(store, pageRows = Math.min(1024, store.storePageRows)) {
  check(Number.isSafeInteger(pageRows) && pageRows > 0 && pageRows <= store.storePageRows, 'taken_fill_settings');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const rows = statement(store.db, 'SELECT * FROM takenDirty ORDER BY asset,heightKey LIMIT ?').all(pageRows);
    for (const row of rows) projectTaken(store, { space: 'claimed2/' + row.asset, id: row.heightKey,
      value: store.get('claimed2/' + row.asset, row.heightKey) });
    store.db.exec('COMMIT'); return rows.length < pageRows;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
export async function fillTaken(store) {
  while (!fillTakenPage(store)) await yieldIO();
  while (!drainTakenPage(store)) await yieldIO();
}

export function takenPage(store, params, settings = {}) {
  projectionReady(store, 'world');
  const state = control(store);
  check(state?.ready && !statement(store.db, 'SELECT 1 FROM takenDirty LIMIT 1').get(), 'taken_index_pending', 503);
  for (const key of params.keys()) check(['since', 'cursor', 'limit'].includes(key) && params.getAll(key).length === 1, 'taken_query');
  check(!(params.has('since') && params.has('cursor')), 'taken_query');
  const maximum = settings.takenPageRows ?? TAKEN_READ_RESOURCES.pageRows, limit = Number(params.get('limit') ?? maximum);
  check(Number.isSafeInteger(limit) && limit > 0 && limit <= maximum, 'taken_limit');
  const maxBytes = settings.publicPageBytes ?? R3_RESOURCES.publicPageBytes, current = token(state);
  if (params.has('since')) {
    const from = params.get('since'), previous = revision(from);
    check(previous.epoch === state.epoch && rules.compareUint(previous.sequence, state.sequence) <= 0, 'taken_revision_gone', 409);
    const rows = statement(store.db, 'SELECT * FROM takenChanges WHERE sequenceKey>? ORDER BY sequenceKey LIMIT ?')
      .all(rules.uintKeyV2(previous.sequence), limit + 1);
    check(previous.sequence === state.sequence ? previous.hash === state.hash :
      rows[0]?.sequence === rules.nextUint(previous.sequence) && rows[0]?.previous === previous.hash, 'taken_revision_gone', 409);
    const result = { v: 1, mode: 'delta', from, revision: current, changes: [], more: rows.length > limit };
    let bytes = Buffer.byteLength(JSON.stringify(result)), last;
    for (const row of rows.slice(0, limit)) {
      const change = [row.asset, row.block, !!row.found], size = Buffer.byteLength(JSON.stringify(change)) + (last ? 1 : 0);
      if (bytes + size > maxBytes) { check(last, 'taken_row_budget', 503); result.more = true; break; }
      result.changes.push(change); bytes += size; last = row;
    }
    result.revision = last ? token({ ...last, epoch: state.epoch }) : from;
    check(Buffer.byteLength(JSON.stringify(result)) <= maxBytes, 'taken_row_budget', 503);
    return result;
  }
  let after = ['', ''];
  if (params.has('cursor')) {
    const cursor = decode(params.get('cursor'));
    check(cursor?.revision === current, 'taken_snapshot_stale', 409);
    check(Array.isArray(cursor.after) && cursor.after.length === 2 && isAsset(cursor.after[0]) &&
      typeof cursor.after[1] === 'string', 'taken_cursor');
    after = cursor.after;
  }
  const rows = statement(store.db, 'SELECT * FROM takenSlots WHERE (asset,heightKey)>(?,?) ORDER BY asset,heightKey LIMIT ?').all(...after, limit + 1);
  const next = row => encode({ revision: current, after: [row.asset, row.heightKey] });
  const result = { v: 1, mode: 'snapshot', revision: current, slots: [], nextCursor: null, next: null };
  if (rows.length <= limit) {
    const slots = []; let group;
    for (const row of rows) {
      if (group?.[0] !== row.asset) { group = [row.asset, []]; slots.push(group); }
      group[1].push(row.block);
    }
    const complete = { ...result, slots };
    if (Buffer.byteLength(JSON.stringify(complete)) <= maxBytes) return complete;
  }
  // Reserve the longest continuation before filling; group heights by asset to
  // fit thousands of slots in a normal public response without full find rows.
  let bytes = Buffer.byteLength(JSON.stringify(result)) + 2 * rows.reduce((size, row) => Math.max(size, next(row).length), 0) + 4;
  let more = rows.length > limit, group, last;
  for (const row of rows.slice(0, limit)) {
    const fresh = group?.[0] !== row.asset;
    const size = Buffer.byteLength(JSON.stringify(fresh ? [row.asset, [row.block]] : row.block)) + (fresh ? result.slots.length > 0 : 1);
    if (bytes + size > maxBytes) { check(last, 'taken_row_budget', 503); more = true; break; }
    if (fresh) { group = [row.asset, []]; result.slots.push(group); }
    group[1].push(row.block); bytes += size; last = row;
  }
  if (more) result.next = result.nextCursor = next(last);
  check(Buffer.byteLength(JSON.stringify(result)) <= maxBytes, 'taken_row_budget', 503);
  return result;
}
