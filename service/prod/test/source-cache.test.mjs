import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { HttpSource, withBackgroundReads, withClockReads, withPublicReads } from '../http.mjs';
import { ByteCache, sourcePolicy } from '../source-cache.mjs';
import { TapReader } from '../tap.mjs';
import { installNamedReads } from '../named-reads.mjs';
const id = 'ab'.repeat(32) + 'i0', hash = 'cd'.repeat(32);
const finish = async (t, work) => {
  let done = false, result, error; work.then(v => { done = true; result = v; }, e => { done = true; error = e; });
  for (let i = 0; i < 1000 && !done; i++) { await turn(); t.mock.timers.tick(10); }
  assert.ok(done); if (error) throw error; return result;
};

test('byte LRU eviction, disabled caches, independent copies and failed-load retry', async () => {
  const cache = new ByteCache(30); cache.set('one', { x: '1234567890' }); cache.set('two', { x: '1234567890' });
  assert.ok(cache.bytes <= 30); assert.equal(cache.get('one'), undefined);
  const item = cache.get('two'); item.x = 'changed'; assert.equal(cache.get('two').x, '1234567890');
  const off = new ByteCache(0); off.set('one', 1); assert.equal(off.get('one'), undefined);
  let n = 0; await assert.rejects(cache.read('fail', () => { n++; throw Error('unavailable'); }));
  assert.equal(await cache.read('fail', () => { n++; return 'ok'; }), 'ok'); assert.equal(n, 2);
  assert.throws(() => sourcePolicy({ unknown: 1 }), /source_policy/);
  assert.throws(() => sourcePolicy({ maxScopeMs: 0 }), /source_policy/);
});

test('identical HTTP reads coalesce, failed reads retry cleanly, and clock capacity survives filled lower lanes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10000 });
  const seen = [], source = new HttpSource({ url: 'https://source.invalid', requestsPerSecond: 2, maxQueue: 1, publicMaxQueue: 1, backgroundMaxQueue: 1, clockMaxQueue: 1, retries: 0,
    fetchImpl: async url => { const path = new URL(url).pathname; seen.push({ path, at: Date.now() }); return Response.json({ path }); } });
  const publicRead = withPublicReads(() => source.request('/public'));
  const bg = withBackgroundReads(() => source.request('/background'));
  const paid = source.request('/paid'), duplicate = source.request('/paid');
  withBackgroundReads(() => assert.throws(() => source.request('/background-full'), /http_capacity/));
  const clock = withClockReads(() => source.request('/clock'));
  const [a, b] = await finish(t, Promise.all([paid, duplicate, publicRead, bg, clock]));
  assert.notEqual(a, b); assert.deepEqual(a, b);
  assert.deepEqual(seen.map(r => r.path), ['/public', '/clock', '/paid', '/background']);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].at - seen[i - 1].at >= 500);
});

function readerFixture() {
  const state = { height: 5, hash, badRow: false }, calls = [];
  const source = { request: async path => {
    calls.push(path);
    if (path === '/r/tap/getCurrentBlock') return { result: state.height };
    if (path.startsWith('/r/blockhash/')) return state.hash;
    if (path.startsWith('/content/')) return state.hash;
    if (path.startsWith('/r/tap/getPrivilegeAuthList?')) return { result: [{ ins: state.badRow ? '00'.repeat(32) + 'i0' : id }] };
    return { result: { tick: 'named', ins: id } };
  } };
  const reader = new TapReader({ sources: [source], agreement: 1, bitcoin: {}, sharedTransport: true });
  reader.history = async () => ({ hashAt: n => n <= state.height ? state.hash : null });
  const reads = installNamedReads({}, reader);
  return { state, calls, reader, reads };
}

test('nested reads share one checked snapshot; concurrent actions cannot share mutable state or views', async () => {
  const f = readerFixture(), view = { tip: 5, tipHash: hash };
  await f.reader.at(view, async () => {
    await f.reader.at(view, () => f.reader.tap('getDeployment/named'));
    await f.reader.at(undefined, () => f.reader.tap('getDeployment/named'));
    await assert.rejects(f.reader.at({ ...view, tip: 4 }, async () => {}), /tap_historical_snapshot_unavailable/);
  });
  assert.equal(f.calls.length, 5);
  f.calls.length = 0;
  let release, started;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const a = f.reader.at(view, async () => { await f.reader.tap('getDeployment/named'); started(); await gate; });
  await entered;
  await f.reader.at(view, () => f.reader.tap('getDeployment/named')); release(); await a;
  assert.equal(f.calls.filter(path => path.endsWith('getDeployment/named')).length, 2);
});

