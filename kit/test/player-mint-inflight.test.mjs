import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { signCommit, hex, fundingAddress } from '../lib/inscription-core.mjs';
import { PlayerMint } from '../lib/player-mint.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { Journal } from '../lib/journal.mjs';
import { temp, cleanup } from './helpers.mjs';

const id = '12'.repeat(32), payee = '34'.repeat(32), owner = 'fixture-first-maker';
// A local signer whose broadcasts are recorded; the gateway is the test's service stub.
function fixture() {
  const key = schnorr.utils.randomPrivateKey(), publicKey = hex(schnorr.getPublicKey(key)), address = fundingAddress(publicKey, 'regtest');
  const fees = [{ role: 'treasury', to: address, ticker: 'tap', amount: '1230000000000000001', tt: 'a', dta: `dmw-pay-v2|${id}|treasury` }];
  const status = { requestId: id, receiver: address, payer: address, asset: 'cfixture', amount: '2', fees, missing: fees, payBy: { rail: 'tap', untilBlock: 500 }, state: 'awaiting_payment' };
  // Two coins: a saved transaction keeps the coin it spends, so the next one pays from the other.
  const utxos = [0, 1].map(vout => ({ txid: payee, vout, value: '100000', script: hex(btc.p2tr(schnorr.getPublicKey(key)).script), cardinal: true, confirmed: true }));
  const sends = [];
  const wallet = { address, publicKey, network: 'regtest', signCommit: p => signCommit(p, key), redeem: () => JSON.stringify({ p: 'tap', op: 'token-auth', redeem: { items: [] } }),
    source: { utxos: async () => utxos, feeRate: async () => 2, broadcast: async (raw, txid) => { sends.push(txid); return txid; } } };
  const payload = { p: 'tap', op: 'token-deploy', tick: 'dmwcfixture', max: '1000', dec: '0', prv: payee + 'i0' };
  const job = { asset: 'cfixture', kind: 'compound', state: 'awaiting_player_deploy', phase: 'deployment', tickerAttempt: 0,
    definition: { firstMaker: owner }, content: payload, inscriptionText: JSON.stringify(payload), attempts: [{ id, phase: 'deployment', attempt: 0, text: payload }] };
  return { wallet, status, job, sends, address };
}
const service = (f, extra) => ({ mintStatus: async () => f.status, deployment: async () => f.job,
  payoutBinding: async () => ({ binding: { request: { agent: owner, address: f.address } } }),
  submitDeployment: async () => { throw Error('deployment_confirmations'); }, reportMintPayment: async () => { throw Error('payment_unconfirmed'); }, ...extra });

test('a CLI deploy and payment are reported as in flight right after both transactions are sent', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'deploy'); cleanup(t, () => journal.close());
  const reports = [];
  const player = new PlayerMint({ wallet: f.wallet, journal, owner, dryRun: false,
    service: service(f, { reportInflight: async value => { reports.push({ value, sent: f.sends.length }); return { inflight: { phase: value.phase } }; } }) });
  const deployed = await player.deploy({ asset: 'cfixture', maxFeeSats: '10000' });
  assert.equal(deployed.state, 'broadcast'); assert.equal(deployed.deploymentState, 'awaiting_verification');
  assert.equal(reports.length, 1); assert.equal(reports[0].sent, 2, 'reported after the commit and the reveal were sent');
  assert.deepEqual(reports[0].value, { kind: 'deployment', ref: 'cfixture', phase: 'deployment', attempt: 0,
    commitTxid: deployed.commitTxid, revealTxid: deployed.revealTxid, inscriptionId: deployed.inscriptionId });
  assert.equal(deployed.inscriptionId, deployed.revealTxid + 'i0');
  // The fee payment: the redeem the CLI built, under the mint request.
  const paid = await player.pay({ id, maxFeeSats: '10000' });
  assert.equal(paid.state, 'broadcast');
  assert.deepEqual(reports[1].value, { kind: 'mint', ref: id, phase: 'payment', attempt: 0, commitTxid: paid.commitTxid, revealTxid: paid.revealTxid, inscriptionId: paid.inscriptionId });
  // A resumed payment re-sends the same bytes and reports the same reveal again.
  const again = await player.pay({ id, maxFeeSats: '10000' });
  assert.equal(again.replayed, true); assert.equal(reports[2].value.revealTxid, paid.revealTxid);
  assert.equal(reports.length, 3);
});

test('a failed or impossible report never fails the broadcast', async t => {
  const f = fixture(), journal = await Journal.open(await temp(t), 'deploy'); cleanup(t, () => journal.close());
  // A gateway that refuses the report (an older one has no route): the real client's error is swallowed.
  const asked = [];
  const http = createServer((req, res) => { asked.push(req.method + ' ' + req.url); res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end('{"error":"not_found"}'); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); t.after(() => http.close());
  const client = new ServiceClient({ origin: `http://127.0.0.1:${http.address().port}`, mode: 'regtest', busyRetries: 0 });
  const player = new PlayerMint({ wallet: f.wallet, journal, owner, dryRun: false, service: service(f, { reportInflight: value => client.reportInflight(value) }) });
  const deployed = await player.deploy({ asset: 'cfixture', maxFeeSats: '10000' });
  assert.equal(deployed.state, 'broadcast'); assert.equal(f.sends.length, 2);
  assert.deepEqual(asked, ['POST /mint/inflight']);
  assert.equal(journal.get(`bitcoin-deploy/${id}`).result.state, 'broadcast');
  // An unreachable gateway and a client without the call (older service stubs) behave the same way.
  const down = new ServiceClient({ origin: 'http://127.0.0.1:9', mode: 'regtest', busyRetries: 0 });
  const offline = new PlayerMint({ wallet: f.wallet, journal: await Journal.open(await temp(t), 'pay'), owner, dryRun: false, service: service(f, { reportInflight: value => down.reportInflight(value) }) });
  cleanup(t, () => offline.journal.close());
  assert.equal((await offline.pay({ id, maxFeeSats: '10000' })).state, 'broadcast');
  const old = new PlayerMint({ wallet: f.wallet, journal: await Journal.open(await temp(t), 'mint'), owner, dryRun: false, service: service(f) });
  cleanup(t, () => old.journal.close());
  assert.equal((await old.pay({ id, maxFeeSats: '10000' })).state, 'broadcast');
});
