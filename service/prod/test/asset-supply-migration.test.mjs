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


test('production supply keeps additional pattern units through consume and release while official and compound mints burn', async () => {
  const { PER_TICKER_SUPPLY_HEIGHT } = await import('../../../rules/src/index.js');
  const store = new MemoryStore(), calls = [], capacities = {
    official: { plot: '1' }, extra: { plot: '1', supplyScope: 'extra-deployment' }, compound: { plot: null, supplyScope: 'compound-deployment' } };
  let last = '1';
  const actions = [{ type: 'credits', assets: [['p2:0', '10'], ['c2:test', '10']] },
    ...Object.keys(capacities).map(id => ({ type: 'consume', id, permitHash: id }))];
  await store.put('batches', heightKey('1'), { batch: { n: '1', root: 'root1', execution: { height: PER_TICKER_SUPPLY_HEIGHT }, ops: [{ op: 'ar', actions }] } });
  const trac = async (method, args) => {
    calls.push([method, args]);
    if (method === 'batchLast') return { n: last };
    if (method === 'root') return 'root' + args[0];
    assert.equal(method, 'read'); const [kind, id] = args[0].split('/');
    return kind === 'dc' ? capacities[id] : { state: 'consumed', permitHash: id, asset: id === 'compound' ? 'c2:test' : 'p2:0', amount: '2' };
  };
  assert.deepEqual(await new AcceptedAssetSupply({ store, trac }).read(), { 'p2:0': '8', 'c2:test': '8' });
  last = '2';
  await store.put('batches', heightKey(last), { batch: { n: last, root: 'root2', execution: { height: PER_TICKER_SUPPLY_HEIGHT },
    ops: [{ op: 'ar', actions: [{ type: 'release-mint', id: 'extra' }] }] } });
  assert.deepEqual(await new AcceptedAssetSupply({ store, trac }).read(), { 'p2:0': '8', 'c2:test': '8' });
  assert.deepEqual(calls.filter(([method]) => method === 'read').map(([, args]) => args[0]), ['ao/official', 'dc/official', 'ao/extra', 'dc/extra', 'ao/compound', 'dc/compound']);
});

test('production supply retains additional compound holds and releases with an authenticated issuance cap', async () => {
  const { PER_TICKER_SUPPLY_HEIGHT } = await import('../../../rules/src/index.js');
  const store = new MemoryStore(), asset = 'c2:' + '1'.repeat(64), calls = [];
  await store.put('batches', heightKey('1'), { batch: { n: '1', root: 'root1', execution: { height: PER_TICKER_SUPPLY_HEIGHT },
    ops: [{ op: 'ar', actions: [{ type: 'credit', asset, amount: '7' }, { type: 'consume', id: 'extra', permitHash: 'permit' }, { type: 'release-mint', id: 'extra' }] }] } });
  const trac = async (method, args) => {
    calls.push([method, args]);
    if (method === 'batchLast') return { n: '1' };
    if (method === 'root') return 'root1';
    assert.equal(method, 'read');
    return args[0] === 'dc/extra' ? { plot: null, supplyScope: 'additional', supplyIssued: '7' } :
      { state: 'consumed', permitHash: 'permit', asset, amount: '7', unitsReleased: true };
  };
  assert.deepEqual(await new AcceptedAssetSupply({ store, trac }).read(), { [asset]: '7' });
  assert.deepEqual(await new AcceptedAssetSupply({ store, trac }).read(), { [asset]: '7' });
  assert.deepEqual(calls.filter(([method]) => method === 'read').map(([, args]) => args[0]), ['ao/extra', 'dc/extra']);
});
