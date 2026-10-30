import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
// The fixed conversion list is compiled into consensus; replace only that
// module in this isolated test process, as compound-identity-v4.test does.
const manifest = { network: 'compound-merge-test', ready: true, rows: [] };
mock.module('../../rules/src/compound-merge-manifest.js', { namedExports: { COMPOUND_IDENTITY_V4_MERGES: manifest } });
const r = await import('../../rules/src/index.js');
const { mergeFixture } = await import('../../rules/test/fixtures/compound-merge-v4.js');
const { buildCreditAccounts } = await import('../src/account-batch.mjs');
const { Store } = await import('../src/store.mjs');
const { Files } = await import('../src/files.mjs');
const { Feeds } = await import('../src/feeds.mjs');
const { createPublicAPI } = await import('../src/public-api.mjs');
const { rankingHighlights } = await import('../src/public-rankings.mjs');
const { mintAssetDefinition } = await import('../src/mint-assets.mjs');
const { provisioningFixture } = await import('./provisioning-fixture.mjs');
const { temp } = await import('./helpers.mjs');
const height = r.COMPOUND_IDENTITY_V4_HEIGHT, before = String(BigInt(height) - 1n);
const f = mergeFixture(); manifest.rows.push(...f.manifest.rows);
const [oldest, later] = f.records;

// The two live compounds (1 and 10 units) become one deterministic compound of
// 11 units. Its public row, supply and made-real count follow the new id only.
test('after the conversion the deterministic compound lists 11 units on Trac, retired ids vanish, and no catalog scan runs', async () => {
  const directory = await temp(), store = await Store.open(directory);
  const feeds = new Feeds({ store, files: new Files(join(directory, 'static')), history: { get: h => ({ hash: r.hash(String(h)) }) }, reads: {},
    settings: { projectionVersion: 3 } });
  const drain = async () => { let ticks = 0; do { await feeds.events(); assert.ok(++ticks < 20); } while (store.count('feedEvents')); };
  try {
    await store.put('meta', 'ruleState', { batchVersion: 2 });
    // Before activation: the holder's credited units and the two public rows.
    const credited = await buildCreditAccounts({ store, document: f.settings, height: before,
      credits: [{ op: 'ac', to: f.owner, assets: f.manifest.rows.map(row => [row.oldId, row.amount]) }] });
    await store.transact([...credited.writes, ...f.records.map((c, i) => ({ space: 'catalogTypes', id: c.id, value: { ...c, firstMaker: i ? f.other : f.owner } }))]);
    await drain();
    assert.deepEqual(f.records.map(c => store.get('catalogTypes', c.id).supply), ['1', '10']);

    // The first batch at the gate: the account conversion and the merged catalog,
    // written as the pipeline writes them.
    const { merge } = r.mergeCompoundCatalogV4(f.state, { network: f.network, height });
    const accounts = await buildCreditAccounts({ store, document: f.settings, height, credits: [], compoundMerge: merge });
    const list = store.list.bind(store), listed = [];
    store.list = (space, options) => { listed.push(space); return list(space, options); };
    await store.transact([...accounts.writes, ...merge.types.map(value => ({ space: 'compoundTypes', id: value.id, value })),
      { space: 'feedEvents', id: 'merge', value: { height, tip: height, observation: '1', batch: '1', types: Object.fromEntries(merge.types.map(c => [c.id, c])), crafts: [] } }]);
    await drain();
    assert.ok(!listed.includes('catalogTypes'), 'the conversion touches only its own rows');
    for (const old of f.records) assert.equal(store.get('catalogTypes', old.id), null);
    const merged = store.get('catalogTypes', f.id);
    assert.deepEqual([merged.supply, merged.madeReal, merged.firstMaker, merged.snapshot.height], ['11', '0', f.owner, oldest.snapshot.height]);
    assert.equal(store.get('publicSupply', oldest.id).outstanding, '0'); assert.equal(store.get('publicSupply', later.id).outstanding, '0');

    // Made real counts only the new id; a stray event for a retired id restores nothing.
    const minted = { height, tip: height, observation: '2', batch: '2', financial: [
      { id: 'm1', type: 'mint_complete', data: { requestId: 'r1', owner: f.owner, asset: f.id, amount: '3' }, provenance: { batch: '2' } },
      { id: 'm2', type: 'mint_complete', data: { requestId: 'r2', owner: f.owner, asset: later.id, amount: '4' }, provenance: { batch: '2' } }] };
    await store.put('feedEvents', 'minted', minted);
    await drain();
    assert.equal(store.get('catalogTypes', f.id).madeReal, '3'); assert.equal(store.get('catalogTypes', later.id), null);
    assert.ok(!listed.includes('catalogTypes'));
    store.list = list;

    const api = createPublicAPI({ views: { store } });
    assert.deepEqual((await api.read('/compounds?limit=10')).compounds.map(c => [c.id, c.supply, c.madeReal]), [[f.id, '11', '3']]);
    assert.deepEqual((await api.read(`/compounds?asset=${encodeURIComponent(oldest.id)}&limit=1`)).compounds, []);
    assert.deepEqual((await api.read('/results/supply')).supply.filter(s => s.asset.startsWith('c2:')).map(s => [s.asset, s.outstanding]), [[f.id, '11']]);
    assert.equal(rankingHighlights(store).highestTierCompound.asset, f.id);
    assert.equal(r.compoundTicker(f.id), 'dmwc' + f.id.slice(3, 11));
  } finally { await store.close(); }
});

