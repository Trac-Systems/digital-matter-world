import { rules } from './rules.mjs';
import { check, serial } from './util.mjs';
import { tapReceipts } from './mint-payments.mjs';
import { payoutAddress } from '../../rules/src/payout-bindings.mjs';
import { tickerConflicts } from '../../rules/src/ticker-names.js';
import { indexedTicker, tickerAvailable, reserveTicker, releaseTicker } from './ticker-availability.mjs';
import { publicRefundKey } from '../../contract/public-mint.js';
import { lookupSettings as lookupLimits } from '../prod/lookup-settings.mjs';

const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const heightOf = at => at?.executionHeight ?? at?.counted;
const gates = new WeakMap();
const gate = store => { if (!gates.has(store)) gates.set(store, serial()); return gates.get(store); };
export const tickerFeeScope = (asset, tick, payer) => rules.stableJSON(['ticker-v1', asset, indexedTicker(tick), payer]);

// Native TAP deploy fees use the same request-bound wallet items as v2 links.
// The core deployment flow supplies its authenticated request ID and checks
// that the official deployment exists before calling request().
export async function tickerDeployQuote(reads, { asset, tick, payer, id = null, feeQuote }, at, { network, bitcoinNetwork = 'mainnet' }) {
  check(rules.multiTickerActive(heightOf(at)), 'ticker_inactive');
  check(typeof asset === 'string' && asset.length > 0 && (id === null || rules.hex(id, 32)), 'ticker_request');
  payoutAddress('tap', payer, bitcoinNetwork); tick = indexedTicker(tick);
  const scope = tickerFeeScope(asset, tick, payer);
  if (!feeQuote) {
    const registry = await reads.registry(), treasury = registry.link?.treasury;
    check(typeof treasury === 'string' && treasury.length > 0, 'ticker_treasury');
    feeQuote = await reads.feeQuotes.issue(scope, at.counted, { treasury });
  }
  const terms = await reads.feeQuotes.validate(feeQuote, scope);
  const treasury = terms.payouts?.treasury;
  check(terms.network === network && rules.hex(terms.settingsHash, 32) && typeof treasury === 'string' && treasury.length > 0, 'ticker_fee_quote');
  // Accepted payments remain bound to the signed destination when the
  // operator rotates today's treasury. Recovery must use those same terms.
  payoutAddress('tap', treasury, bitcoinNetwork);
  const document = await reads.financialSettings(terms.settingsHash);
  check(document?.network === network && rules.hashObject(document) === terms.settingsHash, 'ticker_settings');
  rules.validateSettingsDocument(document);
  const price = rules.feeFor('ticker', terms.baseFee, 1, document.values, heightOf(at));
  const split = rules.financialSplit(price, { kind: 'ticker', executionHeight: heightOf(at) }, document);
  // Separate fee domain and bind the complete target, even if a caller reuses
  // a core request ID. A mint/link transfer or another ticker cannot pay this.
  const fees = rules.mintFeeItems(split, { treasury }, null, payer, 'tap', bitcoinNetwork).map(fee => ({ ...fee,
    ...(id ? { dta: 'dmw-ticker-pay-v1|' + rules.hashObject([network, asset, tick, payer, id, rules.hashObject(feeQuote), fee.role, fee.to]) } : {}) }));
  return { feeQuote, price, split, fees, destinations: { treasury }, settingsHash: terms.settingsHash, unit: rules.TAP_UNIT };
}

// Independently usable by the gateway and every registry verifier. Call with
// the batch execution height; neither a payment height nor a quoted height
// selects the rule. No payer history, transfer history or totals are consulted.
export async function verifyTickerDeployPayment(reads, row, at, options) {
  check(row && rules.hex(row.id, 32) && row.tick === indexedTicker(row.tick) && row.kind === 'tap', 'ticker_payment_request');
  check(same(row.feeAuthorization?.quote, row.quote.feeQuote), 'ticker_payment_quote');
  await reads.feeQuotes.accepted(row.feeAuthorization, tickerFeeScope(row.asset, row.tick, row.payer), row.id, row.until);
  const quote = await tickerDeployQuote(reads, { ...row, feeQuote: row.quote.feeQuote }, at, options);
  check(same(quote, row.quote), 'ticker_payment_quote');
  const references = row.paymentReferences ?? [];
  check(Array.isArray(references) && new Set(references).size === references.length, 'ticker_payment_references');
  const document = await reads.financialSettings(quote.settingsHash);
  check(typeof reads.withTapSnapshot === 'function', 'ticker_snapshot_required');
  const pageSize = Math.min(document.values.paymentPage, lookupLimits(options.lookupSettings).paymentIds);
  const receipts = (await reads.withTapSnapshot(at, async () => {
    const result = [];
    // Page explicit references; no lifetime cap can strand partial payments.
    for (let offset = 0; offset < references.length; offset += pageSize)
      result.push(...await tapReceipts(reads, row, references.slice(offset, offset + pageSize), options.lookupSettings, { at, confirmedOnly: true }));
    return result;
  // Mainnet inclusion reads count confirmations from decimal-string heights; fee progress counts whole numbers.
  })).map(receipt => typeof receipt.confirmations === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(receipt.confirmations)
    ? { ...receipt, confirmations: Number(receipt.confirmations) } : receipt);
  const progress = rules.paymentProgress(quote.fees, receipts);
  return { requestId: row.id, settingsHash: quote.settingsHash, quote, receipts, ...progress,
    paymentHash: rules.paymentCommitment(progress.allocations) };
}

