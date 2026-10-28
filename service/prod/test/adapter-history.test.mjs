import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../../src/store.mjs';
import { History } from '../../src/history.mjs';
import { fixtureHistory } from '../../test/helpers.mjs';
import { configFixture } from './helpers.mjs';
import * as r from '../../../rules/src/index.js';
import { heightKey } from '../../src/util.mjs';
import { mine, parseHeader, chain } from '../../../contract/tests/helpers/chain.mjs';
import { REGTEST_PARAMS } from '../../../contract/beacon/bitcoin.js';
import { HeaderRelay } from '../header-relay.mjs';

let branch, tip, counted;
const client = { blockHash: async height => branch.hashAt(height) };
mock.module('../reads.mjs', { exports: { productionReads: async () => ({
  client, manifest: { bitcoin: client }, views: { view: async () => branch }, close() {},
  trac: async method => {
    assert.equal(method, 'head'); return { tip: { height: tip, hash: branch.hashAt(tip) }, counted };
  }
}) } });
const { createAdapters } = await import('../adapter.mjs');

for (const base of ['9007199254740991', '9223372036854775807', '9'.repeat(80)]) test(`activated production observation and relay resume across ${base}`, async t => {
  const first = mine('0'.repeat(64), 1000), anchor = parseHeader(first), raws = [first, ...chain(2, anchor)], rows = new Map(raws.map((raw, i) => [String(BigInt(base) + BigInt(i)), raw]));
  tip = r.addUint(base, '2'); counted = tip;
  branch = { raw: h => rows.get(String(h)), hashAt: h => rows.has(String(h)) ? parseHeader(rows.get(String(h))).hash : null };
  const { config, root } = await configFixture(t);
  config.v2 = { resources: r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE } }) };
  config.prod.startTip = r.nextUint(base); config.prod.maxHeadersPerView = 2;
  const directory = join(root, 'decimal-history'); let store = await Store.open(directory), history = new History(store), adapter;
  try {
    await store.transact([{ space: 'meta', id: 'ruleState', value: { batchVersion: 2 } }, { space: 'meta', id: 'headerHeight', value: base },
      { space: 'headers', id: heightKey(base), value: { raw: first, hash: anchor.hash } }]);
    adapter = await createAdapters({ config, store, history });
    const observations = await adapter.observations();
    assert.deepEqual(observations.map(o => o.tip), [r.nextUint(base), tip]);
    assert.ok(observations.every(o => o.counted === tip && o.revision === '0'));
    await adapter.close(); await store.close(); store = await Store.open(directory); history = new History(store);
    adapter = await createAdapters({ config, store, history });
    assert.deepEqual(await adapter.observations(), observations);
    for (const observation of observations) await adapter.observed(observation);
    assert.deepEqual(await adapter.observations(observations.at(-1)), []);
    const reads = { client: { tip: async () => ({ height: tip, hash: branch.hashAt(tip) }) }, views: { view: async () => branch },
      trac: async method => method === 'head' ? { counted: base, tip: { height: base, hash: anchor.hash } } : { v2: {}, beacon: { checkpoint: { height: base, hash: anchor.hash }, params: REGTEST_PARAMS } } };
    await new HeaderRelay({ reads, store }).tick({ maxJobs: 1, enqueue: (id, op, value, extra) => store.put('outbox', id, { op, value, ...extra }) });
    const job = store.list('outbox')[0].value;
    assert.equal(job.height, tip); assert.deepEqual(job.value.headers, raws.slice(1));
  } finally { await adapter?.close(); await store.close(); }
});

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

test('configured observation pages preserve queued work across a smaller page and restart', async t => {
  branch = fixtureHistory(10); tip = 10; counted = 10;
  const { config, root } = await configFixture(t);
  const resource = size => r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE, relayObservationPage: size } });
  config.v2 = { resources: resource(3) }; config.prod.startTip = '0'; config.prod.maxHeadersPerView = 10;
  const directory = join(root, 'paged-history'); let store = await Store.open(directory), history = new History(store);
  let adapter = await createAdapters({ config, store, history });
  try {
    const first = await adapter.observations(); assert.equal(first.length, 3);
    await adapter.close(); await store.close();
    config.v2.resources = resource(1); store = await Store.open(directory); history = new History(store);
    adapter = await createAdapters({ config, store, history });
    for (const row of first) {
      assert.deepEqual(await adapter.observations(), [row]); await adapter.observed(row);
    }
    const next = await adapter.observations(first.at(-1)); assert.equal(next.length, 1); assert.equal(next[0].tip, '3');
  } finally { await adapter.close(); await store.close(); }
});
