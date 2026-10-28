import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { applyPaymentPage, paymentCreditDigest } from '../payment-pages.js';
import { accountKey, accountTree } from '../account-tree.js';
import { alice, bob, nonce, harness, signedRequest } from './helpers/harness.mjs';
import { bytesToHex, requestDigest } from '../signing.js';

test('65 payment fragments in bounded pages become transferable credit and cannot be spent twice', async () => {
  const db = new Map(), usage = new Map(), network = 'dmw-pages', context = { network, height: 10, settings: { paymentPage: 16 } };
  const store = { get: async k => db.get(k), put: (k, v) => db.set(k, v) }, id = nonce(1), fee = nonce(2);
  await applyPaymentPage(store, { op: 'fp', v: 2, type: 'open', id, owner: alice.address, terms: nonce(3), fees: [{ key: fee, amount: '65' }] }, context);
  for (let i = 0; i < 65; i += 16) {
    const items = Array.from({ length: Math.min(16, 65 - i) }, (_, j) => ({ key: nonce(i + j + 100), fee, amount: '1', total: '1' }));
    const old = db.get('fp/' + id), tree = accountTree(usage);
    await applyPaymentPage(store, { op: 'fp', v: 2, type: 'page', id, sequence: old.sequence, previous: old.root,
      revision: db.get('fp/usage')?.revision ?? '0', items, proof: tree.prove(items.map(p => accountKey('payment', p.key))) }, context);
    for (const item of items) usage.set(accountKey('payment', item.key), { total: '1', used: '1' });
    assert.equal(db.get('fp/usage').root, accountTree(usage).root);
  }
  assert.deepEqual(db.get('fp/' + id).paid, ['65']);
  assert.equal(db.get('fp/' + id).sequence, '5');
  assert.equal([...db.keys()].length, 2, 'one request and one global usage root, no per-fragment records');
  await applyPaymentPage(store, { op: 'fp', v: 2, type: 'credit', id, root: db.get('fp/' + id).root, evidence: nonce(4) }, context);
  const transfer = { op: 'fp', v: 2, type: 'transfer', id, credit: id, revision: '0', to: bob.address, until: 20 };
  transfer.sig = bytesToHex(ed25519.sign(paymentCreditDigest(network, transfer), alice.secret));
  await applyPaymentPage(store, transfer, context);
  await assert.rejects(applyPaymentPage(store, transfer, context), /credit_signature/);
  const next = nonce(10);
  await applyPaymentPage(store, { op: 'fp', v: 2, type: 'open', id: next, owner: bob.address, terms: nonce(3), fees: [{ key: fee, amount: '65' }] }, context);
  const use = { op: 'fp', v: 2, type: 'use', id: next, credit: id, revision: '1', until: 20, items: [{ fee, amount: '65' }] };
  use.sig = bytesToHex(ed25519.sign(paymentCreditDigest(network, use), bob.secret));
  await applyPaymentPage(store, use, context);
  await assert.rejects(applyPaymentPage(store, use, context), /credit_signature/);
  assert.equal(db.get('fc/' + id).fees[0].amount, '0');
  await applyPaymentPage(store, { op: 'fp', v: 2, type: 'consume', id: next, root: db.get('fp/' + next).root, permitHash: nonce(5) }, context);
  await assert.rejects(applyPaymentPage(store, { op: 'fp', v: 2, type: 'credit', id: next, root: db.get('fp/' + next).root, evidence: nonce(4) }, context), /funding_exit/);
  const third = nonce(11);
  await applyPaymentPage(store, { op: 'fp', v: 2, type: 'open', id: third, owner: alice.address, terms: nonce(3), fees: [{ key: fee, amount: '1' }] }, context);
  await assert.rejects(applyPaymentPage(store, { op: 'fp', v: 2, type: 'page', id: third, sequence: '0', previous: db.get('fp/' + third).root,
    revision: db.get('fp/usage').revision, items: [{ key: nonce(100), fee, amount: '1', total: '1' }], proof: accountTree(usage).prove([accountKey('payment', nonce(100))]) }, context), /funding_reused/);
});

test('activated exit releases a legacy held balance once, retains request identity, and cannot cancel consumed units', async () => {
  const h = harness(); await h.mint(['p0']);
  const request = { owner: alice.address, asset: 'p0', amount: '3', receive: nonce(1), nonce: nonce(2), until: 10, expires: 20 };
  await h.tickBatch([signedRequest('rq', request)]);
  const id = bytesToHex(requestDigest(h.options.network, 'rq', request));
  assert.equal(await h.tickBatch([{ op: 'mp', id }]), null);
  const exit = { op: 'mx', v: 2, id, outcome: 'ethereum_refund', evidence: nonce(3) };
  assert.equal(await h.tickBatch([exit]), 'mint_exit_inactive');
  h.db.set('s/assetExits', { version: 2 });
  assert.equal(await h.tickBatch([exit]), null);
  assert.equal(await h.state().balance(await h.state().agent(alice.address), 'p0'), '100');
  assert.equal(h.db.get('m/' + id).s, 3);
  assert.equal(await h.tickBatch([exit]), 'mint_exit_terminal');
  h.db.set('m/' + id, { ...h.db.get('m/' + id), s: 1, permitHash: nonce(4) });
  assert.equal(await h.tickBatch([exit]), 'mint_exit_terminal');
});
