import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Feeds } from '../src/feeds.mjs';
import { AssetScheduler } from '../src/asset-scheduler.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { projectionReady } from '../src/projection-state.mjs';
import { rules } from '../src/rules.mjs';

const owner = 'a'.repeat(64), id = '1';
function batch(count = 100) {
  const occurrences = Array.from({ length: count }, (_, i) => ({ block: String(i), pattern: '0', asset: 'p2:0',
    count: '1', agent: owner, hash: rules.hash('header-' + i) }));
  return { height: '100', tip: '100', occurrences,
    finds: Object.fromEntries(occurrences.map(row => [rules.findIdV2(row.block, row.pattern), { ...row, finder: owner, findHeight: '100' }])),
    discoveries: [{ record: { number: '0', name: 'dmwfixture', discoverer: owner, knownMatchCount: String(count) } }] };
}
async function fixture(t, settings = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'feed-projection-speed-'));
  const f = { directory, store: await Store.open(directory), settings };
  t.after(async () => { await f.store.close(); await rm(directory, { recursive: true, force: true }); });
  await f.store.transact([{ space: 'meta', id: 'ruleState', value: { batchVersion: 2, counted: '100' } },
    { space: 'meta', id: 'compoundTotalsFill', value: { done: true } }]);
  f.feeds = () => new Feeds({ store: f.store, files: new Files(join(directory, 'static')), reads: {}, settings,
    history: { get() { throw Error('history_scan'); } } });
  f.api = () => createPublicAPI({ views: { store: f.store } });
  return f;
}
const pending = { message: 'public_projection_pending', status: 503 };
const paths = ['/agents', '/patterns', '/table', '/events', '/patterns/p2:0/claimed-blocks'];
async function assertPending(api) {
  for (const path of paths) await assert.rejects(api.response(path), pending, path);
}
async function assertComplete(f) {
  const { store } = f;
  assert.equal(store.count('feedEvents'), 0);
  assert.equal(store.get('feedEventCursor', id), null);
  assert.equal(store.get('feedEventComplete', id), true);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM projectionPending').get().n, 0);
  assert.equal(store.count('claimed2/p2:0'), 100);
  assert.equal(store.count('findsByAgent/' + owner), 100);
  assert.equal(store.get('catalogAgents', owner).findCount, '100');
  assert.equal(store.get('catalogAgents', owner).discoveryCount, '1');
  assert.equal(store.get('claimedRevision', 'p2:0'), '200');
  assert.equal(store.count('publicEvents'), 102);
  const api = f.api();
  assert.equal((await api.read('/agents')).agents[0].findCount, '100');
  assert.equal((await api.read('/table')).patterns.length, 1);
  for (const path of paths) await api.response(path);
}

test('a realistic batch finishes in one scheduler tick and keeps every pending scope fenced until commit', async t => {
  const f = await fixture(t), { store } = f, api = f.api();
  // Prime serialized public caches before the event is accepted.
  for (const path of paths) await api.response(path);
  await store.put('feedEvents', id, batch());
  const scopes = store.db.prepare('SELECT scope FROM projectionPending WHERE event=?').all(id).map(r => r.scope);
  assert.ok(scopes.length >= 200);
  await assertPending(api);
  let transactions = 0, projectionTransactions = 0, intermediateChecks = 0, releasedAt;
  const transact = store.transact.bind(store);
  store.transact = async operations => {
    transactions++;
    const projection = operations.some(op => op.space === 'meta' && op.id === 'claimedProjectionRevision');
    if (projection) { projectionTransactions++; await assertPending(api); }
    const result = await transact(operations);
    if (projection && store.get('feedEvents', id)) {
      intermediateChecks++;
      for (const scope of scopes) assert.throws(() => projectionReady(store, scope), pending, scope);
      await assertPending(api);
    } else if (projection) {
      releasedAt = performance.now();
      for (const scope of scopes) projectionReady(store, scope);
      // The same cached API must see the complete event immediately.
      assert.equal((await api.read('/agents')).agents[0].findCount, '100');
      assert.equal((await api.read('/table')).patterns.length, 1);
    }
    return result;
  };
  const feeds = f.feeds(), started = performance.now(); let ticks = 0;
  let finish, fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const scheduler = new AssetScheduler({ onError: error => { scheduler.stop(); fail(error); } });
  // Keep the test alive while the production scheduler's timer is unreferenced.
  const timeout = setTimeout(() => { scheduler.stop(); fail(Error('projection_timeout')); }, 30_000);
  try {
    scheduler.add('feeds', async () => {
      ticks++; await feeds.tick();
      if (!store.hasRows('feedEvents')) { scheduler.stop(); finish(); }
    });
    await done;
  } finally { clearTimeout(timeout); await scheduler.close(); }
  const elapsedMs = performance.now() - started, pendingMs = releasedAt - started;
  t.diagnostic(JSON.stringify({ ticks, transactions, projectionTransactions, scopes: scopes.length,
    elapsedMs: Math.round(elapsedMs), pendingMs: Math.round(pendingMs), intermediateChecks }));
  await assertComplete(f);
  assert.equal(intermediateChecks, projectionTransactions - 1);
  assert.equal(ticks, 1);
  assert.ok(pendingMs < 1000, `projection took ${pendingMs.toFixed(1)} ms`);
});

