import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { History } from '../src/history.mjs';
import { PublicIndex } from '../src/public-index.mjs';
import { PublicViews } from '../src/public-views.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { rules } from '../src/rules.mjs';
import { hash, heightKey } from '../src/util.mjs';
import { chain } from '../../contract/tests/helpers/chain.mjs';
import { temp, fixtureHistory, network, secret, gateway } from './helpers.mjs';

async function fixture(t, height = 63) {
  const store = await Store.open(await temp('public-audit-height-'));
  t.after(() => store.close());
  const files = new Files(join(store.directory, 'static')), history = new History(store), source = fixtureHistory(63);
  await history.appendMany(0, Array.from({ length: source.length }, (_, h) => source.raw(h)));
  const tip = 10, tipHash = history.hashAt(tip), branch = history.view(tip, tipHash);
  const output = rules.processBlock({ height, blockHash: branch.hashAt(height), tip, tipHash, confirmed: Math.min(height, tip),
    network, gateway, history: branch, hashAt: branch.hashAt, patterns: [], entries: [],
    receiptRoot: rules.sealReceipts([], { network, tip, hash: tipHash }, secret),
    state: { lastTip: tip - 1, counted: height - 1, observation: 7 } });
  const publication = await files.publish(output, { id: heightKey(output.file.observation) });
  const root = rules.merkleRoot([output.auditBytes]);
  await store.transact([
    { space: 'publishedObservations', id: heightKey(8), value: publication },
    { space: 'batches', id: heightKey(1), value: { batch: { n: 1, root }, publications: [publication] } },
    { space: 'meta', id: 'publicObservation', value: heightKey(7) },
    { space: 'meta', id: 'publicSequence', value: 1000000 },
  ]);
  const reads = { counted: async () => 63 }, views = new PublicViews({ store, history, reads, network });
  return { store, files, history, reads, views, api: createPublicAPI({ views, files }), file: output.file, publication, root };
}

for (const height of [9, 10, 63]) test(`public audit at height ${height} uses its bounded branch timestamp and publishes exactly once`, async t => {
  const f = await fixture(t, height), { file, history, store } = f;
  assert.equal(history.get(63).height, 63, 'canonical history is complete through the counted height');
  if (height > file.tip) {
    assert.equal(file.hash, null, 'the rules accept a counted clock above the audit tip');
    assert.throws(() => history.view(file.tip, file.tipHash).get(height), /^Error: header_missing$/);
  }
  const index = new PublicIndex(f);
  await index.tick(); await index.tick(); await new PublicIndex(f).tick();
  const expected = { id: hash(`${heightKey(8)}/block/block`), sequence: 1000001,
    at: history.get(height > file.tip ? file.tip : height).time * 1000, type: 'block',
    data: { height, tip: file.tip, windows: [] },
    provenance: { batch: 1, root: f.root, index: 0, count: 1, manifest: '/records/batches/1',
      audit: f.publication.audit, observation: 8, height } };
  assert.deepEqual(store.list('publicEvents'), [{ id: heightKey(1000001), value: expected }]);
  assert.equal(store.count('publicEventKeys'), 1);
  assert.equal(store.get('meta', 'publicObservation'), heightKey(8));
  assert.equal(store.get('meta', 'publicSequence'), 1000001);
  assert.equal(f.views.readIndex.ready, true);
  const page = await f.api.read('/events?since=1000000&order=asc');
  assert.equal(page.total, 1); assert.equal(page.events[0].at, expected.at);
  assert.equal(page.events[0].data.height, height);
  assert.deepEqual(page.events[0].provenance, expected.provenance);
});

async function reorg(f) {
  // Keep the accepted audit's objects, but replace canonical history from tip 10.
  await f.history.appendMany(10, chain(54, f.history.get(9), 601, 1));
  assert.notEqual(f.history.hashAt(10), f.file.tipHash);
}

test('an above-tip audit keeps the timestamp of its accepted branch after a reorg', async t => {
  const f = await fixture(t), at = f.history.get(10).time * 1000;
  await reorg(f);
  assert.notEqual(f.history.get(10).time * 1000, at);
  await new PublicIndex(f).tick();
  const { events } = await f.api.read('/events');
  assert.equal(events.length, 1); assert.equal(events[0].at, at);
  assert.equal(events[0].data.height, 63); assert.equal(events[0].provenance.height, 63);
});

async function rejectsWithoutProgress(f, error) {
  const index = new PublicIndex(f);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(index.tick(), error);
    assert.equal(index.running, false);
    assert.equal(f.store.get('meta', 'publicObservation'), heightKey(7));
    assert.equal(f.store.get('meta', 'publicSequence'), 1000000);
    assert.equal(f.store.count('publicEvents'), 0); assert.equal(f.store.count('publicEventKeys'), 0);
  }
}

test('a genuinely missing canonical timestamp header still fails without advancing the audit', async t => {
  const f = await fixture(t, 9);
  await f.store.put('headers', heightKey(9), undefined);
  await rejectsWithoutProgress(f, /^Error: header_missing$/);
});

test('a missing above-tip audit branch header fails even when canonical history is complete', async t => {
  const f = await fixture(t);
  await reorg(f);
  await f.store.put('headerObjects', f.file.tipHash, undefined);
  assert.equal(f.history.get(10).height, 10); assert.equal(f.history.get(63).height, 63);
  await rejectsWithoutProgress(f, /^Error: branch_header_missing$/);
});

test('above-tip audits still require matching verified audit bytes', async t => {
  const f = await fixture(t);
  await f.store.put('publishedObservations', heightKey(8), { ...f.publication, audit: { ...f.publication.audit, hash: '0'.repeat(64) } });
  await rejectsWithoutProgress(f, /^Error: public_audit_hash$/);
});
