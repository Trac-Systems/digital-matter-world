import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import { newStore } from './helpers.mjs';
import { Store } from '../src/store.mjs';
import { FinancialMints } from '../src/financial-mints.mjs';
import { WebCheckout } from '../src/web-checkout.mjs';
import { createWeb } from '../src/web.mjs';
import { serve } from '../src/http.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { publicScanKey, publicRefundKey } from '../../contract/public-mint.js';
import { MintSenderView } from '../src/mint-sender-view.mjs';
import { MintSenderJournal } from '../src/mint-sender-journal.mjs';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { rules } from '../src/rules.mjs';
import { newRequesterSecret, requesterSecretHash, matchesRequesterSecret } from '../src/public-mint-privacy.mjs';

async function fixture(t) {
  const store = await newStore(); let http;
  t.after(async () => { await http?.close(); await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '12' });
  await store.put('patternsByAsset', 'p2:0', { number: '0', name: 'private-pattern', pat: '[0-9]', fld: 4, dt: 'n' });
  const id = rules.hash('private-checkout'), address = 'bcrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsqysakq';
  const document = { values: { publicMintActivationHeight: '10', publicMintPageSize: 50, paymentPage: 10, moveBytes: 8192 } };
  const q = { id, intent: { asset: 'p2:0', block: '987654' }, amount: '3', price: '100', split: {},
    fees: [{ role: 'treasury', ticker: 'tap', amount: '100', to: address, tt: 'a', dta: 'dmw-public-pay-v1|target-bearing-signed-intent|treasury' }],
    feeQuote: { scope: 'find/p2:0/987654', deploymentId: 'private-deployment', validFrom: '10', validUntil: '20', baseFee: '100' },
    deployment: { id: 'private-deployment', tick: 'private-ticker' } };
  const reads = { counted: async () => '12', batchStamp: async () => ({ counted: '12' }), financialDeployment: async () => ({ existing: true }), publicMintQuote: async () => q };
  const mints = new FinancialMints({ store, reads, document, network: 'test', bitcoinNetwork: 'regtest', financial: {} });
  mints.publicMints.state = () => ({ state: 'public' });
  const publicAPI = createPublicAPI({ views: { store, mints } });
  const checkout = new WebCheckout({ store, mints, reads, config: { mode: 'regtest', network: 'test', endpoints: {}, local: { escrow: { chainId: '31337' } } } });
  http = await serve({ intake: { store }, mints, publicAPI, files: { serve: async () => false }, web: createWeb(checkout) });
  const request = async (path, options = {}) => {
    const response = await fetch(http.url + path, { headers: { accept: 'application/json', ...options.headers }, ...options });
    return { response, value: await response.json() };
  };
  const start = () => request('/public-mints/start', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asset: 'p2:0', block: '987654', tapAddress: address }) });
  return { store, mints, publicAPI, checkout, http, id, start, request };
}
function concealed(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /987654|p2:0|private-pattern|private-ticker|private-deployment|target-bearing-signed-intent/);
  for (const key of ['asset', 'block', 'catalogAsset', 'amount', 'feeQuote', 'actualTicker', 'deploymentId', 'requesterSecret', 'requesterSecretHash']) assert.equal(Object.hasOwn(value, key), false, key);
}

test('start returns a 32-byte secret once, persists only its digest, and never reissues it', async t => {
  const f = await fixture(t), { value } = await f.start();
  assert.equal(value.requesterSecret.length, 64); assert.equal(value.block, '987654'); assert.equal(value.payable, true);
  const row = f.store.get('mints', f.id);
  assert.equal(Object.hasOwn(row, 'requesterSecret'), false);
  assert.ok(matchesRequesterSecret(row.requesterSecretHash, value.requesterSecret));
  assert.ok(!JSON.stringify(row).includes(value.requesterSecret));
  const repeat = await f.start(); concealed(repeat.value); assert.equal(repeat.value.requesterRequired, true);
});

test('the HTTP start route applies its configured minute limit and returns a retryable refusal', async t => {
  const f = await fixture(t); f.mints.resources.publicMintStartsPerMinute = 1;
  assert.equal((await f.start()).response.status, 200);
  const blocked = await f.start();
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.value.error, 'public_mint_start_rate');
  assert.equal(blocked.value.retryable, true);
});

