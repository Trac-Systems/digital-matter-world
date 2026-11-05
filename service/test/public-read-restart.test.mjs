import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { Store } from '../src/store.mjs';
import { History } from '../src/history.mjs';
import { Files } from '../src/files.mjs';
import { PublicViews } from '../src/public-views.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { serve } from '../src/http.mjs';
import { rules } from '../src/rules.mjs';
import { heightKey, hash } from '../src/util.mjs';
import { temp, fixtureHistory, patterns } from './helpers.mjs';
import { createFeePolicy } from '../src/fees.mjs';
import { patternPage } from '../src/feeds.mjs';
import { chain } from '../../contract/tests/helpers/chain.mjs';

const owner = 'a'.repeat(64);
function fixtureReads(history) {
  return { head: async () => ({ tip: { height: history.length - 1 }, counted: history.length - 1 }),
    counted: async () => history.length - 1, registry: async () => ({ feePolicy: createFeePolicy('100'), assets: { p0: {} } }),
    assetSupply: async () => ({ p0: '32' }), publicTreasury: async () => ({ treasury: {}, outstandingSupply: {} }),
    batchLast: async () => ({ n: 1360, to: history.length - 1 }), tip: async () => ({ tip: history.length - 1 }), settings: async () => ({}),
    link: async () => null, balance: async () => '32', bitmap: async () => ({ agent: owner }) };
}

test('million-header legacy migration and restart read only changed/sparse headers, and HTTP stays available during sync', async t => {
  const directory = await temp('read-restart-million-'), length = 1_000_000, raw = fixtureHistory(0).raw(0), header = rules.parseHeader(raw);
  let store, server;
  t.after(async () => { await server?.close(); await store?.close(); await rm(directory, { recursive: true, force: true }); });
  // Model the deployed DB before this schema existed. No projection or change
  // cursor is available, and migration is forbidden to parse all those headers.
  const seed = new DatabaseSync(join(directory, 'index.sqlite'));
  seed.exec('CREATE TABLE records(space TEXT,id TEXT,value TEXT,PRIMARY KEY(space,id)) WITHOUT ROWID');
  seed.prepare(`INSERT INTO records WITH RECURSIVE h(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM h WHERE n+1<?)
    SELECT 'headers',printf('%016d',n),? FROM h`).run(length, JSON.stringify({ raw, hash: header.hash }));
  const put = seed.prepare('INSERT INTO records VALUES(?,?,?)');
  put.run('meta', 'headerHeight', JSON.stringify(length - 1));
  put.run('meta', 'patterns', JSON.stringify(patterns));
  put.run('meta', 'ruleState', JSON.stringify({ rounds: [] }));
  for (let n = 1; n <= 1360; n++) put.run('publicEvents', heightKey(n), JSON.stringify({ id: hash('event/' + n), sequence: n, at: n, type: 'block', data: { height: length - 1361 + n }, provenance: { observation: n } }));
  for (let n = 1; n <= 32; n++) put.run('finds', rules.findId(n, 0), JSON.stringify({ block: n, pattern: 0, asset: 'p0', count: String(n).length, finder: owner, findHeight: length - 10, window: length - 12 }));
  seed.close();
  store = await Store.open(directory);
  let history = new History(store), reads = fixtureReads(history), views = new PublicViews({ store, history, reads }), historyReads = 0;
  const get = history.get.bind(history); history.get = h => { historyReads++; return get(h); };
  let start = performance.now(); await views.readIndex.sync();
  const migrationMs = performance.now() - start;
  assert.equal(historyReads, 0, 'missing legacy timestamps are resolved by the writer');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM publicReadHeaderFields').get().n, 32, 'only find-bearing blocks need missing legacy timestamps');
  assert.equal(views.readIndex.length, length);
  assert.equal(views.readIndex.ready, true);
  const before = await createPublicAPI({ views }).read('/finds?limit=5');
  const originalSupply = reads.assetSupply, originalTreasury = reads.publicTreasury, listFailures = {};
  delete reads.assetSupply; delete reads.publicTreasury;
  for (const [path, message] of [['/patterns', 'this.reads.assetSupply is not a function'], ['/compounds', 'this.reads.assetSupply is not a function'], ['/results', 'this.reads.publicTreasury is not a function']]) {
    const at = performance.now();
    await assert.rejects(createPublicAPI({ views }).read(path), { name: 'TypeError', message });
    listFailures[path] = { message, ms: performance.now() - at };
  }
  reads.assetSupply = originalSupply; reads.publicTreasury = originalTreasury;
  await assert.rejects(createPublicAPI({ views }).read('/patterns/p0/blocks'), { message: 'index_catching_up', status: 503 });
  await store.close(); store = null;
  start = performance.now();
  store = await Store.open(directory); history = new History(store); reads = fixtureReads(history);
  history.get = () => { historyReads++; assert.fail('unchanged restart must not parse history'); };
  historyReads = 0; views = new PublicViews({ store, history, reads });
  await views.readIndex.sync(); const restartMs = performance.now() - start;
  assert.equal(historyReads, 0);
  const api = createPublicAPI({ views });
  assert.deepEqual(await api.read('/finds?limit=5'), before);
  // Durable triggers catch changes made before the next PublicViews exists.
  await store.put('publicEvents', heightKey(1361), { id: hash('new'), sequence: 1361, type: 'block', at: 1, data: {} });
  let release;
  reads.head = () => new Promise(resolve => { release = resolve; });
  const syncing = views.readIndex.sync();
  server = await serve({ files: new Files(join(directory, 'static')), intake: { store }, publicAPI: api });
  const timings = {};
  // status has its own adapter reads; use the consistent committed head while
  // the index's head request is deliberately suspended.
  reads.head = async () => views.readIndex.head;
  for (const path of ['/events?limit=5', '/finds?limit=5', '/patterns', '/compounds', '/results', '/status', '/world?limit=5']) {
    const at = performance.now(), response = await fetch(server.url + path), body = await response.json();
    timings[path] = performance.now() - at;
    assert.equal(response.status, 200, path + JSON.stringify(body));
    assert.ok(timings[path] < 1000, path + ' must not wait for sync');
    if (path.startsWith('/events')) assert.equal(body.total, 1360, 'last committed event snapshot');
  }
  release(views.readIndex.head); await syncing;
  assert.equal((await api.read('/events?limit=1')).total, 1361);
  assert.equal(historyReads, 0);
  assert.ok(restartMs < 5000, 'restart has no million-row hydration');
  await history.appendMany(length, chain(1, { ...header, height: length - 1 }));
  await store.put('finds', rules.findId(length, 0), { block: length, pattern: 0, asset: 'p0', count: 7, finder: owner, findHeight: length });
  reads.head = fixtureReads(history).head;
  await views.readIndex.sync();
  assert.equal(historyReads, 0, 'new headers carry their projection in the durable ingestion write');
  assert.equal((await api.read('/finds?limit=1')).finds[0].block, length);
  t.diagnostic(JSON.stringify({ length, migrationMs, restartMs, migrationHeaderReads: 32, restartHeaderReads: historyReads, beforeListFailures: listFailures, duringSyncMs: timings }));
});

