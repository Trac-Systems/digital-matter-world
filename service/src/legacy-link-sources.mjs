import { rules as r } from './rules.mjs';
import { check } from './util.mjs';

export function installLegacyLinkSources(reads, { network, accepted }) {
  reads.financialLegacyLinkReceipts = async (id, references, at) => {
    const { source } = await accepted(id, at);
    check(source.legacy?.kind === 'link' && references.length === 1 && typeof references[0] === 'string', 'legacy_link_references');
    const original = source.legacy.original;
    check(!original.paymentId || original.paymentId === references[0], 'legacy_link_payment_identity');
    const payment = await reads.linkPaymentFor({ ...original, paymentId: references[0] }, at);
    if (!payment?.settlement?.accepted) return [];
    const verified = r.verifyLinkInput({ request: original.request, sig: original.sig, terms: original.terms, payment }, network, r.safeNumberV2(r.decimalV2(at.counted)));
    check(!await reads.financialRecord('fi/link-payment/' + verified.paymentKey, at), 'legacy_link_payment_used');
    return source.feeItems.map(f => ({ ...f, key: r.paymentItemKey('tap', ['legacy-link', verified.paymentKey, f.role].join('/')),
      accepted: true, confirmations: payment.settlement.confirmations, origin: id, reference: references[0], verifiedHeight: String(payment.verifiedHeight) }));
  };
  reads.financialLegacyLinkEvidence = async (action, at) => {
    const { source, funding } = await accepted(action.id, at);
    check(source.legacy?.kind === 'link' && funding.state === 'open', 'legacy_link_state');
    const bitmap = await reads.bitmap(source.block, at), link = await reads.link(source.block);
    const free = bitmap?.agent === source.owner && link === null && !await reads.financialRecord('fl/slot/' + source.block, at);
    const base = { requestId: action.id, owner: source.owner, terms: funding.terms, block: source.block, fundingRoot: funding.root };
    if (action.type === 'legacy-link-complete') {
      check(free && funding.fees.every((f, i) => f.amount === funding.paid[i]), 'legacy_link_unavailable');
      return { ...base, state: 'complete' };
    }
    check(action.type === 'legacy-link-exit' && (!free || r.compareOrdinal(at.counted, source.until) > 0), 'legacy_link_live');
    return { ...base, state: 'credit', expiry: source.until, ...(!free ? { failure: 'entitlement_invalidated' } : {}) };
  };
}
