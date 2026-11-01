import { assert, exactKeys, hex, hashObject, stableJSON, integer } from '../../rules/src/core.js';
import { validateBulkTerms, bulkOrderId, bulkMemberId, bulkPermitPlans, bulkAllMask, bulkReceiptKey } from '../../rules/src/bulk-mint.js';
import { mintPlotKey, capacityPlotKey } from '../../rules/src/per-ticker-supply-activation.js';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';

const same = (a, b) => stableJSON(a) === stableJSON(b);

// Public-winner readers historically follow dc/plot -> fp/request. Bulk plot
// locks identify a member, whose funding is fp/order. Use this view only for
// public-winner classification; canonical financialRecord remains unchanged.
export function bulkPublicReads(reads, overlay) {
  const raw = (key, at) => overlay?.hasOverlay?.('accountRecords', key)
    ? overlay.get('accountRecords', key) : reads.financialRecord(key, at);
  const resolve = async (key, value, at) => {
    if (value != null || !/^fp\/[0-9a-f]{64}$/.test(key)) return value;
    const id = key.slice(3), member = await raw('dc/' + id, at);
    if (!member?.bulk) return value;
    const funding = await raw('fp/' + member.bulk, at), t = funding?.manifest;
    assert(funding?.kind === 'bulk-v1' && integer(member.index, 63), 'bulk_public_member');
    validateBulkTerms(t);
    assert(member.bulk === bulkOrderId(t.network, t.owner, t.nonce) && member.index < t.members.length &&
      id === bulkMemberId(member.bulk, member.index) && funding.terms === hashObject(t) && member.terms === funding.terms &&
      member.asset === t.asset && member.plot === t.members[member.index].block && member.amount === t.members[member.index].amount &&
      member.deployment === t.generation && (member.supplyScope ?? null) === t.supplyScope &&
      ['reserved', 'issued', 'minted'].includes(member.state), 'bulk_public_member');
    return funding;
  };
  return { ...reads,
    financialRecord: async (key, at) => resolve(key, await raw(key, at), at),
    financialRecords: async (keys, at) => {
      const values = reads.financialRecords ? await reads.financialRecords(keys, at) : await Promise.all(keys.map(key => raw(key, at)));
      assert(Array.isArray(values) && values.length === keys.length, 'point_read_batch');
      return Promise.all(keys.map((key, i) => resolve(key, values[i], at)));
    } };
}

export async function verifyBulkPermit({ reads, network, publicKey, orderId, index, at }) {
  assert(hex(orderId, 32) && integer(index, 63) && typeof reads.bulkPermit === 'function' &&
    typeof reads.financialRecord === 'function' && typeof reads.assetContext === 'function', 'bulk_permit_source');
  const before = await reads.batchStamp();
  assert(!at || same(before, at), 'financial_snapshot_changed'); at = before;
  const result = await reads.bulkPermit(orderId, index, at);
  assert(exactKeys(result, ['terms', 'funding', 'permit', 'memberId']), 'bulk_permit_source');
  const t = validateBulkTerms(result.terms), read = key => reads.financialRecord(key, at);
  assert(t.network === network && orderId === bulkOrderId(network, t.owner, t.nonce) && index < t.members.length, 'bulk_permit_identity');
  const funding = await read('fp/' + orderId), obligation = await read('ao/' + orderId), memberId = bulkMemberId(orderId, index),
    row = await read('dc/' + memberId), m = t.members[index], all = bulkAllMask(t.members.length).toString();
  assert(funding?.kind === 'bulk-v1' && same(funding, result.funding) && same(funding.manifest, t) && funding.terms === hashObject(t) &&
    ['bulk-consumed', 'bulk-complete'].includes(funding.state) && funding.issuedMask === all && funding.releasedMask === '0' &&
    obligation?.state === 'bulk-issued' && obligation.terms === funding.terms && obligation.owner === t.owner &&
    obligation.asset === t.asset && obligation.amount === t.totalAmount && Array.isArray(funding.paid) &&
    same(funding.paid, t.groups.map(g => g.amount)), 'bulk_permit_unissued');
  const plans = bulkPermitPlans(t, funding.receiptRoot), p = plans.plans[index];
  assert(funding.permitRoot === plans.permitRoot && obligation.permitRoot === plans.permitRoot && result.memberId === memberId &&
    same(result.permit, p) && ['issued', 'minted'].includes(row?.state) && row.bulk === orderId && row.index === index &&
    row.amount === m.amount && row.asset === t.asset && row.plot === m.block && row.deployment === t.generation && row.terms === funding.terms &&
    row.permitHash === p.digest && (row.supplyScope ?? null) === t.supplyScope, 'bulk_permit_binding');
  const receiptKey = bulkReceiptKey(t.bitcoinNetwork, funding.reference), internalPlot = capacityPlotKey(t.asset, m.block, t.supplyScope),
    externalPlot = plotKey(t.asset, m.block, t.supplyScope);
  assert(same(await read('fp/bulk-receipt/' + receiptKey), { orderId, receiptRoot: funding.receiptRoot }) &&
    !await read('fp/bulk-credit/' + receiptKey) && await read(internalPlot) === memberId &&
    same(await read(externalPlot), { id: memberId, state: row.state === 'minted' ? 'minted' : 'reserved' }), 'bulk_permit_backing');
  assert(!await read('fr/active'), 'financial_recovery_active');
  for (const key of ['fp/' + orderId, 'ao/' + orderId, 'ar/' + t.owner, 'ar/supply', 'dc/' + memberId, 'fd/' + t.generation,
    capacityKey(t.deployment), internalPlot, externalPlot, 'fp/bulk-receipt/' + receiptKey, 'fp/bulk-credit/' + receiptKey])
    assert(!await read('fq/' + key), 'financial_quarantined');
  // assetContext authenticates the deployment and accepted Trac find; it does
  // not recount a pattern. bulkMint selects its bounded, point-read path.
  const context = await reads.assetContext(t.asset, m.block, { ...at, bulkMint: true }, undefined, undefined, t.deployment), d = context?.deployment;
  assert(d?.id === t.deployment && d.kind === 'dmt' && d.tick === t.ticker && d.privilegePublicKey === publicKey, 'bulk_permit_committee');
  assert(same(before, await reads.batchStamp()), 'financial_snapshot_changed');
  const { memberId: unusedId, index: unusedIndex, ...permit } = p;
  return { digest: p.digest, slots: [`mint/request/${memberId}`, 'mint/block/' + mintPlotKey(t.asset, m.block, t.supplyScope)],
    details: { version: 'bulk-v1', id: memberId, orderId, index, receiver: t.receiver, request: { asset: t.asset, block: m.block, amount: m.amount },
      deployment: d, payment: { kind: 'tap', commitment: plans.paymentHash }, permit, commissions: [] }, permit };
}
