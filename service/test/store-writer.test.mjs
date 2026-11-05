import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { temp } from './helpers.mjs';
import { rules } from '../src/rules.mjs';
import { writerSnapshot } from './store-writer-fixture.mjs';

async function fixture(t, options) {
  const directory = await temp('writer-'), f = { directory, store: await Store.open(directory, options) };
  t.after(() => f.store.close()); return f;
}

test('the main connection is query-only and acknowledgements publish committed state and reads', async t => {
  const { store } = await fixture(t);
  assert.equal(store.db.prepare('PRAGMA query_only').get().query_only, 1);
  assert.throws(() => store.putStmt.run('private', 'bypass', 'true'), /readonly/);
  store.db.exec('PRAGMA query_only=OFF');
  try { assert.throws(() => store.putStmt.run('private', 'bypass', 'true'), /readonly/); }
  finally { store.db.exec('PRAGMA query_only=ON'); }
  await store.transact([{ space: 'meta', id: 'ruleState', value: { batchVersion: 2 } },
    { space: 'types', id: 'one', value: { name: 'one' } },
    { space: 'catalogPatterns', id: 'p2:0', value: { number: '0', name: 'dmwstone', knownMatchCount: '1' } }]);
  assert.equal(store.publicProjectionActive, true); assert.equal(store.decimalSequence, true);
  assert.equal(store.sequence, '1'); assert.equal(store.evidenceReady, true);
  assert.equal(store.get('types', 'one').name, 'one'); assert.equal(store.countUint('types'), '1');
  assert.ok(store.get('catalogPatterns', 'p2:0').symbol);
  assert.equal(store.sequence, store.db.prepare('SELECT sequence FROM journal_progress WHERE id=1').get().sequence);
});

test('apply failure rolls back and rejects active and queued jobs without truncating recovery data', async t => {
  const { store, directory } = await fixture(t, { groupSize: 1, checkpointBytes: 100000000 });
  await store.put('meta', 'ruleState', { batchVersion: 2 });
  const before = store.sequence, root = store.evidenceIndex.root();
  const jobs = [store.transact([{ space: 'types', id: 'lost', value: { name: 'lost' } },
    { space: 'links', id: 'bad', value: { block: 'invalid' } }]), store.put('private', 'queued', true)];
  const settled = await Promise.allSettled(jobs);
  assert.ok(settled.every(result => result.status === 'rejected' && result.reason.message === 'integer_v2'));
  assert.equal(store.failed.message, 'integer_v2'); assert.equal(store.sequence, before);
  assert.equal(store.evidenceIndex.root(), root); assert.equal(store.get('types', 'lost'), null);
  assert.equal(store.get('private', 'queued'), null);
  await assert.rejects(store.put('private', 'later', true), /store_unavailable/);
  const log = await readFile(join(directory, 'pending.log'));
  await store.close({ checkpoint: true });
  assert.deepEqual(await readFile(join(directory, 'pending.log')), log);
});

test('unexpected writer exit fails closed even when no request is pending', async t => {
  const { store } = await fixture(t);
  await store.writer.terminate(); await store.writerExit;
  assert.equal(store.failed.message, 'store_writer_exit');
  await assert.rejects(store.put('private', 'later', true), /store_unavailable/);
});

test('a writer killed during apply recovers the durable transaction exactly once', async t => {
  const options = { checkpointBytes: 100000000, journalFrameBytes: 4096, journalFragmentBytes: 512 };
  const f = await fixture(t, options);
  const operations = Array.from({ length: 12000 }, (_, i) => ({ space: 'types', id: String(i), value: { i } }));
  const apply = f.store.apply.bind(f.store);
  const entered = Promise.withResolvers();
  f.store.apply = rows => {
    const result = apply(rows);
    if (rows.some(row => row.commit)) entered.resolve();
    return result;
  };
  const write = f.store.transact(operations), rejected = assert.rejects(write, /store_writer_exit/);
  await entered.promise; await delay(20);
  assert.equal(f.store.count('types'), 0, 'uncommitted records stay invisible');
  await f.store.writer.terminate(); await rejected; await f.store.close({ checkpoint: true });
  f.store = await Store.open(f.directory);
  assert.equal(f.store.count('types'), operations.length);
  assert.deepEqual(f.store.get('types', '11999'), { i: 11999 });
  const reference = await Store.openForMaintenance(await temp('writer-recovery-reference-'), options);
  t.after(() => reference.close());
  const epoch = f.store.db.prepare('SELECT epoch,hash FROM takenControl').get();
  reference.db.prepare('UPDATE takenControl SET epoch=?,hash=?').run(epoch.epoch, epoch.hash);
  await reference.transact(operations);
  assert.deepEqual(writerSnapshot(f.store), writerSnapshot(reference), 'replay matches an uninterrupted commit in every table and proof');
  const root = f.store.evidenceIndex.root(), sequence = f.store.sequence;
  await f.store.close(); f.store = await Store.open(f.directory);
  assert.equal(f.store.evidenceIndex.root(), root); assert.equal(f.store.sequence, sequence);
});

