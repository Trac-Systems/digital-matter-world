import { tickerRequestId } from './ticker-payment-sources.mjs';
import { randomBytes } from 'node:crypto';
import { rules } from './rules.mjs';
import { check, hash } from './util.mjs';
import { KeyedWork } from './keyed-work.mjs';
import { mintAssetDefinition } from './mint-assets.mjs';
import { deploymentPayload, generationDigest, same, verifyDeployment } from './deployments.mjs';
import { registerAdditionalDeployment, selectedDeployment } from './registry.mjs';

// The coordinated release supplies these components. Lazy loading preserves existing paths
// until the coordinated release is integrated; no substitute admission exists.
const dependencies = async () => ({ ...await import('../../rules/src/ticker-names.js'), ...await import('./ticker-availability.mjs') });
export class TickerProvisioning {
  constructor(provisioner, { checks = dependencies, payments } = {}) {
    this.p = provisioner; this.checks = checks; this.payments = payments; this.work = new KeyedWork();
  }
  async active() {
    const height = rules.decimalV2(await this.p.reads.counted());
    check(rules.multiTickerActive(height), 'multi_ticker_inactive');
    const document = (await this.p.reads.rulesContext()).settings;
    rules.validateSettingsDocument(document); return { height, document };
  }
  async request(asset, input) {
    const { height, document } = await this.active(), { store, reads, network } = this.p;
    const resolved = await mintAssetDefinition(store, asset); asset = resolved.asset;
    const registry = await reads.registry(), official = registry.assets[asset];
    check(official && !official.suspended, 'official_deployment_required');
    const checks = await this.checks(), tick = checks.validateChosenTicker(input.ticker);
    const indexTick = official.kind === 'dmt' ? 'dmt-' + tick : tick;
    rules.legacyDeployHolderAddress(input.receiver, reads.bindings?.bitcoinNetwork ?? 'mainnet');
    const initialId = tickerRequestId(network, asset, indexTick, input.receiver);
    return this.work.run(initialId, async () => {
      let id = store.get('tickerRequestHeads', initialId) ?? initialId;
      let job = store.get('tickerProvisioning', id);
      if (job?.state === 'registered') return this.present(await this.completed(job));
      let requestNonce;
      if (input.retry && job) {
        const previous = store.get('tickerPayments', id);
        check(previous?.reason === 'ticker_expired' && ['refused', 'refund_pending'].includes(previous.state), 'ticker_retry_not_terminal');
        requestNonce = randomBytes(32).toString('hex'); id = tickerRequestId(network, asset, indexTick, input.receiver, requestNonce); job = null;
      }
      if (!job) {
        await checks.tickerConflicts(tick, { officialName: async name => {
          check(typeof reads.officialName === 'function', 'ticker_official_lookup_required');
          return await reads.officialName(name) || registry.officialName?.(name) || null;
        } });
        check(await checks.tickerAvailable(reads, indexTick), 'ticker_occupied');
        job = { id, ...(requestNonce ? { requestNonce } : {}), asset, catalogAsset: resolved.catalogAsset, definition: resolved.definition, network, ticker: tick, indexTick,
          receiver: input.receiver, officialDeployment: official.id, kind: official.kind, generation: 1, privilege: official.privilege, elementId: official.elementId, elementName: official.elementName,
          salt: randomBytes(32).toString('hex'), state: 'awaiting_fee', createdHeight: height };
        await store.transact([{ space: 'tickerProvisioning', id, value: job }, { space: 'tickerRequestHeads', id: initialId, value: id }]);
      }
      const parent = registry.asset?.(asset, job.officialDeployment) ?? official;
      check(parent?.id === job.officialDeployment && !parent.officialDeployment && parent.kind === official.kind &&
        parent.privilege === official.privilege && (parent.elementId ?? null) === (official.elementId ?? null), 'official_deployment_changed');
      // The fee component owns quote/payment verification and refusal refunds.
      // A configured fee always fails closed until that component is installed.
      const payments = await this.paymentService();
      const at = await reads.batchStamp();
      // Recover only this ticker's named reservation. Unpaid requests cannot
      // squat a name indefinitely; paid requests keep their no-expiry promise.
      const held = store.get('tickerReservations', indexTick);
      if (held && held.requestId !== id) {
        const previous = store.get('tickerPayments', held.requestId), prepared = store.get('tickerProvisioning', held.requestId);
        if (previous && BigInt(height) > BigInt(previous.until)) await payments.expire(held.requestId, at);
        else if (!previous && prepared && BigInt(height) > BigInt(prepared.createdHeight) + BigInt(document.values.pendingBlocks))
          await checks.releaseTicker(store, indexTick, held.requestId);
      }
      const oldFee = store.get('tickerPayments', id);
      let fee = oldFee ? await payments.view(id) : await payments.request({ id, asset, tick: indexTick, payer: input.receiver,
        until: rules.addUint(height, String(document.values.pendingBlocks)), ...(input.feeQuote ? { feeQuote: input.feeQuote } : {}) }, at);
      if (job.requestNonce && !oldFee?.requestNonce) {
        const payment = store.get('tickerPayments', id);
        await store.put('tickerPayments', id, { ...payment, requestNonce: job.requestNonce });
      }
      if (input.paymentIds) fee = await payments.payment({ id, paymentIds: input.paymentIds }, at);
      job = { ...job, fee }; await store.put('tickerProvisioning', id, job);
      if (fee.state !== 'paid') return this.present(job);
      if (job.content) return this.present(job);
      if (!await checks.tickerAvailable(reads, indexTick)) return this.refuse(job, 'ticker_occupied');
      const entry = { ...parent, id: undefined, approval: undefined, inclusion: undefined, receiver: input.receiver,
        officialDeployment: parent.id, tickerRequestId: id, generation: 1, tick, indexTick, suspended: false };
      delete entry.ordinal;
      const content = deploymentPayload(entry), attemptId = hash(rules.stableJSON([id, content]));
      job = { ...job, entry, phase: 'deployment', content, inscriptionText: rules.stableJSON(content),
        attempts: [{ phase: 'deployment', attempt: 0, id: attemptId, text: content }], tickerAttempt: 0, state: 'awaiting_player_deploy' };
      await store.put('tickerProvisioning', id, job); return this.present(job);
    }, { join: true });
  }
  async refuse(job, reason) {
    const payments = await this.paymentService();
    const fee = job.fee ? await payments.refuse(job.id, reason, await this.p.reads.batchStamp()) : undefined;
    await (await this.checks()).releaseTicker(this.p.store, job.indexTick, job.id);
    const next = { ...job, ...(fee ? { fee } : {}), state: 'refused', reason };
    await this.p.store.put('tickerProvisioning', job.id, next); return this.present(next);
  }
  async submit(asset, { requestId, inscription, phase = 'deployment' }) {
    await this.active();
    return this.work.run(requestId, async () => {
      const { store, reads, registryPath, policy } = this.p, job = store.get('tickerProvisioning', requestId);
      const resolved = await mintAssetDefinition(store, asset);
      check(job?.asset === resolved.asset && phase === 'deployment' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(inscription), 'deployment_submission');
      if (job.state === 'registered') { check(job.entry.id === inscription, 'deployment_submission_conflict'); return this.present(await this.completed(job)); }
      check(job.state === 'awaiting_player_deploy' && same(await reads.content(inscription), job.content), 'deployment_content');
      const indexed = await reads.tap('getDeployment/' + encodeURIComponent(job.indexTick));
      if (indexed && indexed.ins !== inscription) return this.refuse(job, 'ticker_occupied');
      let entry = { ...job.entry, id: inscription };
      check(typeof reads.tickerDeploymentFee === 'function', 'ticker_payment_unavailable');
      await reads.tickerDeploymentFee(entry, await reads.batchStamp());
      const { inclusion } = await verifyDeployment(reads, entry, { confirmations: policy.confirmations, verifyReceiver: true });
      entry = { ...entry, inclusion: { height: inclusion.height, blockHash: inclusion.blockHash }, confirmations: policy.confirmations };
      entry.approval = generationDigest(entry);
      entry = await registerAdditionalDeployment(registryPath, job.asset, entry);
      const next = { ...job, entry, ordinal: entry.ordinal, state: 'registered', registeredAt: Date.now() };
      await store.put('tickerProvisioning', job.id, next);
      const completed = await this.completed(next);
      await (await this.checks()).releaseTicker(store, job.indexTick, job.id);
      return this.present(completed);
    }, { join: true });
  }
  async completed(job) {
    const fee = await (await this.paymentService()).complete(job.id, job.entry);
    const payment = this.p.store.get('tickerPayments', job.id);
    for (const reference of new Set((payment?.verified?.receipts ?? []).filter(r => r.accepted && BigInt(r.amount) > 0n).map(r => r.reference))) {
      const id = rules.hashObject(['dmw-ticker-funding-return-v1', job.id, reference]);
      await this.p.store.put('tickerFundingReturns', id, { requestId: job.id, reference });
    }
    const next = { ...job, fee }; await this.p.store.put('tickerProvisioning', job.id, next); return next;
  }
  present(job) {
    const view = this.p.mintSender;
    return view && job.fee ? { ...job, fee: { ...job.fee,
      ...(job.fee.payable && view.settings.refundsEnabled && view.ready() ? { refundFunding: {
        address: view.address(job.id), satoshis: view.settings.refundReserveSats, feeRate: view.settings.maxRefundFeeRate,
        label: 'possible ticker fee refund' } } : {}),
      ...(job.fee.refunds ? { refunds: job.fee.refunds.map(r => view.decorateRefund(r)) } : {}) } } : job;
  }
  async fundingReturn(id) {
    await this.active();
    const { store, reads } = this.p, pending = store.get('tickerFundingReturns', id);
    check(pending && id === rules.hashObject(['dmw-ticker-funding-return-v1', pending.requestId, pending.reference]), 'ticker_return_binding');
    const job = store.get('tickerProvisioning', pending.requestId), payment = store.get('tickerPayments', pending.requestId);
    check(job?.state === 'registered' && payment?.state === 'completed' && !payment.reason && this.p.mintSender, 'ticker_return_pending');
    const entry = selectedDeployment(await reads.registry(), job.asset, job.entry.id);
    check(entry?.tickerRequestId === job.id && payment.payer === job.receiver && payment.paymentReferences.includes(pending.reference), 'ticker_return_binding');
    return { requestId: id, fundingId: job.id, fundingReference: pending.reference, tickerReturn: true, state: 'minted', payer: job.receiver, receiver: job.receiver,
      fundingAddress: this.p.mintSender.address(job.id), payBy: { rail: 'tap', untilBlock: payment.until }, counted: String(await reads.counted()) };
  }
  async fundingReturns({ after = '', limit }) {
    await this.active();
    const view = this.p.mintSender; check(view && typeof after === 'string' && (after === '' || rules.hex(after, 32)) &&
      Number.isSafeInteger(limit) && limit > 0 && limit <= view.settings.pageSize, 'ticker_return_page');
    const page = this.p.store.list('tickerFundingReturns', { after, limit });
    return { keyId: view.keyId, rows: await Promise.all(page.map(r => this.fundingReturn(r.id))), next: page.length === limit ? page.at(-1).id : null };
  }
  async paymentService() {
    if (this.payments) return this.payments;
    const { TickerPayments } = await import('./ticker-payments.mjs');
    const { store, reads, network } = this.p;
    this.payments = new TickerPayments({ store, reads, network, bitcoinNetwork: reads.bindings?.bitcoinNetwork ?? 'mainnet',
      officialName: async name => await reads.officialName(name) || (await reads.registry()).officialName?.(name) || null,
      refund: async record => {
        check(this.p.financial, 'ticker_refund_adapter_required');
        const action = { type: 'ticker-refund', id: record.refundId, request: record.id, reference: record.reference, reason: record.reason };
        if (!store.get('accountRecords', 'fp/public-refund/' + action.id))
          await this.p.financial.submit({ type: 'lifecycle', id: action.id, action });
        check(store.get('accountRecords', 'fp/public-refund/' + action.id), 'ticker_refund_pending');
      } });
    return this.payments;
  }
  async payment({ id, paymentIds, expire = false }) {
    await this.active();
    const job = this.p.store.get('tickerProvisioning', id); check(job, 'ticker_request_missing');
    const payments = await this.paymentService(), at = await this.p.reads.batchStamp();
    const fee = expire ? await payments.expire(id, at) : await payments.payment({ id, paymentIds }, at);
    if (fee.state === 'paid') return this.request(job.catalogAsset, { ticker: job.ticker, receiver: job.receiver });
    const next = { ...job, fee }; await this.p.store.put('tickerProvisioning', id, next); return this.present(next);
  }
  async state(asset, selector) {
    await this.active(); const resolved = await mintAssetDefinition(this.p.store, asset);
    const job = this.p.store.get('tickerProvisioning', selector);
    if (job) { check(job.asset === resolved.asset, 'deployment_asset'); return this.present({ ...job, ...(job.fee ? { fee: await (await this.paymentService()).view(job.id) } : {}) }); }
    const entry = selectedDeployment(await this.p.reads.registry(), resolved.asset, selector);
    check(entry, 'deployment_unknown'); return { asset: resolved.asset, catalogAsset: resolved.catalogAsset, state: 'registered', entry };
  }
  // The pattern or compound a TAP ticker belongs to, by point reads only: anyone's own ticker, then the
  // official one. Case-insensitive, bare ("moon") or indexed ("dmt-moon"); asset is null when none matches.
  async find(ticker) {
    const tick = (await this.checks()).indexedTicker(ticker), registry = await this.p.reads.registry();
    check(typeof registry.tickerOwner === 'function', 'registry_migration_required');
    for (const name of tick.startsWith('dmt-') ? [tick] : [tick, 'dmt-' + tick]) {
      const owner = registry.tickerOwner(name), asset = owner?.asset ?? registry.officialName(name);
      const entry = asset ? owner ? registry.deployment(asset, owner.deployment) : registry.asset(asset) : null;
      // The official names also hold pattern names and labels; only a deployed ticker counts here.
      if (!entry || ![entry.tick, entry.indexTick].some(t => typeof t === 'string' && t.toLowerCase() === name)) continue;
      const resolved = await mintAssetDefinition(this.p.store, asset);
      return { ticker: entry.indexTick ?? entry.tick, tick: entry.tick, asset: resolved.catalogAsset, official: !owner, ordinal: entry.ordinal ?? '1' };
    }
    return { ticker: tick, asset: null };
  }
  async list(asset, { after = '', limit = 50 } = {}) {
    await this.active(); const { store, reads } = this.p, resolved = await mintAssetDefinition(store, asset);
    const registry = await reads.registry(), official = registry.assets[resolved.asset];
    check(typeof registry.page === 'function', 'registry_migration_required');
    const page = registry.page('deployments/' + resolved.asset, { after, limit });
    const entries = [...(!after && official ? [official] : []), ...page.map(r => r.value)];
    return { asset: resolved.asset, catalogAsset: resolved.catalogAsset, rows: entries.map(entry => {
      const generation = rules.hashObject(['dmw-financial-generation-v2', this.p.network, resolved.asset, entry.id]);
      const capacity = store.get('accountRecords', 'fd/' + generation);
      return { ticker: entry.indexTick ?? entry.tick, tick: entry.tick, ordinal: entry.ordinal ?? '1', deploymentId: entry.id,
        element: entry.elementId ?? null, deployer: entry.receiver ?? null, holder: null, unitsMinted: capacity?.minted ?? null };
    }), next: page.length === limit ? page.at(-1).id : null };
  }
}
