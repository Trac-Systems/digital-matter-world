import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { start } from '../run.mjs';
import { Store } from '../src/store.mjs';
import { restartFixture, createAdapters } from './restart-fixture.mjs';
import { createV2Runtime } from '../src/v2-runtime.mjs';
import { History } from '../src/history.mjs';
import { rules } from '../src/rules.mjs';

test('gateway listens fail-closed before adapter and committee readiness; public status stays in background', { timeout: 10000 }, async t => {
  const f = await restartFixture({ adapterMs: 150, notaryMs: 100, committeeMs: 250, publicMs: 30000, pollMs: 30000 });
  let service;
  t.after(async () => { await service?.close(); await f.close(); });
  const before = performance.now();
  service = await start(f.config, { background: true });
  assert.ok(performance.now() - before < 1000);
  let initialized = false; service.ready.then(() => { initialized = true; });
  const health = await fetch(service.url + '/health');
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false, ready: false, phase: 'starting' });
  assert.equal(initialized, false);
  const move = await fetch(service.url + '/moves', { method: 'POST', body: '{}' });
  assert.equal(move.status, 503); await move.text();
  await service.ready;
  assert.equal(f.events.some(row => row.phase === 'gateway.public_status'), false, 'slow public reads do not block initialization');
  const ready = await fetch(service.url + '/health');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).ready, false, 'no observed head cannot admit even with a capable committee');
});

test('gateway close aborts in-flight committee I/O and drains before releasing the store', { timeout: 10000 }, async t => {
  const f = await restartFixture({ adapterMs: 0, notaryMs: 0, committeeMs: 0, publicMs: 30000, pollMs: 30000 });
  let service;
  t.after(async () => { await service?.close(); await f.close(); });
  service = await start(f.config, { background: true }); await service.ready; await f.polling;
  const before = performance.now(), first = service.close();
  assert.equal(service.close(), first, 'all callers wait for the same teardown');
  await first;
  assert.ok(performance.now() - before < 2000, 'shutdown must cancel the 30-second request');
  assert.equal((await stat(join(f.config.data, 'pending.log'))).size, 0, 'clean restart does not reverify the committed journal');
  const reopened = await Store.open(f.config.data);
  try { await delay(20); assert.ok(reopened.get('meta', 'v2Activation')); }
  finally { await reopened.close(); }
});

test('shutdown during initialization cancels the source and never installs routes or pollers', { timeout: 10000 }, async t => {
  const f = await restartFixture({ adapterMs: 30000 });
  let service;
  t.after(async () => { await service?.close(); await f.close(); });
  service = await start(f.config, { background: true });
  await delay(50);
  const rejected = assert.rejects(service.ready, /abort|stopping/i), before = performance.now();
  await service.close(); await rejected;
  assert.ok(performance.now() - before < 2000);
  assert.equal(service.adapters, undefined);
  assert.equal(f.events.some(row => row.phase === 'v2.committee'), false);
});

test('shutdown cancels all five in-flight committee readiness requests', { timeout: 10000 }, async t => {
  const f = await restartFixture({ adapterMs: 0, notaryMs: 0, committeeMs: 30000 });
  let service;
  t.after(async () => { await service?.close(); await f.close(); });
  service = await start(f.config, { background: true }); await f.committeePolling;
  const rejected = assert.rejects(service.ready, /abort|stopping/i), before = performance.now();
  await service.close(); await rejected;
  assert.ok(performance.now() - before < 2000);
  assert.equal(service.intake, undefined);
});

test('foreground startup failure releases its listener and writer lock before rejecting', async t => {
  const f = await restartFixture(); t.after(() => f.close());
  f.config.gatewayKey = join(f.config.data, 'missing-key');
  await assert.rejects(start(f.config), { code: 'ENOENT' });
  const store = await Store.open(f.config.data); await store.close();
});

test('persisted receipt recovery has its own worker and cannot hold readiness refreshes', async t => {
  const f = await restartFixture({ adapterMs: 0, notaryMs: 0 });
  const store = await Store.open(f.config.data);
  t.after(async () => { await store.close(); await f.close(); });
  await store.put('meta', 'head', { id: 'fixture-head', tip: '0', counted: '0', hash: f.config.v2.manifest.bitcoinAnchor.hash });
  await store.put('namedFences', rules.hashObject(f.config.v2.document), { phase: 'closing' });
  const { reads } = await createAdapters({ config: f.config, store });
  const runtime = await createV2Runtime({ config: f.config, store, secret: Buffer.alloc(32, 9), history: new History(store), reads,
    committee: { healthy: async () => f.config.committee, readyMs: 15000 }, deferRecovery: true });
  assert.equal(runtime.intake.rulesContext().ready, false);
  let resumed = 0, entered, release;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  runtime.intake.fence = async () => { resumed++; entered(); await blocked; };
  await runtime.refresh(); assert.equal(resumed, 0);
  const recovering = runtime.recoverReceipts(); await started;
  const duplicate = runtime.recoverReceipts();
  try {
    const at = performance.now(); await runtime.refresh();
    assert.ok(performance.now() - at < 100);
    assert.equal(runtime.intake.rulesContext().ready, false); assert.equal(resumed, 1);
  } finally { release(); await Promise.all([recovering, duplicate]); }
});
