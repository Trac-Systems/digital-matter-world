import { check } from './util.mjs';
import { assetResources } from './asset-resources.mjs';
import { rules } from './rules.mjs';
import { bulkSchema, bulkFeeScope, bulkFeeManifest, bulkFinancialKeys, verifyBulkRequest, checkBulkRecoveryBytes } from './bulk-mint-sources.mjs';
import { currentFee } from './fees.mjs';
import { bulkOwnerSpace } from './bulk-mint-admission.mjs';
import { financialGenerationId } from './financial-capacity-sources.mjs';
import { capacityKey, plotKey } from '../../contract/financial-capacity.js';
import { financialBlock } from './financial-status.mjs';
import { KeyedWork, parallelPage } from './keyed-work.mjs';
import { AccountAvailability } from './account-availability.mjs';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { timeReads, timeStep, addStep } from './read-timing.mjs';
import { directHolderTerms, bulkHolderHash, sideWalletItem } from './direct-deployer.mjs';
const same = (a, b) => rules.stableJSON(a) === rules.stableJSON(b);
const bits = (mask, count) => Array.from({ length: count }, (_, i) => !!(BigInt(mask ?? '0') & 1n << BigInt(i)));
const size = value => Buffer.byteLength(rules.stableJSON(value));
// Payment is offered for pendingBlocks; the order stays reserved bulkLateBlocks
// longer so a payment sent in time still confirms within the order's own expiry.
export const bulkLifetime = (values, resources) => Math.min(values.pendingBlocks + resources.bulkLateBlocks,
  values.requestMaxBlocks, values.quoteLifetimeTips);
const paymentUntil = (t, values) => {
  const end = BigInt(t.feeQuote.validFrom) + BigInt(values.pendingBlocks);
  return end < BigInt(t.expires) ? end : BigInt(t.expires);
};
const reasonOf = error => /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'bulk_source_unavailable';
// Batch/TAP plus gateway authority/policy: raw revisions also move on unrelated appends.
const sameBatch = (x, y) => ['counted', 'tip', 'tipHash', 'last', 'tap', 'batchRoot', 'authority', 'admissionPolicy'].every(k => same(x?.[k] ?? null, y?.[k] ?? null));
const preview = (reads, task) => reads.withGatewayFinancialPreview ? reads.withGatewayFinancialPreview(task) : task();
const changedSnapshot = error => ['financial_snapshot_changed', 'read_snapshot_changed', 'trac_snapshot_changed', 'tap_snapshot_changed'].includes(error.message);
export const bulkEvidenceProjection = row => ({ id: row.id, request: row.body.terms, signature: row.body.reserve.sig,
  receiver: row.body.terms.receiver, payer: row.body.terms.payer, kind: 'bulk-v1',
  context: { kind: 'bulk-v1' }, feeAuthorization: row.feeAuthorization });

