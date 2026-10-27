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
  const network = await tap.getNetwork();
  if (network !== target.bitcoinNetwork) await tap.switchNetwork(target.bitcoinNetwork);
  if (await tap.getNetwork() !== target.bitcoinNetwork) fail('Switch TAP wallet to Bitcoin, then try again.');
  const accounts = await tap.requestAccounts(), address = accounts[0];
  if (!(target.bitcoinNetwork === 'regtest' ? /^bcrt1p/ : /^bc1p/).test(address ?? '')) fail('Select a Bitcoin Taproot wallet.');
  if (expected && address !== expected) fail('Select the TAP payer wallet shown in this request.');
  return { tap, address };
}
export async function ethAccount(target, expected) {
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
  const accounts = await eth.request({ method: 'eth_requestAccounts' }), address = accounts[0]?.toLowerCase();
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
export async function orderResult(tap, result) {
  if (/^[0-9a-f]{64}i\d+$/.test(result?.inscriptionId ?? '') && !result.pending) return result.inscriptionId;
  if (!result?.orderId) fail('Wallet did not return an inscription order. Inspect the wallet before retrying.');
  for (let i = 0; i < 90; i++) {
    const r = await tap.getTapActionOrderResult(result.orderId);
    if (/^[0-9a-f]{64}i\d+$/.test(r?.inscriptionId ?? '') && !r.pending) return r.inscriptionId;
    await wait(2000);
  }
  fail('Inscription order is pending. Resume after it confirms.');
}
// Durable per-step checkpoints avoid resending after cancellation or a reload.
// An unresolved provider call is deliberately not silently retried.
export class WalletJournal {
  constructor(key) { this.key = 'dmw-web-v1/' + key; this.data = JSON.parse(localStorage.getItem(this.key) ?? '{}'); this.save(); }
  save() { localStorage.setItem(this.key, JSON.stringify(this.data)); }
  async step(name, action) {
    const old = this.data[name];
    if (old?.state === 'done') return old.result;
    if (old?.state === 'sending') fail('Wallet response was interrupted. Inspect the wallet transaction before any new payment.');
    this.data[name] = { state: 'sending' }; this.save();
    try { const result = await action(); this.data[name] = { state: 'done', result }; this.save(); return result; }
    catch (e) { if (e.code === 4001) { delete this.data[name]; this.save(); } throw e; }
  }
}
export async function authority(tap, address, journal, notify) {
  let active = await tap.getCurrentAuthority();
  if (/^[0-9a-f]{64}i\d+$/.test(active?.ins ?? '') && Array.isArray(active.auth) && (!active.auth.length || active.auth.includes('tap'))) return active.ins;
  notify('Approve a TAP authority, then its activation in your wallet.');
  const order = await journal.step('authority-order', () => tap.createTapAuthority('tap'));
  const ins = await orderResult(tap, order);
  await journal.step('authority-activation', () => tap.sendInscription(address, ins));
  for (let i = 0; i < 90; i++) { active = await tap.getCurrentAuthority(); if (active?.ins === ins) return ins; await wait(2000); }
  fail('Authority activation is pending. Resume after confirmation.');
}
