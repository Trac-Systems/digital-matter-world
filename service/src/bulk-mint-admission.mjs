import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { check } from './util.mjs';

export const bulkOwnerSpace = owner => 'activeBulkOrdersByOwner/' + owner;
export const isBulkTransition = t => t?.type === 'reserve-many' || /^bulk-(fund|consume|finish|release|credit)$/.test(t?.type);

// Called only inside the nonce-reservation admission gate, after independent source verification.
// All plot keys share the single-mint namespace and the aggregate amount is
// charged once. A failed member leaves the whole local transaction untouched.
export function bulkAdmissionWrites(store, transition, capacity, imported, resources, id, generationCapacity) {
  const t = transition.terms, owner = t.owner;
  check(store.count('activeBulkOrders') < resources.activeBulkOrders &&
    store.count(bulkOwnerSpace(owner)) < resources.bulkOrdersPerAgent, 'bulk_order_capacity', 409);
  const key = capacityKey(t.deployment), amount = BigInt(t.totalAmount);
  const pending = BigInt(store.get('financialAdmissionCapacity', key) ?? '0');
  const accepted = BigInt(store.get('accountRecords', key) ?? '0') + imported;
  check(pending + accepted + amount <= BigInt(capacity.remaining), 'financial_capacity_reserved', 409);
  check(generationCapacity && pending + BigInt(generationCapacity.reserved) + BigInt(generationCapacity.minted) + amount <=
    BigInt(generationCapacity.maximum), 'financial_generation_capacity_reserved', 409);
  const plots = t.members.map(m => plotKey(t.asset, m.block, t.supplyScope));
  const conflicts = plots.flatMap((plot, index) => store.get('financialAdmissionPlot', plot) ? [index] : []);
  if (conflicts.length) throw Object.assign(Error('bulk_member_conflict'), { status: 409, details: { indices: conflicts } });
  return { capacity: { deployment: t.deployment, asset: t.asset, amount: t.totalAmount, block: null,
    remaining: capacity.remaining, supplyScope: t.supplyScope, plots }, writes: [
    { space: 'financialAdmissionCapacity', id: key, value: (pending + amount).toString() },
    ...plots.map(plot => ({ space: 'financialAdmissionPlot', id: plot, value: id })),
    { space: 'activeBulkOrders', id: transition.id, value: true },
    { space: 'bulkSenderOrders', id: transition.id, value: true },
    { space: bulkOwnerSpace(owner), id: transition.id, value: true },
  ] };
}
