import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex, ensure, fundingAddress, signCommit, networkFor, transferItems } from './inscription-core.mjs';
import * as btc from '@scure/btc-signer';

// BIP86 uses a separate secp256k1 derivation of the already encrypted local
// mnemonic. No key or recovery words enter config, MCP arguments or results.
export function localBitcoinWallet({ wallet, network = 'mainnet', source, authority }) {
  ensure(typeof wallet.mnemonic === 'string', 'The encrypted local signer must contain recovery words');
  const seed = mnemonicToSeedSync(wallet.mnemonic), root = HDKey.fromMasterSeed(seed);
  const path = `m/86'/${network === 'mainnet' ? 0 : 1}'/0'/0/0`, child = root.derive(path);
  seed.fill(0); root.wipePrivateData();
  const key = child.privateKey.slice(), publicKey = hex(secp256k1.getPublicKey(key)); child.wipePrivateData();
  return {
    address: fundingAddress(publicKey, network), publicKey, network, source, path,
    signCommit: plan => signCommit(plan, key),
    redeem(status) {
      ensure(typeof authority === 'string' && /^[0-9a-f]{64}i[0-9]+$/.test(authority), 'Configure this wallet’s indexed token authority');
      const items = transferItems(status, network), redeem = { items, auth: authority, data: status.requestId };
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const hash = sha256(new TextEncoder().encode(JSON.stringify(redeem) + salt));
      const signature = secp256k1.sign(hash, key, { prehash: false, lowS: true });
      return JSON.stringify({ p: 'tap', op: 'token-auth', sig: { v: String(signature.recovery), r: String(signature.r), s: String(signature.s) }, hash: hex(hash), salt, redeem });
    },
    close() { key.fill(0); },
  };
}

// The explicit outpoint list is the owner's choice of cardinal funding coins.
// Fetch and verify amounts, scripts and spend status; never trust config values.
// Browser wallets supply their own asset-aware UTXO list instead.
export function mempoolBitcoinSource({ network = 'mainnet', funding = [], origin = 'https://mempool.space/api', fetchImpl = fetch } = {}) {
  const url = new URL(origin);
  ensure(network === 'mainnet' ? origin === 'https://mempool.space/api' : url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password, 'Use the public mempool API or a loopback regtest fixture');
  ensure(Array.isArray(funding) && funding.length <= 1000 && funding.every(c => /^[0-9a-f]{64}$/.test(c.txid) && Number.isSafeInteger(c.vout) && c.vout >= 0), 'Configure explicitly selected cardinal funding outpoints');
  const selected = new Map(funding.map(coin => [`${coin.txid}:${coin.vout}`, coin]));
  async function read(path, options = {}) {
    const response = await fetchImpl(origin + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return null;
    ensure(response.ok, `Bitcoin API returned HTTP ${response.status}`, 'bitcoin_api_unavailable');
    const text = await response.text(); ensure(text.length <= 2000000, 'Bitcoin response too large');
    return options.method ? text : JSON.parse(text);
  }
  return {
    addFunding(coins) {
      ensure(Array.isArray(coins) && coins.length <= 16 && coins.every(c => /^[0-9a-f]{64}$/.test(c.txid) && c.vout === 1), 'Invalid saved cardinal change');
      selected.clear();
      for (const coin of funding) selected.set(`${coin.txid}:${coin.vout}`, coin);
      for (const coin of coins) selected.set(`${coin.txid}:${coin.vout}`, coin);
    },
    async utxos(address) {
      const expected = hex(btc.OutScript.encode(btc.Address(networkFor(network)).decode(address))), result = [];
      for (const coin of selected.values()) {
        const tx = await read(`/tx/${coin.txid}`), spent = await read(`/tx/${coin.txid}/outspend/${coin.vout}`);
        const out = tx?.vout?.[coin.vout];
        if (spent?.spent || !tx?.status?.confirmed) continue;
        ensure(out?.scriptpubkey === expected && Number.isSafeInteger(out.value) && out.value > 0, 'Selected funding output does not belong to this local signer');
        result.push({ ...coin, value: String(out.value), script: expected, cardinal: true, confirmed: true });
      }
      return result;
    },
    async feeRate() { const fees = await read('/v1/fees/recommended'); return fees?.halfHourFee; },
    async hasTransaction(txid) { return !!await read(`/tx/${txid}`); },
    async broadcast(raw, txid) {
      if (await this.hasTransaction(txid)) return txid;
      const result = await read('/tx', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: raw });
      ensure(result === txid, 'Bitcoin broadcast returned a different transaction ID'); return txid;
    },
  };
}
