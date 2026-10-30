import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { rankingHighlights } from '../src/public-rankings.mjs';
import { createWeb } from '../src/web.mjs';

// Shaped like the first live v2 compound: tier { value, expression }, mass a commitment, object inputs.
const maker = 'a'.repeat(64);
const compound = (hex, tier, generation, height) => ({
  id: 'c2:' + hex, commitment: hex, v: 3, recipe: 'fusion',
  inputs: [{ asset: 'p2:1', amount: '1', properties: { version: 2, mass: '26'.repeat(32), massResidue: 1, charge: 1, spectrum: 1, generation: '0' } },
    { asset: 'p2:2', amount: '1', properties: { version: 2, mass: '26'.repeat(32), massResidue: 1, charge: 2, spectrum: 2, generation: '0' } }],
  snapshot: { hash: '0'.repeat(64), height: String(height) },
  properties: { version: 2, mass: hex, massResidue: 2, charge: 3, spectrum: 3, generation: String(generation), rarity: '7b'.repeat(32) },
  tier: { value: tier, expression: { op: 'tier', thresholds: ['100', '1000', '10000', '100000'] } }, firstMaker: maker,
});
const first = compound('1bafd6097265662a5da3cd6aecd4c1df945f866038ceb85151ee96ed6227e5d5', 5, 1, 973796);
const lower = compound('f'.repeat(64), 3, 4, 973900);
const older = compound('0'.repeat(63) + '1', 5, 1, 973700);

async function open(t) {
  const directory = await mkdtemp(join(tmpdir(), 'compound-v2-reads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await Store.open(directory);
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '973800' });
  await store.transact([lower, first, older].map(c => ({ space: 'catalogTypes', id: c.id, value: c })));
  return { store, directory };
}

test('a v2 compound is found by its id, sorts by its tier value and leads the records by tier', async t => {
  const { store } = await open(t);
  try {
    const api = createPublicAPI({ views: { store } });
    const found = await api.read(`/compounds?asset=${encodeURIComponent(first.id)}&limit=1`);
    assert.deepEqual(found.compounds.map(c => c.id), [first.id]);
    assert.deepEqual((await api.read('/compounds?asset=c2%3A' + 'e'.repeat(64) + '&limit=1')).compounds, []);
    const byTier = await api.read('/compounds?sort=tier&order=desc&limit=3');
    assert.deepEqual(byTier.compounds.map(c => c.tier.value), [5, 5, 3]);
    assert.deepEqual((await api.read('/compounds?tier=5&limit=10')).compounds.map(c => c.id).sort(), [older.id, first.id].sort());
    // A v2 mass is a commitment, not a size: there is no mass sort.
    await assert.rejects(api.read('/compounds?sort=mass&limit=3'), /projection_sort/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM publicOrderV2 WHERE kind='compounds' AND sort='mass'").get().n, 0);
    const records = rankingHighlights(store);
    assert.equal(records.biggestCompound, undefined, 'a mass commitment is not a size');
    assert.deepEqual(records.highestTierCompound, { asset: first.id, tier: 5, generation: '1', recipe: 'fusion',
      inputs: [{ asset: 'p2:1', amount: '1' }, { asset: 'p2:2', amount: '1' }], firstMaker: maker, snapshotHeight: '973796' });
  } finally { await store.close(); }
});

test('reopening a store repairs compound sort keys written before v2 tiers', async t => {
  let { store, directory } = await open(t);
  // The earlier projection wrote String(tier) for an object tier and had no rank sort.
  store.db.exec("UPDATE publicOrderV2 SET key='[object Object]' WHERE kind='compounds' AND sort='tier'");
  store.db.exec("DELETE FROM publicOrderV2 WHERE kind='compounds' AND sort='rank'");
  store.db.exec("DELETE FROM public_projection_fixes WHERE name='compound-v2-sorts'");
  await store.close();
  store = await Store.open(directory);
  try {
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM publicOrderV2 WHERE kind='compounds' AND key='[object Object]'").get().n, 0);
    assert.equal(rankingHighlights(store).highestTierCompound.asset, first.id);
    const api = createPublicAPI({ views: { store } });
    assert.deepEqual((await api.read('/compounds?sort=tier&order=asc&limit=3')).compounds.map(c => c.tier.value), [3, 5, 5]);
  } finally { await store.close(); }
});

test('compound and compound mint pages open by their c2 id', async () => {
  const web = createWeb({ target: {}, records: async () => ({}) });
  for (const path of ['/compound/' + first.id, '/mint/' + first.id]) {
    const headers = {}; let body;
    const res = { setHeader: (k, v) => { headers[k] = v; }, end: value => { body = value; } };
    assert.equal(await web.handle({ url: path, method: 'GET', headers: { accept: 'text/html' } }, res), true, path);
    assert.match(headers['Content-Type'], /text\/html/); assert.match(String(body), /<html|<!doctype/i);
  }
  const res = { setHeader() {}, end() {} };
  assert.equal(await web.handle({ url: '/mint/c2:xyz', method: 'GET', headers: { accept: 'text/html' } }, res), false);
});
