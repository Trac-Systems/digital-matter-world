import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SenderHTTP, MintSenderBitcoin } from '../src/mint-sender-source.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { requestKey, btc } from '../src/mint-sender-keys.mjs';
import { hex, unhex, networkFor } from '../../kit/lib/inscription-core.mjs';
const settings = mintSenderSettings({ timeoutMs: 100, bitcoinApiPath: '' });
test('HTTP deadlines include response bodies and redact remote errors; oversized payloads stop', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/hang') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
    else if (req.url === '/fail') res.writeHead(500).end('private-provider-detail');
    else if (req.url === '/large') res.writeHead(200, { 'content-length': settings.maxResponseBytes + 1 }).end();
    else res.writeHead(302, { location: 'https://example.invalid' }).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const http = new SenderHTTP({ origin: 'http://127.0.0.1:' + server.address().port, settings });
  const start = Date.now(); await assert.rejects(http.request('/hang'), /mint_sender_timeout/); assert.ok(Date.now() - start < 1000);
  await assert.rejects(http.request('/fail'), e => e.message === 'mint_sender_http_status' && e.status === 500);
  await assert.rejects(http.request('/large'), /mint_sender_source_unavailable/);
  await assert.rejects(http.request('/redirect'), /mint_sender_source_unavailable/);
});
test('UTXO lookup verifies raw txid, amount and script; current fees and broadcast replies bind', async () => {
  const key = requestKey(new Uint8Array(32).fill(31), 'aa'.repeat(32), 'regtest'), script = btc.p2tr(unhex(key.publicKey).slice(1)).script;
  const tx = new btc.Transaction(); tx.addInput({ txid: '11'.repeat(32), index: 0, witnessUtxo: { script, amount: 10000n }, tapInternalKey: unhex(key.publicKey).slice(1) });
  tx.addOutputAddress(key.address, 9000n, networkFor('regtest')); tx.sign(key.privateKey); tx.finalize();
  const coin = { txid: tx.id, vout: 0, value: 9000, status: { confirmed: false } }; let badAmount = false, wrongBroadcast = false;
  const http = { async request(path, options) {
    if (path.includes('/address/')) return [{ ...coin, value: badAmount ? 8000 : coin.value }];
    if (path.endsWith('/hex')) return tx.hex;
    if (path === '/fee-estimates') return { 3: 2.25 };
    if (path === '/tx') { assert.equal(options.body, tx.hex); return wrongBroadcast ? '00'.repeat(32) : tx.id; }
    if (path.startsWith('/tx/')) return null;
    if (path === '/block-height/0') return 'wrong-network';
  } };
  const bitcoin = new MintSenderBitcoin({ http, network: 'regtest', settings });
  const coins = await bitcoin.utxos(key.address); assert.equal(coins[0].confirmed, false); assert.equal(coins[0].value, '9000');
  badAmount = true; await assert.rejects(bitcoin.utxos(key.address), /coin_binding/);
  assert.equal(await bitcoin.feeRate(), 2.25); await bitcoin.broadcast(tx.hex, tx.id);
  wrongBroadcast = true; await assert.rejects(bitcoin.broadcast(tx.hex, tx.id), /broadcast_binding/);
  await assert.rejects(bitcoin.verifyNetwork(), /bitcoin_network/);
});
