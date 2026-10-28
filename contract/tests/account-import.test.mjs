import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountImport } from '../account-import.js';
import { applyRootAccounts } from '../root-accounts.js';
import { accountKey, accountTree } from '../account-tree.js';
import { sha256, hexToBytes, bytesToHex } from '../signing.js';
import { alice, bob, nonce } from './helpers/harness.mjs';

test('terminal import retains available/held/expired units, replay markers, payments and a usable multi-asset lock', async () => {
  const preimage = nonce(99), lock = nonce(1), request = nonce(2), payment = nonce(3), oldNonce = nonce(4);
  const records = new Map([
    ['a/' + alice.address, 1], ['a/' + bob.address, 2], ['v/1/p0', '10'], ['e/1/p0', [[5, '2'], [20, '3']]],
    ['rq/n/1/' + oldNonce, 1], ['pay/' + payment, { total: '10', used: '7' }],
    ['m/' + request, { s: 0, o: 1, asset: 'p0', amount: '3', e: 20, receive: nonce(7) }],
    ['l/' + lock, { o: 1, to: 2, assets: [['p0', '4'], ['p1', '1']], hash: bytesToHex(sha256(hexToBytes(preimage))), refund: 30 }],
  ]);
  const imported = buildAccountImport(records, 10), a = imported.accounts.find(x => x.address === alice.address), b = imported.accounts.find(x => x.address === bob.address);
  assert.deepEqual(a.leaves.get(accountKey('balance', 'p0')), { available: '12', held: '7' });
  assert.equal(a.leaves.get(accountKey('nonce', oldNonce)), 'used');
  assert.deepEqual(imported.payments.leaves.get(accountKey('payment', payment)), { total: '10', used: '7' });
  assert.deepEqual(imported.supply.leaves.get(accountKey('supply', 'p0')), { issued: '19', burned: '0' });
  assert.deepEqual(imported.obligations[0][1].legacy, records.get('m/' + request));
  const db = new Map([...imported.accounts.map(a => ['ar/' + a.address, a.record]), ['ar/supply', { root: imported.supply.root, revision: '0' }], ...imported.obligations, ...imported.locks]);
  const keys = ['p0', 'p1'].map(n => accountKey('balance', n)), op = { op: 'ar', v: 2, availability: nonce(8),
    actions: [{ type: 'claim-lock', id: lock, preimage }], accounts: [a, b].map(a => ({ owner: a.address, revision: '0', proof: accountTree(a.leaves).prove(keys) })),
    supply: { revision: '0', proof: { leaves: [], nodes: [] } } };
  await applyRootAccounts({ get: async key => db.get(key), put: (key, value) => db.set(key, value) }, op, { network: 'dmw-import', height: 11 });
  assert.equal(db.get('al/' + lock).state, 'claimed');
  const expected = new Map([[keys[0], { available: '4', held: '0' }], [keys[1], { available: '1', held: '0' }]]);
  assert.equal(db.get('ar/' + bob.address).root, accountTree(expected).root);
  assert.equal(db.get('ar/supply').root, imported.supply.root, 'claiming a lock conserves the imported supply');
});
