import { publicMintActive, publicPlotId, paymentOrder, settlePublicPayments, claimsNeverCloseActive } from '../rules/src/public-mint.js';
import { validatePublicScanClaim } from '../rules/src/public-claims.js';
import { hashObject, hex, stableJSON } from '../rules/src/core.js';
import { uintV2 } from '../rules/src/integers-v2.js';
import { reserveFinancialCapacity } from './financial-capacity.js';
import { financialUnfrozen } from './financial-lifecycle.js';
import { validatePublicPaymentSettlement } from './public-payment.js';
const check = (ok, reason) => { if (!ok) throw Error(reason); };
export const publicScanKey = id => 'fp/public/' + id;
export const publicRefundKey = payment => 'fp/public-refund/' + hashObject([payment.id, payment.reference]);
const cursor = c => c && ['height', 'transactionIndex', 'inscriptionIndex'].every(k => { try { uintV2(c[k]); return true; } catch { return false; } });

// Only a quorum-certified complete Bitcoin prefix can advance this cursor.
// Starting a checkout never creates an account, hold or capacity reservation.
export async function applyPublicScan(store, op, { network, height, settings }) {
  check(publicMintActive(settings, height), 'public_mint_inactive');
  const key = publicScanKey(op.id), old = await store.get(key);
  await financialUnfrozen(store, [key, 'fp/chain']);
  check(op.id === publicPlotId(op.asset, op.block) && op.previous === hashObject(old ?? null) && cursor(op.from) && cursor(op.next) &&
    paymentOrder(op.from, op.next) < 0 && BigInt(op.from.height) >= BigInt(settings.publicMintActivationHeight) &&
    BigInt(op.from.height) <= BigInt(height) && BigInt(op.next.height) <= BigInt(height) + 1n && hex(op.blockHash, 32) &&
    stableJSON(op.from) === stableJSON(old?.next ?? { height: op.start, transactionIndex: '0', inscriptionIndex: '0' }), 'public_scan_sequence');
  check(Array.isArray(op.payments) && op.payments.length <= settings.publicMintPageSize && op.payments.every((p, i) =>
    hex(p.id, 32) && typeof p.reference === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(p.reference) &&
    typeof p.complete === 'boolean' && p.asset === op.asset && p.block === op.block && typeof p.tapAddress === 'string' && p.tapAddress.length <= 128 &&
    Array.isArray(p.fees) && p.fees.length <= settings.paymentPage && p.fees.every(f => typeof f.amount === 'string' && /^[1-9][0-9]*$/.test(f.amount)) &&
    paymentOrder(p, op.from) >= 0 && paymentOrder(p, op.next) < 0 && (!i || paymentOrder(op.payments[i - 1], p) < 0)), 'public_scan_payments');
  for (const payment of op.payments) await validatePublicPaymentSettlement(store, payment, { network, height, settings });
  const active = claimsNeverCloseActive(settings, height);
  if (active) {
    // Agent state is authenticated by the independently replayed quorum batch.
    // Bind its public predecessor to the contract's own accepted payment row.
    validatePublicScanClaim(op.claim, op.asset);
    check(op.claim.publicWinner === (old?.winner?.id ?? null), 'public_claim_predecessor');
  }
  const { winner, refunds } = settlePublicPayments(old?.winner, op.payments, { claimed: active && op.claim.claimed }), writes = [];
  if (winner && !old?.winner) {
    const source = winner.source;
    check(source?.publicMint === true && source.requestId === winner.id && source.asset === op.asset && source.request.block === op.block &&
      source.payer === winner.tapAddress && source.receiver === winner.tapAddress && hex(winner.permitHash, 32) &&
      source.capacity?.asset === op.asset && source.capacity.block === op.block && !await store.get('fp/' + winner.id), 'public_winner_binding');
    writes.push(...await reserveFinancialCapacity(store, winner.id, source.capacity));
    const generation = await store.get('fd/' + source.generation), amount = BigInt(source.amount), plot = 'dc/plot/' + op.asset + '/' + op.block;
    await financialUnfrozen(store, ['fd/' + source.generation, 'dc/' + winner.id, plot]);
    check(generation?.deployment === source.deployment.id && generation.asset === op.asset &&
      await store.get('fd/asset/' + op.asset) === source.generation && !await store.get(plot) &&
      BigInt(generation.minted) + BigInt(generation.reserved) + amount <= BigInt(generation.maximum), 'financial_capacity');
    writes.push(['fd/' + source.generation, { ...generation, reserved: String(BigInt(generation.reserved) + amount) }],
      ['dc/' + winner.id, { publicMint: true, state: 'issued', deployment: source.generation, asset: op.asset, amount: source.amount,
        plot: op.block, terms: hashObject(source), permitHash: winner.permitHash }], [plot, winner.id]);
    writes.push(['fi/source/' + winner.id, source], ['fp/' + winner.id, { owner: null, publicMint: true, terms: hashObject(source),
      fees: source.fees, paid: source.fees.map(f => f.amount), sequence: '1', root: winner.paymentHash, consumedRoot: winner.paymentHash,
      state: 'consumed', permitHash: winner.permitHash, capacity: source.capacity }]);
  }
  for (const refund of refunds) {
    const refundKey = publicRefundKey(refund); check(!await store.get(refundKey), 'public_payment_replay');
    const { source, ...row } = refund; writes.push([refundKey, row]);
  }
  writes.push([key, { asset: op.asset, block: op.block, next: op.next, blockHash: op.blockHash, scannedHeight: op.from.height, winner }]);
  for (const [k, value] of writes) store.put(k, value);
}
