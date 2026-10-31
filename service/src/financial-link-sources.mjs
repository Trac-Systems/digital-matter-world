import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { financialLinkId, verifyFinancialLink } from '../../rules/src/financial-link.js';
import { financialSplit } from '../../rules/src/financial-fees.js';

export const linkFeeScope = block => rules.stableJSON(['link-v2', rules.decimalV2(block), 'tap']);
export function installLinkSources(reads, { network, bitcoinNetwork, financialFees, accepted }) {
  reads.verifyFinancialLinkRow = row => {
    const r = row?.request;
    check(row?.id === financialLinkId(network, r) && verifyFinancialLink(network, r, row.signature) && r.payer === row.payer &&
      row.receiver === row.payer && row.kind === 'tap' && r.quoteHash === rules.hashObject(row.requestedFeeQuote) &&
      rules.stableJSON(row.requestedFeeQuote) === rules.stableJSON(row.quote.feeQuote), 'financial_link_signature');
    return row;
  };
  reads.financialLinkQuote = async ({ block, payer, feeQuote, id }, at) => {
    block = rules.decimalV2(block);
    const counted = at?.counted ?? await reads.counted(), registry = await reads.registry(), scope = linkFeeScope(block);
    const treasury = registry.link?.treasury; check(typeof treasury === 'string' && treasury.length, 'link_unconfigured');
    check(await reads.link(block) === null, 'link_exists');
    check(BigInt(block) <= BigInt(counted), 'financial_link_unavailable');
    const bitmap = await reads.bitmap(block, at);
    feeQuote ??= await reads.feeQuotes.issue(scope, counted, { treasury }, undefined, rules.hashObject(bitmap));
    const terms = await reads.feeQuotes.validate(feeQuote, scope);
    check(terms.payouts?.treasury === treasury && terms.mintOwnershipHash === rules.hashObject(bitmap), 'financial_link_quote_changed');
    const document = await reads.financialSettings(terms.settingsHash), price = rules.feeFor('link', terms.baseFee, 1, terms.feeSettings, at?.executionHeight ?? counted);
    const split = financialSplit(price, { kind: 'link' }, document), destinations = { treasury };
    const fees = reads.identifyFinancialFees(rules.mintFeeItems(split, destinations, id, payer, 'tap', bitcoinNetwork), 'tap');
    return { feeQuote, price, split, destinations, fees, bitmap, settingsHash: terms.settingsHash };
  };
  reads.financialLinkReservation = async (row, at) => {
    reads.verifyFinancialLinkRow(row);
    const r = row.request, document = await reads.financialSettings(r.settingsHash), counted = at?.counted ?? await reads.counted();
    check(r.settingsHash === row.quote.feeQuote.settingsHash && BigInt(r.until) - BigInt(counted) >= BigInt(document.values.requestMinBlocks) &&
      BigInt(r.until) - BigInt(counted) <= BigInt(document.values.requestMaxBlocks), 'financial_link_deadline');
    await reads.feeQuotes.accepted(row.feeAuthorization, linkFeeScope(r.block), row.id, r.until);
    const quote = await reads.financialLinkQuote({ block: r.block, payer: r.payer, feeQuote: row.requestedFeeQuote, id: row.id }, at);
    check(quote.bitmap.agent === r.owner && rules.stableJSON(quote.fees) === rules.stableJSON(row.quote.fees), 'financial_link_owner');
    return { version: 2, requestId: row.id, state: 'reservable', owner: r.owner, block: r.block, until: r.until, expiry: r.until,
      bitmapOwner: r.owner, bitmap: quote.bitmap, link: null, request: r, signature: row.signature, quote: row.requestedFeeQuote,
      feeAuthorization: row.feeAuthorization, receiver: row.payer, payer: row.payer, rail: 'tap', settingsHash: r.settingsHash,
      fees: financialFees(quote.fees), feeItems: quote.fees };
  };
  reads.financialLinkEvidence = async (a, at, row) => {
    if (a.type === 'link-reserve') return reads.financialLinkReservation(row, at);
    const { funding, source } = await accepted(a.id, at), reservation = await reads.financialRecord('fl/' + a.id, at);
    check(reservation?.state === 'reserved' && funding.state === 'open' && reservation.terms === funding.terms, 'financial_link_terminal');
    const base = { requestId: a.id, owner: funding.owner, terms: funding.terms, block: source.block };
    if (a.type === 'link-complete') {
      check(funding.fees.every((f, i) => f.amount === funding.paid[i]), 'financial_link_unpaid');
      // The current holder may change after admission. The accepted slot is
      // for the Bitmap itself; independently verify it still exists.
      const bitmap = await reads.bitmap(source.block, at);
      check(bitmap && await reads.link(source.block) === null, 'financial_link_unavailable');
      return { ...base, state: 'complete', fundingRoot: funding.root };
    }
    check(a.type === 'link-exit' && BigInt(at?.counted ?? await reads.counted()) > BigInt(source.until) &&
      !funding.fees.every((f, i) => f.amount === funding.paid[i]), 'financial_link_live');
    return { ...base, state: 'credit', expiry: source.until };
  };
}
