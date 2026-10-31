import { hash, serial } from './util.mjs';

const gates = new WeakMap();
export function payoutGate(store, work) {
  if (!gates.has(store)) gates.set(store, serial());
  return gates.get(store)(work);
}

// Outstanding commission candidates only; custody has its own settlement rail.
// Keep below-minimum balances so settings changes need no history scan.
export function payoutIndexOperation(id, total) {
  return { space: 'payoutPayable', id, ...(total && id === hash(total.beneficiary) && BigInt(total.accrued) > BigInt(total.paid)
    ? { value: { beneficiary: total.beneficiary } } : {}) };
}
