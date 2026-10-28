import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { AssetQueue } from '../src/asset-queue.mjs';
import { AssetScheduler } from '../src/asset-scheduler.mjs';
import { temp } from './helpers.mjs';

test('500 first intents fit; round robin, leases and terminal evidence survive restart', async t => {
  const directory = await temp(); let store = await Store.open(directory), now = 1000; t.after(() => store.close());
  const options = () => ({ store, name: 'mint', now: () => now, leaseMs: 10 });
  let queue = new AssetQueue(options());
  for (let i = 0; i < 500; i++) await queue.enqueue('mint-' + i, String(i).padStart(4, '0'), { request: i });
  for (let i = 0; i < 7; i++) await queue.enqueue('extra-' + i, '0000', { request: i });
  await assert.rejects(queue.enqueue('extra-overflow', '0000', {}), /queue_agent_capacity/);
  const first = await queue.claim(); assert.equal(first.owner, '0000');
  const second = await queue.claim(); assert.equal(second.owner, '0001');
  await queue.finish(second, { state: 'complete', evidence: 'accepted-batch' });
  await store.close(); store = await Store.open(directory); queue = new AssetQueue(options());
  assert.equal((await queue.claim()).owner, '0002');
  now += 20;
  // Original abandoned lease is retried with the same identity and a new fence.
  await store.put('queueMeta/mint', 'cursor', '9999');
  let recovered = await queue.claim();
  while (recovered.id !== first.id) {
    await queue.finish(recovered, { state: 'credit', evidence: 'confirmed-credit' });
    await store.put('queueMeta/mint', 'cursor', '9999'); recovered = await queue.claim();
  }
  assert.equal(recovered.digest, first.digest); assert.equal(recovered.revision, '2');
  await assert.rejects(queue.finish(first, { state: 'complete', evidence: 'stale' }), /queue_lease/);
  await queue.finish(recovered, { state: 'refunded', evidence: 'canonical-refund' });
  assert.equal((await queue.enqueue(first.id, first.owner, first.payload)).state, 'refunded');
  await assert.rejects(queue.enqueue(first.id, first.owner, { changed: true }), /queue_conflict/);
});

test('a blocked paid lane cannot starve reveals, and one lane never overlaps itself', async () => {
  let release, paid = 0, reveals = 0, active = 0, overlap = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const scheduler = new AssetScheduler({ intervalMs: 2 });
  scheduler.add('paid', async () => { paid++; await blocked; });
  scheduler.add('reveals', async () => { if (++active > 1) overlap = true; await new Promise(r => setTimeout(r, 2)); reveals++; active--; });
  await new Promise(r => setTimeout(r, 35));
  assert.equal(paid, 1); assert.ok(reveals >= 2); assert.equal(overlap, false);
  release(); await scheduler.close(); const last = reveals;
  await new Promise(r => setTimeout(r, 10)); assert.equal(reveals, last);
});
