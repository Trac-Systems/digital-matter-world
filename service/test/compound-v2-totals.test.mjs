import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Feeds } from '../src/feeds.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { rules } from '../src/rules.mjs';
import { temp } from './helpers.mjs';

const owner = 'a'.repeat(64), A = 'c2:' + '1b'.repeat(32), B = 'c2:' + 'e4'.repeat(32);
const record = (id, generation) => ({ id, commitment: id.slice(3), v: 3, recipe: 'fusion', inputs: [], firstMaker: owner,
  properties: { version: 2, generation: String(generation) }, tier: { value: 5, expression: { op: 'tier' } }, snapshot: { hash: '0'.repeat(64), height: '973796' } });
const supply = (asset, outstanding, issued = outstanding) => ({ space: 'publicSupply', id: asset,
  value: { asset, issued, burned: String(BigInt(issued) - BigInt(outstanding)), outstanding, root: '0'.repeat(64), revision: '1' } });

test('a v2 compound keeps its units on Trac and units made real, per event and without scans', async () => {
  const directory = await temp(), store = await Store.open(directory);
  const feeds = new Feeds({ store, files: new Files(join(directory, 'static')), history: { get: h => ({ hash: rules.hash(String(h)) }) }, reads: {},
    settings: { projectionVersion: 3 } });
  const drain = async () => { let ticks = 0; do { await feeds.events(); assert.ok(++ticks < 20); } while (store.count('feedEvents')); };
  try {
    await store.put('meta', 'ruleState', { batchVersion: 2 });
    // A compound projected before these totals existed.
    await store.transact([{ space: 'catalogTypes', id: A, value: record(A, 1) }, supply(A, '1')]);
    await drain();
    assert.deepEqual([store.get('catalogTypes', A).supply, store.get('catalogTypes', A).madeReal], ['1', '0']);
    assert.deepEqual(store.get('meta', 'compoundTotalsFill'), { done: true });

    // From here on only the touched compounds are read; the catalog is never listed again.
    const list = store.list.bind(store);
    store.list = (space, options) => { assert.notEqual(space, 'catalogTypes', 'no catalog scan'); return list(space, options); };

    // Crafting B uses up A: the ledger leaves show it, the projection copies them.
    const action = { type: 'craft', owner, nonce: '0'.repeat(64), in: [[A, '1'], ['p2:1', '2']], out: [[B, '3']] };
    await store.transact([supply(A, '0', '1'), supply(B, '3'), { space: 'feedEvents', id: '1', value: { height: '100', tip: '100', observation: '1', batch: '1',
      types: { [B]: record(B, 2) }, crafts: [{ id: B, amount: '3', firstMaker: owner, record: record(B, 2), action, move: 'm1' }] } }]);
    await drain();
    assert.deepEqual([store.get('catalogTypes', B).supply, store.get('catalogTypes', B).madeReal], ['3', '0']);
    assert.equal(store.get('catalogTypes', A).supply, '0');

    // A transfer moves units between agents; the totals stay.
    await store.put('feedEvents', '2', { height: '101', tip: '101', observation: '2', batch: '2',
      transfers: [{ move: 'm2', action: { owner, to: 'b'.repeat(64), asset: B, amount: '1', nonce: '1'.repeat(64) } }] });
    await drain();
    assert.deepEqual([store.get('catalogTypes', B).supply, store.get('catalogTypes', B).madeReal], ['3', '0']);

    // Two units made real: consumed on Trac, then the TAP mint lands.
    const minted = { height: '102', tip: '102', observation: '3', batch: '3', financial: [
      { id: 'f1', type: 'financial_capacity_issue', data: { requestId: 'r1', owner, asset: B, amount: '2' }, provenance: { batch: '3' } },
      { id: 'f2', type: 'mint_complete', data: { requestId: 'r1', owner, asset: B, amount: '2' }, provenance: { batch: '3' } }] };
    await store.transact([supply(B, '1', '3'), { space: 'feedEvents', id: '3', value: minted }]);
    await drain();
    assert.deepEqual([store.get('catalogTypes', B).supply, store.get('catalogTypes', B).madeReal], ['1', '2']);
    // The same accepted mint seen again does not count twice.
    await store.put('feedEvents', '4', minted);
    await drain();
    assert.equal(store.get('catalogTypes', B).madeReal, '2');
    // A later type update (refined record) keeps the totals.
    await store.put('feedEvents', '5', { height: '103', tip: '103', observation: '5', batch: '5', types: { [B]: record(B, 2) } });
    await drain();
    assert.deepEqual([store.get('catalogTypes', B).supply, store.get('catalogTypes', B).madeReal], ['1', '2']);
    store.list = list;

    const api = createPublicAPI({ views: { store } });
    const page = await api.read('/compounds?sort=supply&order=desc&limit=5');
    assert.deepEqual(page.compounds.map(c => [c.id, c.supply, c.madeReal]), [[B, '1', '2'], [A, '0', '0']]);
    assert.deepEqual((await api.read(`/compounds?asset=${encodeURIComponent(B)}&limit=1`)).compounds.map(c => c.madeReal), ['2']);
  } finally { await store.close(); }
});
