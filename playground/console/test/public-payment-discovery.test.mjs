import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from '../../../kit/node_modules/@scure/btc-signer/index.js';
import { findPayment } from '../js/inscribe/public.js';

const id = 'a'.repeat(64), txid = 'b'.repeat(64);
function transaction(data, confirmed = true, hash = txid) {
  const body = Buffer.from(JSON.stringify({ p: 'tap', op: 'token-auth', redeem: { items: [{ dta: data, address: 'recipient', tick: 'tap', amt: '1' }] } }));
  const script = Buffer.from(Script.encode([0, 'IF', Buffer.from('ord'), 1, Buffer.from('application/json'), 0, body, 'ENDIF'])).toString('hex');
  return { txid: hash, status: { confirmed }, vin: [{ witness: ['00', script, '00'] }] };
}

test('browser payment recovery recognizes its exact public payment data and waits for Bitcoin confirmation', async () => {
  const data = 'dmw-public-pay-v1|' + Buffer.from(JSON.stringify({ asset: 'p2:0', block: '9' })).toString('base64url') + '|treasury';
  const another = data.replace('treasury', 'burn'), requests = [];
  let transactions = [transaction(data, false), transaction(another, true, 'c'.repeat(64))];
  const fetchImpl = async url => { requests.push(url); return { ok: true, json: async () => transactions }; };
  assert.equal(await findPayment(id, 'payer', { fetchImpl, paymentData: [data] }), null);
  transactions.push(transaction(data));
  assert.equal(await findPayment(id, 'payer', { fetchImpl, paymentData: [data] }), txid + 'i0');
  assert.equal(await findPayment(id, 'payer', { fetchImpl }), null, 'public recovery needs the exact requester payment data');
  assert.ok(requests.every(url => url === 'https://mempool.space/api/address/payer/txs'));
});

test('browser recovery preserves ordinary request markers and never queries Bitcoin for regtest', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [transaction('dmw-pay-v2|' + id + '|treasury')] });
  assert.equal(await findPayment(id, 'payer', { fetchImpl }), txid + 'i0');
  assert.equal(await findPayment(id, 'payer', { network: 'regtest', fetchImpl: () => assert.fail('unexpected request') }), null);
});
