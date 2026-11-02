import { assert, exactKeys, hex, hashObject, stableJSON, integer } from './core.js';
import { BULK_LIMITS, validateBulkTerms, validateBulkFees, bulkReserveAction, bulkBytes, bulkIndices,
  bulkMemberId, bulkPermitPlans, bulkPaymentData, bulkUint, bulkInscription } from './bulk-mint.js';
import { mintRetainsUnits } from './per-ticker-supply-activation.js';

const same = (a, b) => stableJSON(a) === stableJSON(b);
export const bulkTransition = t => t?.type === 'reserve-many' || ['bulk-fund', 'bulk-fund-held', 'bulk-consume', 'bulk-consume-held', 'bulk-finish', 'bulk-release', 'bulk-credit'].includes(t?.type);
export function validateBulkTransition(t) {
  bulkBytes(t, BULK_LIMITS.transitionBytes);
  const fields = { 'reserve-many': ['action', 'terms'], 'bulk-fund': ['reference'], 'bulk-fund-held': ['reference'], 'bulk-credit': ['reference'],
    'bulk-consume': ['permitRoot'], 'bulk-consume-held': ['permitRoot'], 'bulk-finish': ['members'], 'bulk-release': ['members', 'reason'] }[t?.type];
  assert(fields && exactKeys(t, ['type', 'id', ...fields]) && hex(t.id, 32), 'bulk_transition');
  if (t.type === 'reserve-many') {
    const { sig, ...unsigned } = t.action ?? {};
    assert(hex(sig, 64) && same(unsigned, bulkReserveAction(t.terms)) && t.action.id === t.id, 'bulk_reservation');
  } else if (['bulk-fund', 'bulk-fund-held', 'bulk-credit'].includes(t.type)) assert(bulkInscription(t.reference), 'bulk_payment_reference');
  else if (['bulk-consume', 'bulk-consume-held'].includes(t.type)) assert(hex(t.permitRoot, 32), 'bulk_permit_root');
  else { bulkIndices(t.members, BULK_LIMITS.members, t.type === 'bulk-finish'); if (t.type === 'bulk-release') assert(t.reason === 'expired', 'bulk_release_reason'); }
  return t;
}

// Sum over the complete batch, including every observation and merged group.
// A gateway can also use this helper before packing so overflow stays queued.
export async function bulkBatchWork(inputs, { read }) {
  let members = 0, groups = 0;
  const manifests = new Map();
  for (const input of inputs) {
    const t = input.transition; if (!bulkTransition(t)) continue;
    validateBulkTransition(t); bulkBytes(input.evidence, BULK_LIMITS.evidenceBytes, 'bulk_evidence_bytes');
    const terms = t.type === 'reserve-many' ? t.terms : manifests.get(t.id) ?? (await read('fp/' + t.id))?.manifest;
    validateBulkTerms(terms); manifests.set(t.id, terms);
    if (t.type === 'reserve-many' || ['bulk-consume', 'bulk-consume-held'].includes(t.type)) members += terms.members.length;
    if (t.type === 'bulk-finish' || t.type === 'bulk-release') members += t.members.length;
    if (['reserve-many', 'bulk-fund', 'bulk-fund-held', 'bulk-consume', 'bulk-consume-held', 'bulk-credit'].includes(t.type)) groups += terms.groups.length;
    assert(members <= BULK_LIMITS.memberWork && groups <= BULK_LIMITS.groupWork, 'bulk_batch_work');
  }
  return { members, groups };
}

