import assert from 'node:assert/strict';
import { writeFile, statfs } from 'node:fs/promises';
import { harness, person, signedBatch, signedRequest, nonce, invariants, deployment } from '../tests/helpers/harness.mjs';
import { bytesToHex, sha256, hexToBytes, requestDigest } from '../signing.js';
import { chain } from '../tests/helpers/chain.mjs';
const disk=await statfs('/');if(disk.bavail*disk.bsize<100_000_000_000)throw new Error('Less than 100 GB free');
const blocks=Number(process.argv[2]??12960);if(!Number.isSafeInteger(blocks)||blocks<144)throw new Error('At least 144 blocks');
let seed=0x5a17c0de;const random=n=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%n;};
const agents=Array.from({length:500},(_,i)=>person(i+100)),h=harness(),preimage='42'.repeat(32),hash=bytesToHex(sha256(hexToBytes(preimage)));
let accepted=0,refused=0,previous=0,serial=0,latestBatch;const errors={};
const check=error=>{if(error){refused++;errors[error]=(errors[error]??0)+1;}else accepted++;previous=invariants(h.db,previous,h.supply);};
const submit=async(ops,hx)=>{
  const last=await h.state().batchLast(),height=(await h.state().head()).counted+(hx?1:0);
  const b=signedBatch({n:last.n+1,from:last.to+1,to:height,ops,...(hx?{hx}:{})});const error=await h.run('bt',b);check(error);if(!error)latestBatch=b;return error;
};
await h.advance(6);
for(let i=0;i<500;i+=100){await h.advance(1);assert.equal(await submit(agents.slice(i,i+100).map(a=>({op:'mk',to:a.address,asset:'matter',amount:'100'}))),null);}
const started=Date.now();
for(let block=0;block<blocks;block++){
  const head=await h.state().head(),parent=await h.state().beacon().raw(head.tip.hash),hx=chain(1,parent);
  assert.equal(await submit(Array.from({length:1+random(16)},()=>({op:'mk',to:agents[random(500)].address,asset:random(4)?'matter':'compound',amount:String(1+random(10))})),hx),null);
  const height=(await h.state().head()).counted,owner=agents[random(500)],to=agents[random(500)],asset=random(4)?'matter':'compound';
  const available=BigInt(await h.state().balance(await h.state().agent(owner.address),asset));
  const q=(random(4)?(available?1n+BigInt(random(Number(available>50n?50n:available))):1n):available+1n).toString();
  const request={owner:owner.address,asset,amount:q,receive:nonce(random(10000)),nonce:nonce(++serial),until:height+2,expires:height+433};
  switch(random(8)){
    case 0:case 1:check(await h.run('tf',{to:to.address,assets:[[asset,q]]},owner.address));break;
    case 2:case 3:check(await h.run('hl',{to:to.address,assets:[[asset,q]],hash,refund:height+6+random(144)},owner.address));break;
    case 4:await h.advance(1);check(null);await submit([signedRequest('rq',request,owner)]);break;
    case 5:case 6:{await h.advance(1);check(null);const r={owner:owner.address,in:[[asset,q]],out:[[asset==='matter'?'compound':'matter',q]],nonce:request.nonce,until:height+2};await submit([signedRequest('xc',r,owner,random(3)?deployment.network:'foreign')]);break;}
    case 7:check(await h.run('tf',{to:to.address,assets:[[asset,'01']]},owner.address));break;
  }
  const locks=[...h.db].filter(([k])=>/^l\/[0-9a-f]{64}$/.test(k));
  if(locks.length){const [key]=locks[random(locks.length)];const claim=random(2);check(await h.run(claim?'hc':'hr',claim?{lock:key.slice(2),preimage:random(4)?preimage:nonce(0)}:{lock:key.slice(2)},to.address));}
  if(block%7===0){const pending=[...h.db].filter(([k,v])=>k.startsWith('m/')&&v.s===0);if(pending.length){const [key]=pending[random(pending.length)];await h.advance(1);check(null);await submit(random(2)?[{op:'rx',id:key.slice(2)}]:[{op:'rl',id:key.slice(2),inscription:nonce(block)+'i0'}]);}}
  if(block%19===0&&latestBatch)check(await h.run('bt',latestBatch));
  if(block%29===0){const last=await h.state().batchLast();check(await h.run('bt',{...signedBatch({n:last.n+1,from:last.to+1,to:height+10,ops:[]}),sig:'00'.repeat(64)}));}
  if(block%37===0)check(await h.run('bt',signedBatch({n:1,from:1,to:height,ops:[{op:'kv',key:'big',value:'x'.repeat(17000)}]})));
  if(block%41===0)check(await h.run('hd',{headers:['ff'.repeat(80)]}));
  if(block%53===0){
    const now=(await h.state().head()).counted;const ownerN=await h.state().agent(owner.address),amount=await h.state().balance(ownerN,'matter');
    if(BigInt(amount)>0n){await h.advance(1);check(null);const r=signedRequest('xc',{owner:owner.address,in:[['matter',amount]],out:[['compound',amount]],nonce:nonce(++serial),until:now+3},owner);
      const transfer=await h.run('tf',{to:agents[(agents.indexOf(owner)+1)%500].address,assets:[['matter',amount]]},owner.address);check(transfer);assert.equal(transfer,null);assert.equal(await submit([r]),'balance');}
  }
  if(block%1440===1439)console.log(JSON.stringify({blocks:block+1,accepted,refused,entries:h.db.size}));
}
const result={seed:'5a17c0de',blocks,simulatedClockBlocks:previous,minimumDays:blocks/144,agents:500,accepted,refused,errors,entries:h.db.size,seconds:(Date.now()-started)/1000,
  netSupply:Object.fromEntries([...h.supply].map(([k,v])=>[k,v.toString()])),checks:'Every attempted transaction: monotone clock, positive balances, per-asset credits minus exchange/mint burns = balances + locks + mint escrow; live mint escrow agreement; no item states.',metrics:h.metrics};
await writeFile(new URL('../simulation.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
