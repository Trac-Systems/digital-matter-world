import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { takenPage, takenSchema, fillTakenPage, drainTakenPage, takenReadResources } from '../src/taken-index.mjs';
import { rules } from '../src/rules.mjs';
import { temp } from './helpers.mjs';

const params = value => new URLSearchParams(value);
const row = (asset, block, found = true) => ({ space: 'claimed2/' + asset, id: rules.uintKeyV2(String(block)),
  value: { height: String(block), pattern: asset.slice(3), count: '1', found, minted: false, hash: 'ab'.repeat(32) } });
async function fixture(t, options, maintenance = false) {
  const directory = await temp('taken-'), store = await (maintenance ? Store.openForMaintenance(directory, options) : Store.open(directory, options));
  t.after(() => store.close());
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '0' });
  return { directory, store, api: createPublicAPI({ views: { store }, files: {} }) };
}

test('taken snapshots contain only found slots and deltas ignore mint/occurrence updates', async t => {
  const { store, api } = await fixture(t);
  await store.transact([row('p2:0', 10), row('p2:1', 2), row('p2:0', 3, false)]);
  const snapshot = await api.read('/patterns/taken');
  assert.deepEqual(snapshot.slots, [['p2:0', ['10']], ['p2:1', ['2']]]);
  assert.equal(snapshot.nextCursor, null);
  await store.transact([{ ...row('p2:0', 10), value: { ...row('p2:0', 10).value, minted: true } }, row('p2:0', 4, false)]);
  const unchanged = await api.read('/patterns/taken?' + params({ since: snapshot.revision }));
  assert.deepEqual(unchanged.changes, []);
  assert.equal(unchanged.revision, snapshot.revision);
  await store.transact([row('p2:0', 3), row('p2:2', 7), { ...row('p2:0', 10), value: undefined }]);
  const delta = await api.read('/patterns/taken?' + params({ since: snapshot.revision }));
  assert.deepEqual(delta.changes, [['p2:0', '3', true], ['p2:2', '7', true], ['p2:0', '10', false]]);
  assert.equal(delta.from, snapshot.revision); assert.equal(delta.more, false);
  const [epoch, sequence, digest] = JSON.parse(Buffer.from(snapshot.revision, 'base64url'));
  let hash = digest, n = BigInt(sequence);
  for (const change of delta.changes) hash = rules.hash(JSON.stringify([hash, String(++n), ...change]));
  assert.deepEqual(JSON.parse(Buffer.from(delta.revision, 'base64url')), [epoch, String(n), hash]);
  const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM takenChanges WHERE sequenceKey>? ORDER BY sequenceKey LIMIT ?').all('', 2);
  assert.match(JSON.stringify(plan), /SEARCH.*PRIMARY KEY/);
});

test('a snapshot continues across new batches and its deltas resume as the head advances', async t => {
  const { store } = await fixture(t);
  await store.transact([row('p2:0', 1), row('p2:0', 2)]);
  const first = takenPage(store, params({ limit: 1 }));
  assert.ok(first.nextCursor);
  assert.deepEqual(takenPage(store, params({ cursor: first.nextCursor, limit: 1 })).slots, [['p2:0', ['2']]]);
  await store.transact([row('p2:0', 3), row('p2:0', 4)]);
  const later = takenPage(store, params({ cursor: first.nextCursor }));
  assert.equal(later.revision, first.revision);
  assert.deepEqual(later.slots, [['p2:0', ['2', '3', '4']]]);
  const one = takenPage(store, params({ since: first.revision, limit: 1 }));
  assert.equal(one.more, true); assert.deepEqual(one.changes, [['p2:0', '3', true]]);
  await store.put(row('p2:1', 8).space, row('p2:1', 8).id, row('p2:1', 8).value);
  const two = takenPage(store, params({ since: one.revision }));
  assert.deepEqual(two.changes, [['p2:0', '4', true], ['p2:1', '8', true]]);
  assert.equal(two.more, false);
});

