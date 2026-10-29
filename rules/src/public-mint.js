import { assert, hashObject, hex } from './core.js';
import { decimalV2, uintV2 } from './integers-v2.js';

export const publicMintValues = settings => settings?.document?.values ?? settings?.values ?? settings ?? {};
export function publicMintActive(settings, height) {
  const v = publicMintValues(settings);
  return v.publicMintActivationHeight !== undefined && BigInt(decimalV2(height)) >= BigInt(uintV2(v.publicMintActivationHeight));
}
export function bitmapMintOpenActive(settings, height) {
  const v = publicMintValues(settings);
  return v.bitmapMintOpenHeight !== undefined &&
    BigInt(decimalV2(height)) >= BigInt(uintV2(v.bitmapMintOpenHeight));
}
export function claimsNeverCloseActive(settings, height) {
  const v = publicMintValues(settings);
  return v.claimsNeverCloseHeight !== undefined && publicMintActive(settings, height) &&
    BigInt(decimalV2(height)) >= BigInt(uintV2(v.claimsNeverCloseHeight));
}
export function claimDeadline(pattern, block, settings) {
  const v = publicMintValues(settings), height = BigInt(decimalV2(block));
  // Older native v2 catalogs did not retain an immutable release clock.
  const release = pattern.releaseHeight ?? pattern.legacy?.releaseHeight ?? v.publicMintActivationHeight;
  const window = pattern.releaseFinderWindow ?? v.publicMintLegacyFinderWindow ?? v.finderWindow;
  assert(release !== undefined && Number.isSafeInteger(window) && window > 0, 'claim_policy_missing');
  const start = BigInt(decimalV2(release));
  return ((height > start ? height : start) + BigInt(window)).toString();
}
export function assertClaimOpen({ pattern, block, height, settings }) {
  if (publicMintActive(settings, height) && !claimsNeverCloseActive(settings, height)) assert(BigInt(decimalV2(height)) < BigInt(claimDeadline(pattern, block, settings)), 'claim_deadline');
}
export function publicBlockRight({ pattern, block, height, settings, find, reserved, headerAward, minted }) {
  assert(publicMintActive(settings, height), 'public_mint_inactive');
  if (claimsNeverCloseActive(settings, height)) {
    if (minted || reserved?.publicMint) return { state: 'already_minted' };
    if (find || reserved || headerAward) return { state: 'claimed' };
    // An untaken block opens to public minting after its first week; agent claims stay open.
    const publicFrom = claimDeadline(pattern, block, settings);
    return BigInt(decimalV2(height)) < BigInt(publicFrom) ? { state: 'not_yet_public', publicFrom } : { state: 'public' };
  }
  const deadline = claimDeadline(pattern, block, settings);
  if (minted) return { state: 'already_minted', claimDeadline: deadline };
  if (find || reserved || headerAward) return { state: 'claimed', claimDeadline: deadline };
  return { state: BigInt(decimalV2(height)) < BigInt(deadline) ? 'claim_window_open' : 'public', claimDeadline: deadline };
}
export const publicPlotId = (asset, block) => hashObject(['dmw-public-plot-v1', asset, decimalV2(block)]);
export const publicRequestId = (network, intent) => hashObject(['dmw-public-request-v1', network, intent]);
export function paymentOrder(a, b) {
  for (const key of ['height', 'transactionIndex', 'inscriptionIndex']) {
    const x = BigInt(uintV2(a[key])), y = BigInt(uintV2(b[key]));
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
export function settlePublicPayments(previous, payments, { claimed = false } = {}) {
  let winner = previous ?? null; const refunds = [];
  for (const payment of [...payments].sort(paymentOrder)) {
    assert(hex(payment.id, 32) && typeof payment.reference === 'string', 'public_payment');
    if (!winner && claimed) refunds.push({ ...payment, reason: 'claimed_first', winner: null, state: 'owed' });
    else if (!winner && payment.complete) winner = payment;
    else if (!winner || payment.reference !== winner.reference) refunds.push({ ...payment,
      reason: payment.complete ? 'someone_paid_first' : 'public_payment_incomplete', winner: winner?.id ?? null, state: 'owed' });
  }
  return { winner, refunds };
}
