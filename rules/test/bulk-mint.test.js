import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { p2tr } from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { BULK_LIMITS, validateBulkTerms, validateBulkFees, bulkOrderId, bulkMemberId, bulkMembersRoot,
  bulkFeeRoot, bulkReserveAction, bulkWalletItems, bulkPermitPlans, bulkBytes, bulkIndices, validateBulkQuoteInput, bulkCapacitySuccessor } from '../src/bulk-mint.js';
import { stableJSON, hashObject } from '../src/core.js';
import { permit } from '../../committee/signer/adapter.mjs';
import { bulkFinancialPlan, bulkBatchWork } from '../src/bulk-execution.js';
import { financialPlan, nonceReservation, financialReserveGroups, mergedReservePlans } from '../src/financial-execution.js';
import { settingsRevision, SETTINGS_PROFILE } from '../src/settings-v2.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/bulk-v1.json', import.meta.url)));
function sample(n = 1) {
  const { terms: t, feeManifest: fees } = structuredClone(fixture);
  t.members = Array.from({ length: n }, (_, i) => ({ block: String(900000 + i), amount: '3' }));
  const manifest = t.members.map((_, member) => ({ ...structuredClone(fees[0]), member }));
  t.totalAmount = String(n * 3); t.grossFeeAtoms = t.payableFeeAtoms = t.groups[0].amount = String(n * 100);
  t.membersRoot = bulkMembersRoot(t.members); t.feeRoot = bulkFeeRoot(manifest);
  t.feeQuote.scope = stableJSON(['mint-bulk-v1', t.asset, t.deployment, t.membersRoot]);
  t.mintFunding.satoshis = n * 546 + 6546 + Number(t.mintFunding.maxFeeSats);
  return { t, manifest };
}
test('bulk shared fixture and deterministic identities are stable', () => {
  const { terms: t } = fixture;
  assert.equal(validateBulkTerms(t), t); validateBulkFees(t, fixture.feeManifest);
  assert.equal(bulkOrderId(t.network, t.owner, t.nonce), fixture.orderId);
  assert.equal(hashObject(t), fixture.termsHash); assert.deepEqual(bulkReserveAction(t), fixture.reserve);
  assert.deepEqual(bulkPermitPlans(t, fixture.receiptRoot), fixture.permits);
  assert.equal(Object.hasOwn(fixture.reserve, 'revision'), false);
});
test('bulk maximum shared fixture measures real 64-member/131-group request and operation bytes',()=>{
  const f=fixture.max64,t=f.terms;validateBulkFees(t,f.feeManifest);
  assert.equal(t.members.length,64);assert.equal(t.groups.length,131);assert.equal(f.feeManifest.flatMap(m=>m.shares).length,320);
  const reserve={...bulkReserveAction(t),sig:'aa'.repeat(64)},request={version:1,terms:t,feeManifest:f.feeManifest,reserve};
  assert.equal(Buffer.byteLength(stableJSON(t)),f.wireBytes.terms);assert.equal(Buffer.byteLength(stableJSON(request)),f.wireBytes.signedRequest);
  assert.equal(bulkPermitPlans(t,f.receiptRoot).permitRoot,f.permitRoot);assert.equal(bulkWalletItems(t).length,131);
  bulkBytes(t,BULK_LIMITS.termsBytes);bulkBytes(f.feeManifest,BULK_LIMITS.feeManifestBytes);bulkBytes(request,BULK_LIMITS.requestBytes);
  assert.equal(f.wireBytes.bulkOpen<=BULK_LIMITS.operationBytes,true);
  assert.throws(()=>bulkBytes(request,f.wireBytes.signedRequest-1),/bulk_byte_limit/);
  bulkBytes(request,f.wireBytes.signedRequest);
});
test('bulk N=1/64 succeeds, N=65 and duplicate/reordered blocks reject', () => {
  for (const n of [1, 64]) { const { t, manifest } = sample(n); validateBulkFees(t, manifest); }
  assert.throws(() => validateBulkTerms(sample(65).t), /bulk_members/);
  for (const blocks of [['900001', '900000'], ['900000', '900000']]) {
    const { t } = sample(2); t.members.forEach((m, i) => { m.block = blocks[i]; });
    assert.throws(() => validateBulkTerms(t), /bulk_members/);
  }
});
test('bulk G=131 is accepted and 132 rejected, groups sort by UTF-8 tuple', () => {
  const { t } = sample(64);
  t.groups = Array.from({ length: 131 }, (_, i) => ({ to: p2tr(secp256k1.getPublicKey(BigInt(i + 1)).slice(1)).address,
    ticker: 'tap', tt: 'a', amount: '1' })).sort((a, b) => Buffer.compare(Buffer.from(stableJSON(['tap', 'a', a.to])), Buffer.from(stableJSON(['tap', 'a', b.to]))));
  t.payableFeeAtoms = t.grossFeeAtoms = '131'; validateBulkTerms(t);
  t.groups.push(t.groups[0]); assert.throws(() => validateBulkTerms(t), /bulk_groups/);
  t.groups.pop(); t.groups.reverse(); assert.throws(() => validateBulkTerms(t), /bulk_group_order/);
});
test('bulk amounts never round-trip through Number and overflow rejects', () => {
  const { t } = sample(); t.members[0].amount = t.totalAmount = '9007199254740993';
  t.membersRoot = bulkMembersRoot(t.members); t.feeQuote.scope = stableJSON(['mint-bulk-v1', t.asset, t.deployment, t.membersRoot]);
  validateBulkTerms(t); assert.equal(bulkReserveAction(t).amount, '9007199254740993');
  t.groups[0].amount = t.payableFeeAtoms = t.grossFeeAtoms = '18446744073709551616000000000000000000';
  assert.throws(() => validateBulkTerms(t), /tap_amount_range/);
});
test('bulk exact byte boundary accepts and one byte over rejects', () => {
  assert.equal(bulkBytes('x'.repeat(100), 102).length, 100);
  assert.throws(() => bulkBytes('x'.repeat(101), 102), /bulk_byte_limit/);
  const { t } = sample(); t.ticker = 'x'.repeat(BULK_LIMITS.termsBytes);
  assert.throws(() => validateBulkTerms(t), /bulk_byte_limit/);
});
test('bulk strict nested objects, canonical integers and Bitcoin network', () => {
  for (const mutate of [t => { t.extra = true; }, t => { t.members[0].extra = true; }, t => { t.groups[0].extra = true; },
    t => { t.mintFunding.extra = true; }, t => { t.feeQuote.payouts = []; }, t => { t.feeQuote.unit.extra = true; },
    t => { t.until = '0974139'; }, t => { t.receiver = 'invalid'; }, t => { t.bitcoinNetwork = 'regtest'; },
    t => { t.feeQuote.expiresAt++; }, t => { t.mintFunding.satoshis++; }]) {
    const { t } = sample(); mutate(t); assert.throws(() => validateBulkTerms(t));
  }
});
test('bulk fee manifest conserves per-member rounding and custody beneficiary identities', () => {
  const { t, manifest } = sample(2);
  for (const [i, m] of manifest.entries()) m.shares = [
    { role: 'finder', group: 0, beneficiary: String(i + 1).repeat(64), gross: '30', payable: '30' },
    { role: 'treasury', group: 0, beneficiary: null, gross: '70', payable: '70' }];
  t.custody = manifest.map(m => ({ member: m.member, role: 'finder', group: 0, owner: m.shares[0].beneficiary, amount: '30' }));
  t.feeRoot = bulkFeeRoot(manifest); validateBulkFees(t, manifest);
  t.custody[1].owner = t.custody[0].owner; assert.throws(() => validateBulkFees(t, manifest), /bulk_fee_conservation/);
});
test('bulk exempt shares, zero-payable and fabricated group allocations reject', () => {
  const { t, manifest } = sample();
  manifest[0].shares[0].payable = '99'; t.feeRoot = bulkFeeRoot(manifest);
  assert.throws(() => validateBulkFees(t, manifest), /bulk_fee_share/);
  t.groups = []; assert.throws(() => validateBulkTerms(t), /bulk_groups/);
});
test('bulk self exemptions reduce only that member share and reject self-payable destinations', () => {
  const {t,manifest}=sample();
  manifest[0].shares=[{role:'finder',group:null,beneficiary:null,gross:'30',payable:'0'},
    {role:'treasury',group:0,beneficiary:null,gross:'70',payable:'70'}];
  t.payableFeeAtoms=t.groups[0].amount='70';t.feeRoot=bulkFeeRoot(manifest);validateBulkFees(t,manifest);
  t.payer=t.groups[0].to;assert.throws(()=>validateBulkFees(t,manifest),/bulk_fee_self_payment/);
});
test('bulk rejects a nominally small order whose ordinary member payload exceeds 2048 bytes',()=>{
  const {t}=sample();t.members[0].block='1'.repeat(1500);t.membersRoot=bulkMembersRoot(t.members);
  t.feeQuote.scope=stableJSON(['mint-bulk-v1',t.asset,t.deployment,t.membersRoot]);
  assert.throws(()=>validateBulkTerms(t),/bulk_mint_payload_bytes/);
});
test('bulk permit grammar is byte-identical to ordinary member permits', () => {
  const { t } = sample(64), plans = bulkPermitPlans(t, fixture.receiptRoot);
  for (const p of plans.plans) {
    const expected = permit(t.network, t.members[p.index], { kind: 'dmt', id: t.deployment, tick: t.ticker }, t.receiver, p.memberId, plans.paymentHash);
    const { memberId, index, ...actual } = p; assert.deepEqual(actual, expected);
    assert.equal(memberId, bulkMemberId(bulkOrderId(t.network, t.owner, t.nonce), index));
  }
  assert.notEqual(bulkPermitPlans(t, 'aa'.repeat(32)).permitRoot, plans.permitRoot);
});
test('bulk wallet uses one distinct order-domain item per positive group', () => {
  const { t } = sample(), items = bulkWalletItems(t);
  assert.deepEqual(items, [{address:t.groups[0].to,tick:'tap',amt:'0.0000000000000001',dta:`dmw-bulk-pay-v1|${fixture.orderId}|0`}]);
});
test('bulk terminal pages use full 64-bit masks and ascending distinct indices', () => {
  assert.deepEqual(bulkIndices([0, 31, 32, 63], 64), [0, 31, 32, 63]);
  for (const indices of [[], [1, 0], [1, 1], [64], [-1], ['1']]) assert.throws(() => bulkIndices(indices, 64));
});
test('bulk quote input rejects duplicate, unknown and oversized requests', () => {
  const { terms: t } = fixture, q = {v:1,owner:t.owner,nonce:t.nonce,asset:t.asset,deployment:t.deployment,receiver:t.receiver,payer:t.payer,blocks:['900000']};
  validateBulkQuoteInput(q);
  assert.throws(() => validateBulkQuoteInput({...q,blocks:['900000','900000']}));
  assert.throws(() => validateBulkQuoteInput({...q,extra:true}));
  assert.throws(() => validateBulkQuoteInput({...q,blocks:Array.from({length:65},(_,i)=>String(i))}));
});
test('bulk capacity successor changes only the two capacity settings, without activation or price changes', () => {
  const prior=settingsRevision({network:'bulk-test',effectiveBatch:'1',effectiveBitcoinWindow:'974137',values:SETTINGS_PROFILE}),
    successor=bulkCapacitySuccessor(prior,{effectiveBatch:'2',effectiveBitcoinWindow:'974137'});
  assert.equal(prior.values.batchBytes,98304);assert.equal(prior.values.mintOperationBudget,32);
  assert.deepEqual(successor.values,{...prior.values,batchBytes:120000,mintOperationBudget:128});
  assert.equal(successor.previousRevisionHash,hashObject(prior));assert.equal(successor.effectiveBitcoinWindow,prior.effectiveBitcoinWindow);
  validateBulkTerms(fixture.terms);
});

