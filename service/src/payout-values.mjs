import { heightKey } from './util.mjs';

function payoutSettings(store) {
  const last = store.get('meta', 'v2Last');
  const batch = last && store.get('batches', heightKey(last.n))?.batch;
  const values = batch?.settingsHash && store.get('settingsHistory', batch.settingsHash)?.values;
  return { hash: values?.legacyDeployPayoutMinAtoms === undefined ? '' : batch.settingsHash, minimum: values?.legacyDeployPayoutMinAtoms };
}
export const payoutPolicyHash = store => payoutSettings(store).hash;
export function payoutMinimum(store, total) {
  if (total.legacyDeploy !== true) return null;
  const configured = payoutSettings(store).minimum;
  // Retained liabilities keep their positive minimum if a successor disables
  // new accruals. No history enumeration is needed to resolve this address.
  return configured && configured !== '0' ? configured : total.payoutMinAtoms;
}
export function payoutBalance(store, total) {
  const owed = String(BigInt(total.accrued) - BigInt(total.paid)), minimum = payoutMinimum(store, total);
  return { ...total, owed, ...(minimum ? { payoutMinAtoms: minimum, eligible: BigInt(owed) >= BigInt(minimum), payoutRail: 'tap' } : {}) };
}
