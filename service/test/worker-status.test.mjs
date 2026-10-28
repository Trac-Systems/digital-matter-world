import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { WorkerStatus } from '../src/worker-status.mjs';
import { temp } from './helpers.mjs';
import { PublicSnapshot } from '../src/public-cache.mjs';
import { serve } from '../src/http.mjs';
import { AssetScheduler } from '../src/asset-scheduler.mjs';
import { observeOnce } from '../run.mjs';

test('recovered workers clear their historical failure without clearing a sibling failure', async () => {
  const store = await Store.open(await temp('worker-status-')), status = new WorkerStatus(store);
  try {
    await status.failed(Error('ceremony_requires_recovery'), 'pipeline');
    await status.succeeded('cancellation'); assert.equal(store.get('meta', 'workerStatus').worker, 'pipeline');
    await status.succeeded('pipeline'); assert.equal(store.get('meta', 'workerStatus'), null);
    await status.failed(Error('ceremony_requires_recovery'), 'pipeline');
    await Promise.all([status.succeeded('pipeline'), status.failed(Error('cancellation_pending'), 'cancellation'), status.succeeded('pipeline')]);
    assert.equal(store.get('meta', 'workerStatus').code, 'cancellation_pending');
  } finally { await store.close(); }
});

test('the catalog poll clears a failed snapshot and health worker error on its next successful refresh', async () => {
  const store = await Store.open(await temp('catalog-worker-')), status = new WorkerStatus(store);
  let available = false;
  const catalog = new PublicSnapshot(async () => {
    if (!available) throw TypeError('this.reads.assetSupply is not a function');
    return { patterns: [], compounds: [] };
  });
  const http = await serve({ intake: { store }, files: { serve: async () => false } });
  const health = async () => (await fetch(http.url + '/health')).json();
  try {
    await status.run('public_catalog', () => catalog.refresh());
    assert.throws(() => catalog.read(), /assetSupply/);
    assert.equal((await health()).worker.code, 'dependency_unavailable');
    await status.run('public_status', async () => {});
    assert.equal((await health()).worker.worker, 'public_catalog');
    available = true;
    await status.run('public_catalog', () => catalog.refresh());
    assert.deepEqual(catalog.read(), { patterns: [], compounds: [] });
    assert.equal((await health()).worker, null);
    await status.failed(Error('pipeline_failed'), 'pipeline');
    await status.run('public_catalog', () => catalog.refresh());
    assert.equal((await health()).worker.worker, 'pipeline');
  } finally { await http.close(); await store.close(); }
});

test('scheduled observation disk failure remains visible until a successful observation poll', async () => {
  const store = await Store.open(await temp('observation-status-')), status = new WorkerStatus(store);
  let available = false, observed = 0;
  const task = () => observeOnce({ checkDisk: async () => { if (!available) throw Error('disk_floor'); },
    adapters: { observations: async () => [{ chain: 'main' }] }, outbox: { tick: async () => {} },
    intake: { observe: async () => { observed++; } }, chain: 'main', workerStatus: status });
  const run = async () => {
    const scheduler = new AssetScheduler({ intervalMs: 60000, onError: (e, name) => status.failed(e, name), onSuccess: name => status.succeeded(name) });
    scheduler.add('observations', task); await scheduler.close();
  };
  try {
    await run();
    assert.equal(observed, 0);
    assert.deepEqual({ worker: store.get('meta', 'workerStatus').worker, code: store.get('meta', 'workerStatus').code }, { worker: 'observations', code: 'disk_floor' });
    await status.succeeded('pipeline'); assert.equal(store.get('meta', 'workerStatus').code, 'disk_floor');
    available = true; await run();
    assert.equal(observed, 1); assert.equal(store.get('meta', 'workerStatus'), null);
  } finally { await store.close(); }
});