function executionFixture(n = 1) {
  const {t,manifest}=sample(n), id=bulkOrderId(t.network,t.owner,t.nonce), terms=hashObject(t), H='aa'.repeat(32);
  const d={reserved:'0',minted:'0',maximum:'1000000'}, records=new Map([['fd/'+t.generation,d]]), read=async k=>records.get(k)??null;
  const transition={type:'reserve-many',id,action:{...bulkReserveAction(t),sig:'bb'.repeat(64)},terms:t};
  const evidence={version:1,requestId:id,terms:t,feeManifest:manifest,owner:t.owner,asset:t.asset,amount:t.totalAmount,receiver:t.receiver,payer:t.payer,rail:'tap',
    feeAuthorization:{network:t.network,quote:t.feeQuote,id,until:t.expires,counted:'974137',at:t.feeQuote.issuedAt,signature:'cc'.repeat(64)},
    capacity:{deployment:t.deployment,asset:t.asset,amount:t.totalAmount,block:null,remaining:'1000000',limit:'3',supplyScope:t.supplyScope},
    generationCapacity:{deployment:t.generation,...d},members:t.members.map((m,i)=>({...m,memberId:bulkMemberId(id,i),find:{...m,asset:t.asset,count:m.amount},link:null,holder:null,
      deployment:{id:t.deployment,tick:t.ticker,kind:'dmt'}})),expiry:t.expires,settingsHash:t.settingsHash};
  const options={read,height:'974137',document:{values:{requestMinBlocks:6,requestMaxBlocks:2016}}};
  return {t,id,terms,H,records,read,transition,evidence,options};
}
test('bulk planner emits one ordinary reserve-n and one atomic open, single-mint groups share one account proof',async()=>{
  const f=executionFixture(64), input={transition:f.transition,evidence:f.evidence};
  const plan=await financialPlan(input,f.options);
  assert.deepEqual(plan,await bulkFinancialPlan(input,f.options));assert.equal(plan.length,2);
  assert.deepEqual(plan[0],{op:'ar',actions:[f.transition.action]});assert.equal(plan[1].type,'bulk-open');
  assert.deepEqual(plan[1].capacity,{remaining:'1000000',limit:'3'});assert.equal(plan[1].evidence,hashObject(f.evidence));
  const single={type:'reserve',action:{...f.transition.action,id:'dd'.repeat(32)}};
  assert.equal(nonceReservation(single),true);assert.equal(nonceReservation(f.transition),true);
  assert.equal(financialReserveGroups([{...input,reserveGroup:2},{transition:single}])[0].length,2);
  const merged=mergedReservePlans([plan,[{op:'ar',actions:[single.action]},{op:'fp',type:'open'}]]);
  assert.equal(merged[0][0].actions.length,2);assert.equal(merged[1].length,1);
  const tampered=structuredClone(f.evidence);tampered.members.at(-1).amount='4';
  await assert.rejects(bulkFinancialPlan({...input,evidence:tampered},f.options),/bulk_reservation_members/);
});
test('bulk planner authenticates every exact transfer including failure, payer, recipient and order data',async()=>{
  const f=executionFixture();f.records.set('fp/'+f.id,{kind:'bulk-v1',manifest:f.t,terms:f.terms});
  const transition={type:'bulk-fund',id:f.id,reference:'dd'.repeat(32)+'i0'},
    row={index:7,ins:transition.reference,fail:false,int:true,addr:f.t.payer,taddr:f.t.groups[0].to,tick:'tap',amt:'100',dta:`dmw-bulk-pay-v1|${f.id}|0`};
  const evidence={requestId:f.id,owner:f.t.owner,terms:f.terms,state:'settled',reference:transition.reference,confirmations:1,
    block:{height:'974137',hash:f.H},paid:['100'],transfers:[row],receiptRoot:null};
  const root=e=>hashObject(['dmw-bulk-receipt-v1',f.t.network,transition.reference,e.block.hash,e.transfers]);
  evidence.receiptRoot=root(evidence);
  assert.equal((await bulkFinancialPlan({transition,evidence},f.options))[0].receiptRoot,evidence.receiptRoot);
  for(const [field,value]of [['addr','attacker'],['taddr','attacker'],['amt','99'],['tick','other'],['int',false],['ins','ee'.repeat(32)+'i0'],['dta',`dmw-mint-pay-v1|${f.id}|0`]]){
    const e=structuredClone(evidence);e.transfers[0][field]=value;e.receiptRoot=root(e);
    await assert.rejects(bulkFinancialPlan({transition,evidence:e},f.options),/bulk_transfer/);
  }
  for(const mutate of [e=>e.transfers=[],e=>e.transfers.push(row),e=>e.confirmations=0,e=>e.extra=true]){
    const e=structuredClone(evidence);mutate(e);e.receiptRoot=root(e);
    await assert.rejects(bulkFinancialPlan({transition,evidence:e},f.options),/bulk_payment_evidence/);
  }
  const failed=structuredClone(evidence);failed.transfers[0].fail=true;failed.paid=['0'];failed.receiptRoot=root(failed);
  assert.deepEqual((await bulkFinancialPlan({transition,evidence:failed},f.options))[0].paid,['0']);
});
test('bulk planner emits consume before accounts, extra finish releases only its member page',async()=>{
  const f=executionFixture(2);f.t.supplyScope=f.t.deployment;f.terms=hashObject(f.t);
  const plans=bulkPermitPlans(f.t,f.H);f.records.set('fp/'+f.id,{kind:'bulk-v1',manifest:f.t,terms:f.terms,receiptRoot:f.H});
  const base={requestId:f.id,owner:f.t.owner,terms:f.terms};
  let operations=await bulkFinancialPlan({transition:{type:'bulk-consume',id:f.id,permitRoot:plans.permitRoot},
    evidence:{...base,state:'authorized',receiptRoot:f.H,permitRoot:plans.permitRoot}},f.options);
  assert.deepEqual(operations.map(o=>o.type??o.actions[0].type),['bulk-consume','consume-many']);
  const members=[{index:1,inscription:'dd'.repeat(32)+'i0'}],m=f.t.members[1],p=plans.plans[1];
  operations=await bulkFinancialPlan({transition:{type:'bulk-finish',id:f.id,members},evidence:{...base,state:'minted',members:[{...members[0],
    memberId:p.memberId,amount:m.amount,block:m.block,deployment:f.t.generation,permitHash:p.digest,confirmations:1}]}},f.options);
  assert.deepEqual(operations[1].actions[0].members,[1]);assert.equal(operations[1].actions[0].reason,'minted');
});
test('bulk work bounds apply across all observations and merged groups',async()=>{
  const f=executionFixture(64), input={transition:f.transition,evidence:f.evidence};
  assert.deepEqual(await bulkBatchWork(Array(32).fill(input),{read:f.read}),{members:2048,groups:32});
  await assert.rejects(bulkBatchWork(Array(33).fill(input),{read:f.read}),/bulk_batch_work/);
  f.t.groups=Array.from({length:131},(_,i)=>({to:p2tr(secp256k1.getPublicKey(BigInt(i+1)).slice(1)).address,ticker:'tap',tt:'a',amount:'1'}))
    .sort((a,b)=>Buffer.compare(Buffer.from(stableJSON(['tap','a',a.to])),Buffer.from(stableJSON(['tap','a',b.to]))));
  f.t.payableFeeAtoms=f.t.grossFeeAtoms='131';f.transition.action={...bulkReserveAction(f.t),sig:'bb'.repeat(64)};
  assert.deepEqual(await bulkBatchWork(Array(31).fill(input),{read:f.read}),{members:1984,groups:4061});
  await assert.rejects(bulkBatchWork(Array(32).fill(input),{read:f.read}),/bulk_batch_work/);
});
