import test from 'node:test';
import assert from 'node:assert/strict';
import { AcceptedAssetSupply } from '../asset-supply.mjs';
import { MemoryStore } from './helpers.mjs';
import { heightKey } from '../../src/util.mjs';

test('legacy supply checkpoint resumes decimal batches, credits, crafts and consumes once across restart', async () => {
  const store = new MemoryStore(), old = { n: 75, root: 'old', totals: { p0: '10' } };
  await store.put('prodAssetSupply', 'checkpoint', old);
  const ops = [{ op: 'ar', actions: [{ type: 'credits', assets: [['p0', '5']] },
    { type: 'craft', in: [['p0', '3']], out: [['c2:test', '1']] }, { type: 'consume', id: 'mint', permitHash: 'permit' }] }];
  await store.put('batches', heightKey('76'), { batch: { n: '76', root: 'new', ops } });
  const trac = async (method, args) => method === 'batchLast' ? { n: '76', to: '75' } : method === 'root'
    ? String(args[0]) === '75' ? 'old' : 'new' : { state: 'consumed', asset: 'p0', amount: '2', permitHash: 'permit' };
  assert.deepEqual(await new AcceptedAssetSupply({ store, trac }).read(), { p0: '10', 'c2:test': '1' });
  assert.deepEqual(await new AcceptedAssetSupply({ store, trac }).read(), { p0: '10', 'c2:test': '1' });
  assert.deepEqual(store.get('prodAssetSupply', 'checkpoint'), old);
  assert.equal(store.get('prodAssetSupplyV2', 'checkpoint').n, '76');
});

test('v2 supply continuation handles sequences beyond the Number boundary and still binds the original root', async () => {
  const store = new MemoryStore(), before = '9007199254740993', next = '9007199254740994';
  await store.put('prodAssetSupplyV2', 'checkpoint', { n: before, root: 'old', totals: {} });
  await store.put('batches', heightKey(next), { batch: { n: next, root: 'new', ops: [{ op: 'ar', actions: [{ type: 'credit', asset: 'p2:0', amount: '1' }] }] } });
  let changed = false;
  const trac = async (method, args) => method === 'batchLast' ? { n: next, to: '75' } : args[0] === before ? 'old' : changed ? 'bad' : 'new';
  assert.deepEqual(await new AcceptedAssetSupply({ store, trac, pageBatches: 1 }).read(), { 'p2:0': '1' });
  changed = true; await assert.rejects(new AcceptedAssetSupply({ store, trac }).read(), /asset_supply_rewound/);
});
