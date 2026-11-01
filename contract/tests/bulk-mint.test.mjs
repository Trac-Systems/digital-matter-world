import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { accountTree, accountKey } from '../account-tree.js';
import { applyRootAccounts, reserveNonceDigest, accountActionDigest } from '../root-accounts.js';
import { applyPaymentPage, paymentCreditDigest } from '../payment-pages.js';
import { applyBulkPayment } from '../bulk-mint.js';
import { capacityKey, plotKey } from '../financial-capacity.js';
import { custodyId, lifecycleDigest } from '../financial-lifecycle.js';
import { hashObject, stableJSON } from '../../rules/src/core.js';
import { bulkMembersRoot, bulkFeeRoot, bulkOrderId, bulkMemberId, bulkReserveAction, bulkPermitPlans,
  bulkAllMask, bulkReceiptKey, bulkCustodyFeeKey } from '../../rules/src/bulk-mint.js';
import { capacityPlotKey } from '../../rules/src/per-ticker-supply-activation.js';
import { StateTransition } from '../state.js';
import { settingsRevision, SETTINGS_PROFILE } from '../../rules/src/settings-v2.js';
import { accountSettings } from '../../rules/src/account-settings.js';
import { accountOperationsRoot } from '../../rules/src/account-batch.js';
import { deployment as harnessDeployment, signedBatch } from './helpers/harness.mjs';
import { attachPermit } from '../../committee/signer/adapter.mjs';
import { BULK_LIMITS } from '../../rules/src/bulk-mint.js';

