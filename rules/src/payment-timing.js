// Optional policy setting: retained documents keep their hashes. A report is
// only a bounded reservation hold; confirmed receipts still authorize money.
export const PAYMENT_TIMING_DEFAULTS = Object.freeze({ lateConfirmBlocks: 144 });

export function paymentTiming(row, expiry, counted) {
  // Imported v1 rows used a boolean here; it carries no observation height.
  const seen = typeof row.paymentSeen === 'object' ? row.paymentSeen : null;
  const held = !!seen && BigInt(seen.firstSeenBlock) <= BigInt(expiry) &&
    BigInt(counted) <= BigInt(seen.confirmByBlock);
  return { payByBlock: String(expiry), seenAtBlock: seen?.firstSeenBlock ?? null,
    confirmByBlock: seen?.confirmByBlock ?? null, held };
}

export function notePaymentSeen(row, references, expiry, counted, values) {
  if (row.paymentSeen && typeof row.paymentSeen === 'object' || !references.length || BigInt(counted) > BigInt(expiry)) return row;
  const blocks = values.lateConfirmBlocks ?? PAYMENT_TIMING_DEFAULTS.lateConfirmBlocks;
  return { ...row, paymentSeen: { firstSeenBlock: String(counted),
    confirmByBlock: (BigInt(expiry) + BigInt(blocks)).toString() } };
}