test('persistent projections preserve small-chain outputs, offline changes, reorgs and retry after a failed refresh', async t => {
  const directory = await temp('read-restart-small-'); let store = await Store.openForMaintenance(directory);
  t.after(async () => { await store?.close(); await rm(directory, { recursive: true, force: true }); });
  let history = new History(store); const source = fixtureHistory(24);
  await history.appendMany(0, Array.from({ length: source.length }, (_, h) => source.raw(h)));
  await store.transact([{ space: 'meta', id: 'patterns', value: patterns }, { space: 'finds', id: rules.findId(2, 0), value: { block: 2, pattern: 0, asset: 'p0', count: 1, finder: owner, findHeight: 5 } }]);
  let views = new PublicViews({ store, history, reads: fixtureReads(history) });
  await views.readIndex.sync();
  const paths = ['/world?limit=5', '/patterns/p0/blocks?limit=5', '/finds', '/agents', '/blocks/2'];
  const api = createPublicAPI({ views }), rawViews = Object.create(views); rawViews.indexed = undefined;
  const oracle = createPublicAPI({ views: rawViews });
  for (const path of paths) assert.deepEqual(await api.read(path), await oracle.read(path), path);
  const expected = await api.read('/finds');
  await store.close(); store = await Store.openForMaintenance(directory); history = new History(store);
  let calls = 0;
  // Write before reconstructing the read index, then prove the persisted queue
  // catches both an upsert and a deletion across another close/open.
  await store.put('minted', 'p0/2', 'inscription');
  await store.close(); store = await Store.openForMaintenance(directory); history = new History(store);
  const get = history.get.bind(history); history.get = h => { calls++; return get(h); };
  const reads = fixtureReads(history);
  views = new PublicViews({ store, history, reads });
  const nextAPI = createPublicAPI({ views });
  await views.readIndex.sync();
  assert.equal(calls, 0);
  assert.equal((await nextAPI.read('/finds')).finds[0].minted, true);
  await store.put('finds', rules.findId(2, 0), undefined);
  const original = views.readIndex.plot.bind(views.readIndex);
  views.readIndex.plot = () => { throw Error('injected projection failure'); };
  await assert.rejects(views.readIndex.sync(), /injected projection failure/);
  assert.equal(views.readIndex.ready, true);
  assert.equal(views.readIndex.finds.rows.size, expected.total, 'rollback restores the consistent snapshot');
  assert.ok(store.db.prepare('SELECT count(*) AS n FROM publicReadChanges').get().n > 0, 'failed work remains queued');
  views.readIndex.plot = original; await views.readIndex.sync();
  assert.equal((await nextAPI.read('/finds')).total, 0);
  const oldPage = await nextAPI.read('/world?from=20&to=24');
  await history.appendMany(20, chain(5, source.get(19), 601, 7));
  let release;
  reads.head = () => new Promise(resolve => { release = resolve; });
  const syncing = views.readIndex.sync();
  assert.deepEqual(await nextAPI.read('/world?from=20&to=24'), oldPage, 'a reorg retains committed plot hashes during sync');
  reads.head = fixtureReads(history).head; release(await reads.head()); await syncing;
  const afterReorg = await nextAPI.read('/world?from=20&to=24');
  assert.notEqual(afterReorg.plots[0].hash, oldPage.plots[0].hash);
  assert.equal(calls, 0, 'rights and changed patterns use persisted fields');
  const revised = [{ ...patterns[0], pat: '2' }, { ...patterns[0], number: 1, pat: '1' }];
  await store.put('meta', 'patterns', revised); await views.readIndex.sync();
  assert.equal(calls, 0, 'pattern changes do not reread history');
  const rawNext = Object.create(views); rawNext.indexed = undefined;
  for (const path of ['/patterns/p0/blocks', '/patterns/p1/blocks']) assert.deepEqual(await nextAPI.read(path), await createPublicAPI({ views: rawNext }).read(path));
  await store.put('meta', 'patterns', patterns); await views.readIndex.sync();
  await history.setTip(10); await views.readIndex.sync();
  assert.equal((await nextAPI.read('/world')).total, 11);
  assert.equal((await nextAPI.read('/patterns/p0/blocks')).total, 11);
});