test('indexed rows are reused only on the same canonical ancestry; changed and failed scopes never publish evidence', async () => {
  const f = readerFixture(), locator = { id, offset: 50001 };
  await f.reader.at(undefined, () => f.reads.privilegeAuthority(id, locator));
  f.calls.length = 0;
  await f.reader.at(undefined, () => f.reads.privilegeAuthority(id, locator));
  assert.equal(f.calls.length, 4, 'only outer snapshot checks on a warm read');
  f.state.hash = 'ef'.repeat(32); f.state.badRow = true;
  await assert.rejects(f.reader.at(undefined, () => f.reads.privilegeAuthority(id, locator)), /source_locator_changed/);
  f.state.badRow = false;
  await assert.rejects(f.reader.at(undefined, async () => { await f.reads.privilegeAuthority(id, locator); f.state.height++; }), /tap_snapshot_changed/);
  assert.notEqual(f.reader.indexed.get('getPrivilegeAuthList?offset=50001&max=1').anchor.hash, f.state.hash);
  await assert.rejects(f.reader.at(undefined, () => f.reads.privilegeAuthority(id)), /source_locator_required/);
  assert.ok(f.calls.filter(p => p.includes('getPrivilegeAuthList')).every(p => p.endsWith('offset=50001&max=1')));
});

test('inscription content cannot survive a witness-changing reorg merely because its txid is unchanged', async () => {
  const f = readerFixture();
  assert.equal(await f.reader.at(undefined, () => f.reader.content(id)), hash);
  f.calls.length = 0;
  assert.equal(await f.reader.at(undefined, () => f.reader.content(id)), hash);
  assert.equal(f.calls.length, 4);
  f.state.hash = 'ef'.repeat(32);
  assert.equal(await f.reader.at(undefined, () => f.reader.content(id)), f.state.hash);
  assert.equal(f.calls.filter(path => path.startsWith('/content/')).length, 1);
});

test('payments and mints use exact named transaction rows, with no account history fallback', async () => {
  const paths = [], reader = { policy: sourcePolicy(),
    tap: async path => { paths.push(path); assert.equal(path, 'getTransferredListLength/' + id.slice(0, 64)); return 501; },
    indexedRow: async path => { paths.push(path); return [{ ins: id }]; } };
  const reads = installNamedReads({}, reader), locators = [{ id, offset: 90001 }, { id, offset: 90005 }];
  assert.deepEqual((await reads.paymentTransfers(id, locators)).map(row => row.index), [90001, 90005]);
  assert.equal((await reads.mintedItem(id, { id, offset: 80001 })).ins, id);
  assert.ok(paths.every(path => path.endsWith('&max=1')));
  await assert.rejects(reads.paymentTransfers(id), /transaction_locators_required/);
  await assert.rejects(reads.paymentTransfers(id, [locators[0], locators[0]]), /payment_locator_duplicate/);
});

test('legacy batches without monetary inputs remain independent of the current TAP snapshot', async () => {
  const { verifyBatchEvidence } = await import('../../../committee/signer/batch-evidence.mjs');
  await verifyBatchEvidence({ reads: { withSnapshot: () => assert.fail('historical batch must not acquire a live source snapshot') },
    context: { counted: 10, last: { n: 1 } }, files: [{ tip: 16, tipHash: hash, ops: [], mintOperations: [] }] });
});

test('explicit registry import resumes above 10,000 authorities without changing generation or approval', async () => {
  const { locateRegistry } = await import('../../scripts/import-source-locators.mjs');
  const registry = { assets: { c1: { id: 'deployment', privilege: id, generation: 7, approval: 'unchanged' } }, operator: { provisioning: { privilege: id } } };
  const tap = async path => {
    const q = new URLSearchParams(path.split('?')[1]), start = Number(q.get('offset')), max = Number(q.get('max'));
    return Array.from({ length: Math.max(0, Math.min(max, 10502 - start)) }, (_, i) => ({ ins: start + i === 10501 ? id : 'other-' + (start + i) }));
  };
  let progress = {}, iterations = 0, result;
  do { result = await locateRegistry(registry, tap, { progress, pagesPerRun: 2 }); progress = result.progress; iterations++; } while (!result.complete);
  assert.ok(iterations > 10); assert.equal(result.registry.assets.c1.sourceLocators.authority.offset, 10501);
  assert.equal(result.registry.assets.c1.generation, 7); assert.equal(result.registry.assets.c1.approval, 'unchanged');
  assert.deepEqual(result.registry.operator.provisioning.sourceLocators.authority, { id, offset: 10501 });
  result.registry.assets.c1.sourceLocators.authority.offset = 5;
  result.registry.operator.provisioning.sourceLocators.authority.offset = 5;
  const repaired = await locateRegistry(result.registry, tap, { pagesPerRun: 32 });
  assert.equal(repaired.registry.assets.c1.sourceLocators.authority.offset, 10501, 'stale imported hints can be repaired');
});
