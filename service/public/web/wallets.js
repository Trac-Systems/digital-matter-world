import { ensureTapAuthority, tapOrderResult, requireAuthorityAPI, tapWalletCapabilities } from '../../../kit/lib/tap-wallet-actions.mjs';
import { checkTapFunds, checkEthereumFunds } from '../../../kit/lib/wallet-funds.mjs';
export { TAP_WALLET_MIN_VERSION, TAP_WALLET_TOO_OLD } from '../../../kit/lib/tap-wallet-actions.mjs';
export const wait = ms => new Promise(r => setTimeout(r, ms));
export const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); }
export const unhex = s => Uint8Array.from(s.match(/../g), b => parseInt(b, 16));
export function fail(s) { throw Object.assign(Error(s), { display: true }); }
function walletTarget(target) {
  if (!['mainnet', 'regtest'].includes(target?.bitcoinNetwork) || !/^0x[0-9a-f]+$/i.test(target?.ethereum?.chainId ?? '')) fail('Payments are unavailable.');
  if (target.bitcoinNetwork === 'mainnet' && (BigInt(target.ethereum.chainId) !== 1n || target.ethereum.localRpc)) fail('Payments are unavailable.');
}
export async function tapAccount(target, expected) {
  walletTarget(target);
  const tap = window.tapprotocol; if (!tap?.requestAccounts) fail('Open this page with the TAP wallet extension.');
  await requireTapWallet(tap);
  const network = await tap.getNetwork();
  if (network !== target.bitcoinNetwork) await tap.switchNetwork(target.bitcoinNetwork);
  if (await tap.getNetwork() !== target.bitcoinNetwork) fail('Switch TAP wallet to Bitcoin, then try again.');
  const accounts = await tap.requestAccounts(), address = accounts?.[0];
  if (!(target.bitcoinNetwork === 'regtest' ? /^bcrt1p/ : /^bc1p/).test(address ?? '')) fail('Select a Bitcoin Taproot wallet.');
  if (expected && address !== expected) fail('Select the TAP payer wallet shown in this request.');
  return { tap, address };
}
// pick: let the person choose the account again (a new connect), instead of the one the site was granted before.
export async function ethAccount(target, expected, { pick = false } = {}) {
  walletTarget(target);
  const eth = window.ethereum; if (!eth?.request) fail('Open this page with MetaMask available.');
  const chainId = target.ethereum.chainId;
  if (BigInt(await eth.request({ method: 'eth_chainId' })) !== BigInt(chainId)) {
    try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
    catch (e) {
      if (e.code !== 4902 || !target.ethereum.localRpc) throw e;
      await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: 'Digital Matter World', rpcUrls: [target.ethereum.localRpc], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }] });
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    }
  }
  if (BigInt(await eth.request({ method: 'eth_chainId' })) !== BigInt(chainId)) fail('Switch MetaMask to Ethereum, then try again.');
  if (pick) {
    // Without this MetaMask answers with the account granted earlier, not the one now selected.
    try { await eth.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }
    catch (e) { if (![-32601, 4200].includes(e?.code)) throw e; }
  }
  const accounts = await eth.request({ method: 'eth_requestAccounts' }), address = accounts?.[0]?.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address ?? '')) fail('Select an Ethereum wallet.');
  if (expected && address !== expected.toLowerCase()) fail('Select the MetaMask payer wallet shown in this request.');
  return { eth, address };
}
export async function receipt(eth, tx) {
  if (!/^0x[0-9a-f]{64}$/i.test(tx ?? '')) fail('The wallet did not return a transaction receipt.');
  for (let i = 0; i < 90; i++) {
    const r = await eth.request({ method: 'eth_getTransactionReceipt', params: [tx] });
    if (r) { if (BigInt(r.status) !== 1n) fail('Transaction reverted. Inspect the receipt in your wallet.'); return r; }
    await wait(2000);
  }
  fail('Transaction is still pending. Resume to check it again.');
}
export const orderResult = tapOrderResult;
// TAP Wallet 1.0.48 exposes these APIs. Older providers may lack them.
// Do not substitute singleTxTransfer: it cannot encode locks or claims.
export function requireTapActions(tap) {
  if (typeof tap?.redeemTapActions !== 'function') {
    fail('This TAP Wallet cannot pay Bitmap links: it does not support TAP locks and releases. No payment was sent.');
  }
  requireAuthorityAPI(tap);
}
// Every TAP Wallet action on the site needs TAP Wallet 1.0.49 or newer; asked before any other wallet call.
export async function requireTapWallet(tap = window.tapprotocol) {
  try { return await tapWalletCapabilities(tap); } catch (e) { fail(e.message); }
}
// Durable per-step checkpoints avoid resending after cancellation or a reload.
// An unresolved provider call is deliberately not silently retried.
export class WalletJournal {
  constructor(key) { this.key = 'dmw-web-v1/' + key; this.data = JSON.parse(localStorage.getItem(this.key) ?? '{}'); this.save(); }
  save() { localStorage.setItem(this.key, JSON.stringify(this.data)); }
  getStep(name) { return this.data[name]; }
  async step(name, action, { definitelyNotSent = () => false, beforeSend = async () => {} } = {}) {
    const old = this.data[name];
    if (old?.state === 'done') return old.result;
    if (old?.state === 'sending') fail('Wallet response was interrupted. Inspect the wallet transaction before any new payment.');
    await beforeSend();
    this.data[name] = { state: 'sending' }; this.save();
    try { const result = await action(); this.data[name] = { state: 'done', result }; this.save(); return result; }
    catch (e) { if (definitelyNotSent(e)) { delete this.data[name]; this.save(); } throw e; }
  }
}
// Run checks only for a new send, before recording an uncertain wallet attempt.
// Saved receipts can still be resumed when the wallet balance has since changed.
export function tapPaymentStep(journal, name, { provider, address, network, message, options, transfer = false, fetchImpl = fetch }) {
  return journal.step(name, () => transfer ? provider.singleTxTransfer(message.items) : provider.redeemTapActions(message, options), {
    beforeSend: async () => {
      await checkTapFunds({ provider, address, network, message, items: message.items, actions: message.actions, fetchImpl });
      if ((await provider.getAccounts())?.[0] !== address || await provider.getNetwork() !== network) fail('TAP Wallet account or network changed; reconnect before continuing.');
    },
    definitelyNotSent: error => transfer && error?.message === 'No authority found',
  });
}
export function ethereumPaymentStep(journal, name, { provider, transaction, chainId, token }) {
  return journal.step(name, () => provider.request({ method: 'eth_sendTransaction', params: [transaction] }), {
    beforeSend: async () => {
      await checkEthereumFunds({ provider, transaction, token });
      if ((await provider.request({ method: 'eth_accounts' }))?.[0]?.toLowerCase() !== transaction.from?.toLowerCase()
        || BigInt(await provider.request({ method: 'eth_chainId' })) !== BigInt(chainId)) fail('Ethereum account or network changed; reconnect before continuing.');
    },
  });
}
export function escrowPaymentToken(approval, ethereum, requireAllowance = false) {
  if (approval?.to?.toLowerCase() !== ethereum.token?.toLowerCase() || !/^0x095ea7b3[0-9a-f]{128}$/i.test(approval?.data ?? '')
    || approval.data.slice(10, 74).toLowerCase() !== ethereum.escrow.slice(2).toLowerCase().padStart(64, '0')) fail('Invalid escrow token approval; refresh this payment.');
  return { address: ethereum.token, amount: BigInt('0x' + approval.data.slice(74)), spender: ethereum.escrow, requireAllowance, symbol: 'bridged TAP (ERC-20)' };
}
// Checked before a mint or link starts, so nobody reserves what their wallet cannot pay.
export async function oneTxReady(address) {
  const tap = window.tapprotocol; if (!tap?.requestAccounts) fail('Open this page with the TAP wallet extension.');
  await requireTapWallet(tap);
  return ensureTapAuthority(tap, address);
}
export async function authority(tap, address, journal, notify, checkAccount) {
  requireTapActions(tap);
  return ensureTapAuthority(tap, address, journal, { notify, checkAccount });
}
