import test from 'node:test';
import assert from 'node:assert/strict';
import { Mints, payerDigest } from '../src/mints.mjs';
import { Store } from '../src/store.mjs';
import { rules } from '../src/rules.mjs';
import { hash } from '../src/util.mjs';
import { attachPermit } from '../../committee/signer/adapter.mjs';
import { fixture } from '../../committee/test/fixture.mjs';
import { temp, signEd, feeFixture, network } from './helpers.mjs';
async function setup(kind = 'dmt') {
  const f = fixture(kind), store = await Store.open(await temp()), ops = []; let balance = '30', observation = null, signatures = 0;
  const body = { ...f.proposal, kind: 'tap', payer: f.data.payer };
  body.authorization = signEd(payerDigest(network, body), Buffer.from(f.secret));
  f.data.pending.s = 0; delete f.data.pending.h;
  f.data.payment.receipts = [];
  const reads = { ...f.reads, ...feeFixture({ store }), balance: async () => balance, mint: async () => observation };
  const operations = { supportsMintBatches: true, ensure: async (_key, op) => {
    ops.push(op);
    if (op.op === 'rq') return f.data.acceptance;
    if (op.op === 'mp') { f.data.pending.h = true; return true; }
    if (op.op === 'mc') { Object.assign(f.data.pending, { s: 1, permitHash: op.permitHash, payments: op.payments, paymentHash: rules.paymentCommitment(op.payments) }); return true; }
  } };
  const committee = { signature: async (_key, proposal) => {
    signatures++; const approved = await f.policy.approve(proposal);
    return { payload: attachPermit(approved.permit, { r: '1', s: '1', v: 0 }) };
  } };
  const payments = { mint: async row => ({ ...f.data.payment, requestId: row.id, fees: row.quote.fees }) };
  const mints = new Mints({ store, reads, operations, committee, payments, network });
  const start = async () => { await mints.quote(body); await mints.tick(); f.data.payment.fees = store.get('mints', f.id).quote.fees; };
  const pay = (confirmations = 1, fraction = 1) => {
    f.data.payment.receipts = f.data.payment.fees.map((fee, i) => ({ ...fee, amount: (BigInt(fee.amount) / BigInt(fraction)).toString(), key: hash('payment-' + i), confirmations, accepted: true, origin: f.id, used: '0' }));
  };
  const tick = async (n=1) => { for (let i=0;i<n;i++) await mints.tick(); };
  return { ...f, store, reads, mints, body, operations, ops, start, pay, tick, get signatures(){return signatures;}, setBalance: v => balance=v,
    observe: () => { const r=store.get('mints',f.id); observation={accepted:true,fail:false,confirmations:1,inscription:hash('mint')+'i0',deployment:f.data.context.deployment.id,tick:f.data.context.deployment.tick,receiver:body.receiver,amount:body.request.amount,dta:r.permit.dta,permitHash:r.permit.prv.hash,committee:f.publicKey,...(kind==='dmt'?{block:10}:{})}; } };
}
test('quote reserves; partial final items and top-up precede once-only consumption and permanent permit', async t => {
  const f=await setup();t.after(()=>f.store.close());await f.start();
  assert.equal(f.mints.public(f.id).state,'awaiting_payment'); assert.equal(f.signatures,0);
  f.pay(6,2);await f.tick();assert.equal(f.mints.public(f.id).state,'partly_paid');assert.equal(f.signatures,0);assert.equal(f.data.pending.h,true);
  const first=structuredClone(f.data.payment.receipts);f.pay();
  f.data.payment.receipts=f.data.payment.receipts.map((r,i)=>({...r,key:hash('topup-'+i),amount:(BigInt(r.amount)-BigInt(first[i].amount)).toString()})).concat(first);
  await f.tick(2);const issued=f.mints.public(f.id);assert.equal(issued.state,'permit_issued');assert.equal(f.ops.filter(o=>o.op==='mc').length,1);
  f.data.counted=50000;await f.tick(3);assert.deepEqual(f.mints.public(f.id).permit,issued.permit);assert.deepEqual((await f.mints.request(f.body)).permit,issued.permit);
  assert.equal(f.signatures,1); f.observe();await f.tick();assert.equal(f.mints.public(f.id).state,'minted');assert.equal(f.ops.filter(o=>o.op==='mc').length,1);
  assert.deepEqual(f.store.get('feedBlockChanges', 'mint/p0/10'), { block: 10, asset: 'p0' });
});
test('mempool/confirming payment pins a reservation; finality and all items gate the permit',async t=>{
  const f=await setup();t.after(()=>f.store.close());await f.start();f.pay(0);await f.tick();f.data.counted=1000;await f.tick();assert.equal(f.mints.public(f.id).reservation,'held');assert.equal(f.signatures,0);
  f.pay(5);await f.tick();assert.equal(f.signatures,0);f.pay(6);await f.tick(2);assert.equal(f.mints.public(f.id).state,'permit_issued');
});
test('late paid request re-reserves available units; spent units produce same-rail credit',async t=>{
  for(const available of ['30','0']){const f=await setup();t.after(()=>f.store.close());await f.start();f.data.counted=533;f.data.pending.s=2;await f.tick();assert.equal(f.mints.public(f.id).state,'expired');f.setBalance(available);f.pay();await f.tick(2);
    if(available==='30')assert.equal(f.mints.public(f.id).state,'permit_issued');else{assert.equal(f.mints.public(f.id).reason,'payment_credit');assert.ok(f.mints.public(f.id).credit.length);assert.equal(f.signatures,0);assert.ok(f.store.get('mintCredits',f.id));}
  }
});
test('compound deployment must still be indexed before consumption or signing',async t=>{
  const f=await setup('compound');t.after(()=>f.store.close());await f.start();f.pay();f.data.context.deployment.active=false;await f.tick(3);assert.equal(f.signatures,0);assert.equal(f.ops.some(o=>o.op==='mc'),false);f.data.context.deployment.active=true;await f.tick(2);assert.equal(f.mints.public(f.id).state,'permit_issued');
});
test('payer authorization and exact signed expiry are required; payer shares stay in full split only',async t=>{
  const f=await setup();t.after(()=>f.store.close());await assert.rejects(f.mints.request({...f.body,payer:'other'}),/payer_authorization/);
  f.data.context.finderAddress=f.body.payer;f.reprice({consumed:false});await f.start();const q=f.mints.public(f.id);assert.equal(q.fees.some(i=>i.role==='finder'),false);assert.equal(q.fullFees.find(i=>i.role==='finder').amount,'30');assert.equal(q.payableAmount,'70');
  assert.deepEqual(q.blocked,[]);assert.equal(q.payable,true);
});

test('a signed preview cannot silently change Bitmap ownership before reservation',async t=>{
  const f=await setup();t.after(()=>f.store.close());
  f.data.context.link={block:10,linkHeight:90};f.data.bitmap={agent:f.body.request.owner,address:'original-holder'};
  const quote=await f.mints.quote({asset:'p0',block:10,kind:'tap'});
  assert.deepEqual(rules.publicIdentities(quote.feeQuote), quote.feeQuote, 'signed quote bytes survive the public projection');
  f.data.bitmap={agent:f.body.request.owner,address:'new-holder'};
  await assert.rejects(f.mints.quote({asset:'p0',block:10,kind:'tap',feeQuote:quote.feeQuote}),/quote_recipient_changed/);
});
