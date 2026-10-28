import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TapLookupIndex } from '../tap-index.mjs';
import { BitmapIndex } from '../bitmap-index.mjs';
import { pageRows } from '../../src/paging.mjs';
import { playerSpecs } from '../../src/read-specs.mjs';
import { temporary, MemoryStore } from './helpers.mjs';
const spec = { ...playerSpecs.bitmaps, route: '/wallet' };

test('wallet inventory resumes pages, seeks results and tracks transfers back without a new history entry', async t => {
  const filename = join(await temporary(t), 'wallet.sqlite'), ids = Array.from({ length: 1201 }, (_, i) => 'ins-' + i);
  const current = new Map(ids.map((ins, bm) => [ins, { ins, bm, ownr: 'wallet' }]));
  const state = { height: 10, hash: 'aa', events: [], calls: [] };
  const indexer = { bitcoin: { blockHash: async () => state.hash }, stamp: async () => ({ height: state.height, hash: state.hash }), at: async (_v, fn) => fn(), tap: async path => {
    state.calls.push(path);
    if (path === 'getBitmapWalletHistoricListLength/wallet') return ids.length;
    if (path.includes('ListLength')) return 0;
    if (path.startsWith('getBitmapWalletHistoricList/')) { const q = new URLSearchParams(path.split('?')[1]), off = Number(q.get('offset')); return ids.slice(off, off + Number(q.get('max'))); }
    if (path.startsWith('getBitmapByInscription/')) return current.get(path.split('/')[1]);
    if (path.startsWith('getBitmapEventByBlockLength/')) return state.events.length;
    if (path.startsWith('getBitmapEventByBlock/')) return state.events;
    throw Error(path);
  } };
  const store = new MemoryStore(); await store.put('links', '0000000000000002', { block: 2 });
  const options = { filename, indexer, settings: { walletItemsPerTick: 200 } }; let lookups = new TapLookupIndex(options), inventory = new BitmapIndex({ lookups, store });
  let source = await inventory.source('wallet'); assert.equal(pageRows(source, new URLSearchParams(), spec).meta.syncing, true);
  for (let i = 0; i < 7; i++) {
    await inventory.tick(); lookups.close(); lookups = new TapLookupIndex(options); inventory = new BitmapIndex({ lookups, store });
  }
  t.after(() => lookups.close());
  source = await inventory.source('wallet'); state.calls = [];
  let page = pageRows(source, new URLSearchParams({ limit: '2' }), spec);
  assert.deepEqual(page.entries.map(e => e.row.height), [0, 1]); assert.equal(page.meta.syncing, false);
  page = pageRows(source, new URLSearchParams({ limit: '2', cursor: page.meta.next }), spec);
  assert.deepEqual(page.entries.map(e => e.row.height), [2, 3]); assert.equal(page.entries[0].row.linked, true);
  assert.equal(state.calls.length, 0, 'paging never enumerates or refreshes wallet history');
  current.set('ins-2', { ins: 'ins-2', bm: 2, ownr: 'other' }); state.height++; state.events = [current.get('ins-2')]; await inventory.tick();
  assert.equal(pageRows(await inventory.source('wallet'), new URLSearchParams({ height: '2' }), spec).entries.length, 0);
  current.set('ins-2', { ins: 'ins-2', bm: 2, ownr: 'wallet' }); state.height++; state.events = [current.get('ins-2')]; await inventory.tick();
  assert.equal(pageRows(await inventory.source('wallet'), new URLSearchParams({ height: '2' }), spec).entries.length, 1);
  state.hash = 'bb'; await assert.rejects(inventory.source('wallet'), /bitmap_index_reorg/);
  await inventory.tick();
  for (let i=0; i<12; i++) await inventory.tick();
  const fresh = await inventory.source('wallet');
  assert.throws(() => pageRows(fresh, new URLSearchParams({ limit: '2', cursor: page.meta.next }), spec), /bitmap_cursor_changed/);
});

test('an interrupted wallet tick persists the branch needed to reject a later reorg', async t => {
  const filename=join(await temporary(t),'wallet.sqlite'), state={height:10,fork:false,fail:false};
  const canonical=n=>n===11&&state.fork?'fork':'hash-'+n;
  const indexer={bitcoin:{blockHash:async n=>canonical(n)},stamp:async()=>({height:state.height,hash:canonical(state.height)}),at:async(_view,fn)=>fn(),tap:async path=>{
    if(path==='getBitmapWalletHistoricListLength/wallet')return 2;
    if(path.startsWith('getBitmapWalletHistoricList/'))return ['first','second'].slice(Number(new URLSearchParams(path.split('?')[1]).get('offset')));
    if(path.startsWith('getBitmapByInscription/')){const ins=path.split('/')[1];return {ins,bm:ins==='first'?1:2,ownr:'wallet'};}
    if(path.startsWith('getBitmapEventByBlockLength/')){if(state.fail)throw Error('interrupted');return 0;}
    throw Error(path);
  }};
  const options={filename,indexer,settings:{walletItemsPerTick:1}},store=new MemoryStore();
  let lookups=new TapLookupIndex(options),inventory=new BitmapIndex({lookups,store});
  await inventory.watch('wallet');await inventory.tick();state.height=11;state.fail=true;
  await assert.rejects(inventory.tick(),/interrupted/);
  assert.equal(lookups.db.prepare('SELECT count(*) AS n FROM bitmap_inventory').get().n,2);
  lookups.close();state.fork=true;lookups=new TapLookupIndex(options);inventory=new BitmapIndex({lookups,store});t.after(()=>lookups.close());
  await assert.rejects(inventory.source('wallet'),/bitmap_index_reorg/);
});
