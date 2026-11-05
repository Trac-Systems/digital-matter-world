import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { History } from '../src/history.mjs';
import { PublicViews } from '../src/public-views.mjs';
import { BitmapIndex } from '../prod/bitmap-index.mjs';
import { TapLookupIndex } from '../prod/tap-index.mjs';
import { temp, fixtureHistory } from './helpers.mjs';
import { heightKey } from '../src/util.mjs';

const readTables = store => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'publicRead%' ORDER BY name").all()
  .map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort()]));

test('legacy public read refresh uses the writer and matches the offline projections across updates', async t => {
  const store = await Store.open(await temp('writer-public-')), reference = await Store.openForMaintenance(await temp('offline-public-'));
  t.after(async () => { await store.close(); await reference.close(); });
  const source = fixtureHistory(20), histories = [store, reference].map(s => new History(s));
  for (const history of histories) await history.appendMany(0, Array.from({ length: source.length }, (_, i) => source.raw(i)));
  const views = [store, reference].map((s, i) => new PublicViews({ store: s, history: histories[i], reads: {
    head: async () => ({ tip: { height: 20 }, counted: 20 }),
  } }));
  const event = n => ({ space: 'publicEvents', id: heightKey(n), value: { sequence: n, type: 'block', at: n, data: { height: n } } });
  for (const s of [store, reference]) await s.transact([event(1), event(2)]);
  for (const view of views) await view.readIndex.sync();
  assert.equal(views[0].readIndex.ready, true); assert.deepEqual(readTables(store), readTables(reference));
  for (const s of [store, reference]) await s.transact([event(3), { space: 'publicEvents', id: heightKey(1) }]);
  for (const view of views) await view.readIndex.sync();
  assert.deepEqual(readTables(store), readTables(reference));
  assert.equal(store.db.prepare('PRAGMA query_only').get().query_only, 1);
});

test('bitmap inventory acknowledges link invalidations through the writer without losing a racing update', async t => {
  const directory = await temp('writer-bitmap-'), store = await Store.open(join(directory, 'store'));
  const indexer = { bitcoin: { blockHash: async () => 'aa' }, stamp: async () => ({ height: 10, hash: 'aa' }), at: async (_at, fn) => fn(),
    tap: async path => {
      if (path.includes('ListLength')) return 1;
      if (path.startsWith('getBitmapWalletHistoricList/')) return ['one'];
      if (path.startsWith('getBitmapByInscription/')) return { ins: 'one', bm: 2, ownr: 'wallet' };
      throw Error(path);
    } };
  const lookups = new TapLookupIndex({ filename: join(directory, 'lookups.sqlite'), indexer });
  t.after(async () => { lookups.close(); await store.close(); });
  const inventory = new BitmapIndex({ lookups, store });
  await inventory.watch('wallet'); await inventory.tick();
  const id = heightKey(2);
  await store.put('links', id, { block: 2 });
  await store.put('links', id, { block: 2, owner: 'updated' });
  await store.acknowledgeBitmapLinks([{ id, linked: false }]);
  assert.equal(store.db.prepare('SELECT id FROM bitmap_link_changes').get().id, id);
  await inventory.tick();
  assert.equal(lookups.db.prepare('SELECT linked FROM bitmap_inventory').get().linked, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM bitmap_link_changes').get().n, 0);
  await store.put('links', id); await inventory.tick();
  assert.equal(lookups.db.prepare('SELECT linked FROM bitmap_inventory').get().linked, 0);
});

test('a busy WAL checkpoint still truncates the applied journal without losing committed rows', async t => {
  const directory = await temp('writer-checkpoint-'); let store = await Store.open(directory);
  t.after(() => store.close());
  await store.put('private', 'before', true);
  const reader = new DatabaseSync(join(directory, 'index.sqlite'), { readOnly: true });
  try {
    reader.exec('BEGIN'); reader.prepare('SELECT count(*) FROM records').get();
    await store.put('private', 'after', true);
    const result = await store.checkpoint();
    assert.equal(result.busy, 1); assert.equal(await store.bytes(), 0);
    assert.equal(store.failed, undefined);
    await store.put('private', 'later', true);
    reader.exec('ROLLBACK');
    assert.equal((await store.checkpoint()).busy, 0); assert.equal(await store.bytes(), 0);
  } finally { reader.close(); }
  await store.close(); store = await Store.open(directory);
  for (const id of ['before', 'after', 'later']) assert.equal(store.get('private', id), true);
});

test('an offline projection rebuild error does not poison accepted writes', async t => {
  const store = await Store.open(await temp('writer-maintenance-'));
  t.after(() => store.close());
  await assert.rejects(store.requestWriter('migratePublicProjections', { pageRows: 0 }), /public_import_settings/);
  assert.equal(store.failed, undefined);
  await store.put('private', 'after', true); assert.equal(store.get('private', 'after'), true);
});


test('failed legacy refresh rolls back its projection while the writer remains usable for a retry', async t => {
  const directory = await temp('writer-read-retry-'), seed = await Store.openForMaintenance(directory);
  seed.db.exec("CREATE TRIGGER reject_bad_read_row BEFORE INSERT ON publicReadRows WHEN new.id='bad' BEGIN SELECT RAISE(ABORT,'injected_read_failure'); END");
  await seed.close();
  const store = await Store.open(directory); t.after(() => store.close());
  const views = new PublicViews({ store, history: new History(store), reads: { head: async () => ({ tip: { height: -1 }, counted: -1 }) } });
  await store.put('publicEvents', 'good', { sequence: 1, type: 'block', at: 1, data: {} });
  await views.readIndex.sync();
  const before = store.db.prepare('SELECT * FROM publicReadRows ORDER BY kind,id').all();
  await store.put('publicEvents', 'bad', { sequence: 2, type: 'block', at: 2, data: {} });
  await assert.rejects(views.readIndex.sync(), /injected_read_failure/);
  assert.equal(store.failed, undefined); assert.equal(views.readIndex.ready, true);
  assert.deepEqual(store.db.prepare('SELECT * FROM publicReadRows ORDER BY kind,id').all(), before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM publicReadChanges').get().n, 1);
  await store.put('publicEvents', 'bad'); await views.readIndex.sync();
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM publicReadChanges').get().n, 0);
  assert.equal(views.readIndex.events.rows.size, 1);
});
