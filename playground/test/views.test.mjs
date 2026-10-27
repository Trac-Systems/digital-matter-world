import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { walletBitmaps,bitmapHistoryPage,createViews } from '../views.mjs';
import { heightKey } from '../../service/src/util.mjs';
import { HttpSource } from '../../service/prod/http.mjs';
import { installLocalFetch } from '../../service/src/http-client.mjs';

test('Bitmap inventory paginates wallet history and excludes transferred-away holdings',async()=>{
  const calls=[],inscriptions=Array.from({length:501},(_,i)=>'ins'+i);
  const e={reads:{bindings:{current:()=>({request:{address:'player-address'}})},tap:async path=>{
    calls.push(path);
    if(path.startsWith('getBitmapWalletHistoricListLength/'))return 501;
    const inscription=path.split('/')[1],height=Number(inscription.slice(3));
    return {ins:inscription,bm:height,ownr:height===0||height===500?'player-address':'someone-else'};
  }},store:{get:(space,id)=>space==='links'&&id===heightKey(500)?{owner:'owner'}:null}};
  const offsets=[];const page=async(_,address,offset)=>{assert.equal(address,'player-address');offsets.push(offset);return inscriptions.slice(offset,offset+500);};
  assert.deepEqual(await walletBitmaps(e,'owner',page),[{height:0,inscription:'ins0',linked:false},{height:500,inscription:'ins500',linked:true}]);
  assert.deepEqual(offsets,[0,500]);
});

test('Bitmap pagination works under the service fetch guard and refuses remote endpoints and redirects',async t=>{
  let oversized=false,redirect=false;
  const server=createServer((req,res)=>{
    assert.equal(req.url,'/r/tap/getBitmapWalletHistoricList/player-address?offset=500&max=500');
    if(redirect){res.writeHead(302,{location:'http://127.0.0.1:1/'});res.end();return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(oversized?'x'.repeat(128001):JSON.stringify({result:['ins500']}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}`, manifest={ordSource:new HttpSource({url,retries:0,fetchImpl:globalThis.fetch[Symbol.for('dmw.localFetch')]??globalThis.fetch})};installLocalFetch();
  await assert.rejects(fetch(url+'/?offset=500'),/endpoint_must_be_loopback/);
  assert.deepEqual(await bitmapHistoryPage(manifest,'player-address',500),['ins500']);
  await assert.rejects(bitmapHistoryPage({ord:{url:'http://example.invalid'}},'player-address',500),/bitcoin_ord_required/);
  redirect=true;await assert.rejects(bitmapHistoryPage(manifest,'player-address',500),/http_unavailable/);
  redirect=false;oversized=true;await assert.rejects(bitmapHistoryPage(manifest,'player-address',500),/http_response_limit/);
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
