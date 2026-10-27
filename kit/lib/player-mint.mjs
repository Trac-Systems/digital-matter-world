import { setTimeout as sleep } from 'node:timers/promises';
import { buildInscription, mintContent, missingItems, transferItems, ensure, digest, feeItemKey, deploymentContent, checkSavedFee } from './inscription-core.mjs';

export class PlayerMint {
  constructor({ service, journal, wallet, owner, dryRun = true }) {
    Object.assign(this, { service, journal, wallet, owner, dryRun });
    this.tail = Promise.resolve();
  }
  serial(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
  async status(id) {
    ensure(/^[0-9a-f]{64}$/.test(id), 'Invalid mint request ID');
    const status = await this.service.mintStatus(id);
    ensure(status.requestId === id, 'Mint request ID mismatch'); missingItems(status);
    return status;
  }
  async poll(id, { timeoutMs = 30000, intervalMs = 2000, signal } = {}) {
    ensure(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 120000, 'Invalid polling deadline');
    const end = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const status = await this.status(id);
      if (['permit_issued', 'minted', 'expired'].includes(status.state) || Date.now() >= end) return status;
      await sleep(Math.min(intervalMs, end - Date.now()), undefined, { signal });
    }
  }
  async prepare(text, status, { feeRate, maxFeeSats }) {
    ensure(this.wallet && this.wallet.source, 'Configure the local Bitcoin signer and cardinal funding coins');
    this.wallet.source.addFunding?.(this.journal.bitcoinChanges());
    const utxos = await this.wallet.source.utxos(this.wallet.address);
    feeRate ??= await this.wallet.source.feeRate();
    return buildInscription({ text, receiver: status.receiver, publicKey: this.wallet.publicKey, network: this.wallet.network, utxos, feeRate, maxFeeSats });
  }
  async broadcast(row) {
    const plan = row.body.plan, source = this.wallet.source;
    // A response lost after either send is harmless: retry only these exact
    // transaction bytes, never choose replacement inputs or pay again.
    this.journal.mark(row.id, 'sending');
    try {
      await source.broadcast(plan.commitHex, plan.commitTxid);
      await source.broadcast(plan.revealHex, plan.revealTxid);
      const result = { state: 'broadcast', requestId: row.body.requestId, commitTxid: plan.commitTxid, revealTxid: plan.revealTxid, inscriptionId: plan.inscriptionId, feeSats: plan.feeSats };
      this.journal.mark(row.id, 'submitted', result);
      if (row.body.payment && this.service.reportMintPayment) {
        try { await this.service.reportMintPayment({ id: row.body.requestId, paymentId: plan.inscriptionId }); }
        catch { result.notice = 'Payment broadcast; gateway notification is pending. Retry this request to report the same payment ID.'; }
      }
      return result;
    } catch (error) { this.journal.mark(row.id, 'unknown'); throw error; }
  }
  pay({ id, feeRate, maxFeeSats }) {
    return this.serial(async () => {
      const status = await this.status(id), items = missingItems(status);
      if (!items.length || ['paid', 'permit_issued', 'minted'].includes(status.state)) return { state: status.state, requestId: id, missing: items, sent: false };
      ensure(['awaiting_payment', 'partly_paid'].includes(status.state), 'This request is not accepting payment');
      ensure(status.payBy?.rail === 'tap', 'Pay Ethereum deposits with your own Ethereum wallet');
      ensure(status.receiver === this.wallet.address, 'Use this player’s Bitcoin address as receiver');
      const transfers = transferItems(status, this.wallet.network);
      const paymentPlan = status.payer ? status : await this.service.mintPaymentPlan?.(id);
      ensure(paymentPlan?.requestId === id && paymentPlan.payer === this.wallet.address, 'The quoted TAP payer differs from this local Bitcoin wallet');
      ensure(status.payable !== false, 'Wait until the reservation is confirmed before paying'); // Refuse unsupported burns before any signing or spending.
      const key = `bitcoin-pay/${id}`, old = this.journal.get(key);
      if (old) {
        ensure(old.body.receiver === status.receiver, 'Saved payment receiver mismatch');
        checkSavedFee(old.body.plan, maxFeeSats);
        if (this.dryRun) return { state: 'dry-run', requestId: id, resume: true, missing: items, signed: false };
        const result = await this.broadcast(old);
        return { ...result, replayed: true, missing: items, note: 'Original payment rebroadcast. Wait for indexed evidence; no second payment was created.' };
      }
      if (this.dryRun) return { state: 'dry-run', requestId: id, items: transfers, signed: false };
      const text = this.wallet.redeem(status);
      const plan = this.wallet.signCommit(await this.prepare(text, status, { feeRate, maxFeeSats }));
      const fresh = await this.status(id);
      ensure(JSON.stringify(missingItems(fresh).map(i => [feeItemKey(i), i.amount])) === JSON.stringify(items.map(i => [feeItemKey(i), i.amount])), 'Payment evidence changed; review the remaining items and retry');
      const row = this.journal.reserve(key, { requestId: id, receiver: status.receiver }, { requestId: id, receiver: status.receiver, items, plan, payment: true });
      return this.broadcast(row);
    });
  }
  inscribe({ id, feeRate, maxFeeSats }) {
    return this.serial(async () => {
      const status = await this.status(id);
      if (status.state === 'minted') return { state: 'minted', requestId: id, inscriptionId: status.inscription, sent: false };
      const text = mintContent(status, this.wallet.address);
      const key = `bitcoin-mint/${id}`, intent = { requestId: id, receiver: status.receiver, textHash: digest(text) };
      const old = this.journal.get(key);
      if (old) {
        checkSavedFee(old.body.plan, maxFeeSats);
        ensure(old.body.plan.textHash === intent.textHash && old.body.plan.receiver === status.receiver, 'Inscription content changed since preparation');
        if (this.dryRun) return { state: 'dry-run', requestId: id, resume: true, signed: false };
        return { ...await this.broadcast(old), replayed: true };
      }
      const plan = await this.prepare(text, status, { feeRate, maxFeeSats });
      if (this.dryRun) return { state: 'dry-run', requestId: id, receiver: status.receiver, feeSats: plan.feeSats, feeRate: plan.feeRate, text, signed: false };
      const signed = this.wallet.signCommit(plan);
      return this.broadcast(this.journal.reserve(key, intent, { requestId: id, plan: signed }));
    });
  }
  deploy({ asset, feeRate, maxFeeSats }) {
    return this.serial(async () => {
      const job = await this.service.deployment(asset);
      ensure(job.asset === asset, 'Deployment asset mismatch');
      if (job.state === 'registered') return { state: 'registered', asset, inscriptionId: job.entry?.id, sent: false };
      const { text, attemptId, phase } = deploymentContent(job);
      if (job.kind === 'compound') ensure(this.owner && job.definition?.firstMaker === this.owner, 'Only this compound’s first maker may inscribe its deployment');
      ensure(!job.receiver || job.receiver === this.wallet.address, 'Use the wallet that inscribed this pattern’s element');
      const current = await this.service.payoutBinding(this.owner, 'tap');
      ensure(current.binding?.request?.address === this.wallet.address && current.binding.request.agent === this.owner,
        'Bind this player’s local Bitcoin wallet before inscribing the deployment');
      const key = `bitcoin-deploy/${attemptId}`, intent = { asset, receiver: this.wallet.address, textHash: digest(text) };
      let row = this.journal.get(key);
      if (row) { checkSavedFee(row.body.plan, maxFeeSats); ensure(row.body.plan.textHash === intent.textHash && row.body.plan.receiver === intent.receiver, 'Saved deployment differs'); }
      else {
        const plan = await this.prepare(text, { receiver: this.wallet.address }, { feeRate, maxFeeSats });
        if (this.dryRun) return { state: 'dry-run', asset, attemptId, receiver: this.wallet.address, text, feeSats: plan.feeSats, signed: false };
        row = this.journal.reserve(key, intent, { asset, phase, requestId: attemptId, plan: this.wallet.signCommit(plan) });
      }
      if (this.dryRun) return { state: 'dry-run', asset, attemptId, resume: true, signed: false };
      const result = await this.broadcast(row);
      try {
        const registered = await this.service.submitDeployment({ asset, phase, inscription: result.inscriptionId });
        return { ...result, asset, phase, deploymentState: registered.state };
      } catch (error) {
        return { ...result, asset, phase, deploymentState: 'awaiting_verification', notice: 'Retry inscribe_deployment when the inscription lands in a Bitcoin block to submit this same inscription for verification.', verificationCode: error.code ?? 'verification_pending' };
      }
    });
  }
}