// These records are compatible with the existing refundAmounts/refundRedeem
// path. An adapter must persist them in its accepted refund ledger before
// acknowledging refusal. A local obligation alone is never called a refund.
export function tickerPaymentRefunds(row, verified, reason) {
  check(verified?.requestId === row.id && typeof reason === 'string' && /^[a-z][a-z0-9_]*$/.test(reason), 'ticker_refund');
  const byReference = new Map(), seen = new Set();
  for (const receipt of verified.receipts) {
    check(receipt.accepted && Number.isSafeInteger(receipt.confirmations) && receipt.confirmations >= 1 && receipt.origin === row.id &&
      rules.hex(receipt.key, 32) && !seen.has(receipt.key) && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(receipt.reference) &&
      row.quote.fees.some(fee => rules.sameFee(fee, receipt) && fee.dta === receipt.dta), 'ticker_refund_receipt');
    seen.add(receipt.key); rules.tapAtoms(receipt.amount);
    if (BigInt(receipt.amount) === 0n) continue;
    const fees = byReference.get(receipt.reference) ?? new Map();
    const fee = row.quote.fees.find(fee => rules.sameFee(fee, receipt) && fee.dta === receipt.dta), key = rules.hashObject(fee);
    fees.set(key, { ...fee, amount: String(BigInt(fees.get(key)?.amount ?? '0') + BigInt(receipt.amount)) });
    byReference.set(receipt.reference, fees);
  }
  return [...byReference].sort(([a], [b]) => a.localeCompare(b)).map(([reference, fees]) => {
    const record = { id: row.id, reference, tapAddress: row.payer, asset: row.asset, ticker: row.tick,
      fees: [...fees].sort(([a], [b]) => a.localeCompare(b)).map(([, fee]) => fee), state: 'owed', reason };
    return { ...record, refundId: publicRefundKey(record).slice('fp/public-refund/'.length) };
  });
}

