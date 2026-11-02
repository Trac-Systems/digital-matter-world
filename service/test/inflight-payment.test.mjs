import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { provisioningFixture } from './provisioning-fixture.mjs';
import { serve } from '../src/http.mjs';
import { Inflight, matchesPayment } from '../src/inflight.mjs';
import { WebCheckout } from '../src/web-checkout.mjs';
import { buildInscription, fundingAddress, hex } from '../../kit/lib/inscription-core.mjs';
const require = createRequire(new URL('../../local/package.json', import.meta.url));
const btc = require('@scure/btc-signer');
const { schnorr } = require('@noble/curves/secp256k1');

// A wallet-shaped commit/reveal pair for `text`, built offline (the redeem TAP Wallet inscribes is one such reveal).
function reveal(text) {
  const key = schnorr.utils.randomPrivateKey(), publicKey = hex(schnorr.getPublicKey(key)), address = fundingAddress(publicKey, 'regtest');
  const script = hex(btc.OutScript.encode(btc.Address({ ...btc.TEST_NETWORK, bech32: 'bcrt' }).decode(address)));
  return buildInscription({ text, receiver: address, publicKey, network: 'regtest', feeRate: 2, maxFeeSats: '100000',
    utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: '100000', script, confirmed: true, cardinal: true }] });
}
const fee = (role, to, amount, dta) => ({ role, to, amount, ticker: 'tap', tt: 'a', dta });
const redeem = items => JSON.stringify({ p: 'tap', op: 'token-auth', redeem: { items, auth: 'aa'.repeat(32) + 'i0', data: '' }, sig: { v: '1', r: '1', s: '1' }, hash: '00', salt: '1' });
const item = (f, amt) => ({ tick: f.ticker, amt, address: f.to, dta: f.dta });