test('only the deterministic compound deploys: its ticker uses the new id and prov names the oldest record\'s first maker', async t => {
  const p = await provisioningFixture(t), { merge } = r.mergeCompoundCatalogV4(f.state, { network: f.network, height });
  await p.store.put('meta', 'ruleState', { batchVersion: 2 });
  // A job opened for an old id before activation, still waiting for its inscription.
  await p.store.put('compoundTypes', later.id, { ...later, firstMaker: f.other });
  let old = await p.operator.advanceAsset(later.id, { ...later, firstMaker: f.other });
  assert.equal(old.state, 'awaiting_player_deploy');
  for (const value of merge.types) await p.store.put('compoundTypes', value.id, value);

  for (const retired of f.records) {
    await assert.rejects(mintAssetDefinition(p.store, retired.id), /compound_retired/);
    await assert.rejects(p.operator.state(retired.id), /compound_retired/);
    await assert.rejects(p.operator.request(retired.id), /compound_retired/);
  }
  // The background pass offers only the new id and is not stopped by the old job.
  const visited = [], advance = p.operator.advance.bind(p.operator);
  p.operator.advance = async job => { visited.push(job.asset); return job; };
  await p.operator.tick();
  assert.deepEqual(visited, [f.id]); assert.equal(p.store.get('provisioning', oldest.id), null);
  p.operator.advance = advance;
  const item = old.attempts.at(-1), inscription = p.index(item.text); p.mine();
  await assert.rejects(p.operator.submit(later.id, { phase: 'deployment', inscription }), /compound_retired/);

  const resolved = [];
  p.reads.bindings = { resolve: maker => { resolved.push(maker); return { request: { address: 'maker' } }; } };
  const { definition } = await mintAssetDefinition(p.store, f.id);
  assert.equal(definition.firstMaker, f.owner);
  const job = await p.complete(f.id, definition);
  assert.equal(job.entry.tick, 'dmwc' + f.id.slice(3, 11)); assert.equal(job.entry.firstMaker, f.owner);
  assert.equal(job.attempts[0].text.prov, r.encodeTracAddress(f.owner)); assert.equal(job.entry.prov, job.attempts[0].text.prov);
  assert.ok(resolved.length && resolved.every(maker => maker === f.owner));
});
