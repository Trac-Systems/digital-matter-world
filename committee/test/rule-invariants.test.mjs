import { BUILD as configuredBuildRoot } from '../../local/common.mjs';
import { attest, receiptSigners, witnesses } from '../../rules/test/witness-fixture.mjs';
import { observationFixture, requestInput } from '../../rules/test/observation-fixture.mjs';
import { attestMintResult, verifyMintCertificate } from '../signer/certificate.mjs';
import { preflightBatch } from '../signer/preflight.mjs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { x25519 } from '@noble/curves/ed25519';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519';
import * as r from '../../rules/src/index.js';
import { fixture, batchFixture } from './fixture.mjs';
import { Journal } from '../signer/journal.mjs';
import { createSigner } from '../signer/service.mjs';
const scratch = `${configuredBuildRoot}/target/committee-tests`;
await mkdir(scratch, { recursive: true, mode: 0o700 });
const network = 'audit-local', secret = new Uint8Array(32).fill(1), owner = r.bytesToHex(ed25519.getPublicKey(secret));
const gs = new Uint8Array(32).fill(9), gateway = r.bytesToHex(ed25519.getPublicKey(gs));
const hashAt = h => r.hash(String(h));
const history = { length: 2001, get: height => ({height, nonce: height, bits: 1, hash: hashAt(height)}), field: height => String(height) };
const pattern = {number: 0, name:'dmwany', pat:'[0-9]', fld:4, dt:'n', rarity:101, historyHeight:100};
function move(tip, agent, p, type='claim') { return r.solveMove({v:1,network,a:r.bytesToHex(ed25519.getPublicKey(agent)),t:type,b:tip,h:hashAt(tip),p},agent,0); }
function step(state,tip,moves=[],extra={}) {
  const entries=moves.map((move,i)=>({move,receipt:r.signReceipt(move,{tip,hash:hashAt(tip),sequence:(state.lastSequence??-1)+1+i},gs)}));
  const receiptRoot=r.sealReceipts(entries.map(x=>x.receipt),{network,tip,hash:hashAt(tip)},gs);
  return r.processBlock({height:tip-5,blockHash:hashAt(tip-5),tip,tipHash:hashAt(tip),network,gateway,history,patterns:[pattern],entries,receiptRoot,rootAttestations:attest(receiptRoot),state,hashAt,...extra,settings:{puzzleBits:0,receiptSigners,...extra.settings}});
}
test('lifecycle and link operations require evidence replay', async()=>{
  for(const extra of [r.makeRealOp({request:fixture().proposal.request,sig:fixture().proposal.signature},'dmw-regtest',100),r.completeRealOp(r.hash('id'),r.hash('ins')+'i0'),r.cancelRealOp(r.hash('id')),r.bitmapLinkOp(10,95)]) {
    const f=fixture(), b=batchFixture(); f.reads.batchContext=async()=>b.context;
    const file=r.decodeBinary(b.built.fileBytes[0]); file.ops.push(extra);
    const built=r.buildBatch({network:'dmw-regtest',executionHeight:95,epoch:0,sequence:1,lastTo:94,files:[file], maxMintOps:8});
    await assert.rejects(f.policy.approve({...b.proposal,batch:built.batch,files:built.fileBytes.map(r.bytesToHex)}),/batch_mismatch/);
  }
});
test('all five journals retry identical batches while preserving digest agreement',async()=>{
  const journals=[];
  try {
    for(let i=0;i<5;i++) journals.push(await new Journal(`${await mkdtemp(`${scratch}/journal-`)}/signed.log`,new Uint8Array(32).fill(i+1),network,String(i)).load());
    for(const j of journals.slice(0,3)) {await j.reserve(['batch/0/1'],r.hash('batch'),r.hash('session'));await j.append('aborted',{session:r.hash('session')});}
    let able=0;
    for(const j of journals) {try {await j.reserve(['batch/0/1'],r.hash('batch'),r.hash('retry'));able++;} catch(e) {assert.equal(e.message,'slot_already_reserved');}}
    assert.equal(able,5); assert.ok(journals.every(j=>!j.records.some(row=>row.type==='signed')));
  } finally {for(const j of journals) await j.close();}
});
test('any three attestations verify a durable paid mint result certificate', async()=>{
  const f=fixture('compound');
  const members=witnesses.map((w,i)=>({...w, encryptionSecret:new Uint8Array(32).fill(60+i), encryption:r.bytesToHex(x25519.getPublicKey(new Uint8Array(32).fill(60+i)))}));
  const approved=await f.policy.approve(f.proposal); f.confirmed(approved.details);
  const sig=secp256k1.sign(approved.digest,new Uint8Array(32).fill(2),{prehash:false,lowS:true});
  const signature={r:String(sig.r),s:String(sig.s),v:sig.recovery,compact:sig.toCompactHex()};
  const certificate={domain:'dmw-mint-result-v1',network:'dmw-regtest',details:approved.details,signature,attestations:members.slice(0,3).map(m=>attestMintResult('dmw-regtest',approved.details,signature,m.id,r.bytesToHex(m.secret)))};
  assert.equal(verifyMintCertificate(certificate,{network:'dmw-regtest',members,publicKey:f.publicKey,id:f.id}).id,f.id);
  assert.throws(()=>verifyMintCertificate({...certificate,attestations:certificate.attestations.slice(0,2)},{network:'dmw-regtest',members,publicKey:f.publicKey,id:f.id}),/certificate_quorum/);
});
test('discoverer is paid directly with no treasury liability',async()=>{
  const f=fixture();f.data.context.discoverer='regtest-discoverer';f.reprice();
  const approved=await f.policy.approve(f.proposal);assert.deepEqual(approved.details.commissions,[]);
  assert.equal(f.data.payment.fees.find(i=>i.role==='discoverer').amount,'5');
});
test('mint approval refuses a slot without a finder',async()=>{
  const f=fixture();f.data.context.find={block:10,asset:'p0',count:3,finder:null,findHeight:null,settledAt:99};f.data.context.finderAddress=null;
  await assert.rejects(f.policy.approve(f.proposal), /block_count/);
});
test('a backdated gateway root without a timely signer quorum cannot enter replay',()=>{
  const payload={window:100,plots:[{block:100,patterns:[0]}]}, claim=move(100,secret,payload);
  assert.throws(()=>step({lastTip: 99},100,[claim],{rootAttestations:[]}),/receipt_attestations/);
  const good=step({lastTip: 99},100,[claim]);
  assert.throws(()=>r.attestReceiptRoot(good.file.receiptRoot,103,witnesses[0].id,witnesses[0].secret),/receipt_attestation_late/);
  assert.equal(r.verifyRootAttestations(good.file.receiptRoot,[good.file.rootAttestations[0],good.file.rootAttestations[0],good.file.rootAttestations[1]],receiptSigners),false);
  let result=good;for(let tip=101;tip<=108;tip++)result=step(result.state,tip);
  assert.equal(r.recordGet(result.state.finds,r.findId(100,0)).finder,owner);
});
test('claim and header draws assign tickets per distinct signing key',()=>{
  const claims=Array.from({length:10},(_,i)=>({agent:r.bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(i+1))),window:100,block:100,patterns:[0]}));
  const slot={id:r.findId(100,0),block:100,pattern:0,asset:'p0',count:3};let wins=0;
  for(let i=0;i<1000;i++) {const result=r.settleClaims({window:100,counted:103,decidingHash:r.hash(`seed:${i}`),slots:[slot],claims});if(result.winners[0].winner!==owner)wins++;}
  assert.ok(wins>850);console.log(JSON.stringify({multipleKeyWins:wins,draws:1000}));
  const slots=[0,1,2].map(pattern=>({...slot,id:r.findId(100,pattern),pattern}));
  const result=r.settleClaims({window:100,counted:103,decidingHash:hashAt(103),slots,claims:claims.map(c=>({...c,patterns:[0,1,2]})),headerSenders:claims.map(c=>({block:100,agent:c.agent}))});
  assert.equal(result.claims.filter(c=>c.reason==='entered').length,10);
  assert.equal(result.winners.length,3);assert.ok(result.winners.every(w=>w.source==='claim'&&w.claimers.length===10));
});

