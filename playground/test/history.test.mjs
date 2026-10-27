import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { BUILD } from '../common.mjs';
import { loadHistory,loadRegtestHistory,historyProof } from '../../kit/lib/headers.mjs';
import { parseHeader } from '../../rules/src/index.js';
import { mine } from '../../contract/tests/helpers/chain.mjs';
import { historySnapshot } from '../kit-adapter.mjs';
const genesis='0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000';
async function file(t,rows){await mkdir(join(BUILD,'playground-tests'),{recursive:true});const dir=await mkdtemp(join(BUILD,'playground-tests/headers-'));t.after(()=>rm(dir,{recursive:true}));const path=join(dir,'headers.bin');await writeFile(path,Buffer.concat(rows.map(r=>Buffer.from(r,'hex'))));return path;}
test('regtest verifier pins genesis and checks a complete local chain; mainnet loader stays strict',async t=>{
  const first=parseHeader(genesis),next=mine(first.hash,first.time+1),path=await file(t,[genesis,next]);
  const history=await loadRegtestHistory(path);assert.equal(historyProof(history).network,'regtest');assert.equal(history.length,2);assert.equal(historyProof(history).tip,parseHeader(next).hash);
  await assert.rejects(loadHistory(path),/header_pow/);
});
test('playground snapshots use the ord reader after the RPC reader was removed',async t=>{
  const g=parseHeader(genesis),next=mine(g.hash,g.time+1),rows=[genesis,next],tip=parseHeader(next).hash;
  const path=await file(t,rows);
  const reads={client:{tip:async()=>({height:1,hash:tip})},views:{view:async(height,hash)=>{
    assert.equal(height,1);assert.equal(hash,tip);return {length:2,raw:h=>rows[h]};
  }}};
  const history=await historySnapshot(reads,dirname(path));
  assert.equal(history.length,2);assert.equal(historyProof(history).tip,tip);
});
test('regtest verifier rejects foreign genesis, broken links, non-PoW and median-time violations',async t=>{
  const g=parseHeader(genesis);
  await assert.rejects(loadRegtestHistory(await file(t,[mine('0'.repeat(64),g.time)])),/genesis/);
  await assert.rejects(loadRegtestHistory(await file(t,[genesis,mine('1'.repeat(64),g.time+1)])),/does not link/);
  await assert.rejects(loadRegtestHistory(await file(t,[genesis,mine(g.hash,g.time)])),/median time/);
  const bad=Buffer.from(mine(g.hash,g.time+1),'hex');let nonce=0;do{bad.writeUInt32LE(nonce++,76);}while(BigInt('0x'+parseHeader(bad).hash)<=0x7fffffn*256n**29n);
  await assert.rejects(loadRegtestHistory(await file(t,[genesis,bad.toString('hex')])),/proof of work/);
});