test('status, HEAD, checkout, lists, nested public reads and wrong secrets cannot expose the target before a winner', async t => {
  const f = await fixture(t), { value: started } = await f.start();
  for (const path of ['/mint/' + f.id, '/web-api/mint/' + f.id]) {
    const anonymous = await f.request(path); concealed(anonymous.value);
    assert.equal(anonymous.value.payable, false); assert.equal(anonymous.value.fees[0].amount, '100');
    assert.match(anonymous.response.headers.get('cache-control'), /no-store/);
    const wrong = await f.request(path, { headers: { 'x-mint-requester-secret': newRequesterSecret() } }); concealed(wrong.value);
    const own = await f.request(path, { headers: { 'x-mint-requester-secret': started.requesterSecret } });
    assert.equal(own.value.block, '987654'); assert.equal(own.value.asset, 'p2:0'); assert.equal(own.value.payable, true);
    assert.equal(Object.hasOwn(own.value, 'requesterSecret'), false);
    const head = await fetch(f.http.url + path, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }
  concealed(await f.publicAPI.read('/mint/' + f.id));
  const list = await f.request('/results/mints'); assert.equal(list.value.mints.length, 1); concealed(list.value.mints[0]);
  assert.deepEqual((await f.request('/results/mints?asset=p2:0')).value.mints, [], 'filters cannot link a hidden request to its target');
  assert.deepEqual((await f.request('/results/mints?block=987654')).value.mints, []);
  const stored = f.store.get('mints', f.id); await f.store.put('mints', f.id, { ...stored, paymentIds: [rules.hash('payment') + 'i0'], state: 'scanning' });
  concealed((await f.request('/mint/' + f.id)).value, 'payment reporting alone cannot reveal the block');
  const scan = { asset: 'p2:0', block: '987654', winner: { id: f.id, tapAddress: started.receiver } };
  await f.store.put('accountRecords', publicScanKey(rules.publicPlotId('p2:0', '987654')), scan);
  assert.equal((await f.request('/mint/' + f.id)).value.block, '987654');
});

test('refunds without a winner hide the target and cannot be probed by asset or block filters', async t => {
  const f = await fixture(t), { value: started } = await f.start();
  const refund = { id: f.id, asset: 'p2:0', block: '987654', reference: rules.hash('refund') + 'i0', reason: 'public_payment_incomplete', state: 'owed', fees: [{ amount: '1' }] };
  await f.store.put('publicMintRefunds', rules.hash('refund'), refund);
  const result = await f.request('/public-mints/refunds'); concealed(result.value.rows[0]);
  assert.deepEqual((await f.request('/public-mints/refunds?block=987654')).value.rows, []);
  const own = await f.request('/public-mints/refunds', { headers: { 'x-mint-requester-secret': started.requesterSecret } });
  assert.equal(own.value.rows[0].block, '987654');
});

test('private request and refund list retain delivery state without exposing the unpaid target', async t => {
  const f = await fixture(t), { value: started } = await f.start();
  const settings = mintSenderSettings({ directory: join(f.store.directory, 'sender'), seedFile: join(f.store.directory, 'seed'), bitcoinApiUrlFile: join(f.store.directory, 'source') });
  const view = f.mints.mintSender = new MintSenderView({ seed: new Uint8Array(32).fill(17), network: 'regtest', settings });
  const journal = new MintSenderJournal(settings.directory, { keyId: view.keyId, network: 'regtest' });
  try {
    const refund = { id: f.id, asset: 'p2:0', block: '987654', reference: rules.hash('private-refund') + 'i0', tapAddress: started.receiver,
      reason: 'public_payment_incomplete', state: 'owed', fees: [{ ticker: 'tap', amount: '1' }] };
    const refundId = publicRefundKey(refund).split('/').at(-1);
    await f.store.put('publicMintRefunds', refundId, refund);
    await f.store.put('publicMintRefundsByRequest/' + f.id, refundId, refund);
    for (const state of ['refund_pending', 'refund_waiting_funds', 'refund_needs_operator']) {
      journal.saveRefund({ id: refundId, record: { ...refund, refundId }, state });
      for (const path of ['/mint/' + f.id, '/web-api/mint/' + f.id, '/public-mints/refunds']) {
        const { value } = await f.request(path); concealed(value);
        const row = (value.refunds ?? value.rows)[0];
        assert.equal(row.refundDelivery.state, state, path);
      }
      const own = await f.request('/mint/' + f.id, { headers: { 'x-mint-requester-secret': started.requesterSecret } });
      assert.equal(own.value.block, '987654');
      assert.equal(own.value.refunds[0].refundDelivery.state, state);
    }
    assert.deepEqual((await f.request('/public-mints/refunds?block=987654')).value.rows, []);
  } finally { journal.close(); view.close(); }
});

test('requester authentication uses a constant-time comparison of fixed-size digests', async t => {
  const comparisons = [];
  t.mock.module('node:crypto', { exports: { ...Object.fromEntries(Object.entries(crypto).filter(([key]) => key !== 'default')),
    timingSafeEqual: (a, b) => { comparisons.push([a.length, b.length]); return crypto.timingSafeEqual(a, b); } } });
  const { matchesRequesterSecret: compare } = await import('../src/public-mint-privacy.mjs?compare-test');
  const secret = newRequesterSecret(), expected = requesterSecretHash(secret);
  assert.equal(compare(expected, secret), true);
  for (const wrong of [undefined, null, [], {}, '', secret.slice(1), secret + '0', newRequesterSecret()]) assert.equal(compare(expected, wrong), false);
  assert.equal(compare(undefined, secret), false);
  assert.deepEqual(comparisons, Array.from({ length: 10 }, () => [32, 32]));
});

test('opening a pre-upgrade store rewrites target-bearing public request projection caches', async t => {
  let store = await newStore(); const directory = store.directory;
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '12' });
  const id = rules.hash('old-request');
  await store.put('mints', id, { id, publicMint: true, request: { asset: 'p2:0', block: '987654', amount: '3' }, kind: 'tap', state: 'awaiting_payment' });
  store.db.prepare("UPDATE publicItemsV2 SET value=?,asset=?,block=? WHERE kind='mints' AND id=?").run(JSON.stringify({ id, asset: 'p2:0', block: '987654' }), 'p2:0', '987654', id);
  store.db.prepare("UPDATE publicOrderV2 SET asset=?,block=? WHERE kind='mints' AND id=?").run('p2:0', '987654', id);
  await store.close(); store = await Store.open(directory);
  concealed(JSON.parse(store.db.prepare("SELECT value FROM publicItemsV2 WHERE kind='mints' AND id=?").get(id).value));
  assert.equal(store.db.prepare("SELECT 1 FROM publicOrderV2 WHERE kind='mints' AND asset='p2:0'").get(), undefined);
});