async function setup(t) {
  const f = await provisioningFixture(t);
  const txs = new Map(), reads = [];
  const bitcoin = { transaction: async txid => { reads.push(txid); return txs.get(txid) ?? null; }, confirmations: async () => null };
  const mints = { rows: new Map(), public(id) { const row = this.rows.get(id); if (!row) throw Object.assign(Error('request_not_found'), { status: 404 }); return row; } };
  const links = { financialVersion: 2, rows: new Map(), async public(id) { const row = this.rows.get(id); if (!row) throw Object.assign(Error('request_not_found'), { status: 404 }); return row; } };
  const inflight = new Inflight({ store: f.store, provisioner: f.operator, mints, links, bitcoin, settings: { recheckMs: 60000 } });
  const http = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator }, mints, links, inflight });
  t.after(() => http.close());
  const call = async (path, body) => {
    const response = await fetch(http.url + path, body === undefined ? { headers: { accept: 'application/json' } }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { f, txs, reads, mints, links, inflight, call };
}

test('a redeem pays a request only with its own remaining fee items, each once and no more than due', () => {
  const fees = [fee('treasury', 'bc1ptreasury', '20000000000000000000', 'dmw-pay-v2|r|treasury'), fee('burn', 'bc1pburn', '10000000000000000000', 'dmw-pay-v2|r|burn')];
  assert.equal(matchesPayment(redeem([item(fees[0], '20'), item(fees[1], '10')]), fees), true);
  assert.equal(matchesPayment(redeem([item(fees[0], '20')]), fees), true, 'a part payment is a payment of this request');
  assert.equal(matchesPayment(redeem([item(fees[0], '20.5')]), fees), false, 'more than due');
  assert.equal(matchesPayment(redeem([item(fees[0], '0')]), fees), false);
  assert.equal(matchesPayment(redeem([item(fees[0], '1'), item(fees[0], '1')]), fees), false, 'one item twice');
  assert.equal(matchesPayment(redeem([{ ...item(fees[0], '20'), dta: 'dmw-pay-v2|other|treasury' }]), fees), false, 'another request');
  assert.equal(matchesPayment(redeem([{ ...item(fees[0], '20'), address: 'bc1pelse' }]), fees), false, 'another recipient');
  assert.equal(matchesPayment(redeem([{ ...item(fees[0], '20'), tick: 'dmwx' }]), fees), false, 'another ticker');
  assert.equal(matchesPayment(redeem([]), fees), false);
  assert.equal(matchesPayment(JSON.stringify({ p: 'tap', op: 'token-send', items: [item(fees[0], '20')] }), fees), false);
  assert.equal(matchesPayment('not json', fees), false);
});

test('a sent mint fee payment shows on the request until its funding moves; other content and other states are refused', async t => {
  const { f, txs, reads, mints, call } = await setup(t);
  const id = 'ef'.repeat(32), fees = [fee('treasury', 'bcrt1ptreasury', '20000000000000000000', `dmw-pay-v2|${id}|treasury`), fee('finder', 'bcrt1pfinder', '5000000000000000000', `dmw-pay-v2|${id}|finder`)];
  const status = { requestId: id, state: 'awaiting_payment', kind: 'tap', payBy: { rail: 'tap', untilBlock: 9 }, price: '25000000000000000000', fees, missing: fees, payment: [], funding: { paid: ['0', '0'] } };
  mints.rows.set(id, status);
  const other = reveal(redeem([{ ...item(fees[0], '20'), dta: 'dmw-pay-v2|' + 'aa'.repeat(32) + '|treasury' }])); txs.set(other.revealTxid, other.revealHex);
  assert.equal((await call('/mint/inflight', { kind: 'mint', ref: id, phase: 'payment', revealTxid: other.revealTxid })).body.error, 'inflight_content');
  const paid = reveal(redeem([item(fees[0], '20'), item(fees[1], '5')])); txs.set(paid.revealTxid, paid.revealHex);
  assert.equal((await call('/mint/inflight', { kind: 'mint', ref: id, phase: 'payment', commitTxid: 'cd'.repeat(32), revealTxid: paid.revealTxid })).body.error, 'inflight_commit');
  const accepted = await call('/mint/inflight', { kind: 'mint', ref: id, phase: 'payment', attempt: 0, commitTxid: paid.commitTxid, revealTxid: paid.revealTxid, inscriptionId: paid.inscriptionId });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.inflight.phase, 'payment');
  const read = await call('/mint/' + id);
  assert.equal(read.body.state, 'awaiting_payment');
  assert.deepEqual({ ...read.body.inflight, seenAt: 0 }, { phase: 'payment', commitTxid: paid.commitTxid, revealTxid: paid.revealTxid, inscriptionId: paid.inscriptionId, seenAt: 0, confirmations: null });
  // Display only: the request itself is untouched.
  assert.deepEqual(mints.rows.get(id), status);
  // Counted (the funding moved): the note disappears, though the state still says awaiting payment for a moment.
  mints.rows.set(id, { ...status, state: 'partly_paid', funding: { paid: ['20000000000000000000', '0'] }, missing: [fees[1]] });
  assert.equal((await call('/mint/' + id)).body.inflight, undefined);
  mints.rows.set(id, { ...status, state: 'paid', missing: [] });
  assert.equal((await call('/mint/' + id)).body.inflight, undefined);
  // A request that no longer waits for a payment is refused before any Bitcoin read.
  const before = reads.length;
  assert.equal((await call('/mint/inflight', { kind: 'mint', ref: id, phase: 'payment', revealTxid: paid.revealTxid })).body.error, 'inflight_not_waiting');
  assert.equal(reads.length, before);
  assert.equal((await call('/mint/inflight', { kind: 'link', ref: id, phase: 'mint', revealTxid: paid.revealTxid })).body.error, 'inflight_payload');
  assert.equal(f.store.get('inflight', `mint/${id}/payment`).revealTxid, paid.revealTxid);
});

