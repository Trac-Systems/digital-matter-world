import { rules } from './rules.mjs';
import { check, hash, serial } from './util.mjs';

// The operator document can tighten, never expand, the separately authorized
// funding envelope. An acknowledged reservation keeps its exact transaction.
export function sponsorshipLimits(resources, owner) {
  const document = rules.validateResourceDocument(resources);
  check(document.version >= 3, 'resource_upgrade_required');
  const v = document.values, min = (a, b) => BigInt(a) < BigInt(b) ? String(a) : String(b);
  return { resourceHash: rules.hashObject(document), transactions: min(v.sponsorshipTransactions, owner.sponsorship.transactions),
    atoms: min(v.sponsorshipAtoms, min(owner.sponsorship.maxAtoms, owner.funding.writerMaxAtoms)), runway: v.sponsorshipRunwayTransactions };
}
export function sponsoredSender({ store, resources, owner, fee, balance, send }) {
  const gate = serial(), current = () => sponsorshipLimits(typeof resources === 'function' ? resources() : resources, owner);
  const status = async () => {
    const limits = current(), total = store.get('hostSponsorship', 'total') ?? { count: '0', atoms: '0' }, cost = BigInt(await fee());
    check(cost > 0n, 'host_fee_encoding');
    const byCount = BigInt(limits.transactions) - BigInt(total.count), byAtoms = (BigInt(limits.atoms) - BigInt(total.atoms)) / cost;
    const left = byCount < byAtoms ? byCount : byAtoms, transactions = left > 0n ? left : 0n;
    return { resourceHash: limits.resourceHash, usedTransactions: String(total.count), usedAtoms: total.atoms,
      remainingTransactions: String(transactions), belowRunway: transactions <= BigInt(limits.runway) };
  };
  const dispatch = prepared => gate(async () => {
    check(/^[0-9a-f]{64}$/.test(prepared.tx), 'host_sponsor_transaction');
    const intent = hash(rules.stableJSON(prepared)), old = store.get('hostSponsorship', prepared.tx), amount = BigInt(await fee());
    check(amount > 0n && BigInt(await balance()) >= amount, 'host_sponsor_funds');
    if (old) check(old.intent === intent && old.atoms === String(amount), 'host_sponsor_intent_or_fee_changed');
    else {
      const limits = current(), total = store.get('hostSponsorship', 'total') ?? { count: '0', atoms: '0' };
      check(BigInt(total.count) < BigInt(limits.transactions) && BigInt(total.atoms) + amount <= BigInt(limits.atoms), 'host_sponsorship_ceiling');
      const document = typeof resources === 'function' ? resources() : resources;
      await store.transact([
        { space: 'resourceHistory', id: limits.resourceHash, value: document },
        { space: 'hostSponsorship', id: prepared.tx, value: { intent, atoms: String(amount), resourceHash: limits.resourceHash } },
        { space: 'hostSponsorship', id: 'total', value: { count: rules.nextUint(rules.decimalV2(total.count)), atoms: String(BigInt(total.atoms) + amount) } },
      ]);
    }
    return send(prepared);
  });
  dispatch.status = status; return dispatch;
}
