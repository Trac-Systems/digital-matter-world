import { rules } from './rules.mjs';
import { check, serial } from './util.mjs';
import { assetResources } from './asset-resources.mjs';
import { FinancialMints } from './financial-mints.mjs';
import { financialBlock } from './financial-status.mjs';
import { financialLinkId, verifyFinancialLink } from '../../rules/src/financial-link.js';
import { linkFeeScope } from './financial-link-sources.mjs';

const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const ownerSpace = owner => 'financialLinkOwner/' + owner;

export class FinancialLinks {
  constructor(options) { Object.assign(this, options); this.resources = assetResources(options.resources); this.gate = serial(); this.financialVersion = 2; }
  async quote(input) {
    if (!input.feeQuote) check(!this.financial.admissionReady || await this.financial.admissionReady(), 'financial_admission_fenced', 503);
    return this.reads.financialLinkQuote(input);
  }
  async public(id) {
    const row = this.store.get('financialLinks', id); check(row, 'request_not_found', 404);
    const funding = this.store.get('accountRecords', 'fp/' + id), link = this.store.get('accountRecords', 'fl/' + id);
    const blocked = financialBlock(this.store, ['fp/' + id, 'fl/' + id, 'fp/usage']);
    const expired = rules.compareOrdinal(await this.reads.counted(), row.request.until) > 0;
    const missing = row.quote.fees.map((fee, i) => ({ ...fee, amount: (BigInt(fee.amount) - BigInt(funding?.paid[i] ?? '0')).toString() })).filter(f => f.amount !== '0');
    const state = link?.state === 'complete' ? 'accepted' : ['credited', 'refunded'].includes(link?.state) ? link.state :
      !funding ? row.state : expired ? 'reconciling' : missing.length ? funding.paid.some(n => n !== '0') ? 'partly_paid' : 'awaiting_payment' : 'paid';
    return { id, requestId: id, financialVersion: 2, state, payer: row.payer, receiver: row.payer, owner: row.request.owner, block: row.request.block ?? row.request.height,
      terms: { payer: row.payer }, price: row.quote.price, ...(row.quote.price === '0' ? { fee: 'Free' } : {}), split: row.quote.split, fees: row.quote.fees, fullFees: row.quote.fees, missing,
      payable: !blocked && funding?.state === 'open' && !expired && missing.length > 0, payBy: { rail: 'tap', untilBlock: row.request.until },
      payableAmount: missing.reduce((n, f) => n + BigInt(f.amount), 0n).toString(), unit: rules.TAP_UNIT, blocked: blocked ? [blocked] : [],
      funding: funding ? { state: funding.state, paid: funding.paid, root: funding.root } : null };
  }
  request(body) { return this.gate(async () => {
    const r = body.request;
    check(verifyFinancialLink(this.network, r, body.signature) && r.quoteHash === rules.hashObject(body.feeQuote), 'financial_link_signature');
    const id = financialLinkId(this.network, r); let row = this.store.get('financialLinks', id);
    if (row) check(same(row.request, r) && row.signature === body.signature && same(row.requestedFeeQuote, body.feeQuote), 'request_conflict');
    if (row && row.state !== 'authorizing') return this.public(id);
    if (!row) {
      check(!this.financial.admissionReady || await this.financial.admissionReady(), 'financial_admission_fenced', 503);
      check(this.store.count('financialPendingLinks') < this.resources.activeLinks && this.store.count(ownerSpace(r.owner)) < this.resources.linksPerAgent, 'link_capacity', 503);
      const at = await this.reads.batchStamp(), quote = await this.reads.financialLinkQuote({ block: r.block, payer: r.payer, feeQuote: body.feeQuote, id }, at);
      const feeAuthorization = await this.reads.feeQuotes.accept(quote.feeQuote, linkFeeScope(r.block), id, r.until, at.counted);
      row = { id, request: r, signature: body.signature, payer: r.payer, receiver: r.payer, kind: 'tap', requestedFeeQuote: body.feeQuote,
        quote, feeAuthorization, state: 'authorizing' };
      const evidence = await this.reads.financialLinkReservation(row, at);
      row.reservationEvidence = evidence; row.reservationAction = { type: 'link-reserve', id, owner: r.owner, block: r.block, terms: rules.hashObject(evidence), until: r.until };
      await this.store.transact([{ space: 'financialLinks', id, value: row }, { space: 'financialPendingLinks', id, value: true }, { space: ownerSpace(r.owner), id, value: true }]);
    }
    if (!body.reserve) return { ...await this.public(id), reservationAction: row.reservationAction, reservationEvidence: row.reservationEvidence };
    const { sig, ...unsigned } = body.reserve; check(same(unsigned, row.reservationAction), 'financial_reservation_changed');
    const admitted = await this.financial.admitLink({ type: 'lifecycle', id, action: body.reserve }, await this.reads.batchStamp());
    await this.store.put('financialLinks', id, { ...row, state: 'reserving', work: admitted.id }); return this.public(id);
  }); }
  async queue(row, transition) {
    const admitted = await this.financial.submit(transition);
    await this.store.put('financialLinks', row.id, { ...row, work: admitted.id }); return admitted;
  }
  paymentPage(...args) { return FinancialMints.prototype.paymentPage.apply(this, args); }
  advanceLegacyCredit(...args) { return FinancialMints.prototype.advanceLegacyCredit.apply(this, args); }
  payment({ id, requestId, paymentId, paymentIds = [] }) { return this.gate(async () => {
    id ??= requestId; const row = this.store.get('financialLinks', id); check(row, 'request_not_found', 404);
    check(!row.work || this.store.get('financialAccepted', row.work), 'financial_transition_pending', 409);
    const references = [...new Set([...(paymentId ? [paymentId] : []), ...paymentIds])];
    const at = await this.reads.batchStamp(), funding = await this.reads.financialRecord('fp/' + id, at);
    const settingsHash = row.request.settingsHash ?? (await this.reads.financialRecord('fi/source/' + id, at))?.settingsHash;
    const original = await this.reads.financialSettings(settingsHash);
    check(references.length > 0 && references.length <= original.values.paymentPage, 'financial_receipt_references');
    if (row.legacyLink && ['credited', 'refunded'].includes(funding?.state)) {
      const old = this.store.get('financialLegacyCredits', id);
      check(!old?.work || this.store.get('financialAccepted', old.work), 'financial_transition_pending', 409);
      await this.store.put('financialLegacyCredits', id, { references: [...new Set([...(old?.references ?? []), ...references])], offset: 0 });
      await this.advanceLegacyCredit(id); return this.public(id);
    }
    await this.paymentPage(row, references, at); return this.public(id);
  }); }
  async tick() { return this.gate(async () => {
    const page = this.store.list('financialPendingLinks', { after: this.cursor ?? '', limit: this.resources.workPage });
    this.cursor = page.length === this.resources.workPage ? page.at(-1).id : '';
    for (const { id } of page) {
      const row = this.store.get('financialLinks', id), at = await this.reads.batchStamp(), funding = this.store.get('accountRecords', 'fp/' + id);
      try {
        if (!funding && BigInt(at.counted) > BigInt(row.request.until) && (!row.work || await this.financial.expire(row.work, at))) {
          await this.store.transact([{ space: 'financialLinks', id, value: { ...row, state: 'expired' } }, { space: 'financialPendingLinks', id }, { space: ownerSpace(row.request.owner), id }]);
        } else if (funding?.state === 'open' && (!row.work || this.store.get('financialAccepted', row.work))) {
          if (row.legacyLink) {
            const complete = funding.fees.every((fee, i) => fee.amount === funding.paid[i]);
            if (complete) {
              const transition = { type: 'lifecycle', id, action: { type: 'legacy-link-complete', id } };
              try { await this.reads.financialEvidence(transition, at); await this.queue(row, transition); }
              catch { const exit = { type: 'lifecycle', id, action: { type: 'legacy-link-exit', id } }; await this.reads.financialEvidence(exit, at); await this.queue(row, exit); }
            } else if (row.paymentReferences && await this.paymentPage(row, row.paymentReferences, at, { allowEmpty: true })) continue;
            else if (BigInt(at.counted) > BigInt(row.request.until)) await this.queue(row, { type: 'lifecycle', id, action: { type: 'legacy-link-exit', id } });
          } else if (row.paymentReferences) await this.paymentPage(row, row.paymentReferences, at);
          else {
            // A fee payment the link page reported as sent counts without that page open.
            const sent = this.store.get('inflight', `link/${id}/payment`)?.inscriptionId;
            this.sentPaymentChecks ??= new Map();
            if (/^[0-9a-f]{64}i0$/.test(sent ?? '') && Date.now() - (this.sentPaymentChecks.get(id) ?? 0) >= 30000) {
              this.sentPaymentChecks.set(id, Date.now());
              await this.paymentPage(row, [sent], at);
            }
          }
        }
      } catch (error) { await this.store.put('financialLinkFailures', id, { reason: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_source_unavailable' }); }
    }
  }); }
}
