import { createRequire } from 'node:module';
import { bitcoin } from '../local/common.mjs';
import { check } from '../kit/lib/check.mjs';
import { networkFor } from '../kit/lib/inscription-core.mjs';
const require = createRequire(new URL('../kit/package.json', import.meta.url));
const btc = require('@scure/btc-signer');
const valid = coin => /^[0-9a-f]{64}$/.test(coin?.txid) && Number.isSafeInteger(coin.vout) && coin.vout >= 0;

// Only owner-selected cardinal coins and the kit journal's saved commit change.
// Signing remains in the encrypted player wallet; this source never owns a key.
export function regtestBitcoinSource({ manifest, funding = [], rpc = (method, args) => bitcoin(manifest, method, args) }) {
  check(manifest.bitcoin.network === 'regtest', 'regtest_bitcoin_source_required');
  check(Array.isArray(funding) && funding.length <= 1000 && funding.every(valid), 'Configure explicitly selected cardinal funding outpoints');
  const selected = new Map(funding.map(c => [`${c.txid}:${c.vout}`, c]));
  return {
    addFunding(coins) {
      check(Array.isArray(coins) && coins.length <= 16 && coins.every(c => valid(c) && c.vout === 1), 'Invalid saved cardinal change');
      selected.clear();
      for (const coin of [...funding, ...coins]) selected.set(`${coin.txid}:${coin.vout}`, coin);
    },
    async utxos(address) {
      const script = Buffer.from(btc.OutScript.encode(btc.Address(networkFor('regtest')).decode(address))).toString('hex');
      const rows = [];
      for (const coin of selected.values()) {
        const output = await rpc('gettxout', [coin.txid, coin.vout, true]);
        if (!output || output.confirmations < 1) continue;
        const value = Math.round(output.value * 100000000);
        check(output.scriptPubKey?.hex === script && Number.isSafeInteger(value) && value > 0, 'Selected funding output does not belong to this local signer');
        rows.push({ ...coin, value: String(value), script, cardinal: true, confirmed: true });
      }
      return rows;
    },
    feeRate: async () => 2,
    async hasTransaction(txid) {
      try { await rpc('getrawtransaction', [txid]); return true; }
      catch (error) { if (error.rpcCode === -5) return false; throw error; }
    },
    async broadcast(raw, txid) {
      if (await this.hasTransaction(txid)) return txid;
      check(await rpc('sendrawtransaction', [raw]) === txid, 'Bitcoin broadcast returned a different transaction ID');
      return txid;
    },
  };
}