export class BulkMints {
  constructor(options) {
    Object.assign(this, options); this.resources = assetResources(options.resources);
    this.work = new KeyedWork(); this.ceremonies = new KeyedWork({ concurrency: 4, capacity: 256 });
    this.quoteWork = new KeyedWork({ concurrency: Math.min(4, this.resources.workPage), capacity: this.resources.workPage });
    this.quoteResults = new Map();
  }
  row(id) { check(rules.hex(id, 32), 'bulk_order_id'); const row = this.store.get('bulkOrders', id); check(row, 'bulk_not_found', 404); return row; }
  async ingress() {
    check(this.resources.bulkMintEnabled, 'bulk_disabled', 503);
    check(!this.financial.admissionReady || await this.financial.admissionReady(), 'financial_admission_fenced', 503);
    check(this.reads.bulkCandidates && this.senderView?.bulkFunding && this.senderView.ready(), 'bulk_sender_unavailable', 503);
  }
  quoteSnapshot(input, at) {
    const plots = {};
    // Provenance resolves the supply scope during the scan. Capture both
    // possible namespaces up front, bounded by the validated member limit.
    for (const block of input.blocks) for (const scope of [null, input.deployment]) {
      const key = plotKey(input.asset, block, scope);
      plots[key] = this.store.get('financialAdmissionPlot', key);
    }
    return { source: Object.fromEntries(['counted', 'tip', 'tipHash', 'last', 'tap', 'batchRoot', 'authority', 'admissionPolicy'].map(k => [k, at?.[k] ?? null])), accepted: this.financial.acceptedRevision, settings: rules.hashObject(this.document),
      admission: { held: this.store.get('financialAdmissionHeld', input.owner + '/' + input.asset) ?? '0',
        capacity: this.store.get('financialAdmissionCapacity', capacityKey(input.deployment)) ?? '0', plots } };
  }
  async quote(input) {
    const b = await bulkSchema(); b.validateBulkQuoteInput(input);
    const key = rules.hashObject(input);
    const result = await this.quoteWork.run(key, () => preview(this.reads, async () => {
      const timing = { blocks: input.blocks.length, attempts: 0, cached: false, attemptReasons: [] };
      return timeReads('bulk_quote_timing', timing, async () => {
        for (;;) {
          timing.attempts++;
          const attempt = {}; timing.attemptReasons.push(attempt);
          try {
            await timeStep('admission', this.ingress());
            const at = await timeStep('snapshot', this.reads.batchStamp()), document = this.document;
            const snapshot = this.quoteSnapshot(input, at), fingerprint = rules.hashObject(snapshot);
            timing.fingerprint = attempt.fingerprint = fingerprint;
            const saved = this.quoteResults.get(key);
            if (saved && saved.fingerprint === fingerprint && saved.document === document &&
                saved.result.terms.feeQuote.expiresAt > Date.now()) { timing.cached = true; attempt.reason = 'cached'; return saved.result; }
            this.quoteResults.delete(key);
            const result = await this.buildQuote(input, { at, document, admission: snapshot.admission });
            // A changed source or local admission is rechecked before returning
            // anything signable. Unrelated pending work changes no quote inputs;
            // accepted roots remain fenced by acceptedRevision and the stamp.
            const after = this.quoteSnapshot(input, await timeStep('snapshot', this.reads.batchStamp()));
            attempt.afterFingerprint = rules.hashObject(after);
            attempt.changed = Object.keys(snapshot).filter(key => !same(snapshot[key], after[key]));
            check(fingerprint === attempt.afterFingerprint && document === this.document, 'financial_snapshot_changed', 503);
            // HTTP deadlines do not cancel work. Identical retries join this job
            // and retrieve its completed result while every stamp is still current.
            if (result.terms) {
              this.quoteResults.set(key, { fingerprint, document, result });
              while (this.quoteResults.size > this.resources.workPage) this.quoteResults.delete(this.quoteResults.keys().next().value);
            }
            attempt.reason = 'ok'; return result;
          } catch (error) {
            attempt.reason = reasonOf(error);
            // Which fence refused: file:line frames only, no values.
            attempt.where = String(error.stack ?? '').split('\n').slice(1, 5).map(l => (l.match(/([a-z-]+\.m?js:\d+)/) ?? [])[1]).filter(Boolean);
            if (changedSnapshot(error) && timing.attempts < this.resources.bulkQuoteAttempts) continue;
            timing.reason = reasonOf(error); throw error;
          }
        }
      }, { always: true });
    }), { join: true });
    return structuredClone(result);
  }
  async buildQuote(input, { at, document, admission }) {
    const b = await bulkSchema(); b.validateBulkQuoteInput(input);
    b.bulkAddress(input.receiver, this.bitcoinNetwork); b.bulkAddress(input.payer, this.bitcoinNetwork);
    const orderId = b.bulkOrderId(this.network, input.owner, input.nonce);
    const { contexts, skipped } = await timeStep('candidates', this.reads.bulkCandidates(input, at, { policy: document }));
    const capacityStarted = Date.now();
    const policy = currentFee(await this.reads.registry()), eligible = [], deferred = [];
    const head = this.store.get('accountRecords', 'ar/' + input.owner), key = accountKey('balance', input.asset);
    const balance = head ? readAccountLeaf(head.root, new AccountAvailability(this.store).prove(head.root, [key]), key) : null;
    // Use the captured values throughout the attempt, including across awaits.
    // A value changing away and back cannot leave mixed admission evidence.
    const available = BigInt(balance?.available ?? '0') - BigInt(admission.held);
    let total = 0n, capacity, registered;
    for (const c of contexts) {
      const block = rules.decimalV2(c.find.block), amount = BigInt(c.find.count), d = c.deployment;
      if (admission.plots[plotKey(input.asset, block, rules.tickerSupplyScope(d, at.counted))]) {
        skipped.push({ block, reason: 'block_pending' }); continue;
      }
      capacity ??= BigInt(d.remaining) - BigInt(await this.reads.financialRecord(capacityKey(d.id), at) ?? '0') -
        BigInt(await this.reads.financialRecord('fi/deployment/' + d.id, at) ?? '0') - BigInt(admission.capacity);
      registered ??= await this.reads.financialRecord('fd/' + financialGenerationId(this.network, input.asset, d.id), at);
      check(registered?.deployment === d.id, 'bulk_deployment_unavailable', 503);
      const internal = BigInt(registered.maximum) - BigInt(registered.reserved) - BigInt(registered.minted) -
        BigInt(admission.capacity);
      if (internal < capacity) capacity = internal;
      if (total + amount > capacity || total + amount > available) { skipped.push({ block, reason: 'insufficient_units' }); continue; }
      total += amount; eligible.push(c);
    }
    addStep('capacity', Date.now() - capacityStarted);
    const anchor = { counted: rules.decimalV2(at.counted), tipHash: at.tipHash, lastBatch: rules.decimalV2(at.last?.n ?? at.last ?? '0') };
    const output = { v: 1, orderId: null, quoteId: null, terms: null, feeManifest: [], skipped,
      deferred, anchor, limits: { members: b.BULK_LIMITS.members, groups: b.BULK_LIMITS.groups, setAsideSats: b.BULK_LIMITS.setAsideSats }, payable: false };
    let selected = null;
    const holderFees = eligible.length ? await directHolderTerms(this.reads, eligible[0].deployment, document, { at, bitcoinNetwork: this.bitcoinNetwork }) : null;
    // Size the complete signed wrapper before returning anything signable.
    // Reducing a prefix here never changes a submitted signed set.
    for (let count = eligible.length; count > 0; count--) {
      const part = eligible.slice(0, count), d = part[0].deployment;
      const members = part.map(c => ({ block: rules.decimalV2(c.find.block), amount: String(c.find.count) }));
      const plan = bulkFeeManifest(this.reads, part, { payer: input.payer, bitcoinNetwork: this.bitcoinNetwork,
        document, policy, height: at.counted, orderId, holderFees });
      check(plan.payableFeeAtoms !== '0', 'bulk_zero_payable', 422);
      const generation = financialGenerationId(this.network, input.asset, d.id);
      check(registered?.deployment === d.id, 'bulk_deployment_unavailable', 503);
      const funding = await timeStep('funding', this.senderView.bulkFunding({ orderId, network: this.network, bitcoinNetwork: this.bitcoinNetwork,
        members, deployment: d, receiver: input.receiver, payer: input.payer, settings: this.senderView.settings }));
      if (!funding.fits || funding.maxMembers < count) {
        deferred.unshift({ block: members.at(-1).block, reason: 'bulk_funding_limit' }); continue;
      }
      const membersRoot = b.bulkMembersRoot(members);
      const ownership = part.map(c => rules.hashObject({ bitmap: c.holder, link: c.link ?? null, ...(c.assetRevision ? { assetRevision: c.assetRevision } : {}) }));
      const feeQuote = await timeStep('feeQuote', this.reads.feeQuotes.issue(bulkFeeScope({ ...input, membersRoot }), at.counted, undefined, input.deployment,
        bulkHolderHash(ownership, holderFees)));
      check(feeQuote.baseFee === policy.baseFee && same(feeQuote.feeSettings, policy.feeSettings ?? rules.FEE_DEFAULTS) &&
        feeQuote.settingsHash === rules.hashObject(document), 'bulk_quote_changed', 409);
      const terms = { v: 1, network: this.network, bitcoinNetwork: this.bitcoinNetwork, owner: input.owner, nonce: input.nonce,
        asset: input.asset, deployment: input.deployment, generation, ticker: d.tick, supplyScope: rules.tickerSupplyScope(d, at.counted) || null,
        receiver: input.receiver, payer: input.payer, members, membersRoot, feeRoot: b.bulkFeeRoot(plan.feeManifest), groups: plan.groups,
        custody: plan.custody, totalAmount: members.reduce((n, m) => n + BigInt(m.amount), 0n).toString(),
        grossFeeAtoms: plan.grossFeeAtoms, payableFeeAtoms: plan.payableFeeAtoms, settingsHash: rules.hashObject(document), feeQuote,
        until: (BigInt(at.counted) + BigInt(Math.min(document.values.moveFreshnessTips, document.values.pendingBlocks - 1))).toString(),
        expires: (BigInt(at.counted) + BigInt(bulkLifetime(document.values, this.resources))).toString(), mintFunding: funding.mintFunding,
        terminalPolicy: 'hold-issued-credit-unissued-v1' };
      try {
        b.validateBulkFees(terms, plan.feeManifest);
        checkBulkRecoveryBytes(b, terms, plan.feeManifest);
        const reserve = { ...b.bulkReserveAction(terms), sig: '0'.repeat(128) };
        b.bulkBytes({ version: 1, terms, feeManifest: plan.feeManifest, reserve }, b.BULK_LIMITS.requestBytes);
        b.bulkBytes({ type: 'reserve-many', id: orderId, action: reserve, terms }, b.BULK_LIMITS.transitionBytes);
        b.bulkBytes({ ...output, orderId, quoteId: rules.hashObject(terms), terms, feeManifest: plan.feeManifest,
          ...(plan.deployerPayment ? { deployerPayment: plan.deployerPayment } : {}) }, b.BULK_LIMITS.quoteBytes);
        if (plan.deployerPayment) b.bulkBytes({ p: 'tap', op: 'token-auth', redeem: { auth: '0'.repeat(64) + 'i4294967295',
          items: [...b.bulkWalletItems(terms), sideWalletItem(plan.deployerPayment)] } }, b.BULK_LIMITS.redeemBytes);
      } catch (error) {
        if (!['bulk_byte_limit', 'bulk_mint_payload_bytes', 'bulk_groups', 'bulk_fee_conservation', 'bulk_custody'].includes(error.message)) throw error;
        deferred.unshift({ block: members.at(-1).block, reason: 'bulk_byte_limit' }); continue;
      }
      selected = { terms, feeManifest: plan.feeManifest, ...(plan.deployerPayment ? { deployerPayment: plan.deployerPayment } : {}) }; break;
    }
    if (selected) Object.assign(output, selected, { orderId, quoteId: rules.hashObject(selected.terms) });
    else if (eligible.length && deferred.some(d => d.reason === 'bulk_funding_limit')) check(false, 'bulk_funding_limit', 422);
    return output;
  }
  async existingRequest(body) {
    const b = await bulkSchema(), t = body?.terms;
    if (!t) return null;
    const row = this.store.get('bulkOrders', b.bulkOrderId(this.network, t.owner, t.nonce));
    if (row) check(same(row.body, body), 'bulk_request_conflict', 409);
    const transition = row && { type: 'reserve-many', id: row.id, action: row.body.reserve, terms: row.body.terms };
    return row && (row.work || this.financial.existing(rules.hashObject(['dmw-financial-transition-v2', transition]))) ? row : null;
  }
  async request(body) {
    if (body?.version === 1 && body.terms === null) check(false, 'bulk_no_eligible_members', 422);
    await this.existingRequest(body);
    const id = await verifyBulkRequest(body, this.network, this.bitcoinNetwork);
    return this.work.run(id, () => preview(this.reads, async () => {
      let row = this.store.get('bulkOrders', id);
      if (row) { check(same(row.body, body), 'bulk_request_conflict', 409); if (row.work || this.store.get('accountRecords', 'fp/' + id)) return this.status(id); }
      const transition = { type: 'reserve-many', id, action: body.reserve, terms: body.terms };
      const pending = this.financial.existing(rules.hashObject(['dmw-financial-transition-v2', transition]));
      if (row && pending) { await this.store.put('bulkOrders', id, { ...row, work: pending.id }); return this.status(id); }
      await this.ingress();
      const at = await this.reads.batchStamp(), t = body.terms;
      check(BigInt(at.counted) <= BigInt(t.until) && rules.hashObject(this.document) === t.settingsHash, 'bulk_request_expired', 409);
      check(this.senderView.address(id) === t.mintFunding.address, 'bulk_funding_address', 409);
      if (!row) {
        const feeAuthorization = await this.reads.feeQuotes.accept(t.feeQuote, bulkFeeScope(t), id, t.expires, at.counted);
        row = { id, body: structuredClone(body), feeAuthorization, created: rules.decimalV2(at.counted), state: 'reserving', references: [] };
        await this.store.transact([{ space: 'bulkOrders', id, value: row }, { space: 'mints', id, value: bulkEvidenceProjection(row) }]);
      }
      const admitted = await this.financial.admit(transition, at);
      await this.store.put('bulkOrders', id, { ...row, work: admitted.id });
      return this.status(id);
    }), { after: true });
  }
  async queue(row, transition, at) {
    // Hints alone are never queued for consensus. Every transition is rebuilt
    // independently once here and again in the batch and each signer.
    const current = this.row(row.id), key = rules.hashObject(['dmw-financial-transition-v2', transition]);
    check(!current.work || current.work === key || this.store.get('financialAccepted', current.work), 'bulk_transition_pending', 503);
    await this.reads.bulkEvidence(transition, at);
    const result = await this.financial.submit(transition);
    await this.store.put('bulkOrders', row.id, { ...this.row(row.id), work: result.id });
    return result;
  }
  async payment(report) {
    const b = await bulkSchema();
    check(rules.exactKeys(report, ['orderId', 'paymentId', 'commitTxid', 'revealTxid']) && rules.hex(report.orderId, 32) &&
      (report.paymentId === null || b.bulkInscription(report.paymentId)) && [report.commitTxid, report.revealTxid].every(v => v === null || rules.hex(v, 32)) &&
      [report.paymentId, report.commitTxid, report.revealTxid].some(Boolean), 'bulk_payment_report');
    return this.work.run(report.orderId, async () => {
      const row = this.row(report.orderId), at = await this.reads.batchStamp();
      let references = report.paymentId ? [report.paymentId] : [];
      if (!references.length && this.reads.bulkResolvePayment) references = await this.reads.bulkResolvePayment(report, row.body.terms, at);
      // Keep unverified hints separately: an unauthenticated report must not
      // hide Pay or become the primary receipt before independent verification.
      const pending = [...new Set([...(this.row(row.id).discoveryPending ?? []), ...references])];
      check(pending.length + (row.references?.length ?? 0) <= b.BULK_LIMITS.members, 'bulk_payment_hint_limit', 413);
      if (references.length) await this.store.put('bulkOrders', row.id, { ...this.row(row.id), discoveryPending: pending });
      await this.advance(row.id, at);
      return this.status(row.id);
    }, { after: true });
  }
  async finishedReport(report) {
    const row = this.row(report?.orderId), b = await bulkSchema(); b.bulkIndices(report.members, row.body.terms.members.length, true);
    const mask = bits(this.store.get('accountRecords', 'fp/' + row.id)?.finishedMask, row.body.terms.members.length);
    return report.members.every(m => mask[m.index]);
  }
  async finish(report) {
    check(rules.exactKeys(report, ['orderId', 'members']), 'bulk_finish_report');
    return this.work.run(report.orderId, async () => {
      const row = this.row(report.orderId), b = await bulkSchema(), t = row.body.terms;
      b.bulkIndices(report.members, t.members.length, true);
      const mask = bits(this.store.get('accountRecords', 'fp/' + row.id)?.finishedMask, t.members.length);
      const members = report.members.filter(m => !mask[m.index]);
      for (const m of report.members.filter(m => mask[m.index])) check(this.store.get('accountRecords', 'dc/' + b.bulkMemberId(row.id, m.index))?.inscription === m.inscription, 'bulk_finish_conflict', 409);
      if (members.length) {
        const at = await this.reads.batchStamp();
        await this.queue(row, { type: 'bulk-finish', id: row.id, members }, at);
      }
      return this.status(row.id);
    }, { after: true });
  }
  async advance(id, at) {
    let row = this.row(id), funding = this.store.get('accountRecords', 'fp/' + id);
    if (row.work && !this.store.get('financialAccepted', row.work)) {
      if (!await this.financial.expire(row.work, at)) return;
      if (!funding) {
        await this.store.transact([{ space: 'activeBulkOrders', id }, { space: bulkOwnerSpace(row.body.terms.owner), id },
          { space: 'bulkSenderOrders', id }, { space: 'bulkOrders', id, value: { ...row, state: 'expired' } }]);
        return;
      }
      row = { ...row, work: null }; await this.store.put('bulkOrders', id, row);
    }
    if (!funding) return;
    const b = await bulkSchema(), t = funding.manifest;
    // Release unpaid members before any optional payment discovery can fail.
    if (BigInt(funding.issuedMask) === 0n && BigInt(at.counted) > BigInt(t.expires) && funding.state !== 'bulk-released') {
      const members = bits(funding.releasedMask, t.members.length).flatMap((released, i) => released ? [] : [i]).slice(0, b.BULK_LIMITS.terminalPage);
      if (members.length) await this.queue(row, { type: 'bulk-release', id, members, reason: 'expired' }, at);
      return;
    }
    // Bounded background discovery is independent of an open browser page.
    if (this.reads.bulkDiscoverPayments || row.discoveryPending?.length) {
      const found = await this.reads.bulkDiscoverPayments?.(id, t, { after: row.discoveryCursor ?? 0, epoch: row.discoveryEpoch }) ??
        { references: [], next: row.discoveryCursor ?? 0, epoch: row.discoveryEpoch };
      const verified = [], pending = [];
      for (const reference of new Set([...(row.discoveryPending ?? []), ...found.references])) {
        if (this.store.get('accountRecords', 'fp/bulk-receipt/' + b.bulkReceiptKey(this.bitcoinNetwork, reference))) continue;
        try { await this.reads.bulkReceipt(id, reference, at); verified.push(reference); }
        catch (error) {
          if (error.message === 'bulk_payment_unknown') pending.push(reference);
          else if (!['bulk_payment_items', 'bulk_payment_binding'].includes(error.message)) throw error;
        }
      }
      const references = [...new Set([...(row.references ?? []), ...verified])].filter(reference =>
        !this.store.get('accountRecords', 'fp/bulk-receipt/' + b.bulkReceiptKey(this.bitcoinNetwork, reference)));
      check(references.length + pending.length <= b.BULK_LIMITS.members, 'bulk_payment_hint_limit', 413);
      row = { ...row, references, discoveryPending: pending, discoveryCursor: found.next, discoveryEpoch: found.epoch ?? null }; await this.store.put('bulkOrders', id, row);
    }
    for (const reference of row.references ?? []) {
      if (reference === funding.reference || this.store.get('accountRecords', 'fp/bulk-receipt/' + b.bulkReceiptKey(this.bitcoinNetwork, reference))) continue;
      let receipt;
      try { receipt = await this.reads.bulkReceipt(id, reference, at); }
      catch (error) {
        if (['bulk_payment_unknown', 'bulk_source_unavailable'].includes(error.message)) continue;
        if (['bulk_payment_items', 'bulk_payment_binding'].includes(error.message)) {
          row = { ...row, references: row.references.filter(r => r !== reference) }; await this.store.put('bulkOrders', id, row); continue;
        }
        throw error;
      }
      const primary = !funding.reference && funding.state === 'bulk-open' && BigInt(at.counted) <= BigInt(t.expires) &&
        BigInt(receipt.block.height) >= BigInt(funding.created) && BigInt(receipt.block.height) <= BigInt(t.expires);
      if (primary && receipt.deployerPaid === false) {
        await this.store.put('bulkOrders', id, { ...row, deployerUnpaid: true }); return;
      }
      await this.queue(row, { type: primary ? 'bulk-fund' : 'bulk-credit', id, reference }, at); return;
    }
    if (funding.state === 'bulk-consumed') {
      const plans = b.bulkPermitPlans(t, funding.receiptRoot);
      await parallelPage(plans.plans, plan => this.ceremonies.run(plan.memberId, async () => {
        if (this.store.get('bulkPermits/' + id, String(plan.index))) return;
        const verified = await this.reads.bulkPermit(id, plan.index, at);
        const signed = await this.committee.signature('mint/' + plan.memberId,
          { network: this.network, kind: 'mint', version: 'bulk-v1', orderId: id, index: plan.index });
        if (!signed) return;
        const payload = signed.payload, { prv, ...unsigned } = payload ?? {};
        check(same(unsigned, plan.payload) && same(verified.permit, plan) && prv?.hash === plan.digest && prv.address === t.receiver && prv.salt === plan.salt, 'bulk_permit_binding');
        check(sameBatch(at, await this.reads.batchStamp()), 'financial_snapshot_changed', 503);
        await this.store.put('bulkPermits/' + id, String(plan.index), { index: plan.index, memberId: plan.memberId,
          block: t.members[plan.index].block, amount: t.members[plan.index].amount, permitHash: plan.digest, mintContent: payload });
      }, { join: true }), 4);
      if (this.reads.bulkMintMatches && this.store.count('bulkPermits/' + id) === t.members.length &&
          Date.now() >= (row.nextMintDiscovery ?? 0)) {
        const finished = bits(funding.finishedMask, t.members.length);
        const expected = plans.plans.filter(p => !finished[p.index]).map(p => ({ index: p.index, ...t.members[p.index], dta: p.payload.dta, permitHash: p.digest }));
        if (expected.length) {
          const candidates = await this.reads.withBulkSnapshot(at, view => this.reads.bulkMintMatches({ receiver: t.receiver, ticker: 'dmt-' + t.ticker, expected, view }));
          const unique = new Map();
          for (const m of candidates) {
            check(!unique.has(m.index) || unique.get(m.index).inscription === m.inscription, 'bulk_mint_ambiguous', 409);
            unique.set(m.index, { index: m.index, inscription: m.inscription });
          }
          const members = [...unique.values()].sort((a, z) => a.index - z.index).slice(0, b.BULK_LIMITS.terminalPage);
          if (members.length) await this.queue(row, { type: 'bulk-finish', id, members }, at);
        }
        await this.store.put('bulkOrders', id, { ...this.row(id), nextMintDiscovery: Date.now() + 30000 });
      }
      return;
    }
    if (funding.state === 'bulk-funded') await this.queue(row, { type: 'bulk-consume', id,
      permitRoot: b.bulkPermitPlans(t, funding.receiptRoot).permitRoot }, at);
  }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      for (const space of ['activeBulkOrders', 'bulkPaymentRecovery']) {
        const after = this.store.get('bulkCursors', space) ?? '';
        let page = this.store.list(space, { after, limit: this.resources.workPage });
        if (!page.length && after) page = this.store.list(space, { limit: this.resources.workPage });
        await parallelPage(page, ({ id }) => this.work.run(id, async () => {
          try { await this.advance(id, await this.reads.batchStamp()); await this.store.put('bulkFailures', id, null); }
          catch (error) { await this.store.put('bulkFailures', id, { reason: reasonOf(error) }); }
        }, { join: true }), 4);
        await this.store.put('bulkCursors', space, page.at(-1)?.id ?? '');
      }
    } finally { this.running = false; }
  }
  async status(id) {
    const row = this.row(id), t = row.body.terms, funding = this.store.get('accountRecords', 'fp/' + id);
    const count = t.members.length, issued = bits(funding?.issuedMask, count), finished = bits(funding?.finishedMask, count), released = bits(funding?.releasedMask, count);
    const sum = values => values.filter(Boolean).length, readyCount = this.store.count('bulkPermits/' + id);
    const b = await bulkSchema(), block = financialBlock(this.store, bulkFinancialKeys(id, t, b, funding, row.creditReferences));
    const failure = this.store.get('bulkFailures', id)?.reason ?? null;
    const sender = this.senderView?.bulkStatus?.(id);
    let state = !funding ? row.state : funding.state === 'bulk-released' ? (row.creditReferences?.length ? 'credited' : 'expired') :
      funding.state === 'bulk-complete' ? 'minted' : funding.state === 'bulk-releasing' ? 'releasing' :
      sum(finished) ? 'partly_minted' : sum(issued) ? (readyCount === count ? 'permit_issued' : 'permit_pending') :
      funding.state === 'bulk-funded' ? 'paid' : funding.reference ? 'partly_paid' : 'awaiting_payment';
    if (state === 'permit_issued' && ['sending', 'sent', 'minted'].includes(sender?.state)) state = 'minting';
    if (sender?.state === 'needs_attention' && !['minted', 'expired', 'credited'].includes(state)) state = 'needs_attention';
    if (block) state = 'needs_attention';
    if (row.deployerUnpaid && state === 'awaiting_payment') state = 'partly_paid';
    const counted = rules.decimalV2(await this.reads.counted());
    const credits = this.store.list('financialRequestCredits/' + id, { limit: b.BULK_LIMITS.members }).map(r => r.value);
    const creditTotal = this.store.get('financialCreditTotals', id);
    const creditedAmount = creditTotal?.amount ?? credits.reduce((n, c) => n + BigInt(c.amount), 0n).toString();
    const payable = !block && funding?.state === 'bulk-open' && !funding.reference && !(row.references?.length) &&
      BigInt(counted) <= paymentUntil(t, this.document.values) && BigInt(funding.issuedMask) === 0n;
    return { v: 1, orderId: id, termsHash: rules.hashObject(t), state, payable, asset: t.asset, deployment: t.deployment, ticker: t.ticker,
      ...(row.deployerPayment ? { deployerPayment: row.deployerPayment } : {}),
      receiver: t.receiver, payer: t.payer, count, totalAmount: t.totalAmount, grossFeeAtoms: t.grossFeeAtoms, payableFeeAtoms: t.payableFeeAtoms,
      payBy: { rail: 'tap', untilBlock: t.expires }, payment: { reference: funding?.reference ?? null,
        state: funding?.reference ? funding.paid.every((v, i) => v === t.groups[i].amount) ? 'paid' : 'partly_paid' : row.deployerUnpaid ? 'partly_paid' : 'unseen',
        missingGroups: t.groups.flatMap((g, i) => funding?.paid[i] === g.amount ? [] : [i]) },
      progress: { reserved: funding ? count - sum(issued) - sum(released) : 0, issued: sum(issued), minted: sum(finished), released: sum(released), unresolved: count - sum(finished) - sum(released) },
      permit: { root: funding?.permitRoot ?? null, readyCount, complete: readyCount === count },
      mintSender: sender ?? { state: 'waiting_funding', sentBatches: 0, totalBatches: Math.ceil(count / b.BULK_LIMITS.revealMembers) },
      creditReferences: row.creditReferences ?? [], reason: block ?? failure,
      ...(creditedAmount !== '0' ? { creditedAmount, creditId: creditTotal?.firstCreditId ?? credits[0].id, credits, creditsCount: creditTotal?.count ?? credits.length, ...(!block && state === 'credited' ? { reason: 'credited' } : {}) } : {}) };
  }
  async terms(id) { const row = this.row(id); return { v: 1, orderId: id, terms: row.body.terms, feeManifest: row.body.feeManifest,
    ...(row.deployerPayment ? { deployerPayment: row.deployerPayment } : {}) }; }
  async page(id, offset, limit, max) {
    const row = this.row(id), count = row.body.terms.members.length;
    check(Number.isSafeInteger(offset) && offset >= 0 && offset <= count && Number.isSafeInteger(limit) && limit > 0 && limit <= max, 'bulk_page');
    return { row, count, next: offset + limit < count ? offset + limit : null };
  }
  async members(id, { offset = 0, limit = 64 } = {}) {
    const b = await bulkSchema(), { row, count, next } = await this.page(id, offset, limit, b.BULK_LIMITS.members);
    const members = row.body.terms.members.slice(offset, offset + limit).map((m, n) => {
      const index = offset + n, memberId = b.bulkMemberId(id, index), record = this.store.get('accountRecords', 'dc/' + memberId);
      return { index, memberId, ...m, state: record?.state ?? 'reserving', inscription: record?.inscription ?? null, reason: null };
    });
    return { v: 1, orderId: id, offset, next, count, members };
  }
  async permit(id, { offset = 0, limit = 16 } = {}) {
    const b = await bulkSchema(), { row, count, next } = await this.page(id, offset, limit, b.BULK_LIMITS.permitPage), t = row.body.terms;
    const funding = this.store.get('accountRecords', 'fp/' + id), readyCount = this.store.count('bulkPermits/' + id);
    check(!financialBlock(this.store, bulkFinancialKeys(id, t, b, funding, row.creditReferences)), 'financial_quarantined', 503);
    if (readyCount) await this.reads.bulkAccepted(id, await this.reads.batchStamp());
    const members = Array.from({ length: Math.min(limit, count - offset) }, (_, i) => this.store.get('bulkPermits/' + id, String(offset + i))).filter(Boolean);
    return { v: 1, orderId: id, termsHash: rules.hashObject(t), membersRoot: t.membersRoot,
      paymentHash: funding?.receiptRoot ? b.bulkPermitPlans(t, funding.receiptRoot).paymentHash : null,
      permitRoot: funding?.permitRoot ?? null, count, readyCount, complete: readyCount === count, offset, next, members };
  }
  async senderPage({ after = '', limit = 50 } = {}) {
    check((after === '' || rules.hex(after, 32)) && Number.isSafeInteger(limit) && limit > 0 && limit <= 50, 'bulk_sender_page');
    const page = this.store.list('bulkSenderOrders', { after, limit }), rows = [], b = await bulkSchema();
    for (const { id } of page) rows.push(this.senderSummary(this.row(id), await this.status(id), b));
    return { keyId: this.senderView?.keyId, rows, next: page.length === limit ? page.at(-1).id : null };
  }
  senderSummary(row, status, b) {
    const id = row.id, t = row.body.terms;
    // A late-only payment has no primary funding reference. Expose only an
    // accepted receipt-backed liability for the sender's verified BTC return.
    let paymentId = status.payment.reference;
    if (!paymentId && ['expired', 'credited'].includes(status.state)) for (const reference of row.creditReferences ?? []) {
      const credit = this.store.get('accountRecords', 'fp/bulk-credit/' + b.bulkReceiptKey(this.bitcoinNetwork, reference));
      if (credit?.orderId === id && credit.reference === reference) { paymentId = reference; break; }
    }
    return { orderId: id, termsHash: status.termsHash, state: status.state,
      payer: t.payer, receiver: t.receiver, fundingAddress: t.mintFunding.address, fundingSats: t.mintFunding.satoshis,
      paymentId, count: t.members.length, permitRoot: status.permit.root };
  }
  async senderItem(id) {
    const row = this.row(id), t = row.body.terms, status = await this.status(id), b = await bulkSchema();
    const manifest = await this.permit(id), members = [...manifest.members];
    for (let index = b.BULK_LIMITS.permitPage; index < t.members.length; index++) {
      const member = this.store.get('bulkPermits/' + id, String(index)); if (member) members.push(member);
    }
    const permit = { ...manifest, offset: 0, next: null, members };
    const result = { keyId: this.senderView?.keyId, item: this.senderSummary(row, status, b), terms: t, permit,
      ...(row.deployerPayment ? { deployerPayment: row.deployerPayment } : {}) };
    check(size(result) <= b.BULK_LIMITS.permitBytes, 'bulk_response_bytes', 413); return result;
  }
}

