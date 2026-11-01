import { checkPaymentWindow, PAYMENT_MIN_BLOCKS } from './payment-window.mjs';
import * as btc from '@scure/btc-signer';
import { buildInscription, acceptSignedCommit, mintContent, missingItems, transferItems, fundingAddress, ensure, digest, checkSavedFee, deploymentContent, checkDeployer, networkFor } from './inscription-core.mjs';
import { ensureTapAuthority, noAuthority, GLOBAL_AUTHORITY_NOTICE, tapWalletCapabilities } from './tap-wallet-actions.mjs';
import { checkTapFunds, checkBitcoinFunds, cardinalCoins, bitcoinFeeRate, readFunds, displayAmount } from './wallet-funds.mjs';
export { ensureTapAuthority, tapOrderResult, requireAuthorityAPI, GLOBAL_AUTHORITY_NOTICE, noAuthority, TAP_WALLET_MIN_VERSION, TAP_WALLET_TOO_OLD, versionAtLeast, tapWalletCapabilities } from './tap-wallet-actions.mjs';

// The Bitcoin a TAP payment sets aside so the server can send the mint
// inscription once the permit exists (TAP Wallet 1.0.49 extraOutputs).
// Checked before any wallet call: a segwit address of this network, a bounded
// amount and a short plain-text label. Anything else is refused, never sent.
export const MINT_FUNDING_MIN_SATS = 546, MINT_FUNDING_MAX_SATS = 100000;
export function mintFundingOutput(funding, network) {
  const invalid = 'This request’s Bitcoin set-aside for the mint is not valid. Nothing was paid. Refresh the request and try again.';
  ensure(funding && typeof funding === 'object' && typeof funding.address === 'string' && funding.address === funding.address.toLowerCase(), invalid);
  let type;
  try { type = btc.Address(networkFor(network)).decode(funding.address).type; } catch { type = null; }
  ensure(['wpkh', 'wsh', 'tr'].includes(type), invalid);
  ensure(Number.isSafeInteger(funding.satoshis) && funding.satoshis >= MINT_FUNDING_MIN_SATS && funding.satoshis <= MINT_FUNDING_MAX_SATS, invalid);
  const label = funding.label ?? 'your mint inscription';
  ensure(typeof label === 'string' && /^[^\u0000-\u001f\u007f<>]{1,40}$/.test(label), invalid);
  return { address: funding.address, satoshis: funding.satoshis, label };
}

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

const userCancelled = error => error?.message === 'User rejected the request.';
// TAP Wallet's transfer popup refuses these before anything is signed or broadcast
// (its balance and item checks run when the popup opens), so nothing can have been sent.
const refusedBeforeSigning = error => typeof error?.message === 'string' && (error.message.startsWith('Transaction cannot be processed')
  || ['Invalid items', 'Error processing items', 'Error checking token balances'].includes(error.message));

