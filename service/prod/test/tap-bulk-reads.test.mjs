import test from 'node:test';
import assert from 'node:assert/strict';
import { TapReader } from '../tap.mjs';

function fixture(settings) {
  let height = '974137', hash = 'ab'.repeat(32), value = null, fail = false;
  const calls = [];
  const source = { request: async path => {
    calls.push(path);
    if (path === '/r/tap/getCurrentBlock') return { result: height };
    if (path.startsWith('/r/blockhash/')) return hash;
    if (fail) throw Error('offline');
    return { result: structuredClone(value) };
  } };
  const reader = new TapReader({ sources: [source], agreement: 1, bitcoin: { blockHash: async () => hash }, settings });
  return { reader, calls, get at() { return { tip: height, tipHash: hash }; },
    set: v => { value = v; }, fail: v => { fail = v; },
    advance: () => { height = String(BigInt(height) + 1n); hash = 'cd'.repeat(32); },
    reorg: () => { hash = 'ef'.repeat(32); } };
}

test('bulk TAP reads share nested fences and concurrent source responses, without sharing caller mutations', async () => {
  const f = fixture(); f.set({ ins: 'fixture' });
  await f.reader.bulkAt(f.at, async () => {
    const rows = await Promise.all(Array.from({ length: 64 }, () => f.reader.at(f.at, () => f.reader.tap('getDeployment/dmt-example'))));
    rows[0].ins = 'changed'; assert.equal(rows[63].ins, 'fixture');
    assert.equal((await f.reader.tap('getDeployment/dmt-example')).ins, 'fixture');
    await assert.rejects(f.reader.at({ ...f.at, tipHash: '00'.repeat(32) }, () => true), /tap_historical_snapshot_unavailable/);
  });
  assert.equal(f.calls.filter(p => p.endsWith('getCurrentBlock')).length, 2);
  assert.equal(f.calls.filter(p => p.includes('getDeployment/')).length, 1);
  await f.reader.tap('getDeployment/dmt-example');
  assert.equal(f.calls.filter(p => p.includes('getDeployment/')).length, 2, 'ordinary reads do not use the bulk cache');
});

test('verified TAP results survive a Trac failure, but absence and ownership refresh on each new tip or branch', async () => {
  const f = fixture(), path = 'getDmtMintHolderByBlock/dmt-example/1';
  await assert.rejects(f.reader.bulkAt(f.at, async () => {
    assert.equal(await f.reader.tap(path), null); throw Error('financial_snapshot_changed');
  }), /financial_snapshot_changed/);
  assert.equal(await f.reader.bulkAt(f.at, () => f.reader.tap(path)), null);
  assert.equal(f.calls.filter(p => p.endsWith(path)).length, 1);
  f.advance(); f.set({ ins: 'minted' });
  assert.deepEqual(await f.reader.bulkAt(f.at, () => f.reader.tap(path)), { ins: 'minted' });
  f.reorg(); f.set(null);
  assert.equal(await f.reader.bulkAt(f.at, () => f.reader.tap(path)), null);
  assert.equal(f.calls.filter(p => p.endsWith(path)).length, 3);
});

test('a failed TAP fence publishes nothing and source errors are never retained', async () => {
  const f = fixture();
  await assert.rejects(f.reader.bulkAt(f.at, async () => {
    await f.reader.tap('getBitmap/1'); f.reorg();
  }), /tap_snapshot_changed/);
  assert.equal(f.reader.bulkCache.rows.size, 0);
  f.fail(true);
  await assert.rejects(f.reader.bulkAt(f.at, () => f.reader.tap('getBitmap/1')), /tap_quorum_unavailable/);
  f.fail(false); f.set({ owner: 'new' });
  assert.deepEqual(await f.reader.bulkAt(f.at, () => f.reader.tap('getBitmap/1')), { owner: 'new' });
  assert.equal(f.calls.filter(p => p.endsWith('getBitmap/1')).length, 3);
});

test('bulk TAP cache obeys configurable entry and byte bounds and expires detached scopes', async () => {
  const f = fixture({ bulkReadCacheEntries: 2, bulkReadCacheBytes: 100 });
  let escaped;
  const later = new Promise(resolve => { escaped = resolve; });
  let detached;
  await f.reader.bulkAt(f.at, async () => {
    for (const id of [1, 2, 3]) await f.reader.tap('getBitmap/' + id);
    const scope = f.reader.bulkScope.getStore();
    assert.equal(scope.pending.size, 0);
    assert.equal(scope.staged.rows.size, 2); assert.ok(scope.staged.bytes <= 100);
    detached = later.then(() => f.reader.tap('getBitmap/3'));
  });
  assert.equal(f.reader.bulkCache.rows.size, 2);
  escaped(); await detached;
  assert.equal(f.calls.filter(p => p.endsWith('getBitmap/3')).length, 2);
  f.set('x'.repeat(200));
  await f.reader.bulkAt(f.at, () => f.reader.tap('getBitmap/large'));
  assert.ok(f.reader.bulkCache.bytes <= 100); assert.equal(f.reader.bulkCache.rows.size, 2);
});