// Evidence is reconstructed by the installed independent source on both
// gateway and signers. This planner binds that evidence to exact effects.
export async function bulkFinancialPlan({ transition: t, evidence: e }, { read, height, document }) {
  validateBulkTransition(t); bulkBytes(e, BULK_LIMITS.evidenceBytes, 'bulk_evidence_bytes');
  assert(e?.requestId === t.id && bulkUint(height), 'bulk_evidence_binding');
  const evidence = hashObject(e), ar = actions => ({ op: 'ar', actions }),
    fp = fields => bulkBytes({ op: 'fp', v: 2, id: t.id, evidence, ...fields }, BULK_LIMITS.operationBytes);
  if (t.type === 'reserve-many') {
    const terms = t.terms; validateBulkFees(terms, e.feeManifest);
    assert(exactKeys(e, ['version', 'requestId', 'terms', 'feeManifest', 'feeAuthorization', 'owner', 'asset', 'amount', 'receiver', 'payer',
      'rail', 'capacity', 'generationCapacity', 'members', 'expiry', 'settingsHash']) && e.version === 1 &&
      same(e.terms, terms) && e.owner === terms.owner && e.asset === terms.asset && e.amount === terms.totalAmount &&
      e.receiver === terms.receiver && e.payer === terms.payer && e.rail === 'tap' && e.settingsHash === terms.settingsHash && e.expiry === terms.expires &&
      exactKeys(e.feeAuthorization, ['network', 'quote', 'id', 'until', 'counted', 'at', 'signature']) &&
      e.feeAuthorization.network === terms.network && e.feeAuthorization.id === t.id && e.feeAuthorization.until === terms.expires &&
      bulkUint(e.feeAuthorization.counted) && BigInt(e.feeAuthorization.counted) <= BigInt(height) &&
      BigInt(e.feeAuthorization.counted) <= BigInt(terms.until) && integer(e.feeAuthorization.at) && hex(e.feeAuthorization.signature, 64) &&
      BigInt(e.feeAuthorization.counted) >= BigInt(terms.feeQuote.validFrom) && BigInt(terms.expires) <= BigInt(terms.feeQuote.validUntil) &&
      e.feeAuthorization.at >= terms.feeQuote.issuedAt && e.feeAuthorization.at <= terms.feeQuote.expiresAt &&
      same(e.feeAuthorization.quote, terms.feeQuote) &&
      BigInt(height) <= BigInt(terms.until) && BigInt(terms.expires) - BigInt(height) >= BigInt(document.values.requestMinBlocks) &&
      BigInt(terms.expires) - BigInt(height) <= BigInt(document.values.requestMaxBlocks), 'bulk_reservation_evidence');
    assert(Array.isArray(e.members) && e.members.length === terms.members.length && e.members.every((m, i) =>
      exactKeys(m, ['memberId', 'block', 'amount', 'find', 'link', 'holder', 'deployment', ...(m.legacyDeploy ? ['legacyDeploy'] : []), ...(m.deployer ? ['deployer'] : [])]) &&
      m.memberId === bulkMemberId(t.id, i) && m.block === terms.members[i].block && m.amount === terms.members[i].amount &&
      m.find?.asset === terms.asset && String(m.find.block) === m.block && String(m.find.count) === m.amount &&
      m.deployment?.id === terms.deployment && m.deployment.tick === terms.ticker && m.deployment.kind === 'dmt'), 'bulk_reservation_members');
    const c = e.capacity, g = e.generationCapacity, registered = await read('fd/' + terms.generation);
    assert(exactKeys(c, ['deployment', 'asset', 'amount', 'block', 'remaining', 'limit', 'supplyScope']) &&
      exactKeys(g, ['deployment', 'reserved', 'minted', 'maximum']) && c.deployment === terms.deployment && c.asset === terms.asset && c.amount === terms.totalAmount && c.block === null &&
      (c.supplyScope ?? null) === terms.supplyScope && bulkUint(c.remaining) && bulkUint(c.limit) && g?.deployment === terms.generation &&
      registered && g.reserved === registered.reserved && g.minted === registered.minted && g.maximum === registered.maximum, 'bulk_reservation_capacity');
    return [ar([t.action]), fp({ type: 'bulk-open', terms, capacity: { remaining: c.remaining, limit: c.limit } })];
  }
  const funding = await read('fp/' + t.id), terms = validateBulkTerms(funding?.manifest);
  assert(funding.kind === 'bulk-v1' && e.owner === terms.owner && e.terms === funding.terms && funding.terms === hashObject(terms), 'bulk_evidence_binding');
  const bound = { type: t.type, terms: funding.terms };
  if (['bulk-fund', 'bulk-fund-held', 'bulk-credit'].includes(t.type)) {
    assert(exactKeys(e, ['requestId', 'owner', 'terms', 'state', 'reference', 'confirmations', 'block', 'paid', 'receiptRoot', 'transfers', ...(e.feeManifest ? ['feeManifest'] : [])]) &&
      e.state === 'settled' && e.reference === t.reference && integer(e.confirmations) && e.confirmations >= 1 &&
      exactKeys(e.block, ['height', 'hash']) && bulkUint(e.block.height) && hex(e.block.hash, 32) &&
      BigInt(e.block.height) <= BigInt(height) && Array.isArray(e.paid) && e.paid.length === terms.groups.length &&
      Array.isArray(e.transfers) && e.transfers.length === terms.groups.length, 'bulk_payment_evidence');
    let prior = -1; const used = new Set();
    for (const row of e.transfers) {
      assert(exactKeys(row, ['index', 'ins', 'fail', 'int', 'addr', 'taddr', 'tick', 'amt', 'dta']) && integer(row.index) && row.index > prior &&
        row.ins === t.reference && typeof row.fail === 'boolean' && row.int === true && row.addr === terms.payer && row.tick === 'tap', 'bulk_transfer');
      prior = row.index;
      const i = terms.groups.findIndex((g, i) => row.dta === bulkPaymentData(t.id, i));
      assert(i >= 0 && !used.has(i) && row.taddr === terms.groups[i].to && row.amt === terms.groups[i].amount &&
        e.paid[i] === (row.fail ? '0' : row.amt), 'bulk_transfer_binding'); used.add(i);
    }
    assert(e.receiptRoot === hashObject(['dmw-bulk-receipt-v1', terms.network, t.reference, e.block.hash, e.transfers]), 'bulk_receipt_root');
    if (e.feeManifest) { assert(t.type === 'bulk-credit', 'bulk_credit_manifest'); validateBulkFees(terms, e.feeManifest); }
    return [fp({ ...bound, reference: t.reference, block: e.block, paid: e.paid, receiptRoot: e.receiptRoot, ...(e.feeManifest ? { feeManifest: e.feeManifest } : {}) })];
  }
  if (['bulk-consume', 'bulk-consume-held'].includes(t.type)) {
    assert(exactKeys(e, ['requestId', 'owner', 'terms', 'state', 'receiptRoot', 'permitRoot']) &&
      e.state === 'authorized' && e.receiptRoot === funding.receiptRoot && e.permitRoot === t.permitRoot &&
      t.permitRoot === bulkPermitPlans(terms, e.receiptRoot).permitRoot, 'bulk_authorization');
    return [fp({ ...bound, receiptRoot: e.receiptRoot, permitRoot: t.permitRoot }),
      ar([{ type: 'consume-many', id: t.id, terms: funding.terms, permitRoot: t.permitRoot, evidence }])];
  }
  const finish = t.type === 'bulk-finish', indices = bulkIndices(t.members, terms.members.length, finish);
  if (finish) {
    const plans = bulkPermitPlans(terms, funding.receiptRoot);
    assert(exactKeys(e, ['requestId', 'owner', 'terms', 'state', 'members']) && e.state === 'minted' && Array.isArray(e.members) && e.members.length === t.members.length &&
      e.members.every((m, i) => exactKeys(m, ['index', 'memberId', 'inscription', 'amount', 'block', 'deployment', 'permitHash', 'confirmations', ...(m.commissions ? ['commissions'] : [])]) &&
        m.index === t.members[i].index && m.inscription === t.members[i].inscription &&
        m.memberId === plans.plans[m.index].memberId && m.amount === terms.members[m.index].amount &&
        m.block === terms.members[m.index].block && m.deployment === terms.generation && m.permitHash === plans.plans[m.index].digest &&
        integer(m.confirmations) && m.confirmations >= 1 && (!m.commissions || m.commissions.every(c => c.id === m.memberId))), 'bulk_finish_evidence');
  } else assert(exactKeys(e, ['requestId', 'owner', 'terms', 'state', 'expiry', 'members', ...(e.feeManifest ? ['feeManifest'] : [])]) && e.state === 'expired' && e.expiry === terms.expires && BigInt(height) > BigInt(terms.expires) && same(e.members, t.members), 'bulk_expiry_evidence');
  if (e.feeManifest) { assert(!finish, 'bulk_credit_manifest'); validateBulkFees(terms, e.feeManifest); }
  const releaseUnits = !finish || mintRetainsUnits({ supplyScope: terms.supplyScope, plot: terms.members[0].block });
  return [fp({ ...bound, members: t.members, ...(!finish ? { reason: t.reason, ...(e.feeManifest ? { feeManifest: e.feeManifest } : {}) } : {}) }), ...(releaseUnits ?
    [ar([{ type: 'release-many', id: t.id, terms: funding.terms, members: indices, reason: finish ? 'minted' : 'expired', evidence }])] : [])];
}
