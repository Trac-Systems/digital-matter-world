import { buildInscription, acceptSignedCommit, mintContent, missingItems, transferItems, fundingAddress, ensure, digest, checkSavedFee, deploymentContent } from './inscription-core.mjs';

export class BrowserMintJournal {
  constructor(name = 'dmw-player-inscriptions-v1') { this.name = name; }
  async database() {
    return this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('requests');
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async get(key) {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const req = db.transaction('requests').objectStore('requests').get(key);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async put(key, record) {
    const db = await this.database();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('requests', 'readwrite', { durability: 'strict' });
      tx.objectStore('requests').put(record, key);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
  async lock(key, fn) {
    ensure(globalThis.navigator?.locks, 'This browser needs Web Locks to safely resume payments');
    return navigator.locks.request(`${this.name}/${key}`, fn);
  }
}

export class TapWalletMint {
  constructor({ provider = globalThis.tapprotocol, readStatus, readPaymentPlan, network, journal = new BrowserMintJournal(), fetchImpl = fetch }) {
    Object.assign(this, { provider, readStatus, readPaymentPlan, network, journal });
    this.fetchImpl = (...args) => fetchImpl(...args);
  }
  async connect() {
    ensure(this.provider, 'Connect TAP Wallet to pay and inscribe');
    for (const method of ['requestAccounts', 'getAccounts', 'getNetwork', 'getPublicKey', 'getBitcoinUtxos', 'singleTxTransfer', 'signPsbt', 'pushPsbt', 'pushTx'])
      ensure(typeof this.provider[method] === 'function', `TAP Wallet does not provide ${method}`);
    const accounts = await this.provider.requestAccounts(), actual = await this.provider.getNetwork();
    ensure(actual === this.network, `Select ${this.network} in TAP Wallet`);
    this.address = accounts?.[0]; this.publicKey = await this.provider.getPublicKey();
    ensure(this.address === fundingAddress(this.publicKey, this.network), 'Select a Taproot account in TAP Wallet');
    return { address: this.address, network: actual };
  }
  async checkAccount() {
    ensure(this.address && (await this.provider.getAccounts())?.[0] === this.address && await this.provider.getNetwork() === this.network && await this.provider.getPublicKey() === this.publicKey,
      'Wallet account or network changed; reconnect before continuing');
  }
  async status(id) {
    ensure(/^[0-9a-f]{64}$/.test(id), 'Invalid mint request ID');
    const status = await this.readStatus(id);
    ensure(status.requestId === id, 'Mint request ID mismatch'); missingItems(status);
    return status;
  }
  key(id) { return `${this.network}/${this.address}/${id}`; }
  async pay(id) {
    await this.checkAccount();
    return this.journal.lock(this.key(id), async () => {
      const status = await this.status(id);
      ensure(status.receiver === this.address, 'The request is bound to a different wallet');
      if (!status.missing.length || ['paid', 'permit_issued', 'minted'].includes(status.state)) return status;
      ensure(['awaiting_payment', 'partly_paid'].includes(status.state) && status.payBy?.rail === 'tap', 'This request is not accepting a TAP payment');
      ensure(status.payable !== false || status.missing.some(i => i.tt === 'b'), 'Wait until the reservation is confirmed before paying');
      const items = transferItems(status, this.network);
      const paymentPlan = status.payer ? status : await this.readPaymentPlan?.(id);
      ensure(paymentPlan?.requestId === id && paymentPlan.payer === this.address, 'Select the TAP payer wallet quoted for this request');
      const key = this.key(id), saved = await this.journal.get(key) ?? {};
      // The extension builds its own redeem. If its reply is lost, we cannot
      // reconstruct that transaction; never create a second payment blindly.
      if (saved.payment) return { ...status, localState: 'payment_pending', payment: saved.payment, message: 'A payment was already requested. Wait for its indexed items; inspect the wallet if the result is uncertain.' };
      await this.journal.put(key, { ...saved, payment: { state: 'sending', items } });
      await this.checkAccount();
      const result = await this.provider.singleTxTransfer(items);
      await this.journal.put(key, { ...saved, payment: { state: 'submitted', items, result } });
      return { ...await this.status(id), localState: 'payment_submitted' };
    });
  }
  async fees() {
    const response = await this.fetchImpl('https://mempool.space/api/v1/fees/recommended', { redirect: 'error', signal: AbortSignal.timeout(10000) });
    ensure(response.ok, 'Public Bitcoin fee estimate is unavailable');
    const fees = await response.json();
    ensure(Number.isFinite(fees.halfHourFee) && fees.halfHourFee >= 1 && fees.halfHourFee <= 1000, 'Invalid public Bitcoin fee estimate');
    return fees.halfHourFee;
  }
  async inscribe(id, options = {}) {
    await this.checkAccount();
    const status = await this.status(id);
    if (status.state === 'minted') return status;
    return this.inscribeContent(id, mintContent(status, this.address), 'mint', options);
  }
  async inscribeDeployment(job, { owner, binding, ...options } = {}) {
    await this.checkAccount();
    ensure((job.kind !== 'compound' || job.definition?.firstMaker === owner) && binding?.request?.agent === owner && binding.request.address === this.address && (!job.receiver || job.receiver === this.address),
      'Connect the deploying player’s bound TAP Wallet');
    const { text, attemptId, phase } = deploymentContent(job);
    return { ...await this.inscribeContent(attemptId, text, 'deploy', options), asset: job.asset, phase };
  }
  async inscribeContent(id, text, field, { feeRate, maxFeeSats, confirm } = {}) {
    ensure(typeof confirm === 'function', 'Review the Bitcoin fee before inscribing');
    return this.journal.lock(this.key(id), async () => {
      const key = this.key(id);
      let saved = await this.journal.get(key) ?? {}, plan = saved[field];
      if (!plan) {
        const coins = await this.provider.getBitcoinUtxos();
        ensure(Array.isArray(coins), 'Invalid TAP Wallet funding coins');
        const utxos = coins.filter(c => !c.isUserSpendable && !c.isSpent && Array.isArray(c.inscriptions) && c.inscriptions.length === 0 && c.height > 0).map(c => {
          ensure(Number.isSafeInteger(c.satoshi) && c.satoshi > 0, 'Invalid wallet coin amount');
          return { txid: c.txid, vout: c.vout, value: String(c.satoshi), script: c.scriptPk, confirmed: true, cardinal: true };
        });
        feeRate ??= await this.fees();
        plan = buildInscription({ text, receiver: this.address, publicKey: this.publicKey, network: this.network, utxos, feeRate, maxFeeSats });
        // Saving the pre-signed reveal first makes closing the tab during the
        // wallet's commit approval recoverable without an ephemeral key file.
        await this.journal.put(key, { ...saved, [field]: plan });
        saved = { ...saved, [field]: plan };
      }
      checkSavedFee(plan, maxFeeSats);
      ensure(plan.receiver === this.address && plan.textHash === digest(text), 'Saved inscription differs from this request');
      if (!await confirm({ requestId: id, receiver: plan.receiver, feeRate: plan.feeRate, feeSats: plan.feeSats, postage: plan.postage, resume: !!plan.signedCommitPsbt })) return { state: 'cancelled_locally', requestId: id };
      await this.checkAccount();
      if (!plan.signedCommitPsbt) {
        const signed = await this.provider.signPsbt(plan.commitPsbt, { autoFinalized: true, toSignInputs: plan.inputs.map((_, index) => ({ index, address: this.address })) });
        plan = acceptSignedCommit(plan, signed);
        await this.journal.put(key, { ...saved, [field]: plan });
      }
      await this.checkAccount();
      const broadcast = async (send, expected) => {
        try { const value = await send(); ensure(value === expected, 'Wallet returned a different transaction ID'); }
        catch (error) {
          // Only explicit duplicate-transaction responses count as success.
          // Any other error retains the saved bytes for a later retry.
          if (!/already (?:in block chain|in blockchain|in mempool|known)|txn-already-(?:known|in-mempool)/i.test(String(error?.message))) throw error;
        }
      };
      await broadcast(() => this.provider.pushPsbt(plan.signedCommitPsbt), plan.commitTxid);
      await broadcast(() => this.provider.pushTx(plan.revealHex), plan.revealTxid);
      await this.journal.put(key, { ...saved, [field]: { ...plan, broadcast: true } });
      return { state: 'broadcast', requestId: id, inscriptionId: plan.inscriptionId, commitTxid: plan.commitTxid, revealTxid: plan.revealTxid };
    });
  }
}

export { EthereumMint } from './ethereum-mint.mjs';