test('a sent Bitmap link payment shows on the link status and the payment page; a free link has nothing in flight', async t => {
  const { f, txs, links, inflight, call } = await setup(t);
  const id = 'ab'.repeat(32), fees = [fee('treasury', 'bcrt1ptreasury', '20000000000000000000', `dmw-link-v2|${id}|treasury`)];
  const status = { id, requestId: id, financialVersion: 2, state: 'awaiting_payment', payBy: { rail: 'tap', untilBlock: 99 }, price: '20000000000000000000', fees, missing: fees,
    payable: true, funding: { state: 'open', paid: ['0'], root: '00' } };
  links.rows.set(id, status);
  const paid = reveal(redeem([item(fees[0], '20')])); txs.set(paid.revealTxid, paid.revealHex);
  assert.equal((await call('/mint/inflight', { kind: 'link', ref: id, phase: 'payment', revealTxid: paid.revealTxid })).status, 200);
  assert.equal((await call('/link-status/' + id)).body.inflight.revealTxid, paid.revealTxid);
  // The site's payment page reads the request through the web checkout.
  await f.store.put('financialLinks', id, { id });
  const checkout = new WebCheckout({ store: f.store, config: { mode: 'regtest', network: 'dmw-regtest', local: { escrow: { chainId: 31337, token: '0x' + '11'.repeat(20), address: '0x' + '22'.repeat(20) } }, endpoints: { ethereum: 'http://127.0.0.1:1' } },
    reads: { counted: async () => 50 }, links, inflight });
  const plan = await checkout.plan('link', id);
  assert.equal(plan.inflight.revealTxid, paid.revealTxid); assert.equal(plan.state, 'awaiting_payment');
  links.rows.set(id, { ...status, state: 'paid', missing: [], funding: { ...status.funding, paid: ['20000000000000000000'] } });
  assert.equal((await checkout.plan('link', id)).inflight, undefined);
  assert.equal((await call('/link-status/' + id)).body.inflight, undefined);
  // Free links (fee 0) send no payment: a report is refused and no read shows one.
  const free = 'cd'.repeat(32);
  links.rows.set(free, { ...status, id: free, requestId: free, price: '0', fee: 'Free', fees: [], missing: [] });
  assert.equal((await call('/mint/inflight', { kind: 'link', ref: free, phase: 'payment', revealTxid: paid.revealTxid })).body.error, 'inflight_not_waiting');
  assert.equal((await call('/link-status/' + free)).body.inflight, undefined);
});

test('a timely payment report is saved before a slow reveal lookup crosses the deadline', async t => {
  const { f, txs, mints, inflight } = await setup(t);
  const id = 'ac'.repeat(32), fees = [fee('treasury', 'bcrt1ptreasury', '1000000000000000000', `dmw-pay-v2|${id}|treasury`)];
  const paid = reveal(redeem([item(fees[0], '1')]));
  mints.rows.set(id, { requestId: id, state: 'awaiting_payment', kind: 'tap', price: fees[0].amount, missing: fees, payment: [] });
  let counted = '106'; const reports = [];
  mints.reads = { counted: async () => counted };
  mints.paymentBroadcast = async (...args) => reports.push(args);
  inflight.bitcoin.transaction = async txid => {
    assert.deepEqual(reports, [[id, paid.inscriptionId, '106']]);
    counted = '107'; return txs.get(txid) ?? null;
  };
  const report = { kind: 'mint', ref: id, phase: 'payment', revealTxid: paid.revealTxid };
  await assert.rejects(inflight.report(report), /inflight_transaction_unknown/);
  assert.equal(f.store.get('inflight', `mint/${id}/payment`), null, 'a hint is not verified inflight content');
  txs.set(paid.revealTxid, paid.revealHex); counted = '106'; reports.length = 0;
  await inflight.report(report);
  assert.equal(f.store.get('inflight', `mint/${id}/payment`).seenAtBlock, '106');
});