export class TickerPayments {
  constructor({ store, reads, network, bitcoinNetwork = 'mainnet', lookupSettings, officialName, refund }) {
    Object.assign(this, { store, reads, network, bitcoinNetwork, lookupSettings, officialName, refund }); this.gate = gate(store);
  }
  async view(id) {
    const row = this.store.get('tickerPayments', id); check(row, 'ticker_request_missing', 404);
    const missing = row.verified?.missing ?? row.quote.fees;
    return { id, asset: row.asset, ticker: row.tick, payer: row.payer, state: row.state, price: row.quote.price,
      split: row.quote.split, fees: row.quote.fees, missing, unit: rules.TAP_UNIT, settingsHash: row.quote.settingsHash,
      feeQuote: row.quote.feeQuote, payable: ['awaiting_payment', 'partly_paid'].includes(row.state),
      redeem: { items: ['awaiting_payment', 'partly_paid'].includes(row.state) ? rules.walletFeeItems(missing, this.bitcoinNetwork) : [], data: '', actions: [] },
      ...(row.reason ? { reason: row.reason } : {}), ...(row.refunds ? { refunds: row.refunds } : {}) };
  }
  request({ id, asset, tick, payer, until, feeQuote }, at) { return this.gate(async () => {
    check(rules.multiTickerActive(heightOf(at)), 'ticker_inactive');
    check(rules.hex(id, 32), 'ticker_request'); tick = indexedTicker(tick); until = rules.decimalV2(until);
    const old = this.store.get('tickerPayments', id);
    if (old) {
      check(same([old.asset, old.tick, old.payer, old.until], [asset, tick, payer, until]) &&
        (feeQuote === undefined || same(old.quote.feeQuote, feeQuote)), 'ticker_request_conflict');
      return this.view(id);
    }
    await tickerConflicts(tick.startsWith('dmt-') ? tick.slice(4) : tick, { officialName: this.officialName });
    check(await tickerAvailable(this.reads, tick), 'ticker_taken', 409);
    const quote = await tickerDeployQuote(this.reads, { asset, tick, payer, id, feeQuote }, at, this);
    const document = await this.reads.financialSettings(quote.settingsHash);
    const span = BigInt(until) - BigInt(at.counted);
    check(span >= BigInt(document.values.requestMinBlocks) && span <= BigInt(document.values.requestMaxBlocks), 'ticker_deadline');
    const feeAuthorization = await this.reads.feeQuotes.accept(quote.feeQuote, tickerFeeScope(asset, tick, payer), id, until, at.counted);
    await reserveTicker(this.store, tick, id);
    // A failed write leaves a recoverable reservation for the same request ID.
    await this.store.put('tickerPayments', id, { id, asset, tick, payer, until, kind: 'tap', quote, feeAuthorization,
      paymentReferences: [], state: quote.fees.length ? 'awaiting_payment' : 'paid' });
    return this.view(id);
  }); }
  payment({ id, paymentIds = [] }, at) { return this.gate(async () => {
    const row = this.store.get('tickerPayments', id); check(row, 'ticker_request_missing', 404);
    check(row.state !== 'completed', 'ticker_payment_terminal');
    check(Array.isArray(paymentIds), 'ticker_payment_references');
    const candidate = { ...row, paymentReferences: [...new Set([...row.paymentReferences, ...paymentIds])] };
    const verified = await verifyTickerDeployPayment(this.reads, candidate, at, this);
    if (row.reason) return this.refundVerified(candidate, row.reason, verified, at);
    await this.store.put('tickerPayments', id, { ...candidate, verified, state: verified.final ? 'paid' : verified.seen ? 'partly_paid' : 'awaiting_payment' });
    return this.view(id);
  }); }
  expire(id, at) { return this.gate(async () => {
    const row = this.store.get('tickerPayments', id); check(row, 'ticker_request_missing', 404);
    if (row.state === 'completed' || BigInt(at.counted) <= BigInt(row.until)) return this.view(id);
    const verified = await verifyTickerDeployPayment(this.reads, row, at, this);
    if (verified.final && !row.reason) {
      await this.store.put('tickerPayments', id, { ...row, verified, state: 'paid' }); return this.view(id);
    }
    return this.refundVerified(row, row.reason ?? 'ticker_expired', verified, at);
  }); }
  // Core registration must independently verify the payment and win its own
  // asset/ticker registration race before marking this local projection done.
  complete(id, registration) { return this.gate(async () => {
    const row = this.store.get('tickerPayments', id); check(row && ['paid', 'completed'].includes(row.state), 'ticker_unpaid');
    check(registration?.asset === row.asset && indexedTicker(registration.indexTick ?? (registration.kind === 'dmt' ? 'dmt-' : '') + registration.tick) === row.tick &&
      /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(registration.id), 'ticker_registration');
    check(!row.registration || same(row.registration, registration), 'ticker_registration_conflict');
    await this.store.put('tickerPayments', id, { ...row, registration, state: 'completed' });
    await releaseTicker(this.store, row.tick, id); return this.view(id);
  }); }
  refuse(id, reason, at) { return this.gate(async () => {
    const row = this.store.get('tickerPayments', id); check(row && row.state !== 'completed', 'ticker_payment_terminal');
    const verified = await verifyTickerDeployPayment(this.reads, row, at, this);
    return this.refundVerified(row, reason, verified, at);
  }); }
  async refundVerified(row, reason, verified, at) {
    const id = row.id;
    check(!row.reason || row.reason === reason, 'ticker_refusal_conflict');
    const refunds = tickerPaymentRefunds(row, verified, reason);
    const obligation = { ...row, verified, refunds, reason, state: 'recovery' };
    await this.store.put('tickerPayments', id, obligation);
    if (refunds.length) {
      check(typeof this.refund === 'function', 'ticker_refund_adapter_required', 503);
      // Must be idempotent by refundId; failure/restart retains the obligation.
      for (const record of refunds) await this.refund(record, { row: obligation, verified, at });
    }
    await this.store.put('tickerPayments', id, { ...obligation, state: refunds.length ? 'refund_pending' : 'refused' });
    await releaseTicker(this.store, row.tick, id); return this.view(id);
  }
}
