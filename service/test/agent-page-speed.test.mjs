import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { HttpSource, withPublicReads } from '../prod/http.mjs';
import { TapReader } from '../prod/tap.mjs';
import { BitmapCache, bitmapCachePolicy } from '../prod/bitmap-cache.mjs';
import { walletBitmaps } from '../src/bitmaps.mjs';
import { PublicViews } from '../src/public-views.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { createWeb } from '../src/web.mjs';
import { serve } from '../src/http.mjs';
import { Store } from '../src/store.mjs';
import { fixtureHistory, temp } from './helpers.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';

const owner = '12'.repeat(32), publicOwner = encodeTracAddress(owner);
function pacedFixture(count = 0, options = {}) {
  const calls = [], state = { height: 100, hash: 'ab'.repeat(32), address: 'wallet', transferred: false }, links = new Map();
  const source = new HttpSource({ url: 'https://source.invalid', requestsPerSecond: 2, retries: 0,
    ...options, fetchImpl: async url => {
      const path = new URL(url).pathname; calls.push({ path, at: Date.now() }); let value;
      if (path === '/r/tap/getCurrentBlock') value = { result: state.height };
      else if (path.startsWith('/r/blockhash/')) value = state.hash;
      else if (path.startsWith('/r/tap/getBitmapWalletHistoricListLength/')) value = { result: count };
      else if (path.startsWith('/r/tap/getBitmapWalletHistoricList/')) value = { result: Array.from({ length: count }, (_, i) => 'ins' + i) };
      else if (path.startsWith('/r/tap/getBitmapByInscription/')) {
        const inscription = path.split('/').at(-1), n = Number(inscription.slice(3));
        value = { result: { ownr: state.transferred ? 'elsewhere' : 'wallet', ins: inscription, bm: n } };
      } else value = { ok: true };
      return new Response(JSON.stringify(value));
    } });
  const indexer = new TapReader({ sources: [source], agreement: 1, bitcoin: { blockHash: n => source.request('/r/blockhash/' + n) } });
  const bindings = { current: () => state.address ? { request: { address: state.address } } : null }, store = { get: (_space, key) => links.get(key) };
  const reads = { bindings, tap: path => indexer.tap(path) }, cache = new BitmapCache({ indexer, bindings, store, policy: options.policy });
  const legacy = () => indexer.at(undefined, () => walletBitmaps({ reads, store }, owner,
    (_manifest, address, offset) => indexer.tap('getBitmapWalletHistoricList/' + address + '?offset=' + offset + '&max=500')));
  return { calls, state, source, indexer, bindings, store, reads, cache, legacy, links };
}

// Exercise the real scheduler and TAP reader with virtual wall time. Long
// historical-wallet scans need no upstream access or two-minute test sleep.
async function finish(t, promise, step = 500, maxTicks = 5000) {
  let settled = false, value, error;
  promise.then(v => { value = v; settled = true; }, e => { error = e; settled = true; });
  for (let i = 0; !settled && i < maxTicks; i++) { await turn(); if (!settled) t.mock.timers.tick(step); }
  assert.ok(settled, 'paced operation completed'); if (error) throw error; return value;
}
async function advanceUntil(t, ready) {
  for (let i = 0; !ready() && i < 5000; i++) { await turn(); t.mock.timers.tick(500); }
  assert.ok(ready(), 'background source work completed'); await turn();
}