test('a reduced resource budget yields with a durable cursor and resumes without duplicate counts', async t => {
  const f = await fixture(t, { feedEventRows: 32, feedEventsPerTick: 2 });
  await f.store.put('feedEvents', id, batch());
  await f.feeds().events();
  assert.deepEqual(f.store.get('feedEventCursor', id), { phase: 0, offset: 64 });
  assert.equal(f.store.count('claimed2/p2:0'), 64);
  await f.feeds().events();
  assert.deepEqual(f.store.get('feedEventCursor', id), { phase: 1, offset: 28 });
  assert.equal(f.store.get('catalogAgents', owner).findCount, '28');
  await assertPending(f.api());
  await f.store.close(); f.store = await Store.open(f.directory);
  await assertPending(f.api());
  const feeds = f.feeds(); let ticks = 2;
  while (f.store.hasRows('feedEvents') && ticks < 20) { await feeds.events(); ticks++; }
  assert.equal(ticks, 4);
  await assertComplete(f);
});

test('an interruption after a durable find commit resumes the same event with its fence intact', async t => {
  const f = await fixture(t), { store } = f;
  await store.put('feedEvents', id, batch());
  const transact = store.transact.bind(store);
  store.transact = async operations => {
    const result = await transact(operations);
    if (operations.some(op => op.space === 'catalogAgents' && op.value?.findCount === '100')) throw Error('interrupted_after_commit');
    return result;
  };
  await assert.rejects(f.feeds().tick(), /interrupted_after_commit/);
  assert.deepEqual(store.get('feedEventCursor', id), { phase: 2, offset: 0 });
  assert.equal(store.get('catalogAgents', owner).findCount, '100');
  await assertPending(f.api());
  await store.close(); f.store = await Store.open(f.directory);
  await assertPending(f.api());
  await f.feeds().tick();
  await assertComplete(f);
  // Re-delivery only removes the queue entry; it must not reapply the event.
  await f.store.put('feedEvents', id, batch());
  await assertPending(f.api());
  await f.feeds().events();
  await assertComplete(f);
});

test('the row budget is shared across events and later attribution cannot overtake an incomplete event', async t => {
  const f = await fixture(t), { store } = f, first = batch(), other = 'b'.repeat(64);
  const correction = { height: '100', tip: '100', discoveries: [{ record: { ...first.discoveries[0].record, discoverer: other } }] };
  await store.transact([
    ...['1', '2', '3'].map(id => ({ space: 'feedEvents', id, value: first })),
    { space: 'feedEvents', id: '4', value: correction },
  ]);
  const feeds = f.feeds();
  await feeds.events();
  assert.equal(store.get('feedEventComplete', '1'), true);
  assert.equal(store.get('feedEventComplete', '2'), true);
  // Each completed event costs 201 rows + seven empty phases = 208 units.
  // The remaining 96 units of the shared 512 budget belong to event three.
  assert.deepEqual(store.get('feedEventCursor', '3'), { phase: 0, offset: 96 });
  assert.equal(store.get('feedEventCursor', '4'), null);
  assert.equal(store.get('catalogPatterns', 'p2:0').discoverer, owner);
  assert.equal(store.get('catalogAgents', other), null);
  await assertPending(f.api());
  await feeds.events();
  assert.equal(store.count('feedEvents'), 0);
  assert.equal(store.get('catalogPatterns', 'p2:0').discoverer, other);
  assert.equal(store.get('catalogAgents', owner).findCount, '100');
  assert.equal(store.get('catalogAgents', owner).discoveryCount, '0');
  assert.equal(store.get('catalogAgents', other).discoveryCount, '1');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM projectionPending').get().n, 0);
});

test('empty phases consume the resource budget and queue selection stays bounded', async t => {
  const f = await fixture(t, { feedEventRows: 1, feedEventsPerTick: 2 }), { store } = f;
  const event = { height: '0', tip: '0' };
  await store.put('feedEvents', id, event);
  await f.feeds().events();
  assert.deepEqual(store.get('feedEventCursor', id), { phase: 2, offset: 0 });
  assert.throws(() => projectionReady(store, 'publicEvents'), pending);
  for (let i = 0; i < 4; i++) await f.feeds().events();
  assert.equal(store.count('feedEvents'), 0);
  // A larger row budget still cannot select more than two queue entries.
  f.settings.feedEventRows = 128;
  await store.transact(['2', '3', '4'].map(id => ({ space: 'feedEvents', id, value: event })));
  await f.feeds().events();
  assert.equal(store.get('feedEventComplete', '2'), true);
  assert.equal(store.get('feedEventComplete', '3'), true);
  assert.equal(store.get('feedEventCursor', '4'), null);
  assert.equal(store.count('feedEvents'), 1);
  await f.feeds().events();
  assert.equal(store.count('feedEvents'), 0);
  projectionReady(store, 'publicEvents');
});
