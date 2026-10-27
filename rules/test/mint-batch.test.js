import { paidInput } from './pay-first-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as rules from '../src/index.js';
import { observationFixture, requestInput, hashAt, owner, network } from './observation-fixture.mjs';
const publicKey = rules.bytesToHex(secp256k1.getPublicKey(new Uint8Array(32).fill(2)));

test('mint request and free operations share a self-contained bounded audit', () => {
  const input = requestInput(publicKey), f = observationFixture(); f.add(100, 95, { mintOperations: [input] });
  const b = f.build(), decoded = rules.decodeBinary(b.fileBytes[0]);
  assert.deepEqual(decoded.mintOperations, [input]); assert.equal(b.batch.ops[0].op, 'rq');
  assert.equal(rules.recordGet(f.state.balances, owner).p0, '27'); assert.equal(f.state.mints.pending[rules.pendingId(network, input.request)].created, 95);
  assert.throws(() => f.build({ maxMintOps: 0 }), /mint_ops/);
  f.add(101, 96); assert.throws(() => f.build(), /execution_height/);
});
test('mint admission refuses forged requests, wrong holder, live holds, supply clipping and stale expiry', () => {
  const mutations = [
    [i => i.sig = '00'.repeat(64), /owner_signature/],
    [i => i.evidence.minted = true, /already_minted/],
    [i => i.evidence.hold = { id: rules.hash('other'), expiry: 95 }, /block_pending/],
    [i => i.evidence.nonceUsed = true, /mint_evidence/],
    [i => i.evidence.context.deployment.remaining = '2', /mint_capacity/],
    [i => i.evidence.balance = '2', /mint_balance/],
    [i => { i.evidence.context.find.findHeight = 0; i.evidence.context.link = { block: 10, linkHeight: 0 }; }, /bitmap_missing/],
  ];
  for (const [mutate, reason] of mutations) {
    const input = requestInput(publicKey), f = observationFixture(); mutate(input);
    assert.throws(() => f.add(100, 95, { mintOperations: [input] }), reason); assert.equal(f.files.length, 0);
  }
  const f = observationFixture(); assert.throws(() => f.add(100, 95, { mintOperations: [requestInput(publicKey, { expires: 100 })] }), /request_expiry/);
});
test('payment holds and consumption bind independent final items; inscriptions cannot consume',()=>{
  const rq=requestInput(publicKey),mp=paidInput(rq,{op:'mp',confirmations:0});
  assert.equal(observationFixture().add(100,95,{mintOperations:[mp]}).operations[0].op,'mp');
  const mc=paidInput(rq);assert.equal(observationFixture().add(100,95,{mintOperations:[mc]}).operations[0].op,'mc');
  for(const mutate of [i=>i.evidence.payment.receipts[0].confirmations=0,i=>i.evidence.payment.receipts[0].amount='99',i=>i.evidence.reservation.h=false,i=>i.evidence.authorization.paymentHash=rules.hash('other')]){
    const input=structuredClone(mc);mutate(input);assert.throws(()=>observationFixture().add(100,95,{mintOperations:[input]}),/payment_incomplete/);
  }
  assert.throws(()=>observationFixture().add(100,95,{mintOperations:[{...mc,op:'rl'}]}),/mint_input/);
});
test('mint evidence cannot exceed the audit byte cap or mutate state on refusal', () => {
  const input = requestInput(publicKey), f = observationFixture();
  input.evidence.context.deployment.proof = 'x'.repeat(1500000);
  const before = rules.stableJSON(f.state);
  assert.throws(() => f.add(100, 95, { mintOperations: [input] }), /audit_budget/);
  assert.equal(rules.stableJSON(f.state), before);
});