for (const [name, binding, count, beforeCalls] of [['unbound', false, 0, 6], ['empty', true, 0, 7], ['historic-200', true, 200, 208]]) {
  test(`paced bitmap timing: ${name}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
    const before = pacedFixture(count); if (!binding) before.state.address = null;
    const started = Date.now(); await finish(t, before.legacy()); const legacyMs = Date.now() - started;
    assert.equal(before.calls.length, beforeCalls);
    const after = pacedFixture(count); if (!binding) after.state.address = null;
    const coldAt = Date.now(), result = await finish(t, after.cache.snapshot(owner));
    const coldMs = Date.now() - coldAt, calls = after.calls.length, cachedAt = performance.now();
    const cached = await after.cache.snapshot(owner), cachedMs = performance.now() - cachedAt;
    assert.equal(after.calls.length, calls); assert.ok(cachedMs < 300);
    if (!binding) { assert.equal(calls, 0); assert.equal(coldMs, 0); assert.equal(cached.bitmapContext.state, 'unbound'); }
    else { assert.equal(calls, beforeCalls); assert.equal(cached.bitmapContext.cached, true); assert.deepEqual(cached.bitmapContext.tip, { height: 100, hash: 'ab'.repeat(32) }); }
    assert.equal(result.bitmaps.length, count);
    t.diagnostic(JSON.stringify({ case: name, legacyMs, legacyCalls: before.calls.length, coldMs, coldCalls: calls, cachedMs, cachedCalls: after.calls.length - calls }));
  });
}

test('cached ownership follows height, same-height reorgs, expiry and current links', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const f = pacedFixture(1), first = await finish(t, f.cache.snapshot(owner));
  assert.equal(first.bitmaps.length, 1);
  f.links.set('0'.repeat(16), { block: 0 });
  assert.equal((await f.cache.snapshot(owner)).bitmaps[0].linked, true);
  const count = f.calls.length;
  t.mock.timers.tick(5000);
  const checked = await f.cache.snapshot(owner);
  assert.equal(checked.bitmapContext.cached, true); assert.equal(checked.bitmapContext.tipCheckDue, true);
  assert.equal(checked.bitmapContext.checkedAt, first.bitmapContext.checkedAt, 'old snapshot retains its actual check time');
  await advanceUntil(t, () => f.indexer.observedTip.checkedAt !== checked.bitmapContext.checkedAt);
  assert.equal(f.calls.length - count, 3, 'background revalidation of an unchanged tip only costs a stamp');
  f.state.height++; f.state.hash = 'bc'.repeat(32); f.state.transferred = true;
  await finish(t, f.indexer.stamp());
  const moved = await finish(t, f.cache.snapshot(owner));
  assert.equal(moved.bitmapContext.tip.height, 101); assert.deepEqual(moved.bitmaps, []);
  f.state.hash = 'cd'.repeat(32); f.state.transferred = false;
  await finish(t, f.indexer.stamp());
  const reorg = await finish(t, f.cache.snapshot(owner));
  assert.equal(reorg.bitmapContext.cached, false); assert.equal(reorg.bitmapContext.tip.hash, f.state.hash); assert.equal(reorg.bitmaps.length, 1);
});

test('snapshot cache shares in-flight work, rejects a changing tip, and recovers after failure', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const f = pacedFixture(1), first = f.cache.snapshot(owner), second = f.cache.snapshot(owner);
  assert.equal(first, second);
  await advanceUntil(t, () => f.calls.length >= 5);
  f.state.hash = 'ef'.repeat(32);
  await assert.rejects(finish(t, first), /tap_snapshot_changed/);
  const next = await finish(t, f.cache.snapshot(owner)); assert.equal(next.bitmapContext.tip.hash, f.state.hash);
  f.state.address = null;
  const count = f.calls.length; assert.equal((await f.cache.snapshot(owner)).bitmapContext.state, 'unbound'); assert.equal(f.calls.length, count);
});

test('snapshot memory, scan count, lifetime and concurrent wallet limits are operator settings', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  for (const policy of [{ maxRows: 0 }, { ttlMs: -1 }, { tipMaxAgeMs: 60001 }, { maxEntries: 1.5 }, { unknown: 1 }]) assert.throws(() => bitmapCachePolicy(policy), /bitmap_cache_policy/);
  const f = pacedFixture(1, { policy: { maxEntries: 1, maxRows: 1, ttlMs: 10000, maxConcurrentLoads: 1 } });
  const first = f.cache.snapshot(owner); f.state.address = 'other';
  assert.throws(() => f.cache.snapshot('other'), /bitmap_cache_busy/);
  await finish(t, first); await finish(t, f.cache.snapshot('other'));
  f.state.address = 'wallet';
  assert.equal((await finish(t, f.cache.snapshot(owner))).bitmapContext.cached, false, 'LRU address was evicted');
  t.mock.timers.tick(10000);
  assert.equal((await finish(t, f.cache.snapshot(owner))).bitmapContext.cached, false, 'snapshot expired');
  const large = pacedFixture(2, { policy: { maxRows: 1 } });
  await finish(t, large.cache.snapshot(owner));
  assert.equal((await finish(t, large.cache.snapshot(owner))).bitmapContext.cached, false, 'oversize snapshots are not retained');
  const limited = pacedFixture(2, { policy: { maxInscriptions: 1 } });
  await assert.rejects(finish(t, limited.cache.snapshot(owner)), /bitmap_count/);
});

test('unindexed profile loads all other lists concurrently and never starts bitmaps', async () => {
  const views = Object.create(PublicViews.prototype), started = [];
  views.agents = () => [];
  views.agentList = async (_owner, key) => { assert.notEqual(key, 'bitmaps'); started.push(key); await delay(80); return [key]; };
  const at = performance.now(), profile = await views.profile(owner), elapsedMs = performance.now() - at;
  assert.equal(started.length, 5); assert.ok(elapsedMs < 300, `${elapsedMs} ms`);
  assert.equal(profile.bitmaps, null); assert.equal(profile.bitmapStatus.route, '/agents/' + owner + '/bitmaps');
});

test('HTML and indexed profile JSON render while a cold 200-inscription wallet is blocked', async t => {
  const store = await Store.open(await temp('agent-speed-')); t.after(() => store.close());
  const f = pacedFixture(200), history = fixtureHistory(0);
  // Hold the first actual paced source response; the profile must not depend on it.
  const reads = { head: async () => ({ counted: 0, tip: { height: 0, hash: 'ab'.repeat(32) } }),
    balance: async () => '0', registry: async () => ({ assets: {} }), bitmapSnapshot: key => f.cache.snapshot(key), bitmaps: async key => (await f.cache.snapshot(key)).bitmaps };
  const views = new PublicViews({ store, history, reads }), api = createPublicAPI({ views });
  await views.readIndex.available(); views.refreshOnRead = false;
  const server = await serve({ intake: { store }, files: { serve: async () => false }, publicAPI: api, web: createWeb() }); t.after(() => server.close());
  // Use a controlled rejection to stop only our throwaway scan after measuring.
  let rejectScan;
  f.source.fetchImpl = () => new Promise((resolve, reject) => { rejectScan = reject; });
  const scan = f.cache.snapshot(owner); const rejected = assert.rejects(scan, /tap_quorum_unavailable/);
  await turn();
  for (const accept of ['text/html', 'application/json']) {
    const at = performance.now(), response = await fetch(server.url + '/agents/' + publicOwner + '?limit=1', { headers: { accept } });
    assert.equal(response.status, 200); const value = await response.text(), elapsedMs = performance.now() - at;
    assert.ok(elapsedMs < 300, `${accept}: ${elapsedMs} ms`);
    if (accept === 'text/html') assert.match(value, /Digital Matter World/);
    else { const profile = JSON.parse(value); assert.equal(profile.bitmaps, null); assert.equal(profile.bitmapStatus.route, '/agents/' + publicOwner + '/bitmaps'); assert.ok(Array.isArray(profile.history)); }
    t.diagnostic(JSON.stringify({ accept, elapsedMs }));
  }
  rejectScan(Error('fixture_stop')); await rejected;
});

test('public API preserves ownership tip context, filters and pagination on a cache hit', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const f = pacedFixture(3); await finish(t, f.cache.snapshot(owner));
  const api = createPublicAPI({ views: { reads: { bitmapSnapshot: key => f.cache.snapshot(key) } } });
  const before = f.calls.length, at = performance.now();
  const value = await api.read('/agents/' + publicOwner + '/bitmaps?limit=1&sort=height&order=desc');
  assert.ok(performance.now() - at < 300); assert.equal(f.calls.length, before);
  assert.equal(value.total, 3); assert.equal(value.bitmaps[0].height, 2); assert.ok(value.next);
  assert.deepEqual(value.bitmapContext.tip, { height: 100, hash: f.state.hash });
  const next = await api.read('/agents/' + publicOwner + '/bitmaps?limit=1&sort=height&order=desc&cursor=' + encodeURIComponent(value.next));
  assert.equal(next.bitmaps[0].height, 1);
  t.mock.timers.tick(5000);
  const dueAt = performance.now(), due = await api.read('/agents/' + publicOwner + '/bitmaps?limit=1');
  assert.ok(performance.now() - dueAt < 300); assert.equal(due.bitmapContext.tipCheckDue, true);
  assert.deepEqual(due.bitmapContext.tip, value.bitmapContext.tip);
  await advanceUntil(t, () => f.indexer.observedTip.checkedAt !== due.bitmapContext.checkedAt);
});

test('background revalidation labels the previous tip and refreshes transferred ownership at the new tip', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const f = pacedFixture(1), first = await finish(t, f.cache.snapshot(owner));
  t.mock.timers.tick(5000); f.state.height++; f.state.hash = 'cd'.repeat(32); f.state.transferred = true;
  const previous = await f.cache.snapshot(owner);
  assert.equal(previous.bitmaps.length, 1); assert.deepEqual(previous.bitmapContext.tip, first.bitmapContext.tip);
  assert.equal(previous.bitmapContext.tipCheckDue, true); assert.equal(previous.bitmapContext.refreshing, true);
  await advanceUntil(t, () => f.indexer.observedTip.hash === f.state.hash);
  const refreshed = await finish(t, f.cache.snapshot(owner));
  assert.deepEqual(refreshed.bitmaps, []); assert.equal(refreshed.bitmapContext.tip.height, 101);
  const checkedAt = refreshed.bitmapContext.checkedAt;
  t.mock.timers.tick(5000);
  f.indexer.stamp = async () => { throw Error('fixture_source_unavailable'); };
  const unavailable = await f.cache.snapshot(owner); await turn();
  assert.equal(unavailable.bitmapContext.checkedAt, checkedAt); assert.equal(unavailable.bitmapContext.tipCheckDue, true);
  assert.equal((await f.cache.snapshot(owner)).bitmapContext.checkedAt, checkedAt, 'a failed check never presents old data as newly verified');
  await turn();
});

test('cached bitmap HTTP route stays under 300 ms with the real 2 req/s source clock', async t => {
  const f = pacedFixture(0), api = createPublicAPI({ views: { reads: { bitmapSnapshot: key => f.cache.snapshot(key) } } });
  const server = await serve({ files: { serve: async () => false }, publicAPI: api }); t.after(() => server.close());
  const path = server.url + '/agents/' + publicOwner + '/bitmaps';
  const coldAt = performance.now(), cold = await fetch(path); assert.equal(cold.status, 200); await cold.json();
  const coldMs = performance.now() - coldAt, count = f.calls.length, cachedAt = performance.now();
  const cached = await fetch(path); assert.equal(cached.status, 200); const value = await cached.json(), cachedMs = performance.now() - cachedAt;
  assert.equal(f.calls.length, count); assert.ok(cachedMs < 300); assert.equal(value.bitmapContext.cached, true);
  t.diagnostic(JSON.stringify({ realClockColdMs: coldMs, realClockCachedMs: cachedMs, cachedSourceCalls: f.calls.length - count }));
});

test('a full public queue and retries cannot consume game capacity or precede a waiting game read', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const calls = [], source = new HttpSource({ url: 'https://source.invalid', requestsPerSecond: 2, publicRequestsPerSecond: 1, publicMaxQueue: 2, maxQueue: 1, retries: 1, backoffMs: 1000,
    fetchImpl: async url => { const path = new URL(url).pathname; calls.push({ path, at: Date.now() }); return new Response('{}', { status: path === '/public-retry' && calls.filter(c => c.path === path).length === 1 ? 503 : 200 }); } });
  const publicJobs = withPublicReads(() => [source.request('/public-retry'), source.request('/public-next')]);
  withPublicReads(() => assert.throws(() => source.request('/overflow'), /http_capacity/));
  await turn();
  const game = source.request('/game');
  await finish(t, game);
  assert.deepEqual(calls.slice(0, 2).map(c => c.path), ['/public-retry', '/game']);
  await finish(t, Promise.all(publicJobs));
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 500);
  const publicCalls = calls.filter(c => c.path !== '/game');
  for (let i = 1; i < publicCalls.length; i++) assert.ok(publicCalls[i].at - publicCalls[i - 1].at >= 1000);
});

test('HTTP public API work uses the lower-priority source lane', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const f = pacedFixture(0, { publicMaxQueue: 1 });
  await f.source.request('/warm-transport');
  const api = createPublicAPI({ views: { status: () => f.source.request('/public-status') } });
  const first = api.read('/status');
  const same = api.read('/status');
  await turn(); // Public API invalidation finishes before it enqueues its source read.
  withPublicReads(() => assert.throws(() => f.source.request('/different-public'), /http_capacity/));
  const game = f.source.request('/game');
  await finish(t, Promise.all([first, same, game]));
});

test('a game read wakes a source waiting for the slower public budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const f = pacedFixture(0, { publicRequestsPerSecond: 0.1 });
  await withPublicReads(() => f.source.request('/first-public'));
  const waiting = withPublicReads(() => f.source.request('/second-public'));
  await turn(); t.mock.timers.tick(500); await turn();
  const gameAt = Date.now(); await f.source.request('/game');
  assert.equal(Date.now(), gameAt, 'game read does not wait for the ten-second public budget');
  assert.deepEqual(f.calls.map(c => c.path), ['/first-public', '/game']);
  await finish(t, waiting);
});