export class TapWalletMint {
  constructor({ provider = globalThis.tapprotocol, readStatus, readPaymentPlan, network, readerPath, readTip, minPaymentBlocks = PAYMENT_MIN_BLOCKS, journal = new BrowserMintJournal(), fetchImpl = fetch, notify = () => {} }) {
    Object.assign(this, { provider, readStatus, readPaymentPlan, network, readerPath, readTip, minPaymentBlocks, journal, notify });
    this.fetchImpl = (...args) => fetchImpl(...args);
  }
  async connect() {
    ensure(this.provider, 'Connect TAP Wallet to pay and inscribe');
    this.capabilities = await tapWalletCapabilities(this.provider);
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
  // One approval (TAP Wallet 1.0.49): with the request's mintFunding the same
  // payment transaction sets aside the Bitcoin for the server-sent mint.
  async pay(id, { retry = false } = {}) {
    const capabilities = await tapWalletCapabilities(this.provider);
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
      const setAside = value => capabilities?.singleTxTransferExtraOutputs === true && (value.mintFunding ?? paymentPlan.mintFunding)
        ? mintFundingOutput(value.mintFunding ?? paymentPlan.mintFunding, this.network) : null;
      const extra = setAside(status);
      const key = this.key(id), saved = await this.journal.get(key) ?? {};
      // The extension builds its own redeem. If its reply is lost, we cannot
      // reconstruct that transaction; never create a second payment blindly.
      // A 'sending' record without a receipt may be retried only on the
      // player's explicit word that the wallet shows no sent payment.
      if (saved.payment?.state === 'sending' && retry) await this.checkNothingSent(saved.payment.at, saved.payment.extraOutputs);
      if (saved.payment && !(retry && saved.payment.state === 'sending')) return { ...status, localState: 'payment_pending', payment: saved.payment, retryable: saved.payment.state === 'sending',
        message: saved.payment.state === 'sending' ? 'TAP Wallet returned no receipt for the last payment attempt. If your wallet shows no sent payment for this request, retry the payment.' : 'A payment was already requested. Wait for its indexed items; inspect the wallet if the result is uncertain.' };
      // 1-TX Transfers must already be on in TAP Wallet; DMW never sets them up.
      await checkPaymentWindow({ ...this, status });
      await ensureTapAuthority(this.provider, this.address, null, { checkAccount: () => this.checkAccount() });
      await this.checkAccount();
      // Re-read after authority setup: the reservation/fees may have changed.
      const latest = await this.status(id);
      ensure(latest.receiver === this.address && (latest.payer ?? paymentPlan.payer) === this.address &&
        ['awaiting_payment', 'partly_paid'].includes(latest.state) && latest.payable !== false &&
        JSON.stringify(transferItems(latest, this.network)) === JSON.stringify(items) &&
        JSON.stringify(setAside(latest)) === JSON.stringify(extra), 'Payment changed while checking the wallet. Refresh the request before continuing.');
      await this.checkAccount();
      await checkTapFunds({ provider: this.provider, address: this.address, network: this.network, readerPath: this.readerPath,
        items, extraOutputs: extra ? [extra] : [], fetchImpl: this.fetchImpl });
      await this.checkAccount();
      await checkPaymentWindow({ ...this, status: latest });
      await this.journal.put(key, { ...saved, payment: { state: 'sending', items, ...(extra ? { extraOutputs: [extra] } : {}), at: Date.now() } });
      let result;
      // Without a set-aside the call stays exactly the 1.0.48 one (no options argument).
      try { result = await (extra ? this.provider.singleTxTransfer(items, { extraOutputs: [extra] }) : this.provider.singleTxTransfer(items)); }
      catch (error) {
        // This exact 1.0.48 prerequisite error occurs before payment approval.
        // A generic 4001 can arrive after broadcast and must remain uncertain.
        if (noAuthority(error)) {
          await this.journal.put(key, saved);
          throw Error(GLOBAL_AUTHORITY_NOTICE);
        }
        // Reject also arrives when the popup closes mid-broadcast, so a
        // cancel stays a retryable 'sending' record, never a silent reset.
        if (refusedBeforeSigning(error)) {
          await this.journal.put(key, saved);
          const reason = /Insufficient amount for tokens/.test(error.message) ? 'your wallet does not have enough spendable TAP for these fees (TAP held in transfer inscriptions is not spendable here)' : error.message.replace(/\s+/g, ' ').trim();
          throw Error(`TAP Wallet refused the payment before signing: ${reason}. Nothing was sent. Fix that, then press ${extra ? 'Pay and mint' : 'Pay missing items'} again.`);
        }
        if (userCancelled(error)) throw Error(`TAP Wallet reports the payment was cancelled. If you did not confirm it in the wallet, press ${extra ? 'Pay and mint' : 'Pay missing items'} again and confirm the retry.`);
        const said = typeof error?.message === 'string' && /missingorspent|missing-inputs|inputs-missing/i.test(error.message)
          ? ' TAP Wallet tried to spend Bitcoin that your previous payment already used; that payment is still waiting for its block. Wait until it confirms (usually within 10 minutes).'
          : typeof error?.message === 'string' && error.message ? ` TAP Wallet said: “${error.message.slice(0, 300)}”.` : '';
        throw Error(`TAP Wallet did not return a payment receipt.${said} If your wallet shows no sent payment for this request, press ${extra ? 'Pay and mint' : 'Pay missing items'} again and confirm the retry; another payment is never sent automatically.`);
      }
      await this.journal.put(key, { ...saved, payment: { state: 'submitted', items, ...(extra ? { extraOutputs: [extra] } : {}), result } });
      return { ...await this.status(id), localState: 'payment_submitted', ...(extra ? { mintFunded: true } : {}) };
    });
  }
  // The deploy fee of an additional ticker: the request's own wallet items in
  // one TAP transfer, with its refund set-aside when the request names one.
  // The same journal rules as pay(): an uncertain send is never repeated blindly.
  async payTickerFee(job, { retry = false } = {}) {
    const capabilities = await tapWalletCapabilities(this.provider);
    await this.checkAccount();
    ensure(/^[0-9a-f]{64}$/.test(job?.id ?? '') && job.officialDeployment, 'Invalid ticker request');
    return this.journal.lock(this.key('ticker/' + job.id), async () => {
      const fee = job.fee;
      ensure(job.receiver === this.address, 'Connect the TAP Wallet that requested this ticker');
      ensure(fee?.payable === true && ['awaiting_payment', 'partly_paid'].includes(fee.state), 'This ticker fee is not accepting a payment');
      const items = fee.redeem?.items;
      ensure(Array.isArray(items) && items.length > 0 && items.every(i => typeof i?.address === 'string' && i.tick === 'tap' && /^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(i.amt ?? '') && typeof i.dta === 'string'),
        'Invalid ticker fee items. Nothing was paid.');
      const extra = capabilities?.singleTxTransferExtraOutputs === true && fee.refundFunding ? mintFundingOutput(fee.refundFunding, this.network) : null;
      const key = this.key('ticker/' + job.id), saved = await this.journal.get(key) ?? {};
      if (saved.payment?.state === 'sending' && retry) await this.checkNothingSent(saved.payment.at, saved.payment.extraOutputs);
      if (saved.payment && !(retry && saved.payment.state === 'sending')) return { localState: 'payment_pending', payment: saved.payment, retryable: saved.payment.state === 'sending',
        message: saved.payment.state === 'sending' ? 'TAP Wallet returned no receipt for the last payment attempt. If your wallet shows no sent payment for this ticker, retry the payment.' : 'The fee was already paid from this browser. Wait for it to be confirmed.' };
      await ensureTapAuthority(this.provider, this.address, null, { checkAccount: () => this.checkAccount() });
      await this.checkAccount();
      await checkTapFunds({ provider: this.provider, address: this.address, network: this.network, readerPath: this.readerPath,
        items, extraOutputs: extra ? [extra] : [], fetchImpl: this.fetchImpl });
      await this.checkAccount();
      await this.journal.put(key, { ...saved, payment: { state: 'sending', items, ...(extra ? { extraOutputs: [extra] } : {}), at: Date.now() } });
      let result;
      try { result = await (extra ? this.provider.singleTxTransfer(items, { extraOutputs: [extra] }) : this.provider.singleTxTransfer(items)); }
      catch (error) {
        if (noAuthority(error)) { await this.journal.put(key, saved); throw Error(GLOBAL_AUTHORITY_NOTICE); }
        if (refusedBeforeSigning(error)) {
          await this.journal.put(key, saved);
          throw Error(`TAP Wallet refused the payment before signing: ${error.message.replace(/\s+/g, ' ').trim()}. Nothing was sent.`);
        }
        throw Error('TAP Wallet did not return a payment receipt. If your wallet shows no sent payment for this ticker, press Pay deploy fee again and confirm the retry; another payment is never sent automatically.');
      }
      await this.journal.put(key, { ...saved, payment: { state: 'submitted', items, ...(extra ? { extraOutputs: [extra] } : {}), result } });
      return { localState: 'payment_submitted', result, paymentId: typeof result === 'string' ? result : result?.inscriptionId ?? null };
    });
  }
  // An additional ticker's deploy: the exact registered content, inscribed to the wallet that requested it.
  async inscribeTickerDeployment(job, { validateTicker, ...options } = {}) {
    await this.checkAccount();
    ensure(job?.officialDeployment && job.receiver === this.address, 'Connect the TAP Wallet that requested this ticker');
    const { text, attemptId, phase } = deploymentContent(job, { validateTicker });
    return { ...await this.inscribeContent(attemptId, text, 'deploy', options), asset: job.asset, phase };
  }
  // A retry without a wallet receipt is allowed only when Bitcoin shows that
  // this wallet sent nothing since the attempt: no unconfirmed transaction and
  // no confirmed one newer than the attempt (or the last six hours, if older
  // records lack a time). Unrelated wallet activity also waits, never pays twice.
  async checkNothingSent(at, extraOutputs) {
    if (this.network === 'regtest') return;
    const site = 'https://mempool.space' + (this.network === 'mainnet' ? '' : '/' + this.network) + '/api/address/';
    // The payment also sends this request's Bitcoin set-aside to its own address: that address is the exact witness.
    // It received nothing (mempool or chain) means this payment was never sent, whatever else the wallet did.
    const own = extraOutputs?.[0]?.address;
    let base = site + (own ?? this.address);
    const read = async path => {
      const response = await this.fetchImpl(base + path, { redirect: 'error', signal: AbortSignal.timeout(10000) })
        .catch(() => ensure(false, 'Cannot check Bitcoin for the earlier payment attempt: mempool.space did not answer in time. Nothing was sent; try again shortly.'));
      ensure(response.ok, 'Cannot check Bitcoin for the earlier payment attempt. Try again shortly.');
      const txs = await response.json(); ensure(Array.isArray(txs), 'Cannot check Bitcoin for the earlier payment attempt. Try again shortly.');
      return txs;
    };
    if (own) {
      const received = [...await read('/txs/mempool'), ...await read('/txs/chain')];
      ensure(!received.length, 'This payment was already sent. Wait for the request to update; it does not need to be paid again.');
      return;
    }
    base = site + this.address;
    ensure(!(await read('/txs/mempool')).length, 'A transaction from this wallet is still unconfirmed. Wait until it confirms; if it was this payment, the request will update by itself.');
    const since = Math.floor((Number.isSafeInteger(at) ? at : Date.now() - 6 * 3600_000) / 1000) - 600;
    ensure(!(await read('/txs/chain')).some(tx => !tx.status?.block_time || tx.status.block_time >= since),
      'This wallet sent a Bitcoin transaction after the earlier payment attempt. Wait for the request to update before paying again.');
  }
  // TAP Wallet's receipt names the funding transaction of its redeem order; the
  // payment the service verifies is the redeem inscription revealed from it.
  // Resolve that from Bitcoin so the page can report it. Null until revealed.
  async paymentInscription(id, address = this.address) {
    if (!address || this.network === 'regtest') return null;
    const saved = await this.journal.get(`${this.network}/${address}/${id}`);
    const txid = saved?.payment?.state === 'submitted' ? saved.payment.result?.txid : null;
    if (!/^[0-9a-f]{64}$/.test(txid ?? '')) return null;
    const base = 'https://mempool.space' + (this.network === 'mainnet' ? '' : '/' + this.network) + '/api/tx/';
    const read = async path => {
      const response = await this.fetchImpl(base + path, { redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => null);
      return response?.ok ? response.json() : null;
    };
    // A script-path spend is itself the reveal; otherwise follow output 0.
    if ((await read(txid))?.vin?.[0]?.witness?.length >= 3) return txid + 'i0';
    const spend = await read(txid + '/outspend/0');
    return spend?.spent && /^[0-9a-f]{64}$/.test(spend.txid ?? '') ? spend.txid + 'i0' : null;
  }
  // A mint inscription this browser already broadcast, so the page shows it
  // instead of offering a second inscription while Bitcoin confirms it.
  async sentInscription(id, address = this.address, field = 'mint') {
    if (!address) return null;
    const plan = (await this.journal.get(`${this.network}/${address}/${id}`))?.[field];
    return plan?.broadcast ? { inscriptionId: plan.inscriptionId, commitTxid: plan.commitTxid, revealTxid: plan.revealTxid } : null;
  }
  async fees() {
    return readFunds('Bitcoin fee estimate', this.address, signal => bitcoinFeeRate(this.fetchImpl, signal));
  }
  async inscribe(id, options = {}) {
    await this.checkAccount();
    const status = await this.status(id);
    if (status.state === 'minted') return status;
    return this.inscribeContent(id, mintContent(status, this.address), 'mint', options);
  }
  async inscribeDeployment(job, { owner, binding, publicRequest, ...options } = {}) {
    await this.checkAccount();
    if (publicRequest) {
      ensure(publicRequest.publicMint === true && publicRequest.kind === 'tap' && job.kind === 'dmt'
        && publicRequest.asset === job.asset && publicRequest.receiver === this.address && (!job.receiver || job.receiver === this.address),
        'Connect the TAP Wallet receiving this public mint');
    } else ensure(typeof owner === 'string' && (job.kind !== 'compound' || job.definition?.firstMaker === owner)
      && binding?.request?.agent === owner && binding.request.address === this.address && (!job.receiver || job.receiver === this.address),
      'Connect the deploying player’s bound TAP Wallet');
    checkDeployer(job, { owner: publicRequest ? undefined : owner, address: this.address });
    const { text, attemptId, phase } = deploymentContent(job);
    return { ...await this.inscribeContent(attemptId, text, 'deploy', options), asset: job.asset, phase };
  }
  async inscribeContent(id, text, field, { feeRate, maxFeeSats, confirm } = {}) {
    ensure(typeof confirm === 'function', 'Review the Bitcoin fee before inscribing');
    await tapWalletCapabilities(this.provider);
    return this.journal.lock(this.key(id), async () => {
      const key = this.key(id);
      let saved = await this.journal.get(key) ?? {}, plan = saved[field];
      if (!plan) {
        const coins = await cardinalCoins(this.provider, this.address, { fetchImpl: this.fetchImpl });
        const utxos = coins.map(c => ({ txid: c.txid, vout: c.vout, value: String(c.satoshi), script: c.scriptPk, confirmed: true, cardinal: true }));
        feeRate ??= await this.fees();
        try { plan = buildInscription({ text, receiver: this.address, publicKey: this.publicKey, network: this.network, utxos, feeRate, maxFeeSats }); }
        catch (error) {
          if (error.requiredSats !== undefined) throw Error(`Not enough Bitcoin for fees: this inscription needs about ${displayAmount(error.requiredSats)} sats including postage and change, your wallet can fund ${displayAmount(error.availableSats)} sats from up to 16 spendable coins. Wallet: ${this.address}. Nothing was sent. Miner fees are an estimate.`);
          throw error;
        }
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
        try {
          await checkBitcoinFunds({ provider: this.provider, address: this.address,
            requiredSats: BigInt(plan.feeSats) + BigInt(plan.postage), inputs: plan.inputs });
        } catch (error) {
          // No wallet signature exists: a new click may safely rebuild from
          // fresh coins. Never discard a signed commit or an uncertain send.
          const next = { ...saved }; delete next[field]; await this.journal.put(key, next);
          throw error;
        }
        await this.checkAccount();
        const signed = await this.provider.signPsbt(plan.commitPsbt, { autoFinalized: true, inputForSigns: plan.inputs.map((_, index) => ({ index, address: this.address })) });
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
export { discovererOnly } from './inscription-core.mjs';
