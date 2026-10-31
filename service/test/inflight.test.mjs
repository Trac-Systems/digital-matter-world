import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { serve } from '../src/http.mjs';
import { Inflight, revealText, revealCommit } from '../src/inflight.mjs';
import { buildInscription, fundingAddress, hex } from '../../kit/lib/inscription-core.mjs';
const require = createRequire(new URL('../../local/package.json', import.meta.url));
const btc = require('@scure/btc-signer');
const { schnorr } = require('@noble/curves/secp256k1');

// A real wallet-shaped commit/reveal pair for `text`, built offline like the browser does.
function reveal(text) {
  const key = schnorr.utils.randomPrivateKey(), publicKey = hex(schnorr.getPublicKey(key)), address = fundingAddress(publicKey, 'regtest');
  const script = hex(btc.OutScript.encode(btc.Address({ ...btc.TEST_NETWORK, bech32: 'bcrt' }).decode(address)));
  return buildInscription({ text, receiver: address, publicKey, network: 'regtest', feeRate: 2, maxFeeSats: '100000',
    utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: '100000', script, confirmed: true, cardinal: true }] });
}
async function setup(t, { rate = {} } = {}) {
  const f = await provisioningFixture(t);
  const txs = new Map(), confirmations = new Map(), reads = [];
  const bitcoin = { transaction: async txid => { reads.push(txid); return txs.get(txid) ?? null; }, confirmations: async id => confirmations.get(id) ?? null };
  const mints = { rows: new Map(), public(id) { const row = this.rows.get(id); if (!row) throw Object.assign(Error('request_not_found'), { status: 404 }); return row; } };
  const inflight = new Inflight({ store: f.store, provisioner: f.operator, mints, bitcoin, settings: { recheckMs: 60000 } });
  const http = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator }, mints, inflight, ...rate });
  t.after(() => http.close());
  const call = async (path, body, headers = {}) => {
    const response = await fetch(http.url + path, body === undefined ? { headers: { accept: 'application/json' } }
      : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await f.store.put('meta', 'patterns', [f.pattern]);
  const job = await f.operator.advanceAsset('p2', f.pattern);
  assert.equal(job.state, 'awaiting_player_deploy'); assert.equal(job.phase, 'element');
  return { f, txs, confirmations, reads, mints, inflight, call, job };
}
const deploymentReport = (job, plan, extra = {}) => ({ kind: 'deployment', ref: job.asset, phase: job.phase, attempt: job.elementAttempt,
  commitTxid: plan.commitTxid, revealTxid: plan.revealTxid, inscriptionId: plan.inscriptionId, ...extra });

test('the envelope reader returns the exact text and commit of a wallet reveal', async () => {
  const plan = reveal('x'.repeat(1300) + ' ✓');
  assert.equal(revealText(plan.revealHex), 'x'.repeat(1300) + ' ✓');
  assert.equal(revealCommit(plan.revealHex), plan.commitTxid);
  assert.equal(revealText('00'), null);
  // The p2:3 mainnet deploy reveal (block 973982) carries its gateway text byte for byte.
  const live = (await readFile(new URL('./fixtures/inflight-p2-3-reveal.hex', import.meta.url), 'utf8')).trim();
  assert.equal(revealText(live), '{"dt":"n","elem":"63b5bd2e28c043c4812981718e65d202ab8f68c0f6a1834d9ebea49d8fac7e62i0","op":"dmt-deploy","p":"tap","prov":"trac1w5hv772v8s4qgnhmvvnzfep2ykdzr6az7xctmwka00xvrd4gfyus8hh72l","prv":"c0a5502c26d559af23a5c36ebcb5e04769c633194bdf317484d7204b19568bd0i0","tick":"natural"}');
  assert.equal(revealCommit(live), 'ef7d7e42343c3f6526796a6f159a4bf9bc95538d1167c4abb75135b35be35cdd');
});

test('a matching broadcast shows as in flight on every deployment read, then disappears when the state moves on', async t => {
  const { f, txs, confirmations, call, job } = await setup(t);
  const plan = reveal(job.inscriptionText); txs.set(plan.revealTxid, plan.revealHex);
  const before = await call('/mint/deployment-state/p2');
  assert.equal(before.body.inflight, undefined);
  const accepted = await call('/mint/inflight', deploymentReport(job, plan));
  assert.equal(accepted.status, 200);
  assert.deepEqual({ ...accepted.body.inflight, seenAt: 0 }, { phase: 'element', commitTxid: plan.commitTxid, revealTxid: plan.revealTxid, inscriptionId: plan.inscriptionId, seenAt: 0, confirmations: null });
  for (const path of ['/mint/deployment-state/p2', '/mint/deployment/p2']) {
    const read = await call(path);
    assert.equal(read.body.state, 'awaiting_player_deploy');
    assert.equal(read.body.inflight.revealTxid, plan.revealTxid, path);
  }
  // Display only: the job itself is unchanged and the stored record is outside the job.
  const stored = f.store.get('provisioning', 'p2');
  assert.deepEqual(stored.attempts, job.attempts); assert.equal(stored.state, 'awaiting_player_deploy');
  // A later report of the same broadcast keeps its first sighting and updates the confirmations.
  confirmations.set(plan.inscriptionId, 1);
  await f.store.put('inflight', 'deployment/p2/element', { ...f.store.get('inflight', 'deployment/p2/element'), checkedAt: 0 });
  const second = await call('/mint/inflight', deploymentReport(job, plan));
  assert.equal(second.body.inflight.seenAt, accepted.body.inflight.seenAt); assert.equal(second.body.inflight.confirmations, 1);
  // The normal path: the element is indexed, the job moves to the deploy phase and the element record stops showing.
  f.index(job.inscriptionText, plan.inscriptionId); f.mine(1);
  const next = await f.operator.advanceAsset('p2', f.pattern);
  assert.equal(next.phase, 'deployment');
  const after = await call('/mint/deployment-state/p2');
  assert.equal(after.body.phase, 'deployment'); assert.equal(after.body.inflight, undefined);
});

test('the route refuses unknown transactions, other content, other refs, phases and attempts, a wrong commit and bad payloads', async t => {
  const { txs, call, job, reads } = await setup(t);
  const plan = reveal(job.inscriptionText), other = reveal(job.inscriptionText + ' ');
  txs.set(other.revealTxid, other.revealHex);
  const refused = async (body, error, status = 400) => { const r = await call('/mint/inflight', body); assert.equal(r.body.error, error, JSON.stringify(body)); assert.equal(r.status, status); };
  await refused(deploymentReport(job, plan), 'inflight_transaction_unknown', 404);
  await refused(deploymentReport(job, other), 'inflight_content');
  txs.set(plan.revealTxid, plan.revealHex);
  await refused(deploymentReport(job, plan, { phase: 'deployment' }), 'inflight_not_waiting', 409);
  await refused(deploymentReport(job, plan, { attempt: 1 }), 'inflight_not_waiting', 409);
  await refused(deploymentReport(job, plan, { ref: 'p9' }), 'asset_unknown');
  await refused(deploymentReport(job, plan, { kind: 'bitmap' }), 'inflight_payload');
  await refused(deploymentReport(job, plan, { commitTxid: 'cd'.repeat(32) }), 'inflight_commit');
  await refused(deploymentReport(job, plan, { inscriptionId: plan.revealTxid + 'i1' }), 'inflight_payload');
  await refused({ ...deploymentReport(job, plan), state: 'registered' }, 'inflight_payload');
  await refused(deploymentReport(job, plan, { kind: 'mint', ref: 'ef'.repeat(32), phase: 'mint', attempt: 0 }), 'request_not_found', 404);
  // Refusals before any Bitcoin read cost no point read.
  const count = reads.length;
  await refused(deploymentReport(job, plan, { phase: 'deployment' }), 'inflight_not_waiting', 409);
  assert.equal(reads.length, count);
  const oversize = await call('/mint/inflight', JSON.stringify({ ...deploymentReport(job, plan), pad: 'x'.repeat(2000) }));
  assert.equal(oversize.status, 413); assert.equal(oversize.body.error, 'body_limit');
  assert.equal((await call('/mint/inflight', deploymentReport(job, plan))).status, 200);
});

test('reports share the POST rate limit', async t => {
  const { call, job, txs } = await setup(t, { rate: { rateBurst: 2, ratePerSecond: 0.001 } });
  const plan = reveal(job.inscriptionText); txs.set(plan.revealTxid, plan.revealHex);
  assert.equal((await call('/mint/inflight', deploymentReport(job, plan))).status, 200);
  assert.equal((await call('/mint/inflight', deploymentReport(job, plan))).status, 200);
  const limited = await call('/mint/inflight', deploymentReport(job, plan));
  assert.equal(limited.status, 429); assert.equal(limited.body.error, 'request_rate');
});

test('a mint inscription after its permit shows on the request until it is minted; tickers follow their job', async t => {
  const { f, txs, mints, inflight, call } = await setup(t);
  const id = 'ef'.repeat(32), mintContent = { p: 'tap', op: 'dmt-mint', dep: 'x', tick: 'dmwexample', blk: '7', prv: { address: 'bcrt1p' }, dta: id };
  mints.rows.set(id, { requestId: id, state: 'permit_issued', mintContent });
  const wrong = reveal(JSON.stringify({ ...mintContent, blk: '8' })); txs.set(wrong.revealTxid, wrong.revealHex);
  assert.equal((await call('/mint/inflight', { kind: 'mint', ref: id, phase: 'mint', revealTxid: wrong.revealTxid })).body.error, 'inflight_content');
  const plan = reveal(JSON.stringify(mintContent)); txs.set(plan.revealTxid, plan.revealHex);
  assert.equal((await call('/mint/inflight', { kind: 'mint', ref: id, phase: 'mint', revealTxid: plan.revealTxid })).status, 200);
  assert.equal((await call('/mint/' + id)).body.inflight.inscriptionId, plan.inscriptionId);
  mints.rows.set(id, { requestId: id, state: 'minted', mintContent });
  assert.equal((await call('/mint/' + id)).body.inflight, undefined);

  const ticker = 'cd'.repeat(32), content = { p: 'tap', op: 'token-deploy', tick: 'dmwabc', max: '1', lim: '1', dec: '0', prv: 'ab'.repeat(32) + 'i0' };
  await f.store.put('tickerProvisioning', ticker, { id: ticker, asset: 'p2', state: 'awaiting_player_deploy', content, inscriptionText: JSON.stringify(content) });
  const deploy = reveal(JSON.stringify(content)); txs.set(deploy.revealTxid, deploy.revealHex);
  assert.equal((await call('/mint/inflight', { kind: 'ticker', ref: ticker, phase: 'deployment', revealTxid: deploy.revealTxid })).status, 200);
  assert.equal(inflight.decorate('ticker', f.store.get('tickerProvisioning', ticker)).inflight.revealTxid, deploy.revealTxid);
  assert.equal(inflight.decorate('ticker', { ...f.store.get('tickerProvisioning', ticker), state: 'registered' }).inflight, undefined);
});

test('an unconfirmed reveal unknown to ord is read from the mempool reader and must hash to its txid', async () => {
  const { ordInflightReads } = await import('../src/inflight.mjs');
  const { BitcoinSource } = await import('../prod/bitcoin.mjs');
  const raw = (await readFile(new URL('./fixtures/inflight-p2-3-reveal.hex', import.meta.url), 'utf8')).trim();
  const client = new BitcoinSource({ source: { request: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } } });
  const txid = client.decode(raw).txid, asked = [];
  const reads = ordInflightReads(client, { mempoolTransaction: async id => { asked.push(id); return raw; } });
  assert.equal(await reads.transaction(txid), raw);
  assert.equal(await reads.transaction('00'.repeat(32)), null, 'bytes of another transaction are refused');
  assert.deepEqual(asked, [txid, '00'.repeat(32)]);
  assert.equal(await ordInflightReads(client).transaction(txid), null, 'without a mempool reader an unconfirmed reveal stays unknown');
});
