// Bitcoin script acceptance; TAP delivery evidence is covered by the source fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { requestKey, refundFloatKey, fundingAmount, btc } from '../src/mint-sender-keys.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { tokenAuth, refundRedeem } from '../src/mint-refund-protocol.mjs';
import { buildAuthorityTap } from '../src/mint-refund-sender.mjs';
import { publicRefundKey } from '../../contract/public-mint.js';
import { buildInscription, signCommit, unhex, hex, networkFor } from '../../kit/lib/inscription-core.mjs';

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
test('Bitcoin accepts float authority activation and a payer-funded refund with payer change', { timeout: 60000 }, async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url)), directory = await mkdtemp(join(root, '.rf1-bitcoin-')), port = await freePort();
  const seed = new Uint8Array(32).fill(53), float = refundFloatKey(seed, 'regtest'), payer = requestKey(seed, '11'.repeat(32), 'regtest'), fund = requestKey(seed, '22'.repeat(32), 'regtest');
  const child = spawn(process.env.DMW_BITCOIND ?? 'bitcoind', [`-datadir=${directory}`, '-regtest', '-server=1', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-fixedseeds=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${port}`, '-fallbackfee=0.00001', '-printtoconsole=0'], { stdio: 'ignore' });
  let startupError; child.on('error', error => { startupError = error; });
  t.after(async () => {
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await ended; clearTimeout(timer);
      }
    } finally { seed.fill(0); for (const key of [float, payer, fund]) key.privateKey.fill(0); await rm(directory, { recursive: true, force: true }); }
  });
  let cookie;
  async function rpc(method, params = [], wallet = '') {
    const response = await fetch(`http://127.0.0.1:${port}` + (wallet ? '/wallet/' + wallet : ''), {
      method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cookie).toString('base64'), 'content-type': 'application/json' },
      // Mining the initial fixture chain can exceed a normal RPC's budget.
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method === 'generatetoaddress' ? 20000 : 5000),
    });
    const value = await response.json(); if (value.error) throw Object.assign(Error('bitcoin_fixture_rpc'), { rpcCode: value.error.code }); return value.result;
  }
  const deadline = Date.now() + 20000;
  for (;;) {
    if (startupError) throw Error('bitcoin_fixture_start_failed');
    try { cookie = (await readFile(join(directory, 'regtest/.cookie'), 'utf8')).trim(); await rpc('getblockchaininfo'); break; }
    catch { if (Date.now() >= deadline) throw Error('bitcoin_fixture_start_timeout'); await sleep(100); }
  }
  await rpc('createwallet', ['fixture']);
  const mining = await rpc('getnewaddress', [], 'fixture'), mine = async (n = 1) => rpc('generatetoaddress', [n, mining]);
  await mine(101);
  const settings = mintSenderSettings({ refundsEnabled: true });
  async function fundCoin(key, value) {
    const txid = await rpc('sendtoaddress', [key.address, value / 100000000], 'fixture'); await mine();
    const tx = btc.Transaction.fromRaw(unhex(await rpc('getrawtransaction', [txid]))), script = hex(btc.p2tr(unhex(key.publicKey).slice(1), undefined, networkFor('regtest')).script);
    const vout = Array.from({ length: tx.outputsLength }, (_, n) => n).find(n => hex(tx.getOutput(n).script) === script);
    return { txid, vout, script, value: String(tx.getOutput(vout).amount), cardinal: true, confirmed: true };
  }
  const floatCoin = await fundCoin(float, 30000);
  const payload = tokenAuth(['tap'], 'auth', float.privateKey, 'bitcoin-fixture-authority');
  const authority = signCommit(buildInscription({ text: JSON.stringify(payload), receiver: float.address, publicKey: float.publicKey, network: 'regtest', utxos: [floatCoin], feeRate: 2, maxFeeSats: '20000' }), float.privateKey);
  const activation = buildAuthorityTap(authority, float, 'regtest', settings);
  assert.equal(await rpc('sendrawtransaction', [authority.commitHex]), authority.commitTxid);
  assert.equal(await rpc('sendrawtransaction', [authority.revealHex]), authority.revealTxid); await mine();
  assert.equal(await rpc('sendrawtransaction', [activation.hex]), activation.txid); await mine();
  assert.ok((await rpc('gettxout', [activation.txid, 0])).confirmations > 0);
  const payerCoin = await fundCoin(fund, fundingAmount(settings));
  const record = { id: '22'.repeat(32), reference: '33'.repeat(32) + 'i0', tapAddress: payer.address, state: 'owed', fees: [{ ticker: 'tap', amount: '1234567891234567890' }] };
  record.refundId = publicRefundKey(record).split('/').at(-1);
  const redeem = refundRedeem(record, authority.inscriptionId, float.privateKey, 'regtest', settings);
  const plan = signCommit(buildInscription({ text: redeem.text, receiver: payer.address, publicKey: fund.publicKey, network: 'regtest', utxos: [payerCoin],
    changeAddress: payer.address, feeRate: 2, maxFeeSats: String(settings.refundReserveSats) }), fund.privateKey);
  const acceptance = await rpc('testmempoolaccept', [[plan.commitHex]]); assert.equal(acceptance[0].allowed, true);
  assert.equal(await rpc('sendrawtransaction', [plan.commitHex]), plan.commitTxid);
  assert.equal((await rpc('testmempoolaccept', [[plan.revealHex]]))[0].allowed, true);
  assert.equal(await rpc('sendrawtransaction', [plan.revealHex]), plan.revealTxid); await mine();
  const change = await rpc('gettxout', [plan.commitTxid, 1]), postage = await rpc('gettxout', [plan.revealTxid, 0]);
  assert.equal(change.scriptPubKey.address, payer.address); assert.equal(postage.scriptPubKey.address, payer.address);
  assert.equal(Math.round((change.value + postage.value) * 100000000) + Number(plan.feeSats), Number(payerCoin.value));
  assert.ok((await rpc('gettxout', [activation.txid, 0])).confirmations > 0, 'refund did not spend float BTC');
});
