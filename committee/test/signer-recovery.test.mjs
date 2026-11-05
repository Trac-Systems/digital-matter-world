import { BUILD as configuredBuildRoot } from '../../local/common.mjs';
import { secp256k1 } from '@noble/curves/secp256k1';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fixture } from './fixture.mjs';
import { Policy } from '../signer/policy.mjs';
import { Journal } from '../signer/journal.mjs';
import { createSigner } from '../signer/service.mjs';
import * as r from '../../rules/src/index.js';
import { observationFixture, network, owner, secret, gateway, gatewaySecret, hashAt } from '../../rules/test/observation-fixture.mjs';
import { witnesses } from '../../rules/test/witness-fixture.mjs';
import { linkInput } from './link-fixture.mjs';
const scratch=`${configuredBuildRoot}/target/committee-tests`;
await mkdir(scratch, { recursive: true, mode: 0o700 });

test('paid Bitmap links replay from owner, live payment, holder and prior-link evidence', async()=>{
  for (const kind of ['tap','ethereum']) {
  const input={...linkInput(42,kind),bitmap:{agent:owner,address:'local-holder'},previous:null};
  input.sig=r.signLink(network,input.request,secret);input.payment.requestId=r.linkId(network,input.request);
  input.terms.baseFee='5';
  if(kind==='tap'){input.payment.base='50';input.payment.allocations[0].amt='50';}
  else{input.payment.status=2;input.payment.split.treasuryAmount='50';input.payment.split.burnAmount='50';}
  input.payment.consumed=true;input.payment.settlement={accepted:true,refund:false,paymentId:input.payment.id,txid:r.hash('paid-link'),confirmations:1};
  assert.throws(()=>observationFixture().add(100,95,{linkOperations:[{...input,payment:{...input.payment,consumed:false,...(kind==='ethereum'?{status:1}:{})}}]}),/link_unpaid/);
  const observations=observationFixture();observations.add(100,95,{linkOperations:[input]});
  const built=observations.build(),f=fixture(), reads={...f.reads, counted:async()=>95,batchContext:async()=>observations.context(),
    batchStamp:async()=>({counted:95,tip:100,tipHash:hashAt(100),revision:0,last:{n:0,to:94}}),
    bitmap:async()=>input.bitmap,link:async()=>null,linkTerms:async()=>input.terms,linkPayment:async()=>input.payment};
  const policy=new Policy({network,publicKey:f.publicKey,reads}),proposal={network,kind:'batch',batch:built.batch,files:built.fileBytes.map(r.bytesToHex)};
  await policy.approve(proposal);assert.ok(built.batch.ops.some(op=>op.key==='link/16'));
  reads.bitmap=async()=>({agent:r.hash('wrong-holder'),address:'local-other'});
  await assert.rejects(policy.approve(proposal),/link_state_read/);
  }
});
test('batch retries survive restart and never relax permit or conflicting-digest protection',async()=>{
  const path=`${await mkdtemp(`${scratch}/committee-journal-`)}/journal`,key='disposable-test-key';
  let journal=await new Journal(path,key,network,'one').load();
  await journal.reserve(['batch/0/1'],r.hash('batch'),r.hash('one'));await journal.append('aborted',{session:r.hash('one')});await journal.close();
  journal=await new Journal(path,key,network,'one').load();
  try {
    await journal.reserve(['batch/0/1'],r.hash('batch'),r.hash('two'));
    await assert.rejects(journal.reserve(['batch/0/1'],r.hash('different'),r.hash('three')),/slot_conflict/);
    await journal.reserve(['mint/request/1'],r.hash('permit'),r.hash('four'));
    await assert.rejects(journal.reserve(['mint/request/1'],r.hash('permit'),r.hash('five')),/slot_already_reserved/);
  }finally{await journal.close();}
});
test('signer receipt witnesses persist root agreement and high-water deadlines across restart',async()=>{
  const f=fixture(),m=witnesses[0],directory=await mkdtemp(`${scratch}/committee-witness-`);
  let tip=100,highestTip=100,seal=r.sealReceipts([],{network,tip,hash:hashAt(tip)},gatewaySecret);
  const reads={...f.reads,tip:async()=>({tip,highestTip}),receiptObservation:async()=>({seal,receipts:[]})};
  const server=createServer(async(req,res)=>{for await(const _ of req){};res.end(JSON.stringify({public:f.publicKey,retired:false,epoch:1}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let signer;
  const config={directory,network,id:m.id,epoch:1,members:witnesses,gateway,sidecar:`http://127.0.0.1:${server.address().port}`};
  const secrets={journalKey:'disposable-witness-key',sidecarToken:'disposable-local-token',identity:r.bytesToHex(m.secret)};
  try{
    signer=await createSigner(config,secrets,reads);const first=await signer.handle('/attest-root',{tip,hash:hashAt(tip)});
    highestTip=103;tip=101;seal=r.sealReceipts([],{network,tip,hash:hashAt(tip)},gatewaySecret);
    await assert.rejects(signer.handle('/attest-root',{tip,hash:hashAt(tip)}),/receipt_attestation_late/);
    await signer.close();signer=await createSigner(config,secrets,reads);highestTip=101;
    await assert.rejects(signer.handle('/attest-root',{tip,hash:hashAt(tip)}),/receipt_attestation_late/);
    tip=100;seal=r.sealReceipts([],{network,tip,hash:hashAt(tip)},gatewaySecret);
    assert.deepEqual(await signer.handle('/attest-root',{tip,hash:hashAt(tip)}),first);
    seal=r.sealReceipts([],{network,tip,hash:r.hash('fork')},gatewaySecret);
    await assert.rejects(signer.handle('/attest-root',{tip,hash:r.hash('fork')}),/receipt_root_conflict/);
  }finally{await signer?.close();await new Promise(resolve=>server.close(resolve));}
});
test('a late non-empty receipt segment is witnessed only by signers that admitted all of its receipts',async()=>{
  const f=fixture(),directory=await mkdtemp(`${scratch}/committee-late-segment-`),tip='100',hash=hashAt(100);
  const receipts=['7','8'].map(sequence=>({network,gateway,tip,hash,sequence,batch:'3',agent:r.hash('agent'+sequence)}));
  const context={network,tip,hash,segment:'0',previous:null,ruleset:'dmw-v2',settingsRevision:'1',settingsHash:r.hash('settings')};
  const seal=r.sealReceiptSegment(receipts,context,gatewaySecret);
  const reads={...f.reads,tip:async()=>({tip:'103',highestTip:'103'}),receiptObservation:async()=>({seal,receipts})};
  const server=createServer(async(req,res)=>{for await(const _ of req){};res.end(JSON.stringify({public:f.publicKey,retired:false,epoch:1}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let signer;
  const signerFor=async(m,admitted)=>{
    const dir=`${directory}/${m.id}`;await mkdir(dir,{recursive:true,mode:0o700});
    const journal=await new Journal(`${dir}/signed.log`,'disposable-late-key',network,m.id).load();
    for(const receipt of admitted)await journal.append('receipt-admission',{receipt,vote:{signer:m.id}});await journal.close();
    return createSigner({directory:dir,network,id:m.id,epoch:1,members:witnesses,gateway,sidecar:`http://127.0.0.1:${server.address().port}`},
      {journalKey:'disposable-late-key',sidecarToken:'disposable-local-token',identity:r.bytesToHex(m.secret)},reads);
  };
  try{
    const votes=[];
    for(const m of witnesses.slice(0,3)){signer=await signerFor(m,receipts);votes.push(await signer.handle('/attest-root',{tip,hash,segment:'0'}));await signer.close();signer=null;}
    assert.ok(votes.every(v=>v.observedTip==='100'));
    assert.equal(r.verifySegmentAttestations(seal,votes,witnesses.map(({id,identity})=>({id,identity}))),true);
    signer=await signerFor(witnesses[3],receipts.slice(0,1));
    await assert.rejects(signer.handle('/attest-root',{tip,hash,segment:'0'}),/receipt_attestation_late/);
  }finally{await signer?.close();await new Promise(resolve=>server.close(resolve));}
});
test('after a reorg the canonical block at a witnessed height gets its own witness; other blocks stay refused',async()=>{
  const f=fixture(),directory=await mkdtemp(`${scratch}/committee-reorg-`),tip='100',m=witnesses[0];
  const context=hash=>({network,tip,hash,segment:'0',previous:null,ruleset:'dmw-v2',settingsRevision:'1',settingsHash:r.hash('settings')});
  let clock='100',canonical=hashAt(100),seal=r.sealReceiptSegment([],context(hashAt(100)),gatewaySecret);
  const reads={...f.reads,tip:async()=>({tip:clock,highestTip:clock}),receiptObservation:async()=>({seal,receipts:[]}),financialCanonicalBitcoinHash:async()=>canonical};
  const server=createServer(async(req,res)=>{for await(const _ of req){};res.end(JSON.stringify({public:f.publicKey,retired:false,epoch:1}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let signer;
  const config={directory,network,id:m.id,epoch:1,members:witnesses,gateway,sidecar:`http://127.0.0.1:${server.address().port}`};
  try{
    signer=await createSigner(config,{journalKey:'disposable-reorg-key',sidecarToken:'disposable-local-token',identity:r.bytesToHex(m.secret)},reads);
    const first=await signer.handle('/attest-root',{tip,hash:hashAt(100),segment:'0'});
    clock='104';seal=r.sealReceiptSegment([],context(r.hash('stale-fork')),gatewaySecret);
    await assert.rejects(signer.handle('/attest-root',{tip,hash:r.hash('stale-fork'),segment:'0'}),/receipt_root_conflict/);
    canonical=r.hash('reorg');seal=r.sealReceiptSegment([],context(canonical),gatewaySecret);
    const replaced=await signer.handle('/attest-root',{tip,hash:canonical,segment:'0'});
    assert.equal(replaced.segmentHash,r.receiptSegmentHash(seal));
    await signer.close();signer=await createSigner(config,{journalKey:'disposable-reorg-key',sidecarToken:'disposable-local-token',identity:r.bytesToHex(m.secret)},reads);
    assert.deepEqual(await signer.handle('/attest-root',{tip,hash:canonical,segment:'0'}),replaced);
    seal=r.sealReceiptSegment([],context(hashAt(100)),gatewaySecret);
    assert.deepEqual(await signer.handle('/attest-root',{tip,hash:hashAt(100),segment:'0'}),first);
  }finally{await signer?.close();await new Promise(resolve=>server.close(resolve));}
});
test('discovery indexes extend existing vectors and invalidate a rewritten boundary',()=>{
  const p={name:'dmwone',pat:'1',fld:4,dt:'n'},q={name:'dmwtwo',pat:'2',fld:4,dt:'n'};
  let reads=0,changed=false;const history={length:102,field:n=>{reads++;return String(n);},get:n=>({hash:changed&&n===99?r.hash('fork'):hashAt(n)})};
  const state={highestTip:102,discoveryQueue:[{tip:100,agent:owner,commitment:r.hash('one'),height:99,proposal:p}]},table=[];
  assert.equal(r.advanceDiscovery(state,table,history,99).accepted.length,1);assert.equal(reads,100);
  state.discoveryQueue=[{tip:101,agent:owner,commitment:r.hash('two'),height:100,proposal:q}];
  assert.equal(r.advanceDiscovery(state,table,history,100).accepted.length,1);assert.equal(reads,202);
  state.discoveryQueue=[{tip:102,agent:owner,commitment:r.hash('three'),height:99,proposal:{...p,name:'dmwdupe'}}];changed=true;
  const result=r.advanceDiscovery(state,table,history,100);assert.equal(result.rejected[0].reason,'pattern_duplicate');assert.equal(reads,402);
});
test('recovery rejects expired admission in the audit without applying its request',()=>{
  const f=fixture(), request={...f.proposal.request,until:94}, input={op:'rq',request,sig:r.signRequest('rq',network,request,f.secret),receiver:f.proposal.receiver,evidence:{}};
  const observations=observationFixture();const output=observations.add(100,95,{mintOperations:[input]});
  assert.deepEqual(output.file.mintOutcomes,[{reason:'request_expired'}]);assert.equal(output.file.ops.some(o=>o.op==='rq'),false);observations.build();
});


test('a reserved permit recovers the same durable sidecar result after restart without another ceremony',async()=>{
  const f=fixture('compound'), approval=await f.policy.approve(f.proposal), directory=await mkdtemp(`${scratch}/committee-result-`), session=r.hash('completed-session');
  const sig=secp256k1.sign(approval.digest,new Uint8Array(32).fill(2),{prehash:false,lowS:true}),signature={r:String(sig.r),s:String(sig.s),v:sig.recovery,compact:sig.toCompactHex()};
  const m=witnesses[0], secrets={journalKey:'disposable-recovery-key',sidecarToken:'disposable-local-token',identity:r.bytesToHex(m.secret)};
  const journal=await new Journal(`${directory}/signed.log`,secrets.journalKey,network,m.id).load();
  await journal.reserve(approval.slots,approval.digest,session,approval.details);await journal.close();
  let prepares=0;const server=createServer(async(req,res)=>{for await(const _ of req){};if(req.url==='/prepare')prepares++;res.end(JSON.stringify(req.url==='/result'?{start:{digest:approval.digest,network},signature}:{public:f.publicKey,retired:false,epoch:1}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let signer;
  const config={directory,network,id:m.id,epoch:1,members:witnesses,sidecar:`http://127.0.0.1:${server.address().port}`};
  try{
    signer=await createSigner(config,secrets,f.reads);const recovered=await signer.handle('/status',{id:session});assert.deepEqual(recovered.signature,signature);
    await signer.close();signer=await createSigner(config,secrets,f.reads);assert.deepEqual(await signer.handle('/status',{id:session}),recovered);
    assert.deepEqual((await signer.handle('/recover-result',{network,id:f.id,signature})).signature,signature);assert.equal(prepares,0);
    const other=secp256k1.sign(approval.digest,new Uint8Array(32).fill(2),{prehash:false,lowS:true,extraEntropy:new Uint8Array(32).fill(5)});
    await assert.rejects(signer.handle('/recover-result',{network,id:f.id,signature:{r:String(other.r),s:String(other.s),v:other.recovery,compact:other.toCompactHex()}}),/permit_result_conflict/);
  }finally{await signer?.close();await new Promise(resolve=>server.close(resolve));}
});
