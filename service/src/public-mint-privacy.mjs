import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { rules } from './rules.mjs';
import { publicScanKey } from '../../contract/public-mint.js';

export const requesterSecretHash = secret => createHash('sha256').update(secret).digest('hex');
export const newRequesterSecret = () => randomBytes(32).toString('hex');
export function matchesRequesterSecret(expected, supplied) {
  const valid = typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected);
  const actual = createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest();
  // Always compare fixed-size digests, including missing/malformed input.
  const equal = timingSafeEqual(Buffer.from(valid ? expected : '0'.repeat(64), 'hex'), actual);
  return valid && equal;
}
export function publicMintTargetVisible(store, row, secret) {
  if (!row.publicMint || row.permit || matchesRequesterSecret(row.requesterSecretHash, secret)) return true;
  return !!store?.get('accountRecords', publicScanKey(rules.publicPlotId(row.request.asset, row.request.block, row.intent?.supplyScope ?? row.request.supplyScope)))?.winner;
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const feeAmounts = rows => (rows ?? []).map(row => pick(row, ['role', 'to', 'ticker', 'amount', 'tt']));
export function privatePublicRefundView(row) {
  return { ...pick(row, ['id', 'requestId', 'paymentId', 'reference', 'tapAddress', 'reason', 'state', 'refundId']), fees: feeAmounts(row.fees) };
}

// A whitelist also hides indirect target identifiers: deployment/ticker,
// feeQuote.scope, signed intents, output units and refund plot fields.
export function privatePublicMintView(status) {
  const view = pick(status, ['id', 'requestId', 'receiver', 'payer', 'kind', 'state', 'publicMint', 'reservation', 'unitsConsumed',
    'payableAmount', 'price', 'baseFee', 'unit', 'payBy', 'created', 'expiry', 'networkFeeSats', 'payment', 'reason', 'paymentPage',
    'mintFunding', 'mintSender', 'sentInscription', 'publicBulkOrderId']);
  return { ...view, fees: feeAmounts(status.fees), fullFees: feeAmounts(status.fullFees), missing: feeAmounts(status.missing),
    refunds: (status.refunds ?? []).map(row => pick(row, ['requestId', 'paymentId', 'reason', 'state', 'refundId', 'refundDelivery'])), winner: null,
    // Legacy payment dta embeds the target. Only the requester may obtain those
    // signing bytes until the claim is public.
    payable: false, blocked: ['public_mint_requester_required'], requesterRequired: true };
}
