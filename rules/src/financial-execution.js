import { perTickerSupplyActive, compoundSupplyCapped } from './per-ticker-supply-activation.js';
import { multiTickerActive } from './multi-ticker-activation.js';
import { ordinalCodec } from './integers-v2.js';
import { assert, hex, hashObject, stableJSON, exactKeys } from './core.js';
import { financialLifecyclePlan, reserveCapacity, terminalCapacity } from './financial-lifecycle.js';
import { publicMintActive, publicPlotId, claimsNeverCloseActive } from './public-mint.js';
import { validatePublicScanClaim } from './public-claims.js';
import { publicPaymentV2Active, publicPaymentKey } from './public-payment.js';

// Financial evidence is independently reconstructed by every signer. These
// plans bind it to exact notary effects; a gateway cannot smuggle arbitrary
// credits/crafts into the account-operation list alongside a payment.
export async function financialPlan(input, { read, height, document }) {
  const { chainAnchor, ...body } = input;
  const effects = await financialEffects(body, { read, height, document });
  if (chainAnchor) effects.push({ op: 'fp', v: 2, type: 'checkpoint', id: body.transition.id,
    previous: hashObject(await read('fp/chain') ?? null), anchor: chainAnchor });
  return effects;
}

async function financialEffects(input, { read, height, document }) {
  assert(input && exactKeys(input, ['transition', 'evidence']) && input.evidence && typeof input.evidence === 'object', 'financial_input');
  const clock = ordinalCodec(typeof height === 'string');
  const t = input.transition, evidence = hashObject(input.evidence);
  assert(t && hex(t.id, 32), 'financial_identity');
  if (t.type === 'public-payment') {
    const e = input.evidence, register = t.action === 'register';
    assert(publicPaymentV2Active(document, height) && ['register', 'reveal'].includes(t.action) &&
      exactKeys(t, ['type', 'id', 'action', ...(register ? ['registration'] : ['intent', 'reference'])]) &&
      e.requestId === t.id && e.action === t.action && e.previous === hashObject(await read(publicPaymentKey(t.id)) ?? null) &&
      (register ? stableJSON(t.registration) === stableJSON(e.registration) :
        stableJSON(t.intent) === stableJSON(e.intent) && t.reference === e.reference), 'public_payment_binding');
    const { requestId, ...fields } = e;
    return [{ op: 'fp', v: 2, type: 'public-payment', id: t.id, ...fields }];
  }
  if (t.type === 'public-scan') {
    const e = input.evidence;
    if (claimsNeverCloseActive(document, height)) validatePublicScanClaim(e.claim, t.asset);
    assert(publicMintActive(document, height) && exactKeys(t, ['type', 'id', 'asset', 'block', 'previous', ...(t.deployment ? ['deployment'] : [])]) &&
      (!t.deployment || perTickerSupplyActive(height)) && (e.deployment ?? null) === (t.deployment ?? null) &&
      t.id === publicPlotId(t.asset, t.block, t.deployment) && e.requestId === t.id && e.asset === t.asset && e.block === t.block &&
      t.previous === e.previous && e.previous === hashObject(await read('fp/public/' + t.id) ?? null), 'public_scan_binding');
    const { requestId, ...fields } = e;
    return [{ op: 'fp', v: 2, type: 'public-scan', id: t.id, ...fields }];
  }
  if (t.type === 'beacon-recovery') {
    assert(exactKeys(t, ['type', 'id', 'operation']) && t.operation?.op === 'br' && t.operation.v === 2 && t.operation.id === t.id &&
      input.evidence.requestId === t.id && input.evidence.state === 'beacon_verified' && input.evidence.operation === hashObject(t.operation), 'financial_beacon_operation');
    return [t.operation];
  }
  if (t.type === 'lifecycle') return financialLifecyclePlan(input, { read, height, document });
  const fp = fields => ({ op: 'fp', v: 2, id: t.id, ...fields });
  const ar = actions => ({ op: 'ar', actions });
  if (t.type === 'reserve' && t.action?.type === 'reserve-n') {
    assert(!input.evidence.request?.deployment || multiTickerActive(height), 'multi_ticker_inactive');
    assert(exactKeys(t, ['type', 'id', 'action', 'fees']) && t.action?.type === 'reserve-n' && t.action.id === t.id &&
      t.action.terms === evidence && Array.isArray(t.fees) && t.fees.length <= document.values.paymentPage &&
      stableJSON(t.fees) === stableJSON(input.evidence.fees), 'financial_reservation');
    assert(input.evidence.owner === t.action.owner && input.evidence.asset === t.action.asset && input.evidence.amount === t.action.amount,
      'financial_reservation_binding');
    const capacity = input.evidence.capacity, generation = input.evidence.generationCapacity ?? (capacity && Object.hasOwn(capacity, 'plot') ? capacity : null), external = capacity && !Object.hasOwn(capacity, 'plot') ? capacity : null;
    assert(!await read('fd/asset/' + t.action.asset) || generation, 'financial_capacity_required');
    const snapshot = generation && compoundSupplyCapped(await read('fd/' + generation.deployment), height);
    return [ar([t.action, ...(snapshot ? [{ type: 'snapshot-supply', id: t.id, deployment: generation.deployment }] : [])]), fp({ type: 'open', owner: t.action.owner, terms: t.action.terms, fees: t.fees,
      ...(external ? { capacity: external } : {}) }), ...(generation ? reserveCapacity(t, input.evidence, generation) : [])];
  }
  if (t.type === 'reserve') {
    assert(!input.evidence.request?.deployment || multiTickerActive(height), 'multi_ticker_inactive');
    assert(exactKeys(t, ['type', 'id', 'action', 'fees']) && t.action?.type === 'reserve' && t.action.id === t.id &&
      t.action.terms === evidence && Array.isArray(t.fees) && t.fees.length <= document.values.paymentPage &&
      stableJSON(t.fees) === stableJSON(input.evidence.fees), 'financial_reservation');
    assert(input.evidence.owner === t.action.owner && input.evidence.asset === t.action.asset && input.evidence.amount === t.action.amount,
      'financial_reservation_binding');
    const capacity = input.evidence.capacity, generation = input.evidence.generationCapacity ?? (capacity && Object.hasOwn(capacity, 'plot') ? capacity : null), external = capacity && !Object.hasOwn(capacity, 'plot') ? capacity : null;
    assert(!await read('fd/asset/' + t.action.asset) || generation, 'financial_capacity_required');
    const snapshot = generation && compoundSupplyCapped(await read('fd/' + generation.deployment), height);
    return [ar([t.action, ...(snapshot ? [{ type: 'snapshot-supply', id: t.id, deployment: generation.deployment }] : [])]), fp({ type: 'open', owner: t.action.owner, terms: t.action.terms, fees: t.fees,
      ...(external ? { capacity: external } : {}) }), ...(generation ? reserveCapacity(t, input.evidence, generation) : [])];
  }
  const funding = await read('fp/' + t.id);
  assert(funding, 'financial_funding_missing');
  if (t.type === 'fund' || t.type === 'surplus') {
    assert(exactKeys(t, ['type', 'id', 'items', ...(t.references ? ['references'] : [])]) && Array.isArray(t.items) && t.items.length > 0 &&
      t.items.length <= document.values.paymentPage && stableJSON(t.items) === stableJSON(input.evidence.items), 'financial_payment_items');
    // In-block settlement is mandatory. Seeing a mempool transaction or an
    // open escrow deposit never creates spendable payment allocations.
    assert(input.evidence.requestId === t.id && input.evidence.state === 'settled' && Number.isSafeInteger(input.evidence.confirmations) && input.evidence.confirmations >= 1 &&
      input.evidence.owner === funding.owner && input.evidence.terms === funding.terms, 'financial_payment_unsettled');
    const link = await read('fl/' + t.id);
    if (link && t.type === 'fund') assert(clock.valid(input.evidence.verifiedHeight) && clock.compare(input.evidence.verifiedHeight, link.until) <= 0, 'financial_link_payment_late');
    return [fp({ type: t.type === 'fund' ? 'page' : 'surplus', items: t.items })];
  }
  const obligation = await read('ao/' + t.id);
  assert(obligation?.state === 'reserved' && obligation.owner === funding.owner && obligation.terms === funding.terms, 'financial_obligation');
  assert(input.evidence.requestId === t.id && input.evidence.owner === obligation.owner && input.evidence.terms === obligation.terms,
    'financial_evidence_binding');
  if (t.type === 'consume') {
    assert(exactKeys(t, ['type', 'id', 'permitHash']) && hex(t.permitHash, 32) && input.evidence.permitHash === t.permitHash &&
      input.evidence.state === 'authorized' && input.evidence.fundingRoot === funding.root, 'financial_authorization');
    return [fp({ type: 'consume', root: funding.root, permitHash: t.permitHash }),
      ar([{ type: 'consume', id: t.id, terms: obligation.terms, evidence, permitHash: t.permitHash }]), ...await terminalCapacity(t, input.evidence, read)];
  }
  assert(t.type === 'refund' && exactKeys(t, ['type', 'id', 'reason', ...(t.references ? ['references'] : [])]) && ['credit', 'ethereum_refund'].includes(t.reason), 'financial_transition');
  assert(input.evidence.state === t.reason && !input.evidence.permitHash, 'financial_exit');
  if (t.reason === 'ethereum_refund') assert(input.evidence.rail === 'ethereum' && Number.isSafeInteger(input.evidence.confirmations) && input.evidence.confirmations >= 1 &&
    input.evidence.status === 3 && input.evidence.domain && input.evidence.payer, 'financial_refund_unproven');
  else assert(clock.valid(input.evidence.expiry) && clock.compare(input.evidence.expiry, height) < 0, 'financial_exit_live');
  return [fp({ type: t.reason === 'credit' ? 'credit' : 'refund', root: funding.root, evidence }),
    ar([{ type: 'refund', id: t.id, terms: obligation.terms, evidence }]), ...await terminalCapacity(t, input.evidence, read)];
}