const fixture = JSON.parse(readFileSync(new URL('../../rules/test/fixtures/bulk-v1.json', import.meta.url)));
const secret = new Uint8Array(32).fill(17), owner = Buffer.from(ed25519.getPublicKey(secret)).toString('hex'), H = 'ab'.repeat(32);
function setup(n = 1, extra = false, custody = false, wire = null) {
  const t = structuredClone(wire?.terms ?? fixture.terms), manifest = wire ? structuredClone(wire.feeManifest) : Array.from({length:n}, (_, member) => ({...structuredClone(fixture.feeManifest[0]),member}));
  t.owner = owner; t.members = Array.from({length:n},(_,i)=>({block:String(900000+i),amount:'3'}));
  t.totalAmount=String(n*3); if(!wire)t.groups[0].amount=t.grossFeeAtoms=t.payableFeeAtoms=String(n*100);
  t.membersRoot=bulkMembersRoot(t.members); t.feeQuote.scope=stableJSON(['mint-bulk-v1',t.asset,t.deployment,t.membersRoot]);
  t.mintFunding.satoshis=n*546+6546+Number(t.mintFunding.maxFeeSats);
  if (extra) t.supplyScope=t.deployment;
  if (custody) for (const m of manifest) {
    m.shares=[{role:'finder',group:0,beneficiary:m.member%2?Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(18))).toString('hex'):owner,gross:'30',payable:'30'},
      {role:'treasury',group:0,beneficiary:null,gross:'70',payable:'70'}];
    t.custody.push({member:m.member,role:'finder',group:0,owner:m.shares[0].beneficiary,amount:'30'});
  }
  t.feeRoot=bulkFeeRoot(manifest);
  const id=bulkOrderId(t.network,t.owner,t.nonce), terms=hashObject(t), db=new Map(), leaves=new Map(), supplies=new Map(), writes=[],operations=[],reads=[];
  const balance=accountKey('balance',t.asset), supply=accountKey('supply',t.asset);
  leaves.set(balance,{available:'1000',held:'0'}); supplies.set(supply,{issued:'1000',burned:'0'});
  db.set('ar/'+owner,{revision:'0',root:accountTree(leaves).root}); db.set('ar/supply',{revision:'0',root:accountTree(supplies).root});
  const current=extra?'cc'.repeat(32):t.generation;
  db.set('fd/asset/'+t.asset,current); db.set('fd/external/'+hashObject(t.deployment),t.generation);
  if(extra) db.set('fd/'+current,{asset:t.asset,deployment:'dd'.repeat(32)+'i0'});
  db.set('fd/'+t.generation,{asset:t.asset,deployment:t.deployment,generation:'0',previous:null,maximum:'1000',limit:'3',reserved:'0',minted:'0',evidence:H,...(extra?{official:current}:{})});
  const store={get:async k=>{reads.push(k);return db.get(k)??null;},put:(k,v)=>{writes.push([k,structuredClone(v)]);db.set(k,structuredClone(v));}};
  const sign = a=>({...a,sig:Buffer.from(ed25519.sign(reserveNonceDigest(t.network,a),secret)).toString('hex')});
  const accountOp = actions => {
    const keys=new Set([balance]); for(const a of actions) if(a.nonce)keys.add(accountKey('nonce',a.nonce));
    const burn=actions.some(a=>a.type==='consume-many')&&!extra;
    return {op:'ar',v:2,actions,accounts:[{owner,revision:db.get('ar/'+owner).revision,proof:accountTree(leaves).prove([...keys])}],
      supply:{revision:db.get('ar/supply').revision,proof:burn?accountTree(supplies).prove([supply]):{leaves:[],nodes:[]}},availability:H};
  };
  const accounts=async(actions,height='974140',mutate=()=>{})=>{
    const op=accountOp(actions);mutate(op);
    const result=await applyRootAccounts(store,op,{network:t.network,height,capture:(who,root,proof,updates)=>{
      const target=who==='supply'?supplies:leaves; for(const [k,v]of updates)if(v===null)target.delete(k);else target.set(k,v);
    }});operations.push(structuredClone(op));return result;
  };
  const fp=(type,fields={})=>({op:'fp',v:2,type,id,terms,evidence:H,...fields});
  const pay=async(op,height='974140')=>{const result=await applyPaymentPage(store,op,{network:t.network,height});operations.push(structuredClone(op));return result;};
  const open=async()=>{
    await accounts([sign(bulkReserveAction(t))],'974137');
    await pay(fp('bulk-open',{terms:t,capacity:{remaining:'1000',limit:'3'}}),'974137');
  };
  const fund=async(paid=t.groups.map(g=>g.amount),height='974140')=>pay(fp('bulk-fund',{reference:'ee'.repeat(32)+'i0',block:{height,hash:H},paid,receiptRoot:H}),height);
  const consume=async()=>{
    const plans=bulkPermitPlans(t,H);
    await pay(fp('bulk-consume',{receiptRoot:H,permitRoot:plans.permitRoot}));
    await accounts([{type:'consume-many',id,terms,permitRoot:plans.permitRoot,evidence:H}]);
    return plans;
  };
  const terminal=async(indices,finish=true,height=finish?'974150':'974570')=>{
    const members=finish?indices.map(index=>({index,inscription:'ff'.repeat(32)+'i'+index})):indices;
    await pay(fp(finish?'bulk-finish':'bulk-release',{members,...(!finish?{reason:'expired'}:{})}),height);
    if(!finish||extra)await accounts([{type:'release-many',id,terms,members:indices,reason:finish?'minted':'expired',evidence:H}],height);
  };
  return {t,manifest,id,terms,db,leaves,supplies,balance,supply,store,writes,operations,reads,sign,accountOp,accounts,fp,pay,open,fund,consume,terminal};
}
async function unchanged(f, action, reason) {
  const before=structuredClone([...f.db]),count=f.writes.length;
  await assert.rejects(action,reason);assert.deepEqual([...f.db],before);assert.equal(f.writes.length,count);
}

