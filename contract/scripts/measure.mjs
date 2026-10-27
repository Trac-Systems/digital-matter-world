import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { harness, person, signedBatch, deployment } from '../tests/helpers/harness.mjs';
import { chain, beaconOptions, addr } from '../tests/helpers/chain.mjs';
import { BitcoinBeacon as ResetBeacon } from '../tests/helpers/reset-beacon.js';
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const h=harness(),agents=Array.from({length:500},(_,i)=>person(i+100));
await h.advance(6);
for(let i=0;i<500;i+=100){await h.advance(1);assert.equal(await h.batch(agents.slice(i,i+100).map(a=>({op:'mk',to:a.address,asset:'matter',amount:'100'}))),null);}
await h.advance(2200);
const before={...h.metrics};await h.advance(1);
const header=Object.fromEntries(Object.keys(before).map(k=>[k,h.metrics[k]-before[k]]));
const batches=[];
for(const credits of [1,3,8,16,64,128]){
  const head=await h.state().head(),parent=await h.state().beacon().raw(head.tip.hash),hx=chain(1,parent),last=await h.state().batchLast();
  const batch=signedBatch({n:last.n+1,from:last.to+1,to:head.counted+1,hx,ops:Array.from({length:credits},(_,i)=>({op:'mk',to:agents[i].address,asset:'matter',amount:'1'}))});
  const before={...h.metrics};assert.equal(await h.run('bt',batch),null);
  const changes=Object.fromEntries(Object.keys(before).map(k=>[k,h.metrics[k]-before[k]]));
  batches.push({credits,...changes,batchBytes:bytes(batch)});
}
const reset=new ResetBeacon(beaconOptions),headers=chain(2201);
for(let i=0;i<headers.length;i+=20) assert.equal(reset.ingest(headers.slice(i,i+20),addr(1)).error,undefined);
const fixture=JSON.parse(await readFile(new URL('../tests/fixtures/mainnet-retarget.json',import.meta.url),'utf8'));
const main=harness({...deployment,beacon:{checkpoint:fixture.checkpoint}});
for(let i=1;i<fixture.headers.length-1;i+=20) assert.equal(await main.run('hd',{headers:fixture.headers.slice(i,Math.min(i+20,fixture.headers.length-1))}),null);
const mainBefore={...main.metrics};assert.equal(await main.run('hd',{headers:fixture.headers.slice(-1)}),null);
const mainnetHeader=Object.fromEntries(Object.keys(mainBefore).map(k=>[k,main.metrics[k]-mainBefore[k]]));
const result={method:'Logical UTF8 key + JSON value bytes per put; key bytes per delete. Combined header/batch measurements; real runtime and physical disk are measured separately by measure:devnet.',agents:500,header,mainnetHeader,batches,resetPerHeaderBytes:Buffer.byteLength('beacon/state')+bytes(reset.exportState({compact:true})),viewValueBytes:[...h.db].reduce((n,[k,v])=>n+Buffer.byteLength(k)+bytes(v),0)};
await writeFile(new URL('../measurements.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