test('expired or forked revisions demand a rebuild; log retention is bounded', async t => {
  const { store } = await fixture(t, { takenChangeRows: 2 });
  const start = takenPage(store, params()).revision;
  await store.transact([row('p2:0', 1), row('p2:0', 2), row('p2:0', 3)]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM takenChanges').get().n, 2);
  assert.throws(() => takenPage(store, params({ since: start })), e => e.status === 409 && e.message === 'taken_revision_gone');
  const current = takenPage(store, params()).revision, fork = JSON.parse(Buffer.from(current, 'base64url'));
  fork[2] = 'cd'.repeat(32);
  assert.throws(() => takenPage(store, params({ since: Buffer.from(JSON.stringify(fork)).toString('base64url') })), /taken_revision_gone/);
  assert.equal(takenPage(store, params({ since: current })).more, false);
});

test('taken projection shares transaction rollback and refuses pending projection scopes', async t => {
  const { store } = await fixture(t, undefined, true);
  const before = takenPage(store, params()).revision;
  store.db.exec('BEGIN IMMEDIATE');
  store.applyOperation(row('p2:0', 1));
  store.db.exec('ROLLBACK');
  assert.equal(takenPage(store, params()).revision, before);
  assert.deepEqual(takenPage(store, params()).slots, []);
  await store.put('feedEvents', 'unfinished', { finds: [{ block: '10', pattern: '0', finder: 'aa'.repeat(32) }] });
  assert.throws(() => takenPage(store, params({ since: before })), e => e.status === 503 && e.message === 'public_projection_pending');
  await store.put('feedEvents', 'unfinished');
  assert.equal(takenPage(store, params({ since: before })).revision, before);
});

test('restart keeps revisions and an old database fills once in bounded resumable pages', async () => {
  const directory = await temp('taken-migration-'); let store = await Store.openForMaintenance(directory);
  try {
    await store.transact([row('p2:0', 1), row('p2:0', 2), row('p2:1', 3), row('p2:0', 4, false)]);
    const before = takenPage(store, params()).revision;
    await store.close(); store = await Store.openForMaintenance(directory);
    assert.equal(takenPage(store, params()).revision, before);
    // Recreate just the disposable read index to exercise upgrade/rebuild.
    store.db.exec('DROP TABLE takenControl; DROP TABLE takenSlots; DROP TABLE takenChanges');
    takenSchema(store.db);
    assert.equal(fillTakenPage(store, 1), false);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM takenSlots').get().n, 1);
    assert.throws(() => takenPage(store, params()), /taken_index_pending/);
    await store.close(); store = await Store.openForMaintenance(directory);
    const rebuilt = takenPage(store, params());
    assert.deepEqual(rebuilt.slots, [['p2:0', ['1', '2']], ['p2:1', ['3']]]);
    assert.notEqual(rebuilt.revision, before);
    assert.throws(() => takenPage(store, params({ since: before })), /taken_revision_gone/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM takenChanges').get().n, 0);
  } finally { await store.close(); }
});

test('taken pages preserve large decimal heights, cap bytes and validate read parameters', async t => {
  const { store } = await fixture(t);
  const huge = '9'.repeat(80);
  await store.transact([row('p2:0', 0)]);
  const small = takenPage(store, params(), { publicPageBytes: 500 });
  assert.deepEqual(small.slots, [['p2:0', ['0']]]); assert.equal(small.nextCursor, null);
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 500, 'a complete page needs no continuation reservation');
  await store.transact(Array.from({ length: 1000 }, (_, i) => row('p2:0', String(i))));
  await store.transact([row('p2:1', huge)]);
  const settings = { publicPageBytes: 1800 }, slots = []; let cursor;
  do {
    const page = takenPage(store, params(cursor ? { cursor } : {}), settings);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1800);
    slots.push(...page.slots.flatMap(([asset, blocks]) => blocks.map(block => [asset, block])));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(slots.length, 1001); assert.deepEqual(slots.at(-1), ['p2:1', huge]);
  for (const query of ['since=no', 'limit=0', 'limit=4097', 'limit=1&limit=1', 'found=true', 'since=a&cursor=b'])
    assert.throws(() => takenPage(store, new URLSearchParams(query)));
  for (const settings of [null, [], { pageRows: 0 }, { changeRows: -1 }, { extra: 1 }]) assert.throws(() => takenReadResources(settings), /taken_read_settings/);
});

test('writes by an older SQLite connection are detected and drained before serving after restart', async () => {
  const directory = await temp('taken-older-writer-'); let store = await Store.openForMaintenance(directory);
  try {
    await store.transact([row('p2:0', 1)]);
    const before = takenPage(store, params()).revision;
    await store.close();
    const old = new DatabaseSync(join(directory, 'index.sqlite'));
    try {
      const put = old.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(space,id) DO UPDATE SET value=excluded.value');
      for (const op of [row('p2:0', 1, false), row('p2:0', 2), row('p2:1', 3)]) put.run(op.space, op.id, JSON.stringify(op.value));
    } finally { old.close(); }
    store = await Store.openForMaintenance(directory);
    const delta = takenPage(store, params({ since: before }));
    assert.deepEqual(delta.changes, [['p2:0', '1', false], ['p2:0', '2', true], ['p2:1', '3', true]]);
    assert.deepEqual(takenPage(store, params()).slots, [['p2:0', ['2']], ['p2:1', ['3']]]);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM takenDirty').get().n, 0);
    // A bypassing write in the current process also fails closed until drained.
    const op = row('p2:0', 4); store.putStmt.run(op.space, op.id, JSON.stringify(op.value));
    assert.throws(() => takenPage(store, params({ since: delta.revision })), /taken_index_pending/);
    assert.equal(drainTakenPage(store, 1), false);
    assert.deepEqual(takenPage(store, params({ since: delta.revision })).changes, [['p2:0', '4', true]]);
  } finally { await store.close(); }
});

test('membership updates and revision hashes replay from a durable journal tail exactly once', async () => {
  const directory = await temp('taken-replay-'); let store = await Store.open(directory);
  try {
    const before = takenPage(store, params()).revision, apply = store.apply.bind(store);
    // Capture the fsynced transaction without applying it, as a process exit
    // between journal sync and SQLite commit would do.
    store.apply = () => {};
    await store.transact([row('p2:0', 5)]);
    store.apply = apply;
    assert.equal(takenPage(store, params()).revision, before);
    await store.close(); store = await Store.open(directory);
    const replayed = takenPage(store, params({ since: before }));
    assert.deepEqual(replayed.changes, [['p2:0', '5', true]]);
    await store.close(); store = await Store.open(directory);
    assert.equal(takenPage(store, params()).revision, replayed.revision);
    assert.deepEqual(takenPage(store, params({ since: replayed.revision })).changes, []);
  } finally { await store.close(); }
});

test('a snapshot spanning batches ends equal to the head once its deltas are replayed', async t => {
  const { store } = await fixture(t);
  await store.transact([row('p2:0', 1), row('p2:0', 5), row('p2:1', 2)]);
  const first = takenPage(store, params({ limit: 1 })), slots = new Map();
  const add = page => { for (const [asset, blocks] of page.slots) for (const b of blocks) slots.set(asset + '/' + b, true); };
  add(first);
  // Removed before the cursor reaches it, added behind and ahead of the cursor.
  await store.transact([row('p2:0', 5, false), row('p2:0', 0), row('p2:1', 9)]);
  let page = first;
  while (page.nextCursor) { page = takenPage(store, params({ cursor: page.nextCursor, limit: 1 })); assert.equal(page.revision, first.revision); add(page); }
  const delta = takenPage(store, params({ since: first.revision }));
  for (const [asset, block, found] of delta.changes) found ? slots.set(asset + '/' + block, true) : slots.delete(asset + '/' + block);
  const head = takenPage(store, params()), expected = new Set(head.slots.flatMap(([asset, blocks]) => blocks.map(b => asset + '/' + b)));
  assert.deepEqual(new Set(slots.keys()), expected);
  assert.equal(delta.revision, head.revision);
});

test('a snapshot older than the retained change log still restarts', async t => {
  const { store } = await fixture(t, { takenChangeRows: 2 });
  await store.transact([row('p2:0', 1), row('p2:0', 2)]);
  const first = takenPage(store, params({ limit: 1 }));
  await store.transact([row('p2:0', 3), row('p2:0', 4), row('p2:0', 6)]);
  assert.throws(() => takenPage(store, params({ cursor: first.nextCursor })), e => e.status === 409 && e.message === 'taken_snapshot_stale');
  const forged = JSON.parse(Buffer.from(first.nextCursor, 'base64url'));
  forged.revision = Buffer.from(JSON.stringify(['ab'.repeat(32), '1', 'cd'.repeat(32)])).toString('base64url');
  assert.throws(() => takenPage(store, params({ cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') })), /taken_snapshot_stale/);
});