for(const n of [1,64]) for(const extra of [false,true]) test(`bulk ${n} complete members conserve ${extra?'extra held':'official burned'} units and both capacities`,async()=>{
  const f=setup(n,extra);await f.open();
  assert.equal(f.db.get(capacityKey(f.t.deployment)),f.t.totalAmount);
  assert.equal(f.db.get('fd/'+f.t.generation).reserved,f.t.totalAmount);
  assert.deepEqual(f.leaves.get(f.balance),{available:String(1000-n*3),held:String(n*3)});
  await f.fund();await f.consume();
  assert.equal(f.db.get('fp/'+f.id).issuedMask,bulkAllMask(n).toString());
  assert.equal(f.leaves.get(f.balance).held,extra?String(n*3):'0');
  for(let start=0;start<n;start+=16)await f.terminal(Array.from({length:Math.min(16,n-start)},(_,i)=>start+i));
  assert.equal(f.db.get('fp/'+f.id).state,'bulk-complete');assert.equal(f.db.get('fp/'+f.id).finishedMask,bulkAllMask(n).toString());
  assert.equal(f.db.get(capacityKey(f.t.deployment)),'0');assert.equal(f.db.get('fd/'+f.t.generation).reserved,'0');
  assert.equal(f.db.get('fd/'+f.t.generation).minted,String(n*3));
  assert.deepEqual(f.leaves.get(f.balance),{available:String(extra?1000:1000-n*3),held:'0'});
  assert.deepEqual(f.supplies.get(f.supply),{issued:'1000',burned:extra?'0':String(n*3)});
  for(const [i,m]of f.t.members.entries()){
    const id=bulkMemberId(f.id,i);
    assert.deepEqual(f.db.get(plotKey(f.t.asset,m.block,f.t.supplyScope)),{id,state:'minted'});
    assert.equal(f.db.get(capacityPlotKey(f.t.asset,m.block,f.t.supplyScope)),id);
  }
  await unchanged(f,()=>f.terminal([0]),/bulk_terminal_member/);
});
test('bulk maximum lifecycle measures reserve, all 131 payments, 64 signatures and every finish page',async testContext=>{
  const f=setup(64,false,false,fixture.max64);await f.open();await f.fund();const plans=await f.consume();
  const secret=new Uint8Array(32).fill(9),contents=plans.plans.map(p=>{
    const sig=secp256k1.sign(p.digest,secret,{prehash:false,lowS:true});
    return attachPermit(p,{r:String(sig.r),s:String(sig.s),v:sig.recovery});
  });
  for(const content of contents)assert.ok(Buffer.byteLength(stableJSON(content))<=BULK_LIMITS.mintPayloadBytes);
  for(let start=0;start<64;start+=16)await f.terminal(Array.from({length:16},(_,i)=>start+i));
  const bytes=x=>Buffer.byteLength(stableJSON(x));
  const groups=[f.operations.slice(0,2),f.operations.slice(2,3),f.operations.slice(3,5),...f.operations.slice(5).map(op=>[op])];
  const signedBatchBytes=groups.map((ops,i)=>bytes(signedBatch({v:2,n:String(i+1),epoch:'0',from:'974137',to:'974137',deadline:'974139',
    previous:H,ruleset:'dmw-v2',settingsRevision:'0',settingsHash:f.t.settingsHash,execution:{height:'974137',hash:H},observation:String(i+1),
    receipts:H,finds:H,catalog:H,accounts:accountOperationsRoot(ops),previousClaims:H,claims:H,ops},{...harnessDeployment,network:f.t.network})));
  assert.ok(signedBatchBytes.every(n=>n<=98304),'complete signed envelopes fit preceding capacity settings');
  const measured={operations:f.operations.length,signedBatchBytes,memberSignatures:contents.length,mintContentBytes:bytes(contents),
    committedWriteBytes:bytes(f.writes),pointReads:f.reads.length};
  assert.equal(f.operations.length,9);assert.equal(f.db.get('fp/'+f.id).paid.length,131);
  assert.ok(measured.committedWriteBytes<1500000);assert.equal(f.db.get('fp/'+f.id).state,'bulk-complete');
  testContext.diagnostic(JSON.stringify(measured));
});
test('bulk open is atomic on last-member conflicts in every plot namespace',async()=>{
  for(const namespace of ['external','internal','imported']){
    const f=setup(64);await f.accounts([f.sign(bulkReserveAction(f.t))],'974137');const m=f.t.members.at(-1);
    const key=namespace==='external'?plotKey(f.t.asset,m.block):namespace==='internal'?capacityPlotKey(f.t.asset,m.block):'fi/plot/'+f.t.asset+'/'+m.block;
    f.db.set(key,H);
    await unchanged(f,()=>f.pay(f.fp('bulk-open',{terms:f.t,capacity:{remaining:'1000',limit:'3'}}),'974137'),/bulk_member_conflict/);
  }
});
test('bulk signed notary batch rolls back the aggregate account reserve on a late member failure',async()=>{
  const f=setup(64),height='974137',document=settingsRevision({network:f.t.network,effectiveBatch:'1',effectiveBitcoinWindow:height,values:SETTINGS_PROFILE});
  const manifest={version:1,network:f.t.network,fromRuleset:'dmw-v1',toRuleset:'dmw-v2',effectiveBatch:'1',previousBatchRoot:H,
    bitcoinAnchor:{height,hash:H},settingsHash:hashObject(document),catalogRoot:H,accountsRoot:H,receiptSegmentStart:'0',
    schemas:{batch:2,file:5,integer:2,receipt:2},minimumKitVersion:'0.2.0',route:'terminal-import'};
  const options={...harnessDeployment,network:f.t.network,v2:{manifest,manifestHash:hashObject(manifest),document,importRoot:H,importRows:1}};
  f.db.set('v2/ready',hashObject(manifest));f.db.set('v2/manifest',manifest);f.db.set('v2/settings',document);f.db.set('v2/claims',H);
  f.db.set('bt/last',{n:'0',to:height});f.db.set('s/assets',{version:2,settings:accountSettings(document)});
  const last=f.t.members.at(-1);f.db.set(capacityPlotKey(f.t.asset,last.block),H);
  const ops=[f.accountOp([f.sign(bulkReserveAction(f.t))]),f.fp('bulk-open',{terms:f.t,capacity:{remaining:'1000',limit:'3'}})];
  const batch=signedBatch({v:2,epoch:'0',n:'1',from:height,to:height,deadline:'974139',root:H,previous:H,ruleset:'dmw-v2',
    settingsRevision:document.revision,settingsHash:hashObject(document),execution:{height,hash:H},observation:'1',receipts:H,finds:H,catalog:H,
    accounts:accountOperationsRoot(ops),previousClaims:H,claims:H,ops},options);
  const state=new StateTransition(async key=>f.db.get(key)??null,options);
  state.head=async()=>({counted:height});state.beacon=()=>({hashAt:async()=>H});
  const before=structuredClone([...f.db]);
  assert.equal(await state.transaction('bt',batch,owner),'bulk_member_conflict');
  assert.equal(state.writes.size,0);assert.deepEqual([...f.db],before);assert.equal(f.db.has('ao/'+f.id),false);
  f.db.delete(capacityPlotKey(f.t.asset,last.block));
  assert.equal(await state.transaction('bt',batch,owner),null);
  assert.equal((await state.get('fp/'+f.id)).state,'bulk-open');assert.equal((await state.get('ar/'+owner)).revision,'1');
});
test('bulk capacity checks member limits independently from aggregate and imported supply',async()=>{
  for(const [changes,reason]of [[f=>f.db.set('fi/deployment/'+f.t.deployment,'900'),/bulk_capacity_exhausted/],
    [f=>f.db.get('fd/'+f.t.generation).limit='2',/bulk_member_limit/]]){
    const f=setup(64);await f.accounts([f.sign(bulkReserveAction(f.t))],'974137');changes(f);
    await unchanged(f,()=>f.pay(f.fp('bulk-open',{terms:f.t,capacity:{remaining:'1000',limit:'3'}}),'974137'),reason);
  }
});
test('bulk additional deployments retain their independent generation after official rollover',async()=>{
  const f=setup(2,true),next='ba'.repeat(32);f.db.set('fd/asset/'+f.t.asset,next);f.db.set('fd/'+next,{asset:f.t.asset,deployment:'bc'.repeat(32)+'i0'});
  await f.open();assert.equal(f.db.get('fd/'+f.t.generation).reserved,'6');assert.equal(f.db.get('fp/'+f.id).state,'bulk-open');
});
test('bulk partial and late primary payments cannot issue, expiry creates only receipt-backed liabilities',async()=>{
  const f=setup(2);await f.open();await f.fund(['0']);
  await unchanged(f,()=>f.consume(),/bulk_funding_incomplete/);
  await f.terminal([0],false);
  const receipt=f.db.get('fp/'+f.id).reference,key=bulkReceiptKey(f.t.bitcoinNetwork,receipt);
  assert.deepEqual(f.db.get('fp/bulk-credit/'+key).groups,[]);
  await f.terminal([1],false);assert.deepEqual(f.leaves.get(f.balance),{available:'1000',held:'0'});
  assert.equal(f.db.get('fp/'+f.id).state,'bulk-released');
  const g=setup();await g.open();await unchanged(g,()=>g.fund(undefined,'974570'),/bulk_funding_window/);
  await g.pay(g.fp('bulk-credit',{reference:'ee'.repeat(32)+'i0',block:{height:'974570',hash:H},paid:['100'],receiptRoot:H}),'974570');
  assert.equal(g.db.get('fp/'+g.id).state,'bulk-open');
  assert.equal(g.db.get('fp/bulk-credit/'+key).groups[0].amount,'100');
});
test('bulk mixed 131-group payment releases all 64 unissued members and credits only successful groups',async()=>{
  const f=setup(64,false,false,fixture.max64);await f.open();
  const paid=f.t.groups.map((g,i)=>i%2?'0':g.amount);await f.fund(paid);
  assert.equal(f.db.get('fp/'+f.id).state,'bulk-open');await unchanged(f,()=>f.consume(),/bulk_funding_incomplete/);
  await f.terminal(Array.from({length:32},(_,i)=>i),false);await f.terminal(Array.from({length:32},(_,i)=>i+32),false);
  const credit=f.db.get('fp/bulk-credit/'+bulkReceiptKey(f.t.bitcoinNetwork,'ee'.repeat(32)+'i0'));
  assert.deepEqual(credit.groups.map(g=>g.index),Array.from({length:66},(_,i)=>i*2));
  assert.equal(credit.groups.reduce((n,g)=>n+BigInt(g.amount),0n),paid.reduce((n,a)=>n+BigInt(a),0n));
  assert.equal(f.db.get('fp/'+f.id).releasedMask,'18446744073709551615');assert.equal(f.db.get('ao/'+f.id).releasedMask,'18446744073709551615');
  assert.deepEqual(f.leaves.get(f.balance),{available:'1000',held:'0'});assert.equal(f.supplies.get(f.supply).burned,'0');
  assert.equal(f.db.get(capacityKey(f.t.deployment)),'0');
});
test('bulk expiry of verified full payment credits once and permanently fences consume',async()=>{
  const f=setup(2);await f.open();await f.fund();await f.terminal([0],false);
  const key=bulkReceiptKey(f.t.bitcoinNetwork,'ee'.repeat(32)+'i0');
  assert.equal(f.db.get('fp/bulk-credit/'+key).groups[0].amount,'200');
  await unchanged(f,()=>f.consume(),/bulk_funding_incomplete/);
  await unchanged(f,()=>f.terminal([0],false),/bulk_terminal_member/);
  await f.terminal([1],false);assert.equal(f.db.get('fp/bulk-credit/'+key).groups[0].amount,'200');
});
test('bulk receipts cannot be reassigned or mixed with old usage/credits',async()=>{
  const f=setup();await f.open();await f.fund();
  assert.equal(f.db.has('fp/usage'),false);assert.equal(f.db.has('fc/'+f.id),false);
  await unchanged(f,()=>f.fund(),/bulk_receipt_reused/);
  await unchanged(f,()=>f.pay(f.fp('bulk-credit',{reference:'ee'.repeat(32)+'i0',block:{height:'974140',hash:H},paid:['100'],receiptRoot:H})),/bulk_receipt_reused/);
  await unchanged(f,()=>f.pay({op:'fp',v:2,type:'consume',id:f.id,root:H,permitHash:H}),/funding_incomplete/);
});
test('bulk issued masks retain every hold after expiry even if no signature was delivered',async()=>{
  const f=setup(64,true);await f.open();await f.fund();await f.consume();
  await unchanged(f,()=>f.terminal([0,63],false,'999999999999999999999999999'),/bulk_release_state/);
  assert.equal(f.db.get(capacityKey(f.t.deployment)),'192');assert.equal(f.leaves.get(f.balance).held,'192');
  for(const members of [[1,0],[0,0],[64]])await unchanged(f,()=>f.pay(f.fp('bulk-finish',{members:members.map(index=>({index,inscription:'ff'.repeat(32)+'i'+index}))})),/bulk_member_page/);
});
test('bulk consume cannot use an old execution anchor to bypass the current counted expiry',async()=>{
  const f=setup();await f.open();await f.fund();const plans=bulkPermitPlans(f.t,H),op=f.fp('bulk-consume',{receiptRoot:H,permitRoot:plans.permitRoot});
  await unchanged(f,()=>applyBulkPayment(f.store,op,{network:f.t.network,height:'974570',executionHeight:'974140'}),/bulk_funding_incomplete/);
  await f.pay(op,'974569');assert.equal(f.db.get('fp/'+f.id).state,'bulk-consumed');
});
test('bulk account returned-unit mask independently blocks duplicate restoration and bad proof rollback',async()=>{
  const f=setup(2,true);await f.open();await f.fund();await f.consume();
  await f.pay(f.fp('bulk-finish',{members:[{index:0,inscription:'ff'.repeat(32)+'i0'}]}));
  const action={type:'release-many',id:f.id,terms:f.terms,members:[0],reason:'minted',evidence:H};
  await unchanged(f,()=>f.accounts([action],'974150',op=>{op.accounts[0].proof.leaves[0].value={available:'999',held:'6'};}),/account_root/);
  await f.accounts([action]);await unchanged(f,()=>f.accounts([action]),/bulk_account_member/);
  assert.equal(f.leaves.get(f.balance).held,'3');
});
test('bulk missing supply proof atomically rejects official consume account changes',async()=>{
  const f=setup();await f.open();await f.fund();const plans=bulkPermitPlans(f.t,H);
  await f.pay(f.fp('bulk-consume',{receiptRoot:H,permitRoot:plans.permitRoot}));
  await unchanged(f,()=>f.accounts([{type:'consume-many',id:f.id,terms:f.terms,permitRoot:plans.permitRoot,evidence:H}],'974140',op=>{op.supply.proof={leaves:[],nodes:[]};}),/supply_leaf_missing/);
  assert.equal(f.db.get('ao/'+f.id).state,'reserved');assert.equal(f.leaves.get(f.balance).held,'3');
});
test('bulk custody accrues each member/beneficiary identity exactly once',async()=>{
  const f=setup(64,false,true);await f.open();await f.fund();await f.consume();
  assert.equal([...f.db.keys()].filter(k=>k.startsWith('bc/')).length,64);
  for(const c of f.t.custody){const fee=bulkCustodyFeeKey(f.id,c),row=f.db.get('bc/'+custodyId(f.id,fee));
    assert.equal(row.owner,c.owner);assert.equal(row.amount,'30');assert.equal(row.request,f.id);assert.equal(row.state,'claimable');}
  await unchanged(f,()=>f.consume(),/bulk_funding_incomplete/);
});
test('bulk custody keeps existing claim/settle signatures and checks primary receipt quarantine',async()=>{
  const f=setup(1,false,true);await f.open();await f.fund();await f.consume();
  const id=custodyId(f.id,bulkCustodyFeeKey(f.id,f.t.custody[0])),unsigned={type:'custody-claim',id,revision:'0',destination:'1BitcoinEaterAddressDontSendf59kuE',until:'974151'};
  const claim={...unsigned,sig:Buffer.from(ed25519.sign(lifecycleDigest(f.t.network,unsigned),secret)).toString('hex')};
  const apply=action=>f.pay({op:'fp',v:2,type:'lifecycle',id,action,evidence:H},'974150');
  await apply(claim);assert.equal(f.db.get('bc/'+id).state,'paying');
  const settle={type:'custody-settle',id,claim:f.db.get('bc/'+id).claim,receipt:H},key='fq/fp/bulk-receipt/'+bulkReceiptKey(f.t.bitcoinNetwork,'ee'.repeat(32)+'i0');
  f.db.set(key,{recovery:H});await unchanged(f,()=>apply(settle),/financial_quarantined/);f.db.delete(key);
  await apply(settle);assert.equal(f.db.get('bc/'+id).state,'settled');assert.equal(f.db.get('bc/'+id).amount,'30');
  await unchanged(f,()=>apply(settle),/custody_claim/);
});
test('bulk quarantine/recovery fences late writes, receipts and custody',async()=>{
  for(const keyOf of [f=>'fr/active',f=>'fq/fd/'+f.t.generation,f=>'fq/dc/'+bulkMemberId(f.id,63)]){
    const f=setup(64);await f.accounts([f.sign(bulkReserveAction(f.t))],'974137');f.db.set(keyOf(f),{recovery:H});
    await unchanged(f,()=>f.pay(f.fp('bulk-open',{terms:f.t,capacity:{remaining:'1000',limit:'3'}}),'974137'),/financial_(recovery_active|quarantined)/);
  }
  const f=setup(2,false,true);await f.open();await f.fund();
  f.db.set('fq/bc/'+custodyId(f.id,bulkCustodyFeeKey(f.id,f.t.custody.at(-1))),{recovery:H});
  await unchanged(f,()=>f.consume(),/financial_quarantined/);
});
test('bulk and single-mint reserve-n share nonce proofs and survive intervening account revisions',async()=>{
  const f=setup(2),bulk=f.sign(bulkReserveAction(f.t));
  const single=f.sign({...bulk,id:'dc'.repeat(32),amount:'1',terms:H,nonce:'da'.repeat(32)});
  await f.accounts([single],'974137');await f.accounts([bulk],'974137');
  assert.deepEqual(f.leaves.get(f.balance),{available:'993',held:'7'});
  await unchanged(f,()=>f.accounts([bulk],'974137'),/account_replay/);
  const fresh={...bulk,id:'db'.repeat(32),nonce:'df'.repeat(32)};delete fresh.sig;
  const wrong={...fresh,sig:Buffer.from(ed25519.sign(accountActionDigest(f.t.network,fresh),secret)).toString('hex')};
  await unchanged(f,()=>f.accounts([wrong],'974137'),/account_signature/);
  const packet=f.accountOp([f.sign(fresh)]);packet.accounts[0].revision='0';
  await unchanged(f,()=>applyRootAccounts(f.store,packet,{network:f.t.network,height:'974137'}),/account_revision/);
});
test('bulk strict operation fields, altered commitments and oversized operations fail without writes',async()=>{
  const f=setup();await f.open();
  for(const extra of [{terms:H},{extra:true},{paid:['99']},{receiptRoot:'bad'}]){
    const op=f.fp('bulk-fund',{reference:'ee'.repeat(32)+'i0',block:{height:'974140',hash:H},paid:['100'],receiptRoot:H,...extra});
    await unchanged(f,()=>f.pay(op));
  }
  await unchanged(f,()=>applyBulkPayment(f.store,{...f.fp('bulk-release',{members:[0],reason:'expired'}),padding:'x'.repeat(65536)},{network:f.t.network,height:'974570'}),/bulk_byte_limit/);
});

