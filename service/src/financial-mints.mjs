import { Mints, publicMint, verifyPayer } from './mints.mjs';
import { rules } from './rules.mjs';
import { check, hash } from './util.mjs';
import { mintFeeScope } from './fees.mjs';
import { financialMintId, verifyFinancialMintRequest } from '../../rules/src/financial-mint.js';
import { financialFees } from './financial-sources.mjs';
import { AccountAvailability } from './account-availability.mjs';
import { accountKey, EMPTY_ACCOUNT_ROOT } from '../../contract/account-tree.js';
import { releaseCalldata } from './ethereum.mjs';
import { buildFinancialExecution } from './financial-execution.mjs';
import { financialBlock } from './financial-status.mjs';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { surplusCreditId } from '../../contract/payment-pages.js';

const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const ownerSpace = owner => 'financialMintOwner/' + owner;

// Ordinary mint HTTP methods use this implementation after v2 activation.
// The player separately signs the exact account reservation returned by the
// first request. Every retry retains the original request and fee quote.
export class FinancialMints extends Mints {
  constructor(options) { super(options); this.financial = options.financial; this.document = options.document; this.pendingBlocks = this.document.values.pendingBlocks; }
  async quote(input) {
    if (input.request) return this.request(input);
    if (!input.feeQuote) check(!this.financial.admissionReady || await this.financial.admissionReady(), 'financial_admission_fenced', 503);
    if (this.reads.financialDeployment) {
      const generation = await this.reads.financialDeployment(input.asset, await this.reads.batchStamp());
      if (!generation.existing) {
        await this.financial.submit({ type: 'lifecycle', id: generation.id, action: generation.action });
        check(false, 'financial_deployment_pending', 409);
      }
    }
    const quote = await super.quote(input);
    if (this.reads.identifyFinancialFees) quote.fees = this.reads.identifyFinancialFees(quote.fees, input.kind ?? 'tap', quote.custody);
    return { ...quote, financialVersion: 2, settingsHash: quote.feeQuote.settingsHash ?? rules.hashObject(this.document) };
  }
  async deploymentNeeded() { return null; }
  public(id) {
    const row = this.store.get('mints', id); check(row, 'request_not_found', 404);
    const funding = this.store.get('accountRecords', 'fp/' + id), obligation = this.store.get('accountRecords', 'ao/' + id);
    const capacity = this.store.get('accountRecords', 'dc/' + id), external = funding?.capacity;
    const blocked = financialBlock(this.store, ['fp/' + id, 'ao/' + id, 'dc/' + id, 'fp/usage',
      ...(capacity ? ['fd/' + capacity.deployment] : []), ...(external ? [capacityKey(external.deployment),
        'fi/deployment/' + external.deployment, ...(external.block === null ? [] : [plotKey(external.asset, external.block)])] : [])]);
    return { ...publicMint(row), financialVersion: 2, state: row.state,
      payable: !blocked && !!funding && funding.state === 'open' && !row.permit, blocked: blocked ? [blocked] : [],
      reservation: obligation?.state ?? 'pending', funding: funding ? { state: funding.state, paid: funding.paid, sequence: funding.sequence, root: funding.root } : null,
      ...(row.work ? { transition: { id: row.work, state: this.store.get('financialAccepted', row.work)?.state ?? 'queued',
        reason: this.store.get('financialDeferred', row.work)?.reason ?? null } } : {}) };
  }
  request(body) { return this.gate(async () => {
    const r = body.request, counted = await this.reads.counted();
    check(verifyFinancialMintRequest(this.network, r, body.signature, r?.until) && verifyPayer(this.network, body) &&
      typeof body.receiver === 'string' && hash(body.receiver) === r.receive, 'financial_request_signature');
    const id = financialMintId(this.network, r); let row = this.store.get('mints', id);
    if (row) check(same(row.request, r) && row.signature === body.signature && row.receiver === body.receiver && row.payer === body.payer && row.kind === body.kind &&
      same(row.requestedFeeQuote, body.feeQuote) && row.authorization === body.authorization, 'request_conflict', 409);
    if (row && row.state !== 'authorizing') return this.public(id);
    if (!row) {
      check(!this.financial.admissionReady || await this.financial.admissionReady(), 'financial_admission_fenced', 503);
      check(rules.compareOrdinal(counted, r.until) <= 0 && body.feeQuote, 'financial_request_expired');
      check(this.store.count('financialActiveMints') < this.resources.activeMints && this.store.count(ownerSpace(r.owner)) < this.resources.mintsPerAgent, 'mint_capacity', 503);
      const quote = await this.quote({ asset: r.asset, amount: r.amount, ...(r.block === undefined ? {} : { block: r.block }), kind: body.kind, payer: body.payer, receiver: body.receiver, feeQuote: body.feeQuote });
      if (this.reads.financialFeePlan && quote.feeQuote.settingsHash) {
        const terms = { split: quote.split, destinations: quote.destinations, beneficiaries: quote.beneficiaries, id, rail: body.kind };
        const plan = this.reads.financialFeePlan({ ...terms, payer: body.payer });
        quote.fees = plan.fees; quote.custody = plan.custody;
        quote.fullFees = this.reads.financialFeePlan({ ...terms, payer: null }).fees;
      } else {
        quote.fees = rules.mintFeeItems(quote.split, quote.destinations, id, body.payer, body.kind, this.bitcoinNetwork);
        quote.fullFees = rules.mintFeeItems(quote.split, quote.destinations, id, null, body.kind, this.bitcoinNetwork);
      }
      if ((!this.reads.financialFeePlan || !quote.feeQuote.settingsHash) && this.reads.identifyFinancialFees) {
        quote.fees = this.reads.identifyFinancialFees(quote.fees, body.kind);
        quote.fullFees = this.reads.identifyFinancialFees(quote.fullFees, body.kind);
      }
      quote.payableAmount = quote.fees.reduce((n, f) => n + BigInt(f.amount), 0n).toString();
      const feeAuthorization = await this.reads.feeQuotes.accept(quote.feeQuote, mintFeeScope(r.asset, r.block, body.kind), id, r.expires, counted);
      row = { id, request: r, signature: body.signature, receiver: body.receiver, payer: body.payer, kind: body.kind, authorization: body.authorization,
        requestedFeeQuote: body.feeQuote, quote, feeAuthorization, state: 'authorizing', created: counted, expiry: r.expires, paymentIds: [] };
      const at = await this.reads.batchStamp(), evidence = await this.reads.financialReservation(row, at), account = await this.reads.financialRecord('ar/' + r.owner, at);
      row.context = { deployment: evidence.deployment };
      row.reservationEvidence = evidence;
      row.reservationAction = { type: 'reserve', id, owner: r.owner, asset: r.asset, amount: r.amount, terms: rules.hashObject(evidence),
        revision: account?.revision ?? '0', nonce: r.nonce, until: r.until };
      await this.store.transact([{ space: 'mints', id, value: row }, { space: 'financialActiveMints', id, value: true }, { space: ownerSpace(r.owner), id, value: true }]);
    }
    if (!body.reserve) return { ...this.public(id), reservationAction: row.reservationAction, reservationEvidence: row.reservationEvidence };
    const { sig, ...unsigned } = body.reserve;
    check(same(unsigned, row.reservationAction), 'financial_reservation_changed');
    const transition = { type: 'reserve', id, action: body.reserve, fees: financialFees(row.quote.fees) };
    const admitted = await this.financial.admit(transition, await this.reads.batchStamp());
    await this.store.put('mints', id, { ...row, state: 'reserving', work: admitted.id });
    return this.public(id);
  }); }
  async queue(row, transition) {
    const admitted = await this.financial.submit(transition);
    await this.store.put('mints', row.id, { ...row, work: admitted.id });
    return admitted;
  }
  async paymentPage(row, references, at, { allowEmpty = false } = {}) {
    const funding = await this.reads.financialRecord('fp/' + row.id, at);
    check(funding && !row.permit, 'payment_state', 409);
    const receipts = await this.reads.financialReceipts(row.id, references, at), usage = this.store.get('accountRecords', 'fp/usage') ?? { root: EMPTY_ACCOUNT_ROOT };
    const availability = new AccountAvailability(this.store), paid = [...funding.paid], items = [];
    for (const receipt of receipts) {
      if (items.length === this.document.values.paymentPage) break;
      const key = accountKey('payment', receipt.key), used = availability.prove(usage.root, [key]).leaves[0].value;
      const fee = financialFees([receipt])[0].key, index = funding.fees.findIndex(f => f.key === fee); check(index >= 0, 'financial_fee');
      const available = BigInt(receipt.amount) - BigInt(used?.used ?? '0'), missing = BigInt(funding.fees[index].amount) - BigInt(paid[index]);
      const amount = available < missing ? available : missing;
      if (amount <= 0n) continue;
      paid[index] = (BigInt(paid[index]) + amount).toString(); items.push({ key: receipt.key, fee, total: receipt.amount, amount: amount.toString() });
    }
    if (items.length) {
      for (;;) {
        const transition = { type: 'fund', id: row.id, items: [...items], references };
        try {
          await buildFinancialExecution({ store: this.store, reads: this.reads, document: this.document, transitions: [transition], height: at.counted, at });
          return this.queue({ ...row, [row.kind === 'ethereum' ? 'ethereumReferences' : 'paymentReferences']: references }, transition);
        } catch (error) {
          if (items.length === 1 || !['account_operation_bytes', 'account_proof_budget', 'financial_batch_bytes', 'funding_operation'].includes(error.message)) throw error;
          items.length = Math.max(1, Math.floor(items.length / 2));
        }
      }
    }
    check(allowEmpty || receipts.length > 0, 'payment_unconfirmed'); return null;
  }
  payment({ id, requestId, paymentId, paymentIds = [], inscription }) { return this.gate(async () => {
    id ??= requestId; const row = this.store.get('mints', id); check(row, 'request_not_found', 404);
    if (inscription) {
      check(row.permit && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(inscription), 'mint_inscription');
      await this.store.put('mints', id, { ...row, mintInscription: inscription }); return this.public(id);
    }
    check(!row.work || this.store.get('financialAccepted', row.work), 'financial_transition_pending', 409);
    const references = [...new Set([...(paymentId ? [paymentId] : []), ...paymentIds])];
    const at = await this.reads.batchStamp();
    const settingsHash = row.request.settingsHash ?? (await this.reads.financialRecord('fi/source/' + id, at))?.settingsHash;
    const original = this.reads.financialSettings ? await this.reads.financialSettings(settingsHash) : this.document;
    check(rules.hashObject(original) === settingsHash, 'financial_settings_history');
    check(references.length > 0 && references.length <= original.values.paymentPage, 'financial_receipt_references');
    const funding = await this.reads.financialRecord('fp/' + id, at);
    if (['credited', 'refunded'].includes(funding?.state) && await this.reads.financialRecord('fi/source/' + id, at)) {
      const old = this.store.get('financialLegacyCredits', id);
      check(!old?.work || this.store.get('financialAccepted', old.work), 'financial_transition_pending', 409);
      await this.store.put('financialLegacyCredits', id, { references: [...new Set([...(old?.references ?? []), ...references])], offset: 0 });
      await this.advanceLegacyCredit(id); return this.public(id);
    }
    if (row.kind === 'ethereum') {
      const snapshot = await this.reads.financialEscrow(id, references, at);
      await this.store.put('mints', id, { ...row, ethereumReferences: references, state: snapshot.deposit.status === 1 ? 'paid' : row.state });
      if (snapshot.deposit.status === 1) return this.public(id);
    }
    await this.paymentPage(row, references, at); return this.public(id);
  }); }
  refund({ id, requestId, references = [], reason = 'credit' }) { return this.gate(async () => {
    id ??= requestId; const row = this.store.get('mints', id); check(row, 'request_not_found', 404);
    const transition = { type: 'refund', id, reason, ...(references.length ? { references } : {}) };
    await this.reads.financialEvidence(transition, await this.reads.batchStamp());
    await this.queue(row, transition); return this.public(id);
  }); }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      for (const space of ['financialActiveMints', 'financialIssuedMints']) {
        this.financialCursors ??= {}; const page = this.store.list(space, { after: this.financialCursors[space] ?? '', limit: this.resources.workPage });
        this.financialCursors[space] = page.length === this.resources.workPage ? page.at(-1).id : '';
        for (const { id } of page) await this.gate(async () => {
          try { await this.advance(this.store.get('mints', id)); }
          catch (error) { const row = this.store.get('mints', id); await this.store.put('mints', id, { ...row, lastError: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_source_unavailable' }); }
        });
      }
      const credits = this.store.list('financialLegacyCredits', { after: this.legacyCreditCursor ?? '', limit: this.resources.workPage });
      this.legacyCreditCursor = credits.length === this.resources.workPage ? credits.at(-1).id : '';
      for (const { id } of credits) await this.gate(async () => {
        try { await this.advanceLegacyCredit(id); }
        catch (error) { await this.store.put('financialLegacyCreditFailures', id, { reason: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_source_unavailable' }); }
      });
    } finally { this.running = false; }
  }
  async advanceLegacyCredit(id) {
    let pending = this.store.get('financialLegacyCredits', id);
    if (pending.work && !this.store.get('financialAccepted', pending.work)) return;
    if (pending.work) {
      await this.store.put('legacyCreditResults/' + id, pending.credit, { state: 'accepted', transition: pending.work });
      const { work, credit, ...rest } = pending; pending = rest;
    }
    const at = await this.reads.batchStamp(), funding = await this.reads.financialRecord('fp/' + id, at);
    check(['credited', 'refunded', 'consumed'].includes(funding?.state), 'pending_credit_live');
    const references = pending.references.slice(pending.offset, pending.offset + this.document.values.paymentPage);
    if (!references.length) { await this.store.transact([{ space: 'financialLegacyCredits', id }, { space: 'financialLegacyCreditFailures', id }]); return; }
    const receipts = await this.reads.financialReceipts(id, references, at), usage = this.store.get('accountRecords', 'fp/usage') ?? { root: EMPTY_ACCOUNT_ROOT };
    const availability = new AccountAvailability(this.store), items = [];
    for (const receipt of receipts) {
      const used = availability.prove(usage.root, [accountKey('payment', receipt.key)]).leaves[0].value;
      const amount = BigInt(receipt.amount) - BigInt(used?.used ?? '0');
      if (amount > 0n) items.push({ key: receipt.key, total: receipt.amount, fee: financialFees([receipt])[0].key, amount: amount.toString() });
      if (items.length === this.document.values.paymentPage) break;
    }
    if (!items.length) {
      check(receipts.length > 0, 'pending_credit_unconfirmed');
      await this.store.put('financialLegacyCredits', id, { ...pending, offset: pending.offset + references.length }); return;
    }
    const transition = { type: 'surplus', id, items, references };
    await buildFinancialExecution({ store: this.store, reads: this.reads, document: this.document, transitions: [transition], height: at.counted, at });
    const admitted = await this.financial.submit(transition);
    await this.store.put('financialLegacyCredits', id, { ...pending, work: admitted.id, credit: surplusCreditId(id, funding.sequence) });
  }
  async advance(row) {
    const at = await this.reads.batchStamp(), funding = await this.reads.financialRecord('fp/' + row.id, at);
    if (!funding) {
      if (rules.compareOrdinal(at.counted, row.request.until) > 0 && (!row.work || await this.financial.expire(row.work, at))) {
        await this.store.transact([{ space: 'mints', id: row.id, value: { ...row, state: 'expired', reason: 'reservation_expired' } },
          { space: 'financialActiveMints', id: row.id }, { space: ownerSpace(row.request.owner), id: row.id }]);
      }
      return;
    }
    if (['credited', 'refunded'].includes(funding.state)) {
      await this.store.transact([{ space: 'mints', id: row.id, value: { ...row, state: 'expired', reason: funding.state } },
        { space: 'financialActiveMints', id: row.id }, { space: ownerSpace(row.request.owner), id: row.id }]); return;
    }
    if (row.permit) {
      // Completion is checked only for the inscription the player names.
      if (!row.mintInscription) return;
      const observation = await this.reads.mint(row.id, at);
      if (!this.verifyMint(row, observation)) return;
      const capacity = this.store.get('accountRecords', 'dc/' + row.id);
      if (capacity?.state === 'issued' || funding.capacity && !funding.minted && this.store.get('accountRecords', 'fi/source/' + row.id)?.legacy) {
        await this.queue(row, { type: 'lifecycle', id: row.id, action: { type: 'capacity-finish', id: row.id, permitHash: row.permit.prv.hash } }); return;
      }
      check(!capacity || capacity.state === 'minted', 'financial_capacity_terminal');
      await this.store.transact([{ space: 'mints', id: row.id, value: { ...row, state: 'minted', observation } }, { space: 'financialIssuedMints', id: row.id }]);
      return;
    }
    if (funding.state === 'consumed') {
      const p = await this.reads.financialPermit(row.id, at, { consumed: true });
      const signed = await this.committee.signature('mint/' + row.id, { network: this.network, kind: 'mint', version: 2, request: row.request, signature: row.signature, receiver: row.receiver });
      if (!signed) return;
      check(signed.payload?.prv?.hash === p.permit.digest && signed.payload.prv.address === row.receiver, 'financial_permit_binding');
      await this.store.transact([{ space: 'mints', id: row.id, value: { ...row, permit: signed.payload, unitsConsumed: true, state: 'permit_issued', missing: [] } },
        { space: 'financialPermitDelivery', id: row.id, value: { digest: p.permit.digest, session: signed.session } },
        { space: 'financialActiveMints', id: row.id }, { space: ownerSpace(row.request.owner), id: row.id }, { space: 'financialIssuedMints', id: row.id, value: true }]); return;
    }
    if (rules.compareOrdinal(at.counted, row.expiry) > 0) {
      if (row.work && !this.store.get('financialAccepted', row.work) && !await this.financial.expire(row.work, at)) return;
      if (this.store.get('accountRecords', 'fi/source/' + row.id)?.legacy) {
        if (row.kind === 'tap' && row.paymentReferences && await this.paymentPage(row, row.paymentReferences, at, { allowEmpty: true })) return;
        if (row.kind === 'ethereum' && row.ethereumReferences) {
          const snapshot = await this.reads.financialEscrow(row.id, row.ethereumReferences, at);
          if (snapshot.deposit.status === 3) { await this.queue(row, { type: 'refund', id: row.id, reason: 'ethereum_refund', references: row.ethereumReferences }); return; }
          if (snapshot.deposit.status === 2 && await this.paymentPage(row, row.ethereumReferences, at, { allowEmpty: true })) return;
        }
      }
      await this.queue(row, { type: 'refund', id: row.id, reason: 'credit' }); return;
    }
    if (row.work && !this.store.get('financialAccepted', row.work)) return;
    row = { ...row, state: funding.paid.some(n => n !== '0') ? 'partly_paid' : 'awaiting_payment',
      missing: row.quote.fees.map((f, i) => ({ ...f, amount: (BigInt(f.amount) - BigInt(funding.paid[i])).toString() })).filter(f => f.amount !== '0') };
    await this.store.put('mints', row.id, row);
    if (funding.fees.every((f, i) => f.amount === funding.paid[i])) {
      const p = await this.reads.financialPermit(row.id, at);
      await this.queue(row, { type: 'consume', id: row.id, permitHash: p.permit.digest }); return;
    }
    if (row.kind === 'tap' && row.paymentReferences) await this.paymentPage(row, row.paymentReferences, at);
    if (row.kind === 'ethereum' && row.ethereumReferences) {
      const snapshot = await this.reads.financialEscrow(row.id, row.ethereumReferences, at);
      if (snapshot.deposit.status === 1 && !row.release) {
        const signed = await this.committee.signature('payment-release/' + row.id, { network: this.network, kind: 'ethereum-payment-release', version: 2, id: row.id, references: row.ethereumReferences });
        if (signed) await this.store.put('mints', row.id, { ...row, release: { chainId: signed.typedData.domain.chainId, to: signed.typedData.domain.verifyingContract,
          data: releaseCalldata(row.payer, row.id, signed.ethereumSignature), signature: signed.ethereumSignature, typedData: signed.typedData } });
        return;
      }
      if (snapshot.deposit.status === 2) await this.paymentPage(row, row.ethereumReferences, at);
      if (snapshot.deposit.status === 3) await this.queue(row, { type: 'refund', id: row.id, reason: 'ethereum_refund', references: row.ethereumReferences });
    }
  }
}