// Rebuild the private journal and indexes from accepted audits, in the same
// transaction as account writes. Issued unresolved orders retain their slot.
export function bulkAcceptedWrites(store, input, accepted) {
  const t = input.transition, id = t.id, writes = [];
  if (t.type !== 'reserve-many' && !t.type.startsWith('bulk-')) return writes;
  let row = store.get('bulkOrders', id);
  if (t.type === 'reserve-many') row = { ...row, id, body: { version: 1, terms: t.terms, feeManifest: input.evidence.feeManifest, reserve: t.action },
    ...(input.evidence.deployerPayment ? { deployerPayment: input.evidence.deployerPayment } : {}),
    feeAuthorization: input.evidence.feeAuthorization, state: 'awaiting_payment', references: row?.references ?? [],
    created: accepted.get('accountRecords', 'fp/' + id)?.created };
  check(row, 'bulk_projection_missing');
  if (t.type === 'bulk-credit') row = { ...row, creditReferences: [...new Set([...(row.creditReferences ?? []), t.reference])] };
  if (['bulk-fund', 'bulk-credit'].includes(t.type)) row = { ...row, references: (row.references ?? []).filter(r => r !== t.reference) };
  const funding = accepted.get('accountRecords', 'fp/' + id), terminal = ['bulk-complete', 'bulk-released'].includes(funding?.state);
  if (funding?.state === 'bulk-released' && funding.reference) row = { ...row, creditReferences: [...new Set([...(row.creditReferences ?? []), funding.reference])] };
  writes.push({ space: 'bulkOrders', id, value: row }, { space: 'mints', id, value: bulkEvidenceProjection(row) },
    { space: 'activeBulkOrders', id, ...(terminal ? {} : { value: true }) },
    { space: 'bulkSenderOrders', id, ...(funding?.state === 'bulk-complete' || funding?.state === 'bulk-released' &&
      !funding.reference && !row.creditReferences?.length ? {} : { value: true }) },
    { space: bulkOwnerSpace(row.body.terms.owner), id, ...(terminal ? {} : { value: true }) });
  if (terminal) writes.push({ space: 'bulkPaymentRecovery', id, value: true });
  return writes;
}
