import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { verifyBulkPermit, bulkPublicReads } from '../signer/bulk-mint.mjs';
import { readPublicWinner, readPublicWinners } from '../signer/public-claims.mjs';
import { Policy } from '../signer/policy.mjs';
import { verifyFinancialExecution } from '../signer/financial-execution.mjs';
import { hashObject, stableJSON } from '../../rules/src/core.js';
import { bulkOrderId, bulkMemberId, bulkPermitPlans, bulkReceiptKey, bulkMembersRoot, bulkFeeRoot, bulkAllMask, bulkReserveAction } from '../../rules/src/bulk-mint.js';
import { mintPlotKey, capacityPlotKey } from '../../rules/src/per-ticker-supply-activation.js';
import { plotKey } from '../../contract/financial-capacity.js';
import { settingsRevision, SETTINGS_PROFILE } from '../../rules/src/settings-v2.js';
import { reserveNonceDigest } from '../../contract/root-accounts.js';
import { AccountExecution } from '../../service/src/account-batch.mjs';
import { buildFinancialExecution } from '../../service/src/financial-execution.mjs';

const fixture=JSON.parse(readFileSync(new URL('../../rules/test/fixtures/bulk-v1.json',import.meta.url)));
const publicKey=Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(9))).toString('hex');
function setup(n=1,extra=false){
  const t=structuredClone(fixture.terms);t.members=Array.from({length:n},(_,i)=>({block:String(900000+i),amount:'3'}));
  t.totalAmount=String(n*3);t.groups[0].amount=t.grossFeeAtoms=t.payableFeeAtoms=String(n*100);
  t.membersRoot=bulkMembersRoot(t.members);t.feeQuote.scope=stableJSON(['mint-bulk-v1',t.asset,t.deployment,t.membersRoot]);
  t.feeRoot=bulkFeeRoot(t.members.map((_,member)=>({...structuredClone(fixture.feeManifest[0]),member})));
  t.mintFunding.satoshis=n*546+6546+Number(t.mintFunding.maxFeeSats);if(extra)t.supplyScope=t.deployment;
  const id=bulkOrderId(t.network,t.owner,t.nonce),terms=hashObject(t),plans=bulkPermitPlans(t,fixture.receiptRoot),db=new Map(),H='ab'.repeat(32);
  const funding={kind:'bulk-v1',state:'bulk-consumed',owner:t.owner,created:'974137',terms,manifest:t,paid:t.groups.map(g=>g.amount),
    reference:'ee'.repeat(32)+'i0',receiptRoot:fixture.receiptRoot,permitRoot:plans.permitRoot,issuedMask:bulkAllMask(n).toString(),finishedMask:'0',releasedMask:'0'};
  db.set('fp/'+id,funding);db.set('ao/'+id,{state:'bulk-issued',owner:t.owner,asset:t.asset,amount:t.totalAmount,terms,permitRoot:plans.permitRoot,releasedMask:'0'});
  db.set('fp/bulk-receipt/'+bulkReceiptKey(t.bitcoinNetwork,funding.reference),{orderId:id,receiptRoot:funding.receiptRoot});
  for(const p of plans.plans){const m=t.members[p.index];
    db.set('dc/'+p.memberId,{state:'issued',deployment:t.generation,asset:t.asset,amount:m.amount,plot:m.block,terms,bulk:id,index:p.index,permitHash:p.digest,...(extra?{supplyScope:t.supplyScope}:{})});
    db.set(capacityPlotKey(t.asset,m.block,t.supplyScope),p.memberId);db.set(plotKey(t.asset,m.block,t.supplyScope),{id:p.memberId,state:'reserved'});
  }
  let stamp={counted:'974140',last:{n:'1',to:'974137'},revision:'1',tip:'974140',tipHash:H};
  const calls=[],reads={
    batchStamp:async()=>structuredClone(stamp),financialRecord:async key=>{calls.push(key);return structuredClone(db.get(key)??null);},
    bulkPermit:async(orderId,index,at)=>{assert.equal(orderId,id);return{terms:structuredClone(t),funding:structuredClone(funding),permit:structuredClone(plans.plans[index]),memberId:bulkMemberId(id,index)};},
    assetContext:async(asset,block,at,a,b,deployment)=>{assert.equal(asset,t.asset);assert.equal(at.bulkMint,true);assert.equal(deployment,t.deployment);
      return{deployment:{id:t.deployment,kind:'dmt',tick:t.ticker,privilegePublicKey:publicKey}};},
  };
  const verify=(index=0)=>verifyBulkPermit({reads,network:t.network,publicKey,orderId:id,index});
  const policy=new Policy({network:t.network,publicKey,reads});
  return{t,id,terms,db,funding,plans,reads,verify,policy,calls,setStamp:value=>stamp=value};
}
for(const n of [1,64])test(`bulk committee derives ${n} member permits and uses shared single/public conflict slots`,async()=>{
  const f=setup(n);
  for(const p of f.plans.plans){const result=await f.verify(p.index);
    assert.equal(result.digest,p.digest);assert.deepEqual(result.slots,[`mint/request/${p.memberId}`,'mint/block/'+mintPlotKey(f.t.asset,f.t.members[p.index].block)]);
    assert.equal(result.details.payment.commitment,f.plans.paymentHash);assert.equal(result.permit.payload.op,'dmt-mint');
  }
  assert.ok(f.calls.every(k=>!k.includes('range')));
});
test('bulk policy dispatch rejects unknown proposal fields and keeps per-ticker slots',async()=>{
  const f=setup(1,true),proposal={network:f.t.network,kind:'mint',version:'bulk-v1',orderId:f.id,index:0};
  const result=await f.policy.approve(proposal);
  assert.equal(result.slots[1],'mint/block/'+mintPlotKey(f.t.asset,f.t.members[0].block,f.t.deployment));
  await assert.rejects(f.policy.approve({...proposal,receiver:'attacker'}),/bulk_permit_proposal/);
  await assert.rejects(f.policy.approve({...proposal,network:'other'}),/network/);
});
test('bulk member plot locks remain interoperable with public-winner point readers',async()=>{
  const f=setup(2),reads=bulkPublicReads(f.reads),at=await f.reads.batchStamp();
  assert.equal(await readPublicWinner(reads,f.t.asset,f.t.members[0].block,at),null);
  assert.deepEqual(await readPublicWinners(reads,f.t.members.map(m=>[f.t.asset,m.block]),at),[{value:null},{value:null}]);
  const id=bulkMemberId(f.id,0);assert.equal(await f.reads.financialRecord('fp/'+id),null,'canonical reader never fabricates member funding');
  f.db.set('fp/'+id,{publicMint:true,owner:null});assert.equal(await readPublicWinner(reads,f.t.asset,f.t.members[0].block,at),id,'old records retain priority');
  f.db.delete('fp/'+id);f.db.get('dc/'+id).terms='aa'.repeat(32);await assert.rejects(readPublicWinner(reads,f.t.asset,f.t.members[0].block,at),/bulk_public_member/);
});
test('bulk committee rejects unaccepted consume, partial/changed funding, masks and member substitution',async()=>{
  for(const mutate of [f=>f.db.get('ao/'+f.id).state='reserved',f=>f.funding.state='bulk-funded',f=>f.funding.paid[0]='0',
    f=>f.funding.issuedMask='0',f=>f.funding.releasedMask='1',f=>f.funding.permitRoot='aa'.repeat(32),
    f=>f.db.get('dc/'+bulkMemberId(f.id,0)).amount='4',f=>f.db.get('dc/'+bulkMemberId(f.id,0)).permitHash='aa'.repeat(32),
    f=>f.db.set(capacityPlotKey(f.t.asset,f.t.members[0].block),'aa'.repeat(32))]){
    const f=setup();mutate(f);await assert.rejects(f.verify());
  }
  const f=setup(),original=f.reads.bulkPermit;
  f.reads.bulkPermit=async(...args)=>{const result=await original(...args);result.permit.payload.dep='aa'.repeat(32)+'i0';return result;};
  await assert.rejects(f.verify(),/bulk_permit_binding/);
});
test('bulk committee requires canonical receipt ownership and forbids credited primary funding',async()=>{
  for(const mutate of [f=>f.db.delete('fp/bulk-receipt/'+bulkReceiptKey(f.t.bitcoinNetwork,f.funding.reference)),
    f=>f.db.get('fp/bulk-receipt/'+bulkReceiptKey(f.t.bitcoinNetwork,f.funding.reference)).orderId='aa'.repeat(32),
    f=>f.db.set('fp/bulk-credit/'+bulkReceiptKey(f.t.bitcoinNetwork,f.funding.reference),{state:'owed'})]){
    const f=setup();mutate(f);await assert.rejects(f.verify(),/bulk_permit_backing/);
  }
});
test('bulk committee permits exact signature recovery after expiry without enabling release',async()=>{
  const f=setup(),before=await f.verify();f.setStamp({counted:'999999999999999999999999',last:{n:'1',to:'974137'},revision:'99',tip:'999999999999999999999999',tipHash:'aa'.repeat(32)});
  assert.deepEqual(await f.verify(),before);
});
test('bulk committee rejects quarantined records, reorg fences and wrong deployment committee',async()=>{
  for(const key of ['fr/active','fq/ar/supply']){const f=setup();f.db.set(key,{recovery:'aa'.repeat(32)});await assert.rejects(f.verify(),/financial_(recovery_active|quarantined)/);}
  const f=setup(),original=f.reads.assetContext;
  f.reads.assetContext=async(...args)=>{const result=await original(...args);f.setStamp({counted:'974141',last:{n:'1',to:'974137'},revision:'2'});return result;};
  await assert.rejects(f.verify(),/financial_snapshot_changed/);
  const g=setup();g.reads.assetContext=async()=>({deployment:{id:g.t.deployment,kind:'dmt',tick:g.t.ticker,privilegePublicKey:'bad'}});
  await assert.rejects(g.verify(),/bulk_permit_committee/);
});
test('bulk committee still refuses a revision-only change with an unchanged accepted batch',async()=>{
  const f=setup(),before=await f.reads.batchStamp(),context=f.reads.assetContext;
  f.reads.assetContext=async(...args)=>{const result=await context(...args);f.setStamp({...before,revision:'2'});return result;};
  await assert.rejects(f.policy.approve({network:f.t.network,kind:'mint',version:'bulk-v1',orderId:f.id,index:0}),/financial_snapshot_changed/);
});

