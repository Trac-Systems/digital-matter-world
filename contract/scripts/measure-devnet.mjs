import assert from 'node:assert/strict';
import { statfs, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { localNetwork } from '../tests/helpers/local-network.mjs';
import { controls, until } from '../runtime/control.js';
import { deployment, person, signedBatch, invariants } from '../tests/helpers/harness.mjs';
import { chain, checkpoint, parseHeader } from '../tests/helpers/chain.mjs';
import { bytesToHex, sha256, hexToBytes } from '../signing.js';
const blocks=Number(process.argv[2]??1000);
if(!Number.isSafeInteger(blocks)||blocks<1||blocks>1500) throw new Error('Use 1..1500 blocks (at least 1000 for the full measurement)');
const disk=await statfs('/'); if(disk.bavail*disk.bsize<100_000_000_000) throw new Error('Less than 100 GB free');
const local=await localNetwork({cleanup:false});
await writeFile(join(local.root,'supervisor-pid.json'),JSON.stringify({pid:process.pid}));
console.log('MEASURE_START '+JSON.stringify({pid:process.pid,root:local.root,blocks}));
let closing; const close=()=>closing??=local.close();
const signal=()=>void close().then(()=>process.exit(1)); process.once('SIGTERM',signal); process.once('SIGINT',signal);
async function diskSize(directory) {
  let bytes=0,allocated=0,files=0;
  for(const name of await readdir(directory)) { const path=join(directory,name),s=await stat(path); if(s.isDirectory()){const d=await diskSize(path);bytes+=d.bytes;allocated+=d.allocated;files+=d.files;}else{bytes+=s.size;allocated+=s.blocks*512;files++;} }
  return {bytes,allocated,files};
}
const delta=(after,before)=>Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-before[k]]));
const prefix=/^(?:a\/|an\/|v\/|e\/|m\/|l\/|rq\/|b\/|bt\/|ad\/|s\/|n\/)/;
try {
  const validator=await local.msb(),bus=await local.client(validator);
  const indexer=await local.peer('indexer',bus),writer=await local.peer('writer',bus,indexer.base.key.toString('hex'));
  const ci=controls(indexer,bus),cw=controls(writer,bus);
  await local.fund(validator,indexer.wallet);await local.fund(validator,writer.wallet);
  await ci.setup({writer:writer.writerLocalKey});await until(()=>writer.base.writable,'writer admitted');
  const agents=[indexer.wallet.publicKey,writer.wallet.publicKey,...Array.from({length:498},(_,i)=>person(i+100).address)];
  const warm=chain(2055,checkpoint);
  for(let i=0;i<2050;i+=20) await ci.post({op:'hd',value:{headers:warm.slice(i,Math.min(i+20,2050))}});
  for(let i=0;i<5;i++) await ci.post({op:'bt',value:signedBatch({n:i+1,from:i?2046+i:1,to:2046+i,hx:[warm[2050+i]],ops:agents.slice(i*100,i*100+100).map(to=>({op:'mk',to,asset:'load',amount:'1000000'}))})});
  assert.equal((await ci.read({key:'a/last'})),500);
  const synchronized=async()=>{
    await indexer.base.update(); const version=indexer.base.view.version;
    await until(async()=>{await writer.base.update();return writer.base.view.version===version&&indexer.base.view.core.signedLength>=version;},'signed matching views',60000);
  };
  await synchronized();
  const flush=async()=>{await indexer.store.storage.db.flush();await writer.store.storage.db.flush();};
  const logs=()=>({indexerInput:indexer.base.local.byteLength,writerInput:writer.base.local.byteLength,view:indexer.base.view.core.byteLength,system:indexer.base.core.byteLength});
  await flush();
  const before={version:indexer.base.view.version,logs:logs(),indexerDisk:await diskSize(join(local.root,'indexer')),writerDisk:await diskSize(join(local.root,'writer')),busDisk:await diskSize(join(local.root,'bus-admin'))};
  const headers=chain(blocks,parseHeader(warm.at(-1))),preimage='42'.repeat(32),hash=bytesToHex(sha256(hexToBytes(preimage)));
  const started=Date.now(); const transactions=[],payloads=[]; let validatorReconnects=0,rebroadcasts=0;
  const submit=async(op,value)=>{
    if(bus.network.validatorConnectionManager.connectionCount()===0){
      await bus.network.tryConnect(validator.wallet.publicKey.toString('hex'),'validator');
      await until(()=>bus.network.validatorConnectionManager.connectionCount()>0,'local validator reconnect');validatorReconnects++;
    }
    const r=await writer.protocol.instance.tx({command:JSON.stringify({network:deployment.network,op,value})});transactions.push(r.txo.tx);payloads.push(r);};
  const drain=async()=>{
    const target=transactions.length;
    try { await until(async()=> (await ci.read({key:'txl'}))===target,'paid operations settled',2000); return; } catch {}
    console.log('MEASURE_RETRY '+JSON.stringify({target,applied:await ci.read({key:'txl'}),pool:writer.txPool.size(),connections:bus.network.validatorConnectionManager.connectionCount()}));
    if(bus.network.validatorConnectionManager.connectionCount()===0){
      await bus.network.tryConnect(validator.wallet.publicKey.toString('hex'),'validator');
      await until(()=>bus.network.validatorConnectionManager.connectionCount()>0,'local validator reconnect');validatorReconnects++;
    }
    for(const payload of payloads.slice(-50)) {
      if(!await writer.msbClient.getSignedAtLength(payload.txo.tx,writer.msbClient.getSignedLength())) {
        const ok=await bus.network.validatorMessageOrchestrator.send({...payload,tro:{tx:payload.txo.tx}});rebroadcasts++;
        console.log('MEASURE_REBROADCAST '+JSON.stringify({ok,tx:payload.txo.tx}));
      }
    }
    await until(async()=> (await ci.read({key:'txl'}))===target,'paid operations settled after retry',30000);
  };
  for(let i=0;i<blocks;i++) {
    const ops=Array.from({length:16},(_,j)=>({op:'mk',to:agents[(i*16+j)%500],asset:'load',amount:'1'}));
    await ci.post({op:'bt',value:signedBatch({n:i+6,from:i+2051,to:i+2051,hx:[headers[i]],ops})});
    await submit('tf',{to:indexer.wallet.publicKey,assets:[['load','1']]});
    await submit('hl',{to:indexer.wallet.publicKey,assets:[['load','1']],hash,refund:4066});
    if(i%25===24||i===blocks-1) {await drain();console.log('MEASURE_PROGRESS '+JSON.stringify({blocks:i+1,paid:transactions.length,seconds:(Date.now()-started)/1000}));}
  }
  await synchronized();
  const rows=new Map(await ci.rows()),other=new Map(await cw.rows());assert.deepEqual(rows,other);
  assert.equal(rows.get('a/last'),500);assert.equal(rows.get('b/cnt'),2050+blocks);
  const supply=new Map([['load',500_000_000n+16n*BigInt(blocks)]]);invariants(rows,0,supply);
  assert.equal([...rows.keys()].filter(k=>/^l\/[0-9a-f]{64}$/.test(k)).length,blocks);
  for(const tx of transactions){const index=rows.get('tx/'+tx);assert.ok(Number.isSafeInteger(index));assert.equal(rows.get('txi/'+index).err,null);}
  const endVersion=indexer.base.view.version,contract={puts:0,deletes:0,bytes:0},bookkeeping={puts:0,deletes:0,bytes:0};
  for await(const row of indexer.base.view.createHistoryStream({gte:before.version,lt:endVersion})) {
    const target=prefix.test(row.key)?contract:bookkeeping;target[row.type==='del'?'deletes':'puts']++;
    target.bytes+=Buffer.byteLength(row.key)+(row.type==='del'?0:Buffer.byteLength(JSON.stringify(row.value)));
  }
  const physical=delta(logs(),before.logs);await flush();
  const indexerDisk=delta(await diskSize(join(local.root,'indexer')),before.indexerDisk),writerDisk=delta(await diskSize(join(local.root,'writer')),before.writerDisk);
  await close();
  const closedIndexerDisk=delta(await diskSize(join(local.root,'indexer')),before.indexerDisk),closedWriterDisk=delta(await diskSize(join(local.root,'writer')),before.writerDisk),busDisk=delta(await diskSize(join(local.root,'bus-admin')),before.busDisk);
  const result={blocks,agents:500,creditsPerBlock:16,paidTransfers:blocks,paidLocks:blocks,seconds:(Date.now()-started)/1000,warmupHeaders:2055,
    method:'Hyperbee committed history: UTF-8 key + JSON value bytes, deletes key only. Input log byteLength counts each writer once; view and system byteLength count one replica. Disk includes Corestore, indexes and metadata per peer; MSB separate. Baseline/final database flush; closed disk also reported. Synthetic blocks run faster than wall-clock Bitcoin.',
    contract,bookkeeping,physical,indexerDisk,writerDisk,closedIndexerDisk,closedWriterDisk,busDisk,
    perBlock:{contract:contract.bytes/blocks,bookkeeping:bookkeeping.bytes/blocks,inputLogs:(physical.indexerInput+physical.writerInput)/blocks,viewLog:physical.view/blocks,
      systemLog:physical.system/blocks,peerLogs:(physical.indexerInput+physical.writerInput+physical.view+physical.system)/blocks,indexerDisk:closedIndexerDisk.bytes/blocks,indexerAllocated:closedIndexerDisk.allocated/blocks,writerDisk:closedWriterDisk.bytes/blocks,writerAllocated:closedWriterDisk.allocated/blocks,msbDisk:busDisk.bytes/blocks},
    validatorReconnects,rebroadcasts,checks:{matchingViews:true,conservation:true,paidTransactions:transactions.length,retainedLocks:blocks,allPaidAccepted:true}};
  await writeFile(new URL('../measurements-devnet.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log('MEASURE_RESULT '+JSON.stringify(result));await rm(local.root,{recursive:true,force:true});
} finally {await close();process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);}
