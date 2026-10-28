import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { accountKey, accountTree, verifyAccountProof, readAccountLeaf } from '../account-tree.js';
import { applyRootAccounts, accountActionDigest } from '../root-accounts.js';
import { alice, bob, nonce, harness } from './helpers/harness.mjs';

test('sparse multiproof authenticates named leaves and shared frontier, rejecting substitution and unused nodes', () => {
  const keys = ['p0', 'p1', 'p2'].map(x => accountKey('balance', x));
  const data = new Map(keys.map((k, i) => [k, { available: String(i + 1), held: '0' }]));
  const tree = accountTree(data), proof = tree.prove(keys.slice(0, 2)), changes = new Map(keys.slice(0, 2).map(k => [k, null]));
  const expected = accountTree(new Map([[keys[2], data.get(keys[2])]]));
  assert.equal(verifyAccountProof(tree.root, proof, changes), expected.root);
  assert.deepEqual(readAccountLeaf(tree.root, tree.prove([keys[0]]), keys[0]), data.get(keys[0]));
  const altered = structuredClone(proof); altered.leaves[0].value.available = '999';
  assert.throws(() => verifyAccountProof(tree.root, altered, changes), /account_root/);
  assert.throws(() => verifyAccountProof(tree.root, { ...proof, nodes: [...proof.nodes, [999999, nonce(1)]] }, changes), /account_root/);
  assert.throws(() => verifyAccountProof(tree.root, { ...proof, leaves: [...proof.leaves].reverse() }, changes), /account_leaf_order/);
  assert.throws(() => verifyAccountProof(tree.root, proof, changes, { proofBytes: 10 }), /account_proof_budget/);
  assert.throws(() => verifyAccountProof(tree.root, { empty: true }, changes), /account_empty_proof/);
  const minted = new Map([[keys[0], { available: '3', held: '0' }]]);
  assert.equal(verifyAccountProof(accountTree().root, { empty: true }, minted), accountTree(minted).root);
});

function ledger() {
  const db = new Map(), writes = new Map(), leaves = new Map(), supplies = new Map(), network = 'dmw-test-accounts';
  const store = { get: async k => db.get(k), put: (k, v) => writes.set(k, v) };
  const packet = (owner, keys) => ({ owner, revision: db.get('ar/' + owner)?.revision ?? '0', proof: accountTree(leaves.get(owner)).prove(keys) });
  const op = (actions, accounts, supplyNames = []) => ({ op: 'ar', v: 2, actions, accounts,
    supply: { revision: db.get('ar/supply')?.revision ?? '0', proof: supplyNames.length ? accountTree(supplies).prove(supplyNames.map(n => accountKey('supply', n))) : { leaves: [], nodes: [] } }, availability: nonce(1) });
  const sign = action => ({ ...action, sig: Buffer.from(ed25519.sign(accountActionDigest(network, action), alice.secret)).toString('hex') });
  const commit = () => { for (const [k, v] of writes) db.set(k, v); writes.clear(); };
  return { db, writes, leaves, supplies, store, packet, op, sign, commit, network };
}

