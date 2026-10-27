import * as rules from '../../rules/src/index.js';
import { owner, secret, network } from '../../rules/test/observation-fixture.mjs';
export function linkInput(height = 42, kind = 'tap') {
  const request = { owner, height, nonce: rules.hash('link-' + height), until: 200 };
  const id = rules.linkId(network, request), zero = '0x' + '00'.repeat(20), payer = kind === 'tap' ? 'local-payer' : '0x' + '11'.repeat(20);
  const terms = { payer, treasury: kind === 'tap' ? 'local-treasury' : '0x' + '22'.repeat(20), baseFee: '5', hash: rules.hash('lock'),
    ...(kind === 'ethereum' ? { chainId: '31337', contract: '0x' + '33'.repeat(20), token: '0x' + '44'.repeat(20) } : {}) };
  const split = rules.splitFee('100', { kind: 'link' });
  const payment = { id: rules.hash('payment') + 'i0:0', requestId: id, kind, payer, total: '100', consumed: true, confirmations: 1, verifiedHeight: 90, eventIndex: 0,
    ...(kind === 'tap' ? { tick: 'tap', lockKind: 'htlc', conditionType: 'hashlock', hash: terms.hash, refund: payer, claim: terms.treasury,
      base: split.treasury, allocations: rules.tapPaymentAllocations(split, {}, 'link'), refundAfter: 400 } : {
      chainId: terms.chainId, contract: terms.contract, token: terms.token, status: 2, timestamp: '1000', expiry: '2000',
      split: { treasury: terms.treasury, treasuryAmount: split.treasury, finder: zero, finderAmount: '0', landowner: zero, landownerAmount: '0', discoverer: zero, discovererAmount: '0', burnAmount: split.burn } }),
    settlement: { accepted: true, refund: false, paymentId: rules.hash('payment') + 'i0:0', txid: rules.hash('release'), confirmations: 1 } };
  return { request, sig: rules.signLink(network, request, secret), terms, payment };
}
