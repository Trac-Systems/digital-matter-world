import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { mergeFixture } from '../../rules/test/fixtures/compound-merge-v4.js';
import { accountKey, accountTree } from '../account-tree.js';
import { applyRootAccounts } from '../root-accounts.js';
const height = r.COMPOUND_IDENTITY_V4_HEIGHT;
function ledger() {
  const f = mergeFixture(), balances = new Map(), supplies = new Map(), db = new Map(), writes = new Map();
  for (const row of f.manifest.rows) {
    balances.set(accountKey('balance', row.oldId), { available: row.amount, held: '0' });
    supplies.set(accountKey('supply', row.oldId), { issued: row.amount, burned: '0' });
  }
  db.set('ar/' + f.owner, { root: accountTree(balances).root, revision: '1' });
  db.set('ar/supply', { root: accountTree(supplies).root, revision: '1' });
  const assets = [...f.records.map(c => c.id), f.id];
  const operation = { op: 'ar', v: 2, actions: [{ type: 'compound-merge', manifest: r.hashObject(f.manifest) }], availability: r.hash('availability'),
    accounts: [{ owner: f.owner, revision: '1', proof: accountTree(balances).prove(assets.map(a => accountKey('balance', a))) }],
    supply: { revision: '1', proof: accountTree(supplies).prove(assets.map(a => accountKey('supply', a))) } };
  const store = { get: async k => db.get(k), put: (k, v) => writes.set(k, v) };
  return { ...f, balances, supplies, db, writes, operation, store, context: { network: f.network, height, mergeManifest: f.manifest } };
}
test('contract atomically converts all 11 units and supply, and persists the one-time marker', async () => {
  const f = ledger();
  await assert.rejects(applyRootAccounts(f.store, f.operation, { ...f.context, executionHeight: String(BigInt(height) - 1n) }), /compound_merge_authorization/);
  assert.equal(f.writes.size, 0);
  await applyRootAccounts(f.store, f.operation, f.context);
  assert.equal(f.writes.get('ar/' + f.owner).root, accountTree(new Map([[accountKey('balance', f.id), { available: '11', held: '0' }]])).root);
  const expected = new Map(f.supplies);
  for (const row of f.manifest.rows) expected.set(accountKey('supply', row.oldId), { issued: row.amount, burned: row.amount });
  expected.set(accountKey('supply', f.id), { issued: '11', burned: '0' });
  assert.equal(f.writes.get('ar/supply').root, accountTree(expected).root);
  assert.equal(f.writes.get(r.COMPOUND_MERGE_ACCOUNT_MARKER), r.hashObject(f.manifest));
  f.db.set(r.COMPOUND_MERGE_ACCOUNT_MARKER, r.hashObject(f.manifest)); f.writes.clear();
  await assert.rejects(applyRootAccounts(f.store, f.operation, f.context), /compound_merge_authorization/);
  assert.equal(f.writes.size, 0);
});
test('contract refuses stale amounts, omitted holders, held units, forged proofs and unauthorized manifests without writes', async () => {
  for (const change of [
    f => f.operation.actions[0].manifest = r.hash('forged'),
    f => { f.context.mergeManifest = structuredClone(f.manifest); f.context.mergeManifest.rows[0].amount = '2'; f.operation.actions[0].manifest = r.hashObject(f.context.mergeManifest); },
    f => { f.operation.accounts[0].proof.leaves.find(l => l.value).value.available = '100'; },
    f => { f.operation.accounts[0].proof.leaves.find(l => l.value).value.held = '1'; },
    f => { const leaf = f.operation.supply.proof.leaves.find(l => l.value); leaf.value.issued = '100'; },
    f => f.operation.actions.push(f.operation.actions[0])
  ]) {
    const f = ledger(); change(f);
    await assert.rejects(applyRootAccounts(f.store, f.operation, f.context)); assert.equal(f.writes.size, 0);
  }
});
