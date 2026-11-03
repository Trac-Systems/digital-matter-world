import { setTimeout as sleep } from 'node:timers/promises';
import { multiTickerActive } from '../../rules/src/multi-ticker-activation.js';
import * as btc from '@scure/btc-signer';
import { buildInscription, mintContent, missingItems, transferItems, ensure, digest, feeItemKey, deploymentContent, checkDeployer, checkSavedFee, hex, unhex } from './inscription-core.mjs';

const commitInputs = plan => {
  try {
    const tx = btc.Transaction.fromRaw(unhex(plan.commitHex), { allowUnknownOutputs: true });
    return Array.from({ length: tx.inputsLength }, (_, i) => { const input = tx.getInput(i); return { txid: hex(input.txid), vout: input.index }; });
  } catch { return []; }
};

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
      if (['permit_issued', 'minted', 'expired', 'accepted', 'credited', 'refunded'].includes(status.state) || Date.now() >= end) return status;
      await sleep(Math.min(intervalMs, end - Date.now()), undefined, { signal });
    }
  }
  async prepare(text, status, { feeRate, maxFeeSats }) {
    ensure(this.wallet && this.wallet.source, 'Configure the local Bitcoin signer and cardinal funding coins');
    this.wallet.source.addFunding?.(this.journal.bitcoinChanges());
    // A coin already used by a saved transaction stays with it, even while that transaction is not yet on Bitcoin.
    const used = new Set(this.journal.bitcoinPlans().flatMap(commitInputs).map(c => `${c.txid}:${c.vout}`));
    const utxos = (await this.wallet.source.utxos(this.wallet.address)).filter(c => !used.has(`${c.txid}:${c.vout}`));
    feeRate ??= await this.wallet.source.feeRate();
    return buildInscription({ text, receiver: status.receiver, publicKey: this.wallet.publicKey, network: this.wallet.network, utxos, feeRate, maxFeeSats });
  }
  // A saved commit is dead when Bitcoin confirmed a different transaction spending one of its coins: it can
  // never confirm, so nothing it would pay can be paid twice by a fresh attempt.
  async deadCommit(plan) {
    const source = this.wallet.source;
    if (typeof source.outspend !== 'function' || await source.hasTransaction?.(plan.commitTxid)) return null;
    for (const input of commitInputs(plan)) {
      const spent = await source.outspend(input.txid, input.vout);
      if (spent?.spent && /^[0-9a-f]{64}$/.test(spent.txid ?? '') && spent.txid !== plan.commitTxid && spent.status?.confirmed === true)
        return { reason: 'commit_input_spent', input: `${input.txid}:${input.vout}`, spentBy: spent.txid, height: spent.status.block_height ?? null };
    }
    return null;
  }
  // Right after a broadcast the gateway is told, so every viewer sees it as sent until Bitcoin confirms it.
  // Best effort: the gateway checks it on Bitcoin, and a failed report never fails the broadcast.
  async reportInflight(inflight, plan) {
    if (!inflight || typeof this.service.reportInflight !== 'function') return;
    try { await this.service.reportInflight({ ...inflight, commitTxid: plan.commitTxid, revealTxid: plan.revealTxid, inscriptionId: plan.inscriptionId }); } catch {}
  }
  async broadcast(row, inflight) {
    const plan = row.body.plan, source = this.wallet.source;
    // A response lost after either send is harmless: retry only these exact
    // transaction bytes, never choose replacement inputs or pay again.
    this.journal.mark(row.id, 'sending');
    try {
      await source.broadcast(plan.commitHex, plan.commitTxid);
      await source.broadcast(plan.revealHex, plan.revealTxid);
      const result = { state: 'broadcast', requestId: row.body.requestId, commitTxid: plan.commitTxid, revealTxid: plan.revealTxid, inscriptionId: plan.inscriptionId, feeSats: plan.feeSats };
      this.journal.mark(row.id, 'submitted', result);
      await this.reportInflight(inflight, plan);
      if (row.body.payment && this.service.reportMintPayment) {
        try { await this.service.reportMintPayment({ id: row.body.requestId, paymentId: plan.inscriptionId }); }
        catch { result.notice = 'Payment broadcast; gateway notification is pending. Retry this request to report the same payment ID.'; }
      }
      if (row.id.startsWith('bitcoin-mint/') && this.service.reportMintPayment) {
        try { await this.service.reportMintPayment({ id: row.body.requestId, inscription: plan.inscriptionId }); }
        catch { result.notice = 'Mint broadcast; retry this request to report the same inscription ID.'; }
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
        const result = await this.broadcast(old, { kind: 'mint', ref: id, phase: 'payment', attempt: 0 });
        return { ...result, replayed: true, missing: items, note: 'Original payment rebroadcast. Wait for indexed evidence; no second payment was created.' };
      }
      if (this.dryRun) return { state: 'dry-run', requestId: id, items: transfers, signed: false };
      const text = this.wallet.redeem(status);
      const plan = this.wallet.signCommit(await this.prepare(text, status, { feeRate, maxFeeSats }));
      const fresh = await this.status(id);
      ensure(JSON.stringify(missingItems(fresh).map(i => [feeItemKey(i), i.amount])) === JSON.stringify(items.map(i => [feeItemKey(i), i.amount])), 'Payment evidence changed; review the remaining items and retry');
      const row = this.journal.reserve(key, { requestId: id, receiver: status.receiver }, { requestId: id, receiver: status.receiver, items, plan, payment: true });
      return this.broadcast(row, { kind: 'mint', ref: id, phase: 'payment', attempt: 0 });
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
        return { ...await this.broadcast(old, { kind: 'mint', ref: id, phase: 'mint', attempt: 0 }), replayed: true };
      }
      const plan = await this.prepare(text, status, { feeRate, maxFeeSats });
      if (this.dryRun) return { state: 'dry-run', requestId: id, receiver: status.receiver, feeSats: plan.feeSats, feeRate: plan.feeRate, text, signed: false };
      const signed = this.wallet.signCommit(plan);
      return this.broadcast(this.journal.reserve(key, intent, { requestId: id, plan: signed }), { kind: 'mint', ref: id, phase: 'mint', attempt: 0 });
    });
  }
  deploy({ asset, ticker, retry, feeRate, maxFeeSats }) {
    return this.serial(async () => {
      let job = ticker === undefined ? await this.service.deployment(asset) : await this.service.deployTicker({ asset, ticker, ...(retry ? { retry } : {}), receiver: this.wallet.address });
      if (ticker !== undefined) {
        ensure(job.ticker === ticker.toLowerCase() && job.officialDeployment, 'Chosen ticker mismatch');
        if (job.state === 'awaiting_fee' || job.state === 'refused') return { ...job, sent: false };
      }
      // The gateway prepares deployment content in the background and answers "queued" first.
      for (let waited = 0; job.state !== 'registered' && job.state !== 'awaiting_ticker' && !job.content && waited < 120000; waited += 2000) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        job = { ...job, ...await (ticker === undefined ? this.service.deploymentState(job.catalogAsset ?? asset) : this.service.tickerState(job.catalogAsset ?? asset, job.id)) };
      }
      // A compound's first maker chooses its ticker first (My agent → Your compounds, or its deploy page).
      if (job.state === 'awaiting_ticker') return { state: job.state, asset, sent: false, notice: 'Its first maker chooses the ticker first: My agent → Your compounds, or the compound\'s deploy page. Then retry inscribe_deployment.' };
      if (job.state !== 'registered' && !job.content) return { state: job.state ?? 'queued', asset, sent: false, notice: 'The gateway is still preparing this deployment. Retry inscribe_deployment in a minute.' };
      ensure(job.asset === asset || asset === job.catalogAsset && /^p2:(0|[1-9][0-9]*)$/.test(asset) &&
        job.asset === 'p' + BigInt(asset.slice(3)).toString(36), 'Deployment asset mismatch');
      asset = job.asset;
      if (job.state === 'registered') return { state: 'registered', asset, inscriptionId: job.entry?.id, sent: false };
      checkDeployer(job, { owner: this.owner, address: this.wallet.address });
      let chosenNames;
      if (job.officialDeployment) {
        ensure(multiTickerActive(job.createdHeight), 'Additional tickers are not active');
        chosenNames = await import('../../rules/src/ticker-names.js');
      }
      const { text, attemptId, phase } = deploymentContent(job, { validateTicker: chosenNames?.validateChosenTicker });
      if (job.kind === 'compound' && !job.officialDeployment) ensure(this.owner && job.definition?.firstMaker === this.owner, 'Only this compound’s first maker may inscribe its deployment');
      ensure(!job.receiver || job.receiver === this.wallet.address, 'Use the wallet that inscribed this pattern’s element');
      const current = await this.service.payoutBinding(this.owner, 'tap');
      ensure(current.binding?.request?.address === this.wallet.address && current.binding.request.agent === this.owner,
        'Bind this player’s local Bitcoin wallet before inscribing the deployment');
      const key = `bitcoin-deploy/${attemptId}`, intent = { asset, receiver: this.wallet.address, textHash: digest(text) };
      let row = this.journal.get(key), replaced = null;
      if (row && (replaced = await this.deadCommit(row.body.plan))) {
        if (this.dryRun) return { state: 'dry-run', asset, attemptId, replaces: replaced, signed: false };
        this.journal.abandon(key, row.body, replaced); row = null;
      }
      if (row) { checkSavedFee(row.body.plan, maxFeeSats); ensure(row.body.plan.textHash === intent.textHash && row.body.plan.receiver === intent.receiver, 'Saved deployment differs'); }
      else {
        const plan = await this.prepare(text, { receiver: this.wallet.address }, { feeRate, maxFeeSats });
        if (this.dryRun) return { state: 'dry-run', asset, attemptId, receiver: this.wallet.address, text, feeSats: plan.feeSats, signed: false };
        row = this.journal.reserve(key, intent, { asset, phase, requestId: attemptId, plan: this.wallet.signCommit(plan) });
      }
      if (this.dryRun) return { state: 'dry-run', asset, attemptId, resume: true, signed: false };
      const result = await this.broadcast(row, job.officialDeployment ? { kind: 'ticker', ref: job.id, phase: 'deployment', attempt: 0 }
        : { kind: 'deployment', ref: asset, phase, attempt: phase === 'element' ? job.elementAttempt : job.tickerAttempt });
      try {
        const registered = job.officialDeployment ? await this.service.deployTicker({ asset, requestId: job.id, phase, inscription: result.inscriptionId }) : await this.service.submitDeployment({ asset, phase, inscription: result.inscriptionId });
        return { ...result, asset, phase, deploymentState: registered.state };
      } catch (error) {
        return { ...result, asset, phase, deploymentState: 'awaiting_verification', notice: 'Retry inscribe_deployment when the inscription lands in a Bitcoin block to submit this same inscription for verification.', verificationCode: error.code ?? 'verification_pending' };
      }
    });
  }
}
