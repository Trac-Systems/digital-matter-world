import { Mints, publicMint, verifyPayer } from './mints.mjs';
import { rules } from './rules.mjs';
import { check, hash } from './util.mjs';
import { mintFeeScope } from './fees.mjs';
import { financialAsset, financialMintId, verifyFinancialMintRequest } from '../../rules/src/financial-mint.js';
import { financialFees } from './financial-sources.mjs';
import { AccountAvailability } from './account-availability.mjs';
import { accountKey, EMPTY_ACCOUNT_ROOT } from '../../contract/account-tree.js';
import { releaseCalldata } from './ethereum.mjs';
import { buildFinancialExecution } from './financial-execution.mjs';
import { financialBlock } from './financial-status.mjs';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { surplusCreditId } from '../../contract/payment-pages.js';
import { deploymentAssetId, mintAssetDefinition } from './mint-assets.mjs';
import { PublicMints } from './public-mints.mjs';
import { KeyedWork, parallelPage } from './keyed-work.mjs';

const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const ownerSpace = owner => 'financialMintOwner/' + owner;

// Ordinary mint HTTP methods use this implementation after v2 activation.
// The player separately signs the exact account reservation returned by the
// first request. Every retry retains the original request and fee quote.
const QUOTE_REUSE_MS = 30000, QUOTE_REUSE_LIMIT = 256, QUOTE_SLOW_MS = 1500;
export class FinancialMints extends Mints {
  constructor(options) { super(options); this.financial = options.financial; this.document = options.document; this.pendingBlocks = this.document.values.pendingBlocks;
    this.publicMints = new PublicMints(this); this.mintWork = new KeyedWork(); this.deploymentWork = new KeyedWork(); }
  async deploymentTick() {
    if (this.deploymentRunning || !this.reads.financialDeployment) return;
    this.deploymentRunning = true;
    try {
      // Warm registered deployments even before the first quote. Durable jobs
      // also cover assets requested between catalog passes.
      const registry = await this.reads.registry?.(), after = this.deploymentCursor ?? '';
      const page = registry?.page ? registry.page('assets', { after, limit: 8 }) :
        Object.entries(registry?.assets ?? {}).filter(([id]) => id > after).sort(([a], [b]) => a.localeCompare(b)).slice(0, 8).map(([id, value]) => ({ id, value }));
      this.deploymentCursor = page.length === 8 ? page.at(-1).id : '';
      const jobs = this.store.list('financialDeploymentJobs', { after: this.deploymentJobCursor ?? '', limit: 8 });
      this.deploymentJobCursor = jobs.length === 8 ? jobs.at(-1).id : '';
      const assets = new Set([...page.filter(r => !r.value.suspended).map(r => r.id), ...jobs.map(r => r.id)]);
      await parallelPage([...assets], asset => this.deploymentWork.run(asset, async () => {
        const job = this.store.get('financialDeploymentJobs', asset);
        if ((job?.nextRetry ?? 0) > Date.now()) return;
        try {
          const generation = await this.reads.financialDeployment(asset, await this.reads.batchStamp());
          if (!generation.existing) await this.financial.submit({ type: 'lifecycle', id: generation.id, action: generation.action });
          await this.store.put('financialDeploymentJobs', asset, { nextRetry: Date.now() + 30000 });
        } catch (error) {
          await this.store.put('financialDeploymentJobs', asset, { nextRetry: Date.now() + 30000,
            reason: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_deployment_unavailable' });
        }
      }, { join: true }));
    } finally { this.deploymentRunning = false; }
  }
  // A read quote can outlast the HTTP response budget. Identical retries share the running quote and, for a short
  // time, its result, so a client retrying within the budget receives the answer instead of starting over.
  quote(input) {
    if (input.request) return this.request(input);
    this.quotes ??= new Map();
    const key = rules.stableJSON([rules.hashObject(this.document), input]), now = Date.now();
    for (const [k, q] of this.quotes) if (q.settled && now - q.settled > QUOTE_REUSE_MS) this.quotes.delete(k);
    const known = this.quotes.get(key);
    if (known) return known.promise;
    const entry = { settled: 0 }, started = now;
    // Only a quote that outlived the response budget left its caller waiting for a retry; others are never reused.
    entry.promise = this.quoteOnce(input).finally(() => {
      entry.settled = Date.now();
      if (entry.settled - started < QUOTE_SLOW_MS && this.quotes.get(key) === entry) this.quotes.delete(key);
    });
    entry.promise.catch(() => this.quotes.get(key) === entry && this.quotes.delete(key));
    this.quotes.set(key, entry);
    if (this.quotes.size > QUOTE_REUSE_LIMIT) this.quotes.delete(this.quotes.keys().next().value);
    return entry.promise;
  }
  async quoteOnce(input) {
    if (!input.feeQuote) check(!this.financial.admissionReady || await this.financial.admissionReady(), 'financial_admission_fenced', 503);
    check(financialAsset(input.asset), 'quote_input');
    const provisionable = deploymentAssetId(input.asset);
    const needed = provisionable && await super.deploymentNeeded(input.asset, { block: input.block, amount: input.amount, kind: input.kind ?? 'tap', receiver: input.receiver });
    if (needed) return { ...needed, financialVersion: 2 };
    const resolved = this.provisioner && provisionable ? await mintAssetDefinition(this.store, input.asset) : null;
    if (resolved) input = { ...input, asset: resolved.asset };
    if (this.reads.financialDeployment) {
      const generation = await this.reads.financialDeploymentState?.(input.asset, await this.reads.batchStamp());
      if (!generation?.existing) {
        if (!this.store.get('financialDeploymentJobs', input.asset)) await this.store.put('financialDeploymentJobs', input.asset, { nextRetry: 0 });
        return { requestId: null, asset: input.asset, state: 'deployment_pending', financialVersion: 2, payable: false,
          reservation: 'none', fees: [], missing: [], blocked: ['financial_deployment_pending'],
          message: 'The Bitcoin deployment is registered. Wait for its financial registration, then quote again.' };
      }
    }
    const quote = await super.quote(input);
    if (this.reads.identifyFinancialFees) quote.fees = this.reads.identifyFinancialFees(quote.fees, input.kind ?? 'tap', quote.custody);
    return { ...quote, ...(resolved ? { catalogAsset: resolved.catalogAsset } : {}), financialVersion: 2, settingsHash: quote.feeQuote.settingsHash ?? rules.hashObject(this.document) };
  }
  async deploymentNeeded() { return null; }
  public(id, requesterSecret) {
    const row = this.store.get('mints', id); check(row, 'request_not_found', 404);
    if (row.publicMint) return this.publicMints.public(id, requesterSecret);
    const funding = this.store.get('accountRecords', 'fp/' + id), obligation = this.store.get('accountRecords', 'ao/' + id);
    const capacity = this.store.get('accountRecords', 'dc/' + id), external = funding?.capacity;
    const blocked = financialBlock(this.store, ['fp/' + id, 'ao/' + id, 'dc/' + id, 'fp/usage',
      ...(capacity ? ['fd/' + capacity.deployment] : []), ...(external ? [capacityKey(external.deployment),
        'fi/deployment/' + external.deployment, ...(external.block === null ? [] : [plotKey(external.asset, external.block)])] : [])]);
    const status = { ...publicMint(row), financialVersion: 2, state: row.state,
      payable: !blocked && !!funding && funding.state === 'open' && !row.permit, blocked: blocked ? [blocked] : [],
      // The reported, not yet confirmed mint inscription: every page hides a second inscribe.
      ...(row.mintInscription && row.state !== 'minted' ? { sentInscription: row.mintInscription } : {}),
      reservation: obligation?.state ?? 'pending', funding: funding ? { state: funding.state, paid: funding.paid, sequence: funding.sequence, root: funding.root } : null,
      ...(row.work ? { transition: { id: row.work, state: this.store.get('financialAccepted', row.work)?.state ?? 'queued',
        reason: this.store.get('financialDeferred', row.work)?.reason ?? null } } : {}) };
    return this.mintSender?.decorate(row, status) ?? status;
  }
  // Background ticks advance the same request; the player's (identical) request waits for them.
  request(body) { return this.mintWork.run(financialMintId(this.network, body.request), async () => {
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
      if (quote.deploymentNeeded || quote.state === 'deployment_pending') return quote;
      check(quote.asset === r.asset, 'mint_asset_use_ledger');
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
      await this.gate(() => {
        check(this.store.count('financialActiveMints') < this.resources.activeMints && this.store.count(ownerSpace(r.owner)) < this.resources.mintsPerAgent, 'mint_capacity', 503);
        return this.store.transact([{ space: 'mints', id, value: row }, { space: 'financialActiveMints', id, value: true }, { space: ownerSpace(r.owner), id, value: true }]);
      });
    }
    if (!body.reserve) return { ...this.public(id), reservationAction: row.reservationAction, reservationEvidence: row.reservationEvidence };
    const { sig, ...unsigned } = body.reserve;
    check(same(unsigned, row.reservationAction), 'financial_reservation_changed');
    const transition = { type: 'reserve', id, action: body.reserve, fees: financialFees(row.quote.fees) };
    const admitted = await this.financial.admit(transition, await this.reads.batchStamp());
    await this.store.put('mints', id, { ...row, state: 'reserving', work: admitted.id });
    return this.public(id);
  }, { after: true }); }
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
  payment({ id, requestId, paymentId, paymentIds = [], inscription }, requesterSecret) { return this.mintWork.run(id ?? requestId, async () => {
    id ??= requestId; const row = this.store.get('mints', id); check(row, 'request_not_found', 404);
    if (row.publicMint) return this.publicMints.payment({ id, paymentId, paymentIds, inscription }, requesterSecret);
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
  refund({ id, requestId, references = [], reason = 'credit' }) { return this.mintWork.run(id ?? requestId, async () => {
    id ??= requestId; const row = this.store.get('mints', id); check(row, 'request_not_found', 404);
    const transition = { type: 'refund', id, reason, ...(references.length ? { references } : {}) };
    await this.reads.financialEvidence(transition, await this.reads.batchStamp());
    await this.queue(row, transition); return this.public(id);
  }); }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      await this.publicMints.tick();
      for (const space of ['financialActiveMints', 'financialIssuedMints']) {
        this.financialCursors ??= {}; const page = this.store.list(space, { after: this.financialCursors[space] ?? '', limit: this.resources.workPage });
        this.financialCursors[space] = page.length === this.resources.workPage ? page.at(-1).id : '';
        await parallelPage(page, async ({ id }) => {
          if (this.mintWork.pending.has(id)) return;
          // A request waiting for its owner's signed reservation has nothing to
          // advance; check only its expiry, once a minute, so the owner's next
          // step is not refused while the key is held.
          const waiting = this.store.get('mints', id);
          if (waiting?.state === 'authorizing' && !waiting.work) {
            this.authorizingChecks ??= new Map();
            if (Date.now() - (this.authorizingChecks.get(id) ?? 0) < 60000) return;
            this.authorizingChecks.set(id, Date.now());
          }
          return this.mintWork.run(id, async () => {
          try { await this.advance(this.store.get('mints', id)); }
          catch (error) { const row = this.store.get('mints', id); await this.store.put('mints', id, { ...row, lastError: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_source_unavailable' }); }
          });
        });
      }
      const credits = this.store.list('financialLegacyCredits', { after: this.legacyCreditCursor ?? '', limit: this.resources.workPage });
      this.legacyCreditCursor = credits.length === this.resources.workPage ? credits.at(-1).id : '';
      await parallelPage(credits, async ({ id }) => {
        if (this.mintWork.pending.has(id)) return;
        return this.mintWork.run(id, async () => {
        try { await this.advanceLegacyCredit(id); }
        catch (error) { await this.store.put('financialLegacyCreditFailures', id, { reason: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'financial_source_unavailable' }); }
        });
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
