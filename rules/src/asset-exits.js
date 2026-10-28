import { assert, hash, stableJSON, hex } from './core.js';
import { pendingId, verifyRequest } from './operations.js';

// Version-2 evidence is explicit. Legacy paymentProgress/replay is untouched.
export function confirmedPaymentSeen(payment) {
  return payment.receipts.some(r => r.accepted === true && r.confirmations >= 1 && BigInt(r.amount) > BigInt(r.used ?? '0')) ||
    payment.kind === 'ethereum' && payment.depositFinal === true;
}
export function verifyMintExit(input, { network, counted }) {
  assert(input?.v === 2 && input.op === 'mx' && ['credit', 'ethereum_refund'].includes(input.reason), 'mint_exit_version');
  const { request, sig, evidence: e } = input, id = pendingId(network, request), raw = e?.reservation;
  assert(verifyRequest('rq', network, request, sig, request.until), 'owner_signature');
  assert(e.owner === request.owner && raw && [0, 2].includes(raw.s) && !raw.permitHash && raw.asset === request.asset && raw.amount === request.amount &&
    raw.receive === request.receive && raw.e === request.expires && raw.block === request.block, 'mint_exit_binding');
  assert(e.pending?.id === id && e.pending.expiry === request.expires && e.payment?.requestId === id, 'mint_exit_binding');
  if (input.reason === 'ethereum_refund') {
    const refund = e.refund;
    assert(e.payment.kind === 'ethereum' && refund?.requestId === id && refund.payer === e.payment.payer.toLowerCase() &&
      refund.chainId === e.domain?.chainId && refund.address === e.domain?.address && refund.token === e.domain?.token &&
      refund.deposit?.status === 3 && refund.deposit.payer === refund.payer && refund.confirmations >= 1 &&
      typeof refund.blockHash === 'string' && /^0x[0-9a-f]{64}$/.test(refund.blockHash), 'mint_refund_unproven');
  } else {
    assert(e.payment.kind === 'tap' && counted > request.expires && Array.isArray(e.payment.receipts), 'mint_credit_unproven');
    // Unused confirmed receipts remain independently redeemable. A source
    // timeout must throw before building this evidence, never mean "no funds".
    for (const receipt of e.payment.receipts) assert(hex(receipt.key, 32), 'mint_credit_receipt');
  }
  return { op: 'mx', v: 2, id, outcome: input.reason, evidence: hash(stableJSON(e)) };
}
