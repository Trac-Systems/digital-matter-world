// Shared by signing and quote sizing so the measured envelope follows the wire format.
export const REFUND_MAX_FEES = 100;
export const REFUND_AMOUNT_DIGITS = 78;
export function refundMessage(amounts, address, refundId, authority) {
  const data = 'dmw-refund-v1|' + refundId;
  const items = Object.entries(amounts).sort(([a], [b]) => a.localeCompare(b)).map(([tick, amount]) => {
    const padded = amount.padStart(19, '0'), fraction = padded.slice(-18).replace(/0+$/, '');
    return { tick, amt: padded.slice(0, -18) + (fraction ? '.' + fraction : ''), address, dta: data };
  });
  return { auth: authority, items, data };
}
export const tokenAuthPayload = (message, field, digest, sig, salt) => ({ p: 'tap', op: 'token-auth', [field]: message, hash: digest, sig, salt });

export function refundRedeemBytes(payer) {
  // A refund may include overpayment: quoted fees do not bound its amount.
  // The accepted refund format permits 100 amounts of up to 78 decimal digits,
  // one TAP item, a 10-digit authority index, and decimal secp256k1 signatures.
  // Subtract one from the maximum sum to retain all 18 fractional digits.
  const amount = String(BigInt(REFUND_MAX_FEES) * (10n ** BigInt(REFUND_AMOUNT_DIGITS) - 1n) - 1n);
  const message = refundMessage({ tap: amount }, payer, 'f'.repeat(64), 'f'.repeat(64) + 'i9999999999');
  const sig = { v: '3', r: '9'.repeat(78), s: '9'.repeat(77) }; // low-S signing
  return Buffer.byteLength(JSON.stringify(tokenAuthPayload(message, 'redeem', 'f'.repeat(64), sig, 'f'.repeat(64))));
}