test('legacy pattern feed migration imports derived rows without historical header reads', async t => {
  const directory = await temp('read-feed-import-'), store = await Store.openForMaintenance(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const history = fixtureHistory(24), files = new Files(join(directory, 'static'));
  await store.put('meta', 'patterns', patterns);
  await patternPage({ store, files, history, pattern: patterns[0], page: 0 });
  await store.put('minted', 'p0/3', 'inscription');
  const views = new PublicViews({ store, history, reads: fixtureReads(history) });
  store.db.prepare('INSERT INTO publicReadHeaderFields VALUES(?,?)').run(3, JSON.stringify(history.get(3)));
  history.get = () => assert.fail('feed import cannot reread headers');
  await views.readIndex.sync();
  const api = createPublicAPI({ views });
  assert.equal((await api.read('/patterns/p0/blocks')).total, history.length);
  assert.equal((await api.read('/patterns/p0/blocks?minted=true')).total, 1);
  await store.put('publicEvents', heightKey(1), { id: 'one', sequence: 1, type: 'block', data: {} });
  await views.readIndex.sync();
  assert.equal((await api.read('/events')).total, 1, 'a completed partial feed page does not poison subsequent refreshes');
  // Import a second legacy asset whose older page has no matches. A cached
  // changed nonce must create a row even though it was absent from that page.
  const noncePattern = { ...patterns[0], number: 1, fld: 10, pat: '^9$' };
  const nonceHistory = { length: 25, get: h => ({ height: h, nonce: 0 }) };
  await patternPage({ store, files, history: nonceHistory, pattern: noncePattern, page: 0 });
  await store.put('headers', heightKey(3), { hash: history.hashAt(3), fields: { height: 3, nonce: 9, bits: 1, time: 1 } });
  await store.put('meta', 'patterns', [...patterns, noncePattern]);
  await views.readIndex.sync();
  const introduced = await api.read('/patterns/p1/blocks');
  assert.equal(introduced.total, 1); assert.equal(introduced.rows[0].block, 3);

});

test('first unavailable snapshot returns 503 index_catching_up while a head is pending', async t => {
  const store = await Store.open(await temp('read-cold-')); t.after(() => store.close());
  let release;
  const history = fixtureHistory(0), reads = fixtureReads(history);
  reads.head = () => new Promise(resolve => { release = resolve; });
  const views = new PublicViews({ store, history, reads });
  await assert.rejects(createPublicAPI({ views }).read('/events'), { message: 'index_catching_up', status: 503 });
  release({ tip: { height: 0 }, counted: 0 }); await views.readIndex.syncing;
});

test('a reused pattern number cannot import a previous definition after a restart', async t => {
  const directory = await temp('read-feed-definition-'); let store = await Store.open(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const history = fixtureHistory(24), files = new Files(join(directory, 'static'));
  await store.put('meta', 'patterns', patterns);
  await patternPage({ store, files, history, pattern: patterns[0], page: 0 });
  let views = new PublicViews({ store, history, reads: fixtureReads(history) });
  await views.readIndex.sync();
  const replacement = { ...patterns[0], pat: '2' };
  await store.put('meta', 'patterns', [replacement]);
  const get = history.get; history.get = () => assert.fail('replacement cannot scan legacy history');
  await views.readIndex.sync();
  await store.close(); store = await Store.open(directory);
  views = new PublicViews({ store, history, reads: fixtureReads(history) });
  await views.readIndex.sync();
  await assert.rejects(createPublicAPI({ views }).read('/patterns/p0/blocks'), { message: 'index_catching_up' });
  history.get = get;
  await patternPage({ store, files, history, pattern: replacement, page: 0 });
  history.get = () => assert.fail('replacement imports derived pages only');
  await views.readIndex.sync();
  const page = await createPublicAPI({ views }).read('/patterns/p0/blocks');
  assert.equal(page.total, 7); assert.deepEqual(page.rows.map(r => r.block), [24, 23, 22, 21, 20, 12, 2]);
});
