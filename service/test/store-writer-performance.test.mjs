import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.mjs';
import { temp } from './helpers.mjs';
import { largeWriterBatch } from './store-writer-fixture.mjs';

test('a 50000-operation evidence and projection transaction keeps the main timer responsive', { timeout: 60000 }, async t => {
  const store = await Store.open(await temp('writer-lag-'), { checkpointBytes: 1000000000 });
  t.after(() => store.close());
  await store.put('meta', 'ruleState', { batchVersion: 2 });
  const operations = largeWriterBatch();
  let previous = performance.now(), maxLag = 0, ticks = 0;
  const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - previous - 5); previous = now; ticks++; }, 5);
  try {
    await delay(20); const started = performance.now(); await store.transact(operations); const elapsed = performance.now() - started;
    await delay(20);
    t.diagnostic(JSON.stringify({ operations: operations.length, elapsedMs: +elapsed.toFixed(2), maxLagMs: +maxLag.toFixed(2), ticks }));
    assert.ok(ticks > 20, 'the timer keeps running during apply');
    assert.ok(maxLag < 100, `maximum timer lag ${maxLag.toFixed(2)} ms`);
    for (const space of ['types', 'catalogAgents', 'claimed2/p2:0', 'publicEvents', 'accountNodes']) assert.equal(store.count(space), 10000);
    assert.equal(store.evidenceIndex.root(), '8a59f9f1356514f743b9708b683f17a7b054e3c799c065f97def681a46698073');
  } finally { clearInterval(timer); }
});