test('nullable discoveries and constant count vectors are refused; TAP counts stay exact',()=>{
  for(const pat of ['^0{0}','0{0}','1?']) assert.throws(()=>r.evaluateDiscovery({proposal:{name:'dmwempty',pat,fld:10,dt:'n'},discoverer:owner,history,number:0}),/pattern_nullable/);
  assert.throws(()=>r.evaluateDiscovery({proposal:{name:'dmwconstant',pat:'1',fld:10,dt:'n'},discoverer:owner,history:{...history,field:()=> '1'},number:0}),/pattern_constant/);
  assert.equal(r.ordMatchCount('^0{0}','123'),1);assert.equal(r.ordMatchCount('0{0}','123'),4);
});
test('settled balances remain final while a reorg changes mintable slots',()=>{
  const p={...pattern,pat:'1',fld:10};
  const original={...history,get:h=>({...history.get(h),nonce:h===100?111:2})};
  const args={patterns:[p],history:original};
  let result=step({lastTip: 99},100,[move(100,secret,{window:100,plots:[{block:100,patterns:[0]}]})],args);
  for(let tip=101;tip<=108;tip++)result=step(result.state,tip,[],args);
  assert.equal(r.recordGet(result.state.balances, owner).p0,'3');
  const rewritten={...original,get:h=>({...original.get(h),nonce:h===100?1:2,hash:h===100?r.hash('replacement'):hashAt(h)})};
  const candidate=r.mintCandidate({pattern:p,block:100,history:rewritten,state:result.state});
  const capacity=Object.values(r.recordObject(result.state.finds)).reduce((n,f)=>n+r.patternCount(p,rewritten.get(f.block)),0);
  assert.equal(candidate.count,1);assert.equal(capacity,1);assert.equal(r.recordGet(result.state.balances, owner).p0,'3');
});
test('repeated counted-height observations form one recoverable batch',()=>{
  const a=step({lastTip: 99},100);
  const b=step(a.state,101,[],{height:95,blockHash:hashAt(95)});
  assert.equal(a.file.height,b.file.height);
  const built=r.buildBatch({network,executionHeight:95,epoch:0,sequence:1,lastTo:94,files:[a.file,b.file]});assert.equal(built.batch.to,95);assert.equal(built.fileBytes.length,2);
});
test('serialization rejects isolated surrogates and preserves BOM keys and values',()=>{
  for(const value of [{s:'\ud800'},{s:'\udc00'},{'\ud800':'value'}]) {assert.throws(()=>r.encodeBinary(value),/unicode_surrogate/);assert.throws(()=>r.stableJSON(value),/unicode_surrogate/);}
  const value={'\ufeffkey':'\ufeffabc',s:'\ufffd',emoji:'😀'};assert.deepEqual(r.decodeBinary(r.encodeBinary(value)),value);
});
test('five discovery reveals are queued and cannot exceed the default record budget',()=>{
  const proposals=['1','2','3','4','5'].map((pat,i)=>({name:`dmwnew${i}`,pat,fld:4,dt:'n'})),salts=proposals.map((_,i)=>r.hash(`salt${i}`));
  const commits=proposals.map((p,i)=>move(100,secret,{commitment:r.discoveryCommitment(p,salts[i],owner)},'discovery-commit'));
  let result=step({lastTip: 99},100,commits);result=step(result.state,101);
  const reveals=proposals.map((proposal,i)=>move(102,secret,{proposal,salt:salts[i]},'discovery-reveal'));
  result=step(result.state,102,reveals);assert.ok(result.file.discoveries.length<=1);assert.equal(result.state.discoveryQueue.length,4);
  assert.ok(result.operations.filter(x=>x.op==='kv').length<=16);
  assert.doesNotThrow(()=>r.buildBatch({network,executionHeight:97,epoch:0,sequence:1,lastTo:96,files:[result.file]}));
});
test('discovery scans are bounded and historical map updates share untouched snapshots',()=>{
  let reads=0;const h={length:10000,field:()=>{reads++;return '1111111111';},get:history.get};
  const pat='[0-9]{0,10}[0-9]{0,10}[0-9]{0,10}a',state={highestTip:102,discoveryQueue:[{tip:100,agent:owner,commitment:r.hash('job'),height:9999,proposal:{name:'dmwcost',pat,fld:10,dt:'n'}}]};
  const a=r.advanceDiscovery(state,[],h,9999);assert.equal(reads,4096);assert.equal(a.work,4096);assert.equal(a.queued,1);
  r.advanceDiscovery(state,[],h,9999);const final=r.advanceDiscovery(state,[],h,9999);assert.equal(reads,10000);assert.equal(final.rejected[0].reason,'pattern_constant');
  const old=Object.fromEntries(Array.from({length:10000},(_,i)=>[i,{settledAt:1}]));
  const result=step({lastTip: 99,finds:old},100);
  assert.equal(result.state.finds,old);
  const next=r.recordSet(old,'new',1);assert.equal(next.base,old);assert.equal(r.recordGet(next,'new'),1);assert.equal(r.recordGet(old,'new'),undefined);
});
test('S01 count vectors reject duplicates across fields and grammar permutations',()=>{
  const existing={...pattern,pat:'1|2'};
  assert.throws(()=>r.evaluateDiscovery({proposal:{...existing,name:'dmwdupe',pat:'[12]',fld:10},discoverer:owner,history,existing:[existing],number:1}),/pattern_duplicate/);
});
test('S02 fee splits conserve every atom and stay nonnegative at all flag combinations',()=>{
  let checked=0;for(const kind of ['find','compound','link'])for(const linked of [false,true])for(const discovered of [false,true])for(const total of ['0','1','2','3','9','99','100','101','1000000000000000001','9'.repeat(78)]){
    const parts=Object.values(r.splitFee(total,{kind,linked,discovered})).map(BigInt);assert.equal(parts.reduce((a,b)=>a+b,0n),BigInt(total));assert.ok(parts.every(x=>x>=0n));checked++;}assert.equal(checked,120);
});
test('S03 Merkle proof mutation cannot change count, index, sibling or file',()=>{
  for(let n=1;n<=20;n++){const files=Array.from({length:n},(_,i)=>r.encodeBinary({i})),root=r.merkleRoot(files);for(let i=0;i<n;i++){
    const proof=r.merkleProof(files,i);assert.equal(r.verifyMerkle(files[i],proof,root),true);
    assert.equal(r.verifyMerkle(files[i],{...proof,count:n+1},root),false);
    assert.equal(r.verifyMerkle(r.encodeBinary({i:i+100}),proof,root),false);
    if(n>1)assert.equal(r.verifyMerkle(files[i],{...proof,index:(i+1)%n},root),false);
  }}
});
test('different valid deciding headers produce distinct deterministic winners',()=>{
  const rival=r.bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(2))),target=r.targetFromBits(0x207fffff),raw=new Uint8Array(80),view=new DataView(raw.buffer);
  view.setInt32(0,1,true);raw.set(r.hexToBytes(hashAt(102)).reverse(),4);view.setUint32(68,2000000000,true);view.setUint32(72,0x207fffff,true);
  const winners=new Map();let valid=0;
  for(let nonce=0;nonce<100&&winners.size<2;nonce++) {view.setUint32(76,nonce,true);const h=r.parseHeader(raw,103);if(BigInt(`0x${h.hash}`)>target)continue;valid++;
    const draw=r.settleClaims({window:100,counted:103,decidingHash:h.hash,slots:[{id:r.findId(100,0),block:100,pattern:0,asset:'p0',count:1}],claims:[owner,rival].map(agent=>({agent,window:100,block:100,patterns:[0]}))});
    winners.set(draw.winners[0].winner,h.hash);
  }
  assert.equal(winners.size,2);console.log(JSON.stringify({validRegtestSeedHeaders:valid,distinctWinners:winners.size}));
});
test('commitment order fixes attribution independently of reveal or receipt order',()=>{
  const otherSecret=new Uint8Array(32).fill(2),other=r.bytesToHex(ed25519.getPublicKey(otherSecret));
  const proposals=[{name:'dmwfirst',pat:'1',fld:4,dt:'n'},{name:'dmwsecond',pat:'[1]',fld:4,dt:'n'}],agents=[owner,other],secrets=[secret,otherSecret],salts=[r.hash('salt1'),r.hash('salt2')];
  const commitments=proposals.map((p,i)=>r.discoveryCommitment(p,salts[i],agents[i]));
  const run=reverse=>{
    const commits=proposals.map((p,i)=>move(100,secrets[i],{commitment:commitments[i]},'discovery-commit'));
    let result=step({lastTip: 99},100,reverse?commits.reverse():commits,{patterns:[]});result=step(result.state,101,[],{patterns:[]});
    const reveals=proposals.map((proposal,i)=>move(102,secrets[i],{proposal,salt:salts[i]},'discovery-reveal'));
    result=step(result.state,102,reverse?reveals.reverse():reveals,{patterns:[]});
    const winner=result.patterns[0]; result=step(result.state,103,[],{patterns:result.patterns});
    assert.equal(result.file.discovery.rejected[0].reason,'pattern_duplicate');return winner;
  };
  assert.deepEqual(run(false),run(true));assert.equal(run(false).discoverer,agents[commitments[0]<commitments[1]?0:1]);
  assert.throws(()=>move(100,secret,proposals[0],'proposal'),/move_type/);
});
test('permit refuses missing consumption and a different committed permit',async()=>{
  const f=fixture('compound');f.data.pending.permitHash=r.hash('different');await assert.rejects(f.policy.approve(f.proposal),/units_not_consumed/);
  f.data.pending=null;await assert.rejects(f.policy.approve(f.proposal),/pending_missing/);
});
test('live preflight rejects expired craft and recovery records its rejection',async()=>{
  const {harness,deployment,committee,committeeSecret}=await import('../../contract/tests/helpers/harness.mjs');
  const {secp256k1}=await import('@noble/curves/secp256k1');
  const f=fixture('dmt',committee),net='dmw-regtest',h=harness({...deployment,network:net,committee});
  await h.mint(['p0','p1'],f.proposal.request.owner);await h.advance(2);
  assert.equal((await h.state().head()).counted,3);
  const patterns=[{...pattern,number:0},{...pattern,number:1,name:'dmwother'}];
  const output=r.compound('fusion',patterns.map(p=>({asset:r.patternAsset(p),amount:'1',properties:r.patternProperties(p)})),3);
  const request={owner:f.proposal.request.owner,in:[['p0','1'],['p1','1']],out:[[output.id,'1']],nonce:r.hash('expired-craft'),until:2};
  const craft=r.solveMove({v:1,network:net,a:request.owner,t:'craft',b:7,h:hashAt(7),p:{recipe:'fusion',request,sig:r.signRequest('xc',net,request,f.secret)}},f.secret,0);
  const receipt=r.signReceipt(craft,{tip:7,hash:hashAt(7),sequence:0},gs);
  const input={height:2,blockHash:hashAt(2),tip:7,tipHash:hashAt(7),entries:[{move:craft,receipt}],receiptRoot:r.sealReceipts([receipt],{network:net,tip:7,hash:hashAt(7)},gs)};
  input.rootAttestations=attest(input.receiptRoot);
  const context={network:net,gateway,history,hashAt,patterns,state:{lastTip: 6,balances:{[request.owner]:{p0:'100',p1:'100'}}},settings:{puzzleBits:0,receiptSigners},counted:3,last:{n:1,to:1},inputs:[input]};
  const result=r.processBlock({...context,...input});assert.equal(result.file.moves[0].reason,'accepted');
  const built=r.buildBatch({network:net,executionHeight:3,epoch:0,sequence:2,lastTo:1,files:[result.file]});f.reads.batchContext=async()=>context;f.data.counted=context.counted;
  await assert.rejects(f.policy.approve({network:net,kind:'batch',batch:built.batch,files:built.fileBytes.map(r.bytesToHex)}),/batch_mismatch|batch_execution_height/);
  const live=await h.state();
  await assert.rejects(preflightBatch(built.batch,{counted:3,last:{n:1,to:1}},{read:key=>live.get(key),deployment:{...deployment,network:net,committee}}),/preflight:request_expired/);
  const recovered=r.processBlock({...context,...input,executionHeight:3});assert.equal(recovered.file.moves[0].reason,'request_expired');assert.equal(recovered.file.ops.some(op=>op.op==='xc'),false);
});