export function financialOperationShape(operation) {
  if (operation.op === 'ar') return { op: 'ar', actions: operation.actions };
  const { sequence, previous, revision, proof, ...shape } = operation;
  return ['page', 'surplus'].includes(operation.type) ? shape : operation;
}

export function financialBatchOperations(inputs, document) {
  assert(Array.isArray(inputs) && inputs.length <= document.values.mintOperationBudget, 'financial_batch_budget');
  assert(inputs.filter(i => /^(?:legacy-)?link-/.test(i.transition?.action?.type ?? '')).length <= document.values.linkOperationBudget, 'financial_link_budget');
  financialReserveGroups(inputs);
  const operations = [];
  for (const input of inputs) {
    assert(exactKeys(input, ['transition', 'evidence', 'operations', ...(input.chainAnchor ? ['chainAnchor'] : []), ...(input.recordCommitments ? ['recordCommitments'] : []), ...(input.reserveGroup !== undefined ? ['reserveGroup'] : [])]) && Array.isArray(input.operations) && input.operations.length > 0 &&
      input.operations.every(op => op.v === 2 && ['ar', 'fp', 'br'].includes(op.op)), 'financial_batch_input');
    operations.push(...input.operations);
  }
  return operations;
}

// Only the new nonce-authorized path may share one account operation. Keep
// individual inputs/identities so accepted evidence and recovery stay addressable.
export const nonceReservation = t => t?.type === 'reserve' && t.action?.type === 'reserve-n';
export function financialReserveGroups(inputs) {
  const groups = [];
  for (let i = 0; i < inputs.length;) {
    const first = inputs[i], size = first.reserveGroup === undefined ? 1 : first.reserveGroup, group = inputs.slice(i, i + size);
    if (first.reserveGroup !== undefined) {
      assert(Number.isSafeInteger(size) && size > 0 && group.length === size &&
        group.every((input, n) => nonceReservation(input.transition) && input.transition.action.owner === first.transition.action.owner &&
          (!n || input.reserveGroup === undefined)), 'financial_reserve_group');
    }
    groups.push(group); i += size;
  }
  return groups;
}
export function mergedReservePlans(plans) {
  assert(plans.length > 0 && plans.every(p => p[0]?.op === 'ar' && p.slice(1).every(op => op.op !== 'ar')), 'financial_reserve_plan');
  return plans.map((plan, i) => [...(i ? [] : [{ op: 'ar', actions: plans.flatMap(p => p[0].actions) }]), ...plan.slice(1)]);
}
