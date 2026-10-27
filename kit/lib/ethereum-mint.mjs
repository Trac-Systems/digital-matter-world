import { ensure, missingItems, digest } from './inscription-core.mjs';
import { keccak_256 } from '@noble/hashes/sha3.js';

const selector = text => Array.from(keccak_256(new TextEncoder().encode(text)).slice(0, 4), b => b.toString(16).padStart(2, '0')).join('');
const DEPOSIT = selector('deposit(bytes32,uint256,(address,uint256,address,uint256,address,uint256,address,uint256,uint256),uint256)');
const RELEASE = selector('release(address,bytes32,bytes)');
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const word = value => BigInt(value).toString(16).padStart(64, '0');

// Uses the existing public escrow checkout and the payer's injected EVM wallet.
// The journal contains only approved public transactions and transaction IDs.
export class EthereumMint {
  constructor({ provider = globalThis.ethereum, readTarget, readPlan, readStatus, journal, network }) {
    Object.assign(this, { provider, readTarget, readPlan, readStatus, journal, network });
  }
  async connect(expected) {
    ensure(this.provider?.request, 'Open this page with an Ethereum wallet');
    const target = await this.readTarget(), eth = target.ethereum;
    ensure(target.bitcoinNetwork === this.network && /^0x[0-9a-f]+$/i.test(eth?.chainId) && address(eth.token) && address(eth.escrow), 'Invalid escrow target');
    ensure(this.network !== 'mainnet' || BigInt(eth.chainId) === 1n && !eth.localRpc, 'Select the mainnet escrow target');
    const accounts = await this.provider.request({ method: 'eth_requestAccounts' });
    this.address = accounts?.[0]?.toLowerCase(); this.target = target;
    ensure(address(this.address) && (!expected || this.address === expected.toLowerCase()), 'Select the Ethereum payer shown in this request');
    await this.checkAccount(); return { address: this.address, target };
  }
  async checkAccount() {
    ensure((await this.provider.request({ method: 'eth_accounts' }))?.[0]?.toLowerCase() === this.address &&
      BigInt(await this.provider.request({ method: 'eth_chainId' })) === BigInt(this.target.ethereum.chainId), 'Ethereum account or network changed; select the expected wallet and chain');
  }
  key(id) { return `ethereum/${this.target.ethereum.chainId}/${this.address}/${id}`; }
  async step(key, name, transaction) {
    const saved = await this.journal.get(key) ?? {}, old = saved[name], fingerprint = digest(JSON.stringify(transaction));
    if (old) {
      ensure(old.fingerprint === fingerprint, 'Escrow transaction changed since preparation');
      ensure(old.txid, 'An Ethereum wallet reply was interrupted. Inspect that wallet before any new send.'); return old.txid;
    }
    await this.checkAccount();
    await this.journal.put(key, { ...saved, [name]: { fingerprint, transaction, state: 'sending' } });
    const txid = await this.provider.request({ method: 'eth_sendTransaction', params: [transaction] });
    ensure(/^0x[0-9a-f]{64}$/i.test(txid), 'Ethereum wallet did not return a transaction ID');
    await this.journal.put(key, { ...saved, [name]: { fingerprint, transaction, txid, state: 'submitted' } });
    return txid;
  }
  async receipt(txid) {
    for (let i = 0; i < 60; i++) {
      const receipt = await this.provider.request({ method: 'eth_getTransactionReceipt', params: [txid] });
      if (receipt) { ensure(BigInt(receipt.status) === 1n, 'Ethereum transaction reverted; inspect its receipt'); return receipt; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw Error('Ethereum transaction is pending. Resume this request to check the same transaction.');
  }
  async plan(id) {
    ensure(/^[0-9a-f]{64}$/.test(id), 'Invalid request ID');
    const plan = await this.readPlan(id);
    ensure(plan.requestId === id && plan.kind === 'ethereum' && plan.payer?.toLowerCase() === this.address, 'Escrow plan belongs to a different request or payer');
    const a = plan.target?.ethereum, b = this.target.ethereum;
    ensure(a && BigInt(a.chainId) === BigInt(b.chainId) && a.token.toLowerCase() === b.token.toLowerCase() && a.escrow.toLowerCase() === b.escrow.toLowerCase(), 'Escrow target changed');
    missingItems(plan); return plan;
  }
  async pay(id) {
    await this.checkAccount();
    return this.journal.lock(this.key(id), async () => {
      const plan = await this.plan(id);
      if (!plan.missing.length || plan.ethereumDepositStatus !== 0) return { state: 'payment_pending', requestId: id, sent: false };
      ensure(plan.payable && ['awaiting_payment', 'partly_paid'].includes(plan.state), 'This request is not accepting an Ethereum deposit');
      let [approve, deposit] = plan.transactions ?? []; const eth = this.target.ethereum;
      const valid = tx => tx && tx.from?.toLowerCase() === this.address && /^0x[0-9a-f]+$/i.test(tx.data) && (!tx.value || BigInt(tx.value) === 0n);
      ensure(valid(approve) && valid(deposit) && plan.transactions.length === 2 && approve.to.toLowerCase() === eth.token.toLowerCase() && deposit.to.toLowerCase() === eth.escrow.toLowerCase(), 'Invalid escrow payment transactions');
      const amount = plan.payableAmount;
      ensure(typeof amount === 'string' && /^[1-9][0-9]*$/.test(amount), 'Invalid escrow amount');
      ensure(approve.data.toLowerCase() === '0x095ea7b3' + eth.escrow.slice(2).toLowerCase().padStart(64, '0') + word(amount), 'Token approval differs from the quoted amount');
      ensure(BigInt(amount) === plan.fees.reduce((sum, item) => sum + BigInt(item.amount), 0n), 'Escrow amount differs from the fee items');
      ensure(deposit.data.toLowerCase().startsWith('0x' + DEPOSIT + id + word(amount)), 'Escrow deposit differs from the quote');
      const key = this.key(id), saved = await this.journal.get(key) ?? {};
      if (saved.terms) {
        ensure(saved.terms.approve.data === approve.data && saved.terms.deposit.data.slice(0, -64) === deposit.data.slice(0, -64) && saved.terms.amount === amount, 'Saved escrow terms differ from this quote');
        ({ approve, deposit } = saved.terms);
      } else await this.journal.put(key, { ...saved, terms: { approve, deposit, amount } });
      // Pass only public wallet fields; never accept gas overrides or another value.
      const tx = value => ({ from: this.address, to: value.to, data: value.data, value: '0x0' });
      const approval = await this.step(key, 'approval', tx(approve)); await this.receipt(approval);
      const fresh = await this.plan(id);
      if (fresh.ethereumDepositStatus !== 0) return { state: 'payment_pending', requestId: id, sent: false };
      ensure(fresh.payable && fresh.transactions?.[1]?.data.slice(0, -64) === deposit.data.slice(0, -64) && fresh.payableAmount === amount, 'Escrow quote changed; review the current request');
      const payment = await this.step(key, 'deposit', tx(deposit));
      return { state: 'payment_submitted', requestId: id, transaction: payment };
    });
  }
  async release(id) {
    await this.checkAccount();
    return this.journal.lock(this.key(id), async () => {
      const plan = await this.plan(id), release = (await this.readStatus(id)).ethereumRelease;
      ensure(release && BigInt(release.chainId) === BigInt(this.target.ethereum.chainId) && release.to.toLowerCase() === this.target.ethereum.escrow.toLowerCase(), 'The committee release is not ready');
      ensure(release.data?.toLowerCase().startsWith('0x' + RELEASE + plan.payer.slice(2).toLowerCase().padStart(64, '0') + id), 'Release differs from this payer and request');
      const transaction = await this.step(this.key(id), 'release', { from: this.address, to: release.to, data: release.data, value: '0x0' });
      return { state: 'release_submitted', requestId: id, transaction };
    });
  }
}