for (const maximum of [false, true]) test(`bulk late receipt creates reusable exact-denomination credit: maximum=${maximum}`, async () => {
  const f = maximum ? setup(64, false, false, fixture.max64) : setup(2, false, true);
  await f.open(); await f.terminal(f.t.members.map((_, i) => i), false);
  const reference = 'ed'.repeat(32) + 'i0', credit = bulkReceiptKey(f.t.bitcoinNetwork, reference);
  const op = f.fp('bulk-credit', { reference, block: { height: '974571', hash: H }, paid: f.t.groups.map(g => g.amount), receiptRoot: H, feeManifest: f.manifest });
  const forged = structuredClone(op); forged.feeManifest[0].shares[0].gross = '1';
  await unchanged(f, () => f.pay(forged, '974571'), /bulk_fee_manifest/);
  f.db.set('fq/fc/' + credit, { reason: 'recovery' });
  await unchanged(f, () => f.pay(op, '974571'), /financial_quarantined/); f.db.delete('fq/fc/' + credit);
  await f.pay(op, '974571');
  const row = f.db.get('fc/' + credit);
  assert.equal(row.fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString(), f.t.payableFeeAtoms);
  assert.equal(f.db.get('fp/bulk-credit/' + credit).state, 'credited');
  assert.equal(f.db.get('fp/bulk-credit/' + credit).creditId, credit);
  const target = 'ae'.repeat(32), fee = row.fees[0];
  await f.pay({ op: 'fp', v: 2, type: 'open', id: target, owner, terms: H, fees: [fee] }, '974571');
  const use = { op: 'fp', v: 2, type: 'use', id: target, credit, revision: '0', until: '974577', items: [{ fee: fee.key, amount: fee.amount }] };
  use.sig = Buffer.from(ed25519.sign(paymentCreditDigest(f.t.network, use), secret)).toString('hex');
  await f.pay(use, '974571');
  assert.equal(f.db.get('fp/' + target).paid[0], fee.amount); assert.equal(f.db.get('fc/' + credit).fees[0].amount, '0');
  await unchanged(f, () => f.pay(op, '974571'), /bulk_receipt_reused/);
  await unchanged(f, () => f.pay(use, '974571'), /credit_signature/);
});

test('bulk partial-payment release credits only paid groups and only on its first release page', async () => {
  const f = setup(64, false, false, fixture.max64); await f.open();
  const paid = f.t.groups.map((g, i) => i % 2 ? g.amount : '0'); await f.fund(paid);
  await f.pay(f.fp('bulk-release', { members: [0], reason: 'expired', feeManifest: f.manifest }), '974570');
  const credit = bulkReceiptKey(f.t.bitcoinNetwork, 'ee'.repeat(32) + 'i0'), row = structuredClone(f.db.get('fc/' + credit));
  assert.equal(row.fees.reduce((n, fee) => n + BigInt(fee.amount), 0n).toString(), paid.reduce((n, a) => n + BigInt(a), 0n).toString());
  await f.pay(f.fp('bulk-release', { members: [1], reason: 'expired' }), '974570');
  assert.deepEqual(f.db.get('fc/' + credit), row);
});