test('root ledger conserves transfer/hold/refund and rejects double spends, stale proofs and missing signatures', async () => {
  const f = ledger(), balance = accountKey('balance', 'p0'), context = { network: f.network, height: 10 };
  const award = f.op([{ type: 'credit', owner: alice.address, asset: 'p0', amount: '100' }], [f.packet(alice.address, [balance])], ['p0']);
  await applyRootAccounts(f.store, award, context); f.commit();
  f.leaves.set(alice.address, new Map([[balance, { available: '100', held: '0' }]]));
  f.supplies.set(accountKey('supply', 'p0'), { issued: '100', burned: '0' });
  assert.equal(f.db.get('ar/' + alice.address).root, accountTree(f.leaves.get(alice.address)).root);
  assert.equal([...f.db.keys()].filter(k => k.startsWith('ar/')).length, 3);
  const transfer = f.sign({ type: 'transfer', owner: alice.address, to: bob.address, asset: 'p0', amount: '30', nonce: nonce(2), until: 20, revision: '1' });
  const send = f.op([transfer], [f.packet(alice.address, [balance, accountKey('nonce', nonce(2))]), f.packet(bob.address, [balance])]);
  await applyRootAccounts(f.store, send, context); f.commit();
  await assert.rejects(applyRootAccounts(f.store, send, context), /account_revision/); assert.equal(f.writes.size, 0);
  f.leaves.get(alice.address).set(balance, { available: '70', held: '0' }); f.leaves.get(alice.address).set(accountKey('nonce', nonce(2)), 'used');
  f.leaves.set(bob.address, new Map([[balance, { available: '30', held: '0' }]]));
  const reserve = f.sign({ type: 'reserve', owner: alice.address, asset: 'p0', amount: '60', id: nonce(8), terms: nonce(9), nonce: nonce(3), until: 20, revision: '2' });
  const request = f.op([reserve], [f.packet(alice.address, [balance, accountKey('nonce', nonce(3))])]);
  await applyRootAccounts(f.store, request, context); f.commit();
  f.leaves.get(alice.address).set(balance, { available: '10', held: '60' }); f.leaves.get(alice.address).set(accountKey('nonce', nonce(3)), 'used');
  assert.equal(f.db.get('ar/' + alice.address).root, accountTree(f.leaves.get(alice.address)).root);
  const spend = f.sign({ ...transfer, amount: '11', revision: '3', nonce: nonce(4) });
  await assert.rejects(applyRootAccounts(f.store, f.op([spend], [f.packet(alice.address, [balance, accountKey('nonce', nonce(4))]), f.packet(bob.address, [balance])]), context), /account_insufficient/);
  assert.equal(f.writes.size, 0);
  const refund = f.op([{ type: 'refund', id: reserve.id, terms: reserve.terms, evidence: nonce(10) }], [f.packet(alice.address, [balance])]);
  await applyRootAccounts(f.store, refund, context); f.commit();
  f.leaves.get(alice.address).set(balance, { available: '70', held: '0' });
  assert.equal(f.db.get('ar/' + alice.address).root, accountTree(f.leaves.get(alice.address)).root);
  await assert.rejects(applyRootAccounts(f.store, f.op(refund.actions, [f.packet(alice.address, [balance])]), context), /obligation_terminal/);
  const replay = f.sign({ ...transfer, revision: '4' });
  await assert.rejects(applyRootAccounts(f.store, f.op([replay], [f.packet(alice.address, [balance, accountKey('nonce', nonce(2))]), f.packet(bob.address, [balance])]), context), /account_replay/);
  const forged = { ...spend, revision: '4' };
  await assert.rejects(applyRootAccounts(f.store, f.op([forged], [f.packet(alice.address, [balance, accountKey('nonce', nonce(4))]), f.packet(bob.address, [balance])]), context), /account_signature/);
});

test('a supply proof failure cannot commit an otherwise valid account update', async () => {
  const f = ledger(), key = accountKey('balance', 'p0');
  const op = f.op([{ type: 'credit', owner: alice.address, asset: 'p0', amount: '1' }], [f.packet(alice.address, [key])], ['p0']);
  op.supply.proof.leaves[0].value = { issued: '1', burned: '0' };
  await assert.rejects(applyRootAccounts(f.store, op, { network: f.network, height: 1 }), /account_root/);
  assert.equal(f.writes.size, 0);
});

test('root cutover refuses every legacy monetary path; the default remains legacy', async () => {
  const h = harness(); await h.mint(['p0']);
  assert.equal(await h.run('tf', { to: bob.address, assets: [['p0', '1']] }), null);
  h.db.set('s/assets', { version: 2 });
  assert.equal(await h.run('tf', { to: bob.address, assets: [['p0', '1']] }), 'account_v2_required');
  assert.equal(await h.tickBatch([{ op: 'mk', to: alice.address, asset: 'p0', amount: '1' }]), 'account_v2_required');
});

for (const height of ['9007199254740991', '9223372036854775807', '9'.repeat(80)]) test(`decimal account authorization and refund clock cross ${height}`, async () => {
  const f = ledger(), balance = accountKey('balance', 'p0'), next = n => String(BigInt(height) + BigInt(n)), context = { network: f.network, height };
  await applyRootAccounts(f.store, f.op([{ type: 'credit', owner: alice.address, asset: 'p0', amount: '100' }], [f.packet(alice.address, [balance])], ['p0']), context); f.commit();
  f.leaves.set(alice.address, new Map([[balance, { available: '100', held: '0' }]]));
  const lock = f.sign({ type: 'lock', owner: alice.address, to: bob.address, asset: 'p0', amount: '100', id: nonce(8), hash: nonce(9), nonce: nonce(3), until: next(2), refund: next(6), revision: '1' });
  const packet = action => f.op([action], [f.packet(alice.address, [balance, accountKey('nonce', nonce(3))])]);
  await assert.rejects(applyRootAccounts(f.store, packet(f.sign({ ...lock, until: 20 })), context), /account_signature/);
  assert.equal(f.writes.size, 0);
  await applyRootAccounts(f.store, packet(lock), context); f.commit();
  assert.equal(f.db.get('al/' + lock.id).refund, next(6));
  f.leaves.get(alice.address).set(balance, { available: '0', held: '100' });
  f.leaves.get(alice.address).set(accountKey('nonce', nonce(3)), 'used');
  const refund = f.op([{ type: 'refund-lock', id: lock.id }], [f.packet(alice.address, [balance])]);
  await assert.rejects(applyRootAccounts(f.store, refund, { ...context, height: next(5) }), /account_lock_proof/);
  assert.equal(f.writes.size, 0);
  await applyRootAccounts(f.store, refund, { ...context, height: next(6) }); f.commit();
  assert.equal(f.db.get('al/' + lock.id).state, 'refunded');
});