test('disk-backed iterable writes retain admission identity, deletion and restart semantics', async t => {
  const f = await fixture(t, { journalFrameBytes: 4096, journalFragmentBytes: 512 });
  const value = { text: 'é漢😀', n: 1 };
  function* operations() {
    for (let i = 0; i < 3000; i++) yield { space: 'offline', id: String(i), value };
    yield { space: 'offline', id: '0' };
  }
  const write = f.store.transactIterable(operations()); value.n = 9; await write;
  assert.equal(f.store.count('offline'), 2999); assert.equal(f.store.get('offline', '1').n, 1);
  assert.ok(!(await readdir(f.directory)).some(name => name.startsWith('transaction-')));
  await f.store.close({ checkpoint: true }); f.store = await Store.open(f.directory);
  assert.equal(f.store.count('offline'), 2999); assert.equal(f.store.get('offline', '0'), null);
});

test('close drains accepted writes and concurrent checkpoint calls serialize journal replacement', async t => {
  const f = await fixture(t, { groupSize: 2, checkpointBytes: 1 });
  const writes = Array.from({ length: 8 }, (_, i) => f.store.put('private', String(i), i));
  await Promise.all([...writes, f.store.compact(), f.store.checkpoint(), f.store.close({ checkpoint: true })]);
  assert.equal(f.store.failed, undefined);
  await assert.rejects(f.store.put('private', 'closed', true), /store_unavailable/);
  f.store = await Store.open(f.directory); assert.equal(f.store.count('private'), 8);
  assert.equal(await f.store.bytes(), 0);
});

test('evidence rebuild runs on the writer and publishes readiness before returning', async t => {
  const directory = await temp('writer-rebuild-');
  const offline = await Store.openForMaintenance(directory);
  offline.putStmt.run('types', 'old', JSON.stringify({ old: true }));
  offline.db.exec('UPDATE evidence_progress SET ready=0'); await offline.close();
  const store = await Store.open(directory); t.after(() => store.close());
  assert.equal(store.evidenceReady, false);
  await store.rebuildEvidenceIndex(); assert.equal(store.evidenceReady, true);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM evidence_values').get().n, 1);
  assert.equal(store.sequence, 0);
});


test('worker settings retain the validated opening snapshot when the caller mutates its options', async t => {
  const options = { takenChangeRows: 2 }, directory = await temp('writer-settings-');
  const opening = Store.open(directory, options); options.takenChangeRows = 1;
  const store = await opening; t.after(() => store.close());
  assert.equal(store.takenChangeRows, 2);
  await store.transact([1, 2, 3].map(n => ({ space: 'claimed2/p2:0', id: rules.uintKeyV2(String(n)), value: { height: String(n), found: true } })));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM takenChanges').get().n, 2);
});


test('a failed reader handoff joins the writer and releases the process lock before reopening', async t => {
  const directory = await temp('writer-open-failure-'), prepare = Store.prototype.prepareConnection;
  const injected = t.mock.method(Store.prototype, 'prepareConnection', function (...args) {
    const result = prepare.apply(this, args);
    if (this.writer) throw Error('injected_reader_handoff');
    return result;
  });
  await assert.rejects(Store.open(directory), /injected_reader_handoff/);
  await assert.rejects(readFile(join(directory, 'writer.lock')), { code: 'ENOENT' });
  injected.mock.restore();
  const store = await Store.open(directory); t.after(() => store.close());
  await store.put('private', 'reopened', true); assert.equal(store.get('private', 'reopened'), true);
});