test('bulk committee replays merged nonce-reservation account proofs, exact operations and independent commitments',async()=>{
  const t=structuredClone(fixture.max64.terms),secret=new Uint8Array(32).fill(23);t.owner=Buffer.from(ed25519.getPublicKey(secret)).toString('hex');
  const H='ab'.repeat(32),height='974137',id=bulkOrderId(t.network,t.owner,t.nonce),data=new Map(),sources=new Map();
  const store={get:(space,id)=>data.get(space+'\0'+id)??null};
  const commit=writes=>{for(const w of writes)data.set(w.space+'\0'+w.id,structuredClone(w.value));};
  const document=settingsRevision({network:t.network,effectiveBatch:'1',effectiveBitcoinWindow:height,values:SETTINGS_PROFILE});
  const seed=new AccountExecution({store,document,height});
  await seed.accounts([{type:'credits',owner:t.owner,assets:[[t.asset,'1000'],['p0','1000']]}]);commit(seed.result().writes);
  const d={asset:t.asset,deployment:t.deployment,reserved:'0',minted:'0',maximum:'1000',limit:'3'};
  for(const [key,value]of [['fd/'+t.generation,d],['fd/asset/'+t.asset,t.generation],['fd/external/'+hashObject(t.deployment),t.generation]])data.set('accountRecords\0'+key,value);
  const sign=a=>({...a,sig:Buffer.from(ed25519.sign(reserveNonceDigest(t.network,a),secret)).toString('hex')});
  const transition={type:'reserve-many',id,terms:t,action:sign(bulkReserveAction(t))};
  const evidence={version:1,requestId:id,terms:t,feeManifest:fixture.max64.feeManifest,owner:t.owner,asset:t.asset,amount:t.totalAmount,
    receiver:t.receiver,payer:t.payer,rail:'tap',expiry:t.expires,settingsHash:t.settingsHash,
    feeAuthorization:{network:t.network,quote:t.feeQuote,id,until:t.expires,counted:height,at:t.feeQuote.issuedAt,signature:'cc'.repeat(64)},
    capacity:{deployment:t.deployment,asset:t.asset,amount:t.totalAmount,block:null,remaining:'1000',limit:'3',supplyScope:null},
    generationCapacity:{deployment:t.generation,reserved:'0',minted:'0',maximum:'1000'},
    members:t.members.map((m,index)=>({...m,memberId:bulkMemberId(id,index),find:{asset:t.asset,block:m.block,count:m.amount},link:null,holder:null,
      deployment:{id:t.deployment,tick:t.ticker,kind:'dmt'}}))};
  const fees=[{key:H,amount:'1'}],singleEvidence={owner:t.owner,asset:'p0',amount:'1',fees};
  const single={type:'reserve',id:'dd'.repeat(32),fees,action:sign({type:'reserve-n',id:'dd'.repeat(32),owner:t.owner,asset:'p0',amount:'1',
    terms:hashObject(singleEvidence),nonce:'ee'.repeat(32),until:t.until})};
  sources.set(hashObject(transition),evidence);sources.set(hashObject(single),singleEvidence);
  // Exact normative B source seam, independently injected for this signer.
  const reads={financialRecord:async key=>store.get('accountRecords',key),bulkEvidence:async transition=>structuredClone(sources.get(hashObject(transition)))};
  reads.financialEvidence=(transition,at)=>reads.bulkEvidence(transition,at);
  const built=await buildFinancialExecution({store,document,height,reads,transitions:[transition,single]});
  const file={ops:built.operations,financialOperations:built.inputs},args={files:[file],reads,document,network:t.network,height};
  assert.equal(built.operations.filter(op=>op.op==='ar').length,1);assert.equal(built.operations[0].accounts.length,1);
  assert.equal(built.inputs[0].reserveGroup,2);await verifyFinancialExecution(args);
  const forged=structuredClone(file);forged.financialOperations[0].recordCommitments[0][1]='ff'.repeat(32);
  await assert.rejects(verifyFinancialExecution({...args,files:[forged]}),/financial_record_commitments/);
  const badProof=structuredClone(file);badProof.financialOperations[0].operations[0].accounts[0].proof.leaves[0].value='forged';
  await assert.rejects(verifyFinancialExecution({...args,files:[badProof]}));
  sources.get(hashObject(transition)).members[63].find.count='4';
  await assert.rejects(verifyFinancialExecution(args),/financial_evidence_read/);
});
