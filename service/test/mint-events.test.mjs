import test from 'node:test';
import assert from 'node:assert/strict';
import { mintEventChanges, liveHold, holdKey } from '../local/mint-events.mjs';
const id='ab'.repeat(32),key='m/'+id;
function store(){const rows=new Map();return {get:(s,k)=>rows.get(s+'/'+k),apply:ops=>{for(const op of ops)if(op.value===undefined)rows.delete(op.space+'/'+op.id);else rows.set(op.space+'/'+op.id,op.value);}};}
for(const block of [undefined,0])test(`reservation height survives hold and consumption (${block===undefined?'compound':'pattern'})`,async()=>{
 const e=store(),pending={s:0,asset:'p0',e:532,...(block===undefined?{}:{block})};
 const scan=await mintEventChanges(e,[{key:'b/cnt',value:100},{key,value:pending},{key:'b/cnt',value:101},{key,value:{...pending,h:true}},{key:'b/cnt',value:102},{key,value:{...pending,h:true,s:1,permitHash:'permit'}}]);e.apply(scan.changes);
 assert.deepEqual(e.get('acceptances',id),{id,created:100,expiry:532});
 assert.deepEqual(e.get('exits',id),{op:'mc',height:102,permitHash:'permit'});
 const next=await mintEventChanges(e,[{key:'b/cnt',value:103},{key,value:{...pending,h:true}}]);e.apply(next.changes);assert.equal(e.get('acceptances',id).created,100);
});
test('paid holds remain exclusive after expiry and consumption; deletion releases the index',async()=>{
 const e=store(),pending={s:0,asset:'p0',block:0,e:20,h:true};e.apply((await mintEventChanges(e,[{key,value:pending}])).changes);
 const api={dmwMint:async()=>({...pending,s:1}),dmwHead:async()=>({counted:1000})};
 assert.deepEqual(await liveHold(e,api,'p0',0),{id,expiry:Number.MAX_SAFE_INTEGER});
 e.apply((await mintEventChanges(e,[{key,type:'del'}])).changes);assert.equal(e.get('liveHolds',holdKey('p0',0)),undefined);assert.equal(await liveHold(e,api,'p0',0),null);
});
