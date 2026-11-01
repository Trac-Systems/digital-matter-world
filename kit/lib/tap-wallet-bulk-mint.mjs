import { hashObject, stableJSON } from '../../rules/src/core.js';
import { validateBulkTerms, validateBulkFees, bulkOrderId, bulkWalletItems } from '../../rules/src/bulk-mint.js';
import { ensure, fundingAddress } from './inscription-core.mjs';
import { BrowserMintJournal, mintFundingOutput } from './tap-wallet-mint.mjs';
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
    journal = new BrowserMintJournal('dmw-bulk-payments-v1'), fetchImpl = globalThis.fetch, readerPath }) {
    Object.assign(this, { provider, readStatus, readTerms, reportPayment, network, journal, fetchImpl, readerPath });
  }
  async connect() {
    const capabilities = await tapWalletCapabilities(this.provider);
    ensure(capabilities.singleTxTransferExtraOutputs === true, 'TAP Wallet must support the bulk Bitcoin set-aside');
    for (const name of ['requestAccounts', 'getAccounts', 'getNetwork', 'getPublicKey', 'singleTxTransfer'])
      ensure(typeof this.provider[name] === 'function', `TAP Wallet does not provide ${name}`);
    const accounts = await this.provider.requestAccounts();
    ensure(await this.provider.getNetwork() === this.network, `Select ${this.network} in TAP Wallet`);
    this.address = accounts?.[0]; this.publicKey = await this.provider.getPublicKey();
    ensure(this.address === fundingAddress(this.publicKey, this.network), 'Select a Taproot account in TAP Wallet');
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
