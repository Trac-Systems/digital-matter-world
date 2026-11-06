import { checkPaymentWindow, PAYMENT_MIN_BLOCKS } from './payment-window.mjs';
import { hashObject, stableJSON } from '../../rules/src/core.js';
import { validateBulkTerms, validateBulkFees, bulkOrderId, bulkWalletItems } from '../../rules/src/bulk-mint.js';
import { ensure, walletPayer } from './inscription-core.mjs';
import { BrowserMintJournal, TapWalletMint, mintFundingOutput } from './tap-wallet-mint.mjs';
import { tapWalletCapabilities, ensureTapAuthority } from './tap-wallet-actions.mjs';
import { checkTapFunds } from './wallet-funds.mjs';

const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const inscription = value => typeof value === 'string' && /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(value);
const payable = status => status.payable === true && status.state === 'awaiting_payment' && status.payBy?.rail === 'tap' && status.payment?.state === 'unseen' && !status.payment.reference;

export function bulkPaymentPlan(orderId, status, response, network) {
  ensure(hex(orderId) && status?.orderId === orderId && response?.v === 1 && response.orderId === orderId, 'Bulk order ID mismatch');
  const terms = validateBulkTerms(response.terms); validateBulkFees(terms, response.feeManifest);
  ensure(terms.bitcoinNetwork === network && hashObject(terms) === status.termsHash &&
    bulkOrderId(terms.network, terms.owner, terms.nonce) === orderId, 'Bulk payment terms mismatch');
  ensure(['payer', 'receiver', 'asset', 'deployment', 'ticker', 'totalAmount', 'grossFeeAtoms', 'payableFeeAtoms'].every(k => status[k] === terms[k]) &&
    status.count === terms.members.length && status.payBy?.untilBlock === terms.expires, 'Bulk payment summary mismatch');
  return { terms, feeManifest: response.feeManifest, items: bulkWalletItems(terms), extraOutputs: [mintFundingOutput(terms.mintFunding, network)] };
}

