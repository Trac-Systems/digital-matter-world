import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { History } from '../../src/history.mjs';
import { fixtureHistory } from '../../test/helpers.mjs';
import { configFixture } from './helpers.mjs';

let branch, tip, counted;
const client = { blockHash: async height => branch.hashAt(height) };
mock.module('../reads.mjs', { namedExports: { productionReads: async () => ({
  client, manifest: { bitcoin: client }, views: { view: async () => branch }, close() {},
  trac: async method => {
    assert.equal(method, 'head'); return { tip: { height: tip, hash: branch.hashAt(tip) }, counted };
  }
}) } });
const { createAdapters } = await import('../adapter.mjs');

test('production fill batches below startTip while preserving view limits, 64 observations and replay', async t => {
  branch = fixtureHistory(4200); tip = 4200; counted = 4000;
  const { config, root } = await configFixture(t);
  config.prod.startTip = 4100; config.prod.maxHeadersPerView = 2500;
  const store = await Store.open(join(root, 'history')), history = new History(store);
  const adapter = await createAdapters({ config, store, history });
  try {
    assert.deepEqual(await adapter.observations(), []);
    assert.equal(history.length, 2500); assert.equal(store.sequence, 2);
    const rows = await adapter.observations();
    assert.equal(rows.length, 64); assert.equal(rows[0].tip, 4100); assert.equal(rows.at(-1).tip, 4163);
    assert.equal(history.length, 4164); assert.equal(store.get('meta', 'headerHeight'), 4163);
    assert.ok(rows.every(row => row.counted === counted && row.confirmed === counted && row.hash === branch.hashAt(row.tip)));
    const sequence = store.sequence;
    assert.deepEqual(await adapter.observations(), rows); assert.equal(store.sequence, sequence);
    for (const row of rows) await adapter.observed(row);
    const rest = await adapter.observations(rows.at(-1));
    assert.equal(rest[0].tip, 4164); assert.equal(rest.at(-1).tip, 4200); assert.equal(rest.length, 37);
    assert.equal(history.length, 4201); assert.equal(history.hashAt(tip), branch.hashAt(tip));
    for (const row of rest) await adapter.observed(row);
    assert.deepEqual(await adapter.observations(rest.at(-1)), []);
  } finally { await adapter.close(); await store.close(); }
});

test('production fill preserves the below-startTip fallback and subsequent counted observations', async t => {
  branch = fixtureHistory(63); tip = 63; counted = 50;
  const { config, root } = await configFixture(t);
  config.prod.startTip = 100; config.prod.maxHeadersPerView = 100;
  const store = await Store.open(join(root, 'history')), history = new History(store);
  const adapter = await createAdapters({ config, store, history });
  try {
    const rows = await adapter.observations();
    assert.equal(rows.length, 1); assert.equal(rows[0].tip, 63); assert.equal(history.length, 64);
    assert.equal(store.sequence, 2); await adapter.observed(rows[0]);
    assert.deepEqual(await adapter.observations(rows[0]), []);
    counted++;
    const changed = await adapter.observations(rows[0]);
    assert.equal(changed.length, 1); assert.equal(changed[0].tip, 63); assert.equal(changed[0].counted, counted);
  } finally { await adapter.close(); await store.close(); }
});

test('production startTip zero still produces at most 64 initial observations', async t => {
  branch = fixtureHistory(100); tip = 100; counted = 90;
  const { config, root } = await configFixture(t);
  config.prod.startTip = 0; config.prod.maxHeadersPerView = 100;
  const store = await Store.open(join(root, 'history')), history = new History(store);
  const adapter = await createAdapters({ config, store, history });
  try {
    const rows = await adapter.observations();
    assert.equal(rows.length, 64); assert.equal(rows[0].tip, 0); assert.equal(rows.at(-1).tip, 63);
    assert.equal(history.length, 64); assert.equal(store.sequence, 128);
  } finally { await adapter.close(); await store.close(); }
});
