import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walletBitmaps, createViews } from '../views.mjs';
import { Store } from '../../service/src/store.mjs';

test('Bitmap views preserve the indexed page source without enumerating wallet history', async () => {
  const calls = [], source = { page() { throw Error('view must not materialize the page'); } };
  const e = { reads: {
    bindings: { current: async (owner, rail) => { assert.equal(owner, 'owner'); assert.equal(rail, 'tap'); return { request: { address: 'player-address' } }; } },
    bitmapInventory: { source: async address => { calls.push(address); return source; } },
    tap: async () => { throw Error('wallet history must not be read'); },
  }, actor: async () => ({ address: 'owner' }) };
  assert.equal(await walletBitmaps(e, 'owner'), source);
  assert.equal(await createViews(e).playerList('bitmaps'), source);
  assert.deepEqual(calls, ['player-address', 'player-address']);
  delete e.reads.bitmapInventory;
  await assert.rejects(walletBitmaps(e, 'owner'), /bitmap_index_required/);
  e.reads.bindings.current = async () => null;
  assert.deepEqual(await walletBitmaps(e, 'owner'), []);
});

test('activated Bitmap views use only submitted owner projections', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bitmap-view-')), store = await Store.open(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true }); });
  const owner = '11'.repeat(32), other = '22'.repeat(32);
  await store.put('meta', 'ruleState', { batchVersion: 2 });
  const first = { block: '1', agent: owner, address: 'wallet', inscription: 'aa'.repeat(32) + 'i0', snapshot: { height: '10', hash: 'bb'.repeat(32) } };
  await store.put('submittedBitmaps', 'first', first);
  await store.put('submittedBitmaps', 'other', { ...first, block: '2', agent: other });
  const e = { store, reads: new Proxy({}, { get() { throw Error('activated views must not enumerate wallet history'); } }) };
  const page = await walletBitmaps(e, owner);
  assert.deepEqual(page.bitmaps, [{ ...first, height: '1', linked: false }]); assert.equal(page.total, null);
  await store.put('submittedBitmaps', 'first', { ...first, agent: other });
  assert.deepEqual((await walletBitmaps(e, owner)).bitmaps, []);
});

test('world flags minted plots including mints with no finder record',async()=>{
  const data=new Map([['minted/p0/1','ins1'],['minted/p1/2','ins2']]);
  const e={trac:async()=>({tip:{height:3},counted:3}),snapshot:async()=>({get:h=>({hash:'hash'+h})}),
    rows:s=>s==='finds'?[{asset:'p0',block:1},{asset:'p0',block:3}]:s==='minted'?[{id:'p0/1'},{id:'p1/2'}]:[],store:{get:(s,id)=>data.get(s+'/'+id)}};
  const plots=(await createViews(e).plots(0,3)).plots;
  assert.deepEqual(plots.map(p=>p.minted),[false,true,true,false]);assert.equal(plots[1].finds[0].minted,true);assert.equal(plots[3].finds[0].minted,false);
});

test('compound labels include recipe, quantities and element names',async()=>{
  const e={reads:{registry:async()=>({assets:{}})},trac:async()=>({}),rows:()=>[],patterns:()=>[{number:0,name:'Ember'},{number:1,name:'Tide'}],compounds:()=>[{id:'compound-id',recipe:'fusion',inputs:[['p0','2'],['p1','1']]}]};
  const result=await createViews(e).patterns();assert.equal(result.compounds[0].name,'Fusion: 2 Ember + 1 Tide');
});

test('results separate outstanding ERC-20 supply from actual released burns and exclude refunds', async () => {
  const mints = ['tap-claim', 'tap-refund', 'eth-release', 'eth-held', 'eth-refund'].map(id => ({
    id, kind: id.startsWith('tap') ? 'tap' : 'ethereum', paymentId: id, payer: 'payer', request: { asset: 'p0', amount: '1' },
  }));
  const e = {
    state: { addresses: { treasury: 'treasury' }, ethTreasury: '0x' + '12'.repeat(20), escrow: { token: 'token' } },
    rows: space => space === 'mints' ? mints : [], get: async () => ({}),
    reads: {
      tap: async path => path.startsWith('getBalance/') ? '100' : { action: path.endsWith('tap-claim') ? 'claim' : 'refund', al: [{ tt: 'b', amt: '20' }] },
      escrow: { deposit: async (_, id) => ({ deposit: { status: id === 'eth-release' ? 2 : id === 'eth-refund' ? 3 : 1, split: { burnAmount: '30' } } }) },
    },
    evm: { rpc: async (_, [call]) => call.data === '0x18160ddd' ? '0x3e8' : '0x64' },
  };
  const result = await createViews(e).results();
  assert.deepEqual(result.burn, { tap: '20', ethereum: '30' });
  assert.deepEqual(result.outstandingSupply, { ethereum: '1000' });
});
