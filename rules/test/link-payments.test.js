import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { observationFixture, owner, secret, network } from './observation-fixture.mjs';
const zero = '0x' + '00'.repeat(20);
function input(kind) {
  const request = { owner, height: 10, nonce: r.hash('paid-link-' + kind), until: 100 };
  const id = r.linkId(network, request), total = r.feeFor('link', '2'), split = r.splitFee(total, { kind: 'link' });
  const terms = { baseFee: '2', treasury: kind === 'tap' ? 'treasury' : '0x' + '11'.repeat(20), payer: kind === 'tap' ? 'payer' : '0x' + '22'.repeat(20), hash: r.hash('release') };
  const payment = { kind, id: 'payment-' + kind, requestId: id, payer: terms.payer, total, consumed: true, confirmations: 1, verifiedHeight: 94, eventIndex: 0,
    settlement: { accepted: true, refund: false, paymentId: 'payment-' + kind, txid: r.hash('settled'), confirmations: 1 } };
  if (kind === 'tap') Object.assign(payment, { tick: 'tap', lockKind: 'htlc', conditionType: 'hashlock', hash: terms.hash, refund: terms.payer, claim: terms.treasury,
    base: split.treasury, allocations: r.tapPaymentAllocations(split, {}, 'link'), refundAfter: 200 });
  else {
    Object.assign(terms, { chainId: '31337', contract: '0x' + '33'.repeat(20), token: '0x' + '44'.repeat(20) });
    Object.assign(payment, { chainId: terms.chainId, contract: terms.contract, token: terms.token, status: 2, timestamp: '100', expiry: '200',
      split: { treasury: terms.treasury, treasuryAmount: split.treasury, finder: zero, finderAmount: '0', landowner: zero, landownerAmount: '0', discoverer: zero, discovererAmount: '0', burnAmount: split.burn } });
  }
  return { request, sig: r.signLink(network, request, secret), terms, payment };
}
for (const kind of ['tap', 'ethereum']) test(`paid Bitmap links retain signatures, split and final-settlement checks on ${kind}`, () => {
  const paid = input(kind);
  assert.equal(r.verifyLinkInput(paid, network, 95).id, r.linkId(network, paid.request));
  const f = observationFixture(), result = f.add(100, 95, { linkOperations: [{ ...paid, bitmap: { agent: owner }, previous: null }] });
  assert.deepEqual(r.recordGet(result.state.links, 10), { block: 10, linkHeight: 95 });
  assert.equal(result.file.linkOutcomes[0].reason, 'accepted');
  assert.equal(result.file.ops[0].key, 'link/a');
  for (const mutate of [p => p.payment.consumed = false, p => p.payment.settlement.refund = true, p => p.payment.confirmations = 0, p => p.sig = '00'.repeat(64), p => p.payment.total = '39']) {
    const bad = input(kind); mutate(bad); assert.throws(() => r.verifyLinkInput(bad, network, 95), /link_/);
  }
});
test('Ethereum link evidence with a removed recipient field is refused', () => {
  const paid = input('ethereum'); paid.payment.split.charterer = zero; paid.payment.split.chartererAmount = '0';
  assert.throws(() => r.verifyLinkInput(paid, network, 95), /link_ethereum/);
});
