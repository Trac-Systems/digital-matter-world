import { freeLinkActive } from './free-link-activation.js';
import { feeFor } from './fees.js';
import { multiTickerActive } from './multi-ticker-activation.js';
import { ordinalCodec } from './integers-v2.js';
import { assert, exactKeys, hashObject, stableJSON, hex } from './core.js';

const same = (a, b) => stableJSON(a) === stableJSON(b);
const landed = e => Number.isSafeInteger(e.confirmations) && e.confirmations >= 1;
export const lifecycleOperation = (action, evidence) => ({ op: 'fp', v: 2, id: action.id, type: 'lifecycle', action, evidence });

// Each signer obtains this evidence from financialEvidence(transition, at),
// independently of the submitted file. The adapter must prove the entire
// named dependency set, including original fee/owner/chain/permit bindings.
export async function financialLifecyclePlan({ transition: t, evidence: e }, { read, height, document }) {
  assert(exactKeys(t, ['type', 'id', 'action']) && t.action?.id === t.id && e?.requestId === t.id, 'lifecycle_input');
  const clock = ordinalCodec(typeof height === 'string');
  const a = t.action, commitment = hashObject(e), op = lifecycleOperation(a, commitment);
  if (a.type === 'ticker-refund') {
    assert(multiTickerActive(height) && exactKeys(a, ['type', 'id', 'request', 'reference', 'reason']) && e.state === 'ticker_refund' &&
      e.refund?.id === a.request && e.refund.reference === a.reference && e.refund.reason === a.reason &&
      a.id === hashObject([a.request, a.reference]), 'ticker_refund_binding');
    return [{ ...op, refund: e.refund }];
  }
  if (a.type === 'legacy-link-complete' || a.type === 'legacy-link-exit') {
    const source = await read('fi/source/' + a.id), funding = await read('fp/' + a.id);
    assert(source?.legacy?.kind === 'link' && funding?.state === 'open' && e.terms === funding.terms && e.owner === funding.owner &&
      e.block === source.block && funding.terms === hashObject(source) && e.fundingRoot === funding.root, 'legacy_link_binding');
    const complete = a.type === 'legacy-link-complete';
    assert(complete ? e.state === 'complete' : e.state === 'credit' && (clock.compare(height, source.until) > 0 || e.failure === 'entitlement_invalidated'), 'legacy_link_exit');
    return [{ op: 'fp', v: 2, type: complete ? 'consume' : 'credit', id: a.id, root: funding.root,
      ...(complete ? { permitHash: hashObject(['dmw-legacy-link-completion-v1', a.id, funding.terms]) } : { evidence: commitment }) }, op];
  }
  if (a.type === 'credit-repair-open') {
    const row = await read('fc/' + a.credit), fees = row?.fees.filter(f => f.amount !== '0');
    assert(row && e.state === 'replacement_terms' && e.credit === a.credit && e.recovery === a.recovery && e.before === a.before &&
      e.owner === row.owner && same(e.fees, fees), 'financial_repair_terms');
    return [{ op: 'fp', v: 2, type: 'open', id: t.id, owner: row.owner, terms: commitment, fees }, op];
  }
  if (a.type === 'credit-repair-finish') {
    const repair = await read('fr/backing/' + a.id), funding = await read('fp/' + a.id);
    assert(repair && funding && e.state === 'replacement_backed' && e.credit === repair.credit && e.before === repair.before &&
      e.fundingRoot === funding.root, 'financial_repair_backing');
    return [{ op: 'fp', v: 2, type: 'consume', id: a.id, root: funding.root, permitHash: hashObject(['dmw-credit-repair-v2', a.id, repair]) }, op];
  }
  if (a.type === 'credit-use' || a.type === 'credit-transfer') {
    assert(exactKeys(a, ['type', 'id', 'operation']) && a.operation?.op === 'fp' && a.operation.v === 2 && a.operation.id === a.id &&
      a.operation.type === (a.type === 'credit-use' ? 'use' : 'transfer') && e.state === 'authorized' && e.operation === hashObject(a.operation), 'financial_credit');
    return [a.operation]; // The contract checks owner signature and revision.
  }
  if (a.type === 'link-reserve') {
    const free = freeLinkActive(height) && document.values.linkMultiplier === 0;
    if (freeLinkActive(height)) assert(e.settingsHash === hashObject(document) &&
      (feeFor('link', e.quote?.baseFee, 1, e.quote?.feeSettings, height) === '0') === free, 'financial_link_price');
    assert(e.state === 'reservable' && a.terms === commitment && a.owner === e.owner && a.block === e.block && a.until === e.until &&
      typeof a.block === 'string' && /^(0|[1-9][0-9]*)$/.test(a.block) && BigInt(a.block) <= BigInt(height) &&
      clock.valid(a.until) && clock.compare(a.until, height) > 0 && clock.compare(a.until, clock.add(height, document.values.requestMaxBlocks)) <= 0 &&
      Array.isArray(e.fees) && (free ? e.fees.length === 0 : e.fees.length > 0) && e.fees.length <= document.values.paymentPage && e.bitmapOwner === a.owner && e.link === null, 'financial_link_reservation');
    return free ? [op] : [{ op: 'fp', v: 2, type: 'open', id: t.id, owner: a.owner, terms: a.terms, fees: e.fees }, op];
  }
  if (a.type === 'link-complete' || a.type === 'link-exit') {
    const row = await read('fl/' + t.id), funding = await read('fp/' + t.id);
    assert(row?.state === 'reserved' && e.owner === row.owner && e.terms === row.terms && e.block === row.block && funding, 'financial_link_binding');
    if (a.type === 'link-complete') {
      assert(e.state === 'complete' && e.fundingRoot === funding.root, 'financial_link_completion');
      const permitHash = hashObject(['dmw-link-completion-v2', t.id, row.terms]);
      return [{ op: 'fp', v: 2, type: 'consume', id: t.id, root: funding.root, permitHash }, op];
    }
    assert(['credit', 'ethereum_refund'].includes(e.state), 'financial_link_exit');
    if (e.state === 'ethereum_refund') assert(e.rail === 'ethereum' && landed(e) && e.status === 3 && e.domain && e.payer, 'financial_refund_unproven');
    else assert(clock.compare(height, row.until) > 0 || e.failure === 'entitlement_invalidated', 'financial_link_live');
    return [{ op: 'fp', v: 2, type: e.state === 'credit' ? 'credit' : 'refund', id: t.id, root: funding.root, evidence: commitment }, op];
  }
  if (a.type === 'custody-accrue') {
    const funding = await read('fp/' + a.request);
    const liability = { request: a.request, fee: a.fee, owner: a.owner, rail: a.rail, custodian: a.custodian, amount: a.amount };
    assert(e.state === 'custodied' && same(e.liability, liability) && landed(e) && funding?.consumedRoot === e.fundingRoot &&
      e.terms === funding.terms, 'financial_custody_evidence');
  } else if (a.type === 'custody-claim') {
    const row = await read('bc/' + a.id);
    assert(e.state === 'destination_verified' && e.owner === row?.owner && e.rail === row?.rail && e.destination === a.destination &&
      e.revision === a.revision, 'financial_custody_destination');
  } else if (a.type === 'custody-settle' || a.type === 'custody-reopen') {
    const row = await read('bc/' + a.id);
    assert(row && e.claim === a.claim && e.amount === row.amount && e.rail === row.rail && e.custodian === row.custodian &&
      e.destination === row.destination, 'financial_payout_binding');
    if (a.type === 'custody-settle') assert(e.state === 'paid' && e.receipt === a.receipt && landed(e), 'financial_payout_unsettled');
    else assert(e.state === 'revoked_unpaid' && hex(e.revocation, 32) && landed(e), 'financial_payout_not_revoked');
  } else if (a.type === 'deployment-open' || a.type === 'deployment-add') {
    assert(a.type !== 'deployment-add' || multiTickerActive(height), 'multi_ticker_inactive');
    const { type, id, ...deployment } = a;
    assert(e.state === 'deployed' && landed(e) && same(e.deployment, deployment) && e.minted === '0' && e.outstanding === '0' &&
      e.remaining === a.maximum, 'financial_deployment_evidence');
  } else if (a.type === 'capacity-reserve') {
    const row = await read('ao/' + a.id);
    assert(e.state === 'capacity_verified' && e.deployment === a.deployment && e.plot === a.plot && e.terms === row?.terms, 'financial_capacity_evidence');
  } else if (a.type === 'capacity-issue') {
    const row = await read('ao/' + a.id);
    assert(e.state === 'authorized' && e.permitHash === a.permitHash && e.terms === row?.terms, 'financial_capacity_authorization');
  } else if (a.type === 'capacity-finish') {
    const funding = await read('fp/' + a.id), source = await read('fi/source/' + a.id);
    const row = await read('dc/' + a.id) ?? (source?.legacy && funding?.capacity && !funding.minted ? {
      ...funding.capacity, plot: funding.capacity.block === null ? null : String(funding.capacity.block) } : null);
    assert(e.state === 'minted' && landed(e) && e.permitHash === a.permitHash && e.deployment === row?.deployment &&
      e.asset === row?.asset && e.amount === row?.amount && e.plot === row?.plot && hex(e.receipt, 32), 'financial_capacity_mint');
  } else if (a.type === 'capacity-release') {
    assert(e.state === 'refunded' && e.terms === (await read('ao/' + a.id))?.terms, 'financial_capacity_release');
  } else if (a.type === 'recovery-inventory') {
    assert(e.state === 'inventory_snapshot' && e.previous === a.previous && e.tip === a.tip && hex(e.snapshot, 32), 'financial_recovery_manifest');
  } else if (a.type === 'recovery-inventory-page') {
    assert(e.state === 'inventory_page' && e.cursor === a.cursor && e.limit === a.limit && same(e.items, a.items), 'financial_recovery_inventory');
  } else if (a.type === 'recovery-inventory-seal') {
    assert(e.state === 'inventory_complete' && e.cursor === (await read('fr/' + a.id))?.cursor, 'financial_recovery_incomplete');
  } else if (a.type === 'recovery-begin') {
    assert(e.state === 'reconciliation_manifest' && e.previous === a.previous && e.tip === a.tip && e.manifest === a.manifest && e.count === a.count &&
      hex(e.snapshot, 32), 'financial_recovery_manifest');
  } else if (a.type === 'recovery-page') {
    assert(e.state === 'reconciled' && same(e.items, a.items) && e.next === a.next && e.sequence === a.sequence, 'financial_recovery_evidence');
  } else if (a.type === 'recovery-approve' || a.type === 'recovery-refresh') {
    const row = await read('fr/' + a.id);
    assert(e.state === 'reconciled' && e.batch === a.batch && e.previous === row?.previous && e.tip === row?.tip && e.manifest === row?.manifest, 'financial_recovery_approval');
  } else if (a.type === 'recovery-finish') {
    assert(e.state === 'adopted' && e.reconciliation === (await read('fr/' + a.id))?.root, 'financial_recovery_adoption');
    if (a.anchor) assert(same(e.anchor, a.anchor), 'financial_recovery_anchor');
  } else if (a.type === 'recovery-abort') {
    assert(e.state === 'candidate_abandoned' && e.manifest === (await read('fr/' + a.id))?.manifest, 'financial_recovery_abort');
  } else if (a.type === 'recovery-release') {
    assert(e.state === 'canonical_again' && e.key === a.key && e.before === a.before && landed(e), 'financial_recovery_canonical');
  } else assert(false, 'lifecycle_type');
  return [op];
}

// These hooks make capacity allocation atomic with the original reservation,
// consumption and refund, while keeping the original payment API stable.
export function reserveCapacity(t, evidence, capacity = evidence.capacity) {
  if (!capacity) return [];
  assert(exactKeys(capacity, ['deployment', 'plot']), 'financial_capacity_terms');
  return [lifecycleOperation({ type: 'capacity-reserve', id: t.id, ...capacity }, hashObject(evidence))];
}
export async function terminalCapacity(t, evidence, read) {
  if (!await read('dc/' + t.id)) return [];
  return [lifecycleOperation({ type: t.type === 'consume' ? 'capacity-issue' : 'capacity-release', id: t.id,
    ...(t.type === 'consume' ? { permitHash: t.permitHash } : {}) }, hashObject(evidence))];
}