// Separate bulk journal keys and validation: no legacy missing-items matcher or
// 32-item limit can accidentally split a bulk redeem into several payments.
export class TapWalletBulkMint {
  constructor({ provider = globalThis.tapprotocol, readStatus, readTerms, reportPayment, network,
    journal = new BrowserMintJournal('dmw-bulk-payments-v1'), fetchImpl = globalThis.fetch, readerPath, readTip, minPaymentBlocks = PAYMENT_MIN_BLOCKS }) {
    Object.assign(this, { provider, readStatus, readTerms, reportPayment, network, journal, fetchImpl, readerPath, readTip, minPaymentBlocks });
  }
  async connect() {
    const capabilities = await tapWalletCapabilities(this.provider);
    ensure(capabilities.singleTxTransferExtraOutputs === true, 'TAP Wallet must support the bulk Bitcoin set-aside');
    for (const name of ['requestAccounts', 'getAccounts', 'getNetwork', 'getPublicKey', 'singleTxTransfer'])
      ensure(typeof this.provider[name] === 'function', `TAP Wallet does not provide ${name}`);
    const accounts = await this.provider.requestAccounts();
    ensure(await this.provider.getNetwork() === this.network, `Select ${this.network} in TAP Wallet`);
    this.address = accounts?.[0]; this.publicKey = await this.provider.getPublicKey();
    // Any TAP Wallet account type works: Taproot, P2WPKH, P2SH-P2WPKH or P2PKH of this key.
    this.payer = walletPayer(this.publicKey, this.address, this.network);
    return { address: this.address, network: this.network };
  }
  async checkAccount() {
    ensure(this.address && (await this.provider.getAccounts())?.[0] === this.address &&
      await this.provider.getNetwork() === this.network && await this.provider.getPublicKey() === this.publicKey,
    'Wallet account or network changed; reconnect before continuing');
  }
  key(id) { return `${this.network}/${this.address}/bulk/${id}`; }
  async plan(id) {
    const [status, response] = await Promise.all([this.readStatus(id), this.readTerms(id)]);
    return { status, ...bulkPaymentPlan(id, status, response, this.network) };
  }
  result(id, payment) {
    const receipt = payment?.receipt ?? {};
    return { orderId: id, localState: payment?.state === 'submitted' ? 'payment_submitted' : 'payment_pending',
      paymentId: receipt.paymentId ?? null, commitTxid: receipt.commitTxid ?? null, revealTxid: receipt.revealTxid ?? null };
  }
  async report(id, payment) {
    const result = this.result(id, payment);
    if (this.reportPayment && [result.paymentId, result.commitTxid, result.revealTxid].some(Boolean)) {
      const { localState, ...report } = result;
      // A failed report leaves the saved wallet receipt available on reload.
      await this.reportPayment(report);
    }
    return result;
  }
  async pay(orderId, { retry = false } = {}) {
    ensure(hex(orderId), 'Invalid bulk order ID');
    const capabilities = await tapWalletCapabilities(this.provider);
    ensure(capabilities.singleTxTransferExtraOutputs === true, 'TAP Wallet must support the bulk Bitcoin set-aside');
    await this.checkAccount();
    return this.journal.lock(this.key(orderId), async () => {
      const first = await this.plan(orderId), key = this.key(orderId), saved = await this.journal.get(key) ?? {};
      ensure(first.terms.payer === this.address, 'Select the TAP payer wallet quoted for this order');
      if (saved.payment) {
        ensure(saved.payment.termsHash === first.status.termsHash, 'Saved bulk payment terms changed');
        if (saved.payment.state === 'submitted') return this.report(orderId, saved.payment);
        if (!retry) return this.result(orderId, saved.payment);
        ensure(saved.payment.state === 'sending', 'This bulk payment cannot be retried');
        await this.checkNothingSent(saved.payment);
      }
      ensure(payable(first.status), 'This bulk order is not accepting a new payment');
      await checkPaymentWindow({ ...this, status: first.status });
      await ensureTapAuthority(this.provider, this.address, null, { checkAccount: () => this.checkAccount() });
      const latest = await this.plan(orderId);
      ensure(payable(latest.status) && latest.status.termsHash === first.status.termsHash &&
        stableJSON(latest.items) === stableJSON(first.items) && stableJSON(latest.extraOutputs) === stableJSON(first.extraOutputs),
      'Bulk payment changed while checking the wallet');
      await this.checkAccount();
      // Never open the wallet for a payment it cannot make: TAP for every group, Bitcoin for fees and the set-aside.
      await checkTapFunds({ provider: this.provider, address: this.address, network: this.network, readerPath: this.readerPath,
        items: first.items, extraOutputs: first.extraOutputs, fetchImpl: this.fetchImpl });
      await this.checkAccount();
      await checkPaymentWindow({ ...this, status: latest.status });
      const payment = { state: 'sending', termsHash: first.status.termsHash, items: first.items, extraOutputs: first.extraOutputs, at: Date.now() };
      await this.journal.put(key, { ...saved, payment });
      await this.checkAccount();
      let result;
      try { result = await this.provider.singleTxTransfer(first.items, { extraOutputs: first.extraOutputs }); }
      catch (error) {
        // Cancellation can arrive after broadcast. Preserve sending on every
        // thrown reply; absence from the TAP index is never permission to repay.
        throw new Error('TAP Wallet returned no payment receipt. Inspect the wallet before explicitly retrying this same order.', { cause: error });
      }
      // txid is the wallet commit, never an invented redeem txid+i0.
      const receipt = {
        paymentId: inscription(result?.inscriptionId) ? result.inscriptionId : inscription(result) ? result : null,
        commitTxid: hex(result?.commitTxid) ? result.commitTxid : hex(result?.txid) ? result.txid : hex(result) ? result : null,
        revealTxid: hex(result?.revealTxid) ? result.revealTxid : null
      };
      if (!Object.values(receipt).some(Boolean)) return this.result(orderId, payment);
      const submitted = { ...payment, state: 'submitted', receipt };
      await this.journal.put(key, { ...saved, payment: submitted });
      return this.report(orderId, submitted);
    });
  }
  async checkNothingSent(payment) {
    ensure(this.network === 'mainnet', 'Cannot independently check this network for an uncertain payment; inspect the saved order');
    const address = payment.extraOutputs?.[0]?.address;
    ensure(typeof address === 'string' && address.length > 0, 'Saved bulk funding output is missing');
    const base = 'https://mempool.space/api/address/' + encodeURIComponent(address);
    const read = async path => {
      const response = await this.fetchImpl(base + path, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      ensure(response.ok, 'Cannot check Bitcoin for the earlier payment attempt');
      return response.json();
    };
    const stats = await read('');
    ensure(Number.isSafeInteger(stats?.chain_stats?.tx_count) && Number.isSafeInteger(stats?.mempool_stats?.tx_count), 'Cannot check Bitcoin for the earlier payment attempt');
    ensure(stats.chain_stats.tx_count === 0 && stats.mempool_stats.tx_count === 0, 'This payment was already sent; wait for confirmation');
    const mempool = await read('/txs/mempool'), chain = await read('/txs/chain');
    ensure(Array.isArray(mempool) && Array.isArray(chain) && mempool.length === 0 && chain.length === 0, 'This payment was already sent; wait for confirmation');
  }
}

// A public bulk order (/public-mints/bulk/<order>): no agent, one TAP Wallet payment. The server's
// authorized status names every fee item (redeem.items) and one Bitcoin set-aside per block
// (extraOutputs). Each is checked here before any wallet call, funds are checked so the wallet never
// opens for a payment it cannot make, and the same journal rules as single mints apply: an uncertain
// send is never repeated blindly. The receipt is reported by its redeem inscription.
const publicPayable = status => status?.payable === true && status.state === 'awaiting_payment' && status.payBy?.rail === 'tap' && !status.paymentIds?.length;
const tapItem = item => item && typeof item === 'object' && typeof item.tick === 'string' && item.tick.length > 0 && item.tick.length <= 32 &&
  typeof item.amt === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(item.amt) && typeof item.address === 'string' && item.address.length > 0 &&
  (item.dta === undefined || typeof item.dta === 'string');
export function publicBulkPaymentPlan(orderId, status, network) {
  ensure(hex(orderId) && status?.publicBulk === true && status.orderId === orderId && !status.requesterRequired, 'Public bulk order ID mismatch');
  ensure(status.bitcoinNetwork === undefined || status.bitcoinNetwork === network, 'Public bulk order network mismatch');
  const items = status.redeem?.items, outputs = status.extraOutputs;
  ensure(Array.isArray(items) && items.length > 0 && items.every(tapItem), 'This order’s fee items are not valid. Nothing was paid. Refresh the order and try again.');
  ensure(Array.isArray(outputs) && outputs.length === status.members?.length, 'This order’s Bitcoin set-aside is not valid. Nothing was paid. Refresh the order and try again.');
  const extraOutputs = outputs.map(output => mintFundingOutput(output, network));
  ensure(String(extraOutputs.reduce((n, o) => n + o.satoshis, 0)) === String(status.mintFundingSatoshis), 'This order’s Bitcoin set-aside does not add up. Nothing was paid. Refresh the order and try again.');
  return { items: items.map(({ tick, amt, address, dta }) => ({ tick, amt, address, ...(dta === undefined ? {} : { dta }) })), extraOutputs };
}
export class TapWalletPublicBulkMint extends TapWalletBulkMint {
  constructor({ readStatus, reportPayment, journal = new BrowserMintJournal('dmw-public-bulk-payments-v1'), ...options }) {
    super({ ...options, journal, readStatus, reportPayment });
    // Called as a method below: keep fetch unbound from this wallet object.
    const fetchImpl = options.fetchImpl ?? globalThis.fetch; this.fetchImpl = (...args) => fetchImpl(...args);
  }
  key(id) { return `${this.network}/${this.address}/public-bulk/${id}`; }
  async plan(id) {
    const status = await this.readStatus(id);
    return { status, ...publicBulkPaymentPlan(id, status, this.network) };
  }
  result(id, payment) {
    const receipt = payment?.receipt ?? {};
    return { orderId: id, localState: payment?.state === 'submitted' ? 'payment_submitted' : 'payment_pending', paymentId: receipt.paymentId ?? null, commitTxid: receipt.commitTxid ?? null };
  }
  // The server takes only the redeem inscription; a wallet that answers with its funding txid is
  // followed on Bitcoin to the reveal (the same lookup as single mints). Null until it is revealed.
  async paymentId(payment) {
    const receipt = payment?.receipt ?? {};
    if (inscription(receipt.paymentId)) return receipt.paymentId;
    if (!hex(receipt.commitTxid) || this.network === 'regtest') return null;
    const base = 'https://mempool.space' + (this.network === 'mainnet' ? '' : '/' + this.network) + '/api/tx/';
    const read = async path => { const r = await this.fetchImpl(base + path, { redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => null); return r?.ok ? r.json() : null; };
    if ((await read(receipt.commitTxid))?.vin?.[0]?.witness?.length >= 3) return receipt.commitTxid + 'i0';
    const spend = await read(receipt.commitTxid + '/outspend/0');
    return spend?.spent && hex(spend.txid) ? spend.txid + 'i0' : null;
  }
  async report(id, payment) {
    const result = this.result(id, payment), paymentId = payment?.state === 'submitted' ? await this.paymentId(payment) : null;
    // A failed report leaves the saved wallet receipt available on reload.
    if (paymentId && this.reportPayment) { await this.reportPayment(id, paymentId); result.reported = true; }
    return { ...result, paymentId };
  }
  // The saved receipt of this browser's payment for the order (any connected account), for reload.
  async saved(id, address) { return address ? (await this.journal.get(`${this.network}/${address}/public-bulk/${id}`))?.payment ?? null : null; }
  async pay(orderId, { retry = false } = {}) {
    ensure(hex(orderId), 'Invalid order ID');
    const capabilities = await tapWalletCapabilities(this.provider);
    ensure(capabilities.singleTxTransferExtraOutputs === true, 'TAP Wallet must support the Bitcoin set-aside');
    await this.checkAccount();
    return this.journal.lock(this.key(orderId), async () => {
      const first = await this.plan(orderId), key = this.key(orderId), saved = await this.journal.get(key) ?? {};
      ensure(first.status.payer === this.address, 'Select the TAP Wallet account this order was started with');
      if (saved.payment) {
        if (saved.payment.state === 'submitted') return this.report(orderId, saved.payment);
        if (!retry) return this.result(orderId, saved.payment);
        // The set-aside address of the first block is this payment's own witness on Bitcoin.
        await TapWalletMint.prototype.checkNothingSent.call(this, saved.payment.at, saved.payment.extraOutputs);
      }
      ensure(publicPayable(first.status), 'This order is not accepting a new payment');
      await checkPaymentWindow({ ...this, status: first.status });
      await ensureTapAuthority(this.provider, this.address, null, { checkAccount: () => this.checkAccount() });
      const latest = await this.plan(orderId);
      ensure(publicPayable(latest.status) && stableJSON(latest.items) === stableJSON(first.items) && stableJSON(latest.extraOutputs) === stableJSON(first.extraOutputs),
        'The order changed while checking the wallet. Refresh it before paying.');
      await this.checkAccount();
      // Never open the wallet for a payment it cannot make: TAP for every fee, Bitcoin for the fees and the set-asides.
      await checkTapFunds({ provider: this.provider, address: this.address, network: this.network, readerPath: this.readerPath,
        items: first.items, extraOutputs: first.extraOutputs, fetchImpl: this.fetchImpl });
      await this.checkAccount();
      await checkPaymentWindow({ ...this, status: latest.status });
      const payment = { state: 'sending', items: first.items, extraOutputs: first.extraOutputs, at: Date.now() };
      await this.journal.put(key, { ...saved, payment });
      let result;
      try { result = await this.provider.singleTxTransfer(first.items, { extraOutputs: first.extraOutputs }); }
      catch (error) {
        // TAP Wallet refuses some payments before anything is signed; nothing was sent then.
        if (typeof error?.message === 'string' && (error.message.startsWith('Transaction cannot be processed') || ['Invalid items', 'Error processing items', 'Error checking token balances'].includes(error.message))) {
          await this.journal.put(key, saved);
          throw new Error(`TAP Wallet refused the payment before signing: ${/Insufficient amount for tokens/.test(error.message) ? 'your wallet does not have enough spendable TAP for these fees' : error.message.replace(/\s+/g, ' ').trim()}. Nothing was sent.`);
        }
        throw new Error('TAP Wallet returned no payment receipt. If your wallet shows no sent payment for this order, press Check and retry; another payment is never sent automatically.', { cause: error });
      }
      const receipt = { paymentId: inscription(result?.inscriptionId) ? result.inscriptionId : inscription(result) ? result : null,
        commitTxid: hex(result?.commitTxid) ? result.commitTxid : hex(result?.txid) ? result.txid : hex(result) ? result : null };
      if (!Object.values(receipt).some(Boolean)) return this.result(orderId, payment);
      const submitted = { ...payment, state: 'submitted', receipt };
      await this.journal.put(key, { ...saved, payment: submitted });
      return this.report(orderId, submitted);
    });
  }
}
