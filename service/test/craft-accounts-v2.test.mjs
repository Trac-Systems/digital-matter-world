import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import * as r from '../../rules/src/index.js';
import { verifyCreditOperations } from '../../rules/src/account-batch.js';
import { accountSettings } from '../../rules/src/account-settings.js';
import { applyRootAccounts, accountActionDigest } from '../../contract/root-accounts.js';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { buildCreditAccounts } from '../src/account-batch.mjs';
import { AccountAvailability } from '../src/account-availability.mjs';
const key = r.hashBytes('disposable-account-craft'), owner = r.bytesToHex(ed25519.getPublicKey(key));
const document = r.settingsRevision({ network: 'craft-accounts', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
const sign = (action) => ({ ...action, sig: r.bytesToHex(ed25519.sign(accountActionDigest(document.network, action), key)) });
const compound = 'c2:' + r.hash('compound');
const action = (nonce = 'one', revision = '1') => sign({ type: 'craft', owner, revision, nonce: r.hash(nonce), until: 100,
  in: [['p2:0', '2'], ['p2:1', '2']], out: [[compound, '2']], compound: compound.slice(3) });
async function fixture() {
  const rows = new Map(), store = { get: (space, id) => rows.get(space + '/' + id) };
  const commit = result => { for (const w of result.writes) rows.set(w.space + '/' + w.id, w.value); };
  commit(await buildCreditAccounts({ store, document, height: 1, credits: [{ op: 'ac', to: owner, assets: [['p2:0', '3'], ['p2:1', '3']] }] }));
  const leaf = (kind, asset) => { const root = store.get('accountRecords', 'ar/' + (kind === 'supply' ? 'supply' : owner)).root, k = accountKey(kind, asset);
    return readAccountLeaf(root, new AccountAvailability(store).prove(root, [k]), k); };
  return { store, commit, rows, leaf };
}
test('craft debit, credit, supply and nonce commit together; stale revisions, replay and overspending leave no writes', async () => {
  const f = await fixture(), before = structuredClone([...f.rows]);
  const craft = { action: action() };
  const result = await buildCreditAccounts({ store: f.store, document, height: 10, credits: [], crafts: [craft] });
  assert.deepEqual([...f.rows], before, 'building proofs does not spend');
  assert.equal(verifyCreditOperations([], result.operations, [craft]), result.operations);
  assert.throws(() => verifyCreditOperations([], result.operations, []), /account_credit_derivation/);
  await assert.rejects(buildCreditAccounts({ store: f.store, document, height: 10, credits: [], crafts: [craft, { action: action('two') }] }), /account_insufficient/);
  assert.deepEqual([...f.rows], before);
  f.commit(result);
  assert.deepEqual(f.leaf('balance', 'p2:0'), { available: '1', held: '0' });
  assert.deepEqual(f.leaf('balance', compound), { available: '2', held: '0' });
  assert.deepEqual(f.leaf('supply', 'p2:0'), { issued: '3', burned: '2' });
  assert.deepEqual(f.leaf('supply', compound), { issued: '2', burned: '0' });
  assert.equal(f.leaf('nonce', r.hash('one')), 'used');
  assert.equal(f.store.get('publicBalances', owner + '/p2:0').amount, '1');
  assert.equal(f.store.get('publicBalances', owner + '/' + compound).amount, '2');
  assert.deepEqual(f.store.get('publicBalanceHeads', owner), f.store.get('accountRecords', 'ar/' + owner));
  const after = structuredClone([...f.rows]);
  await assert.rejects(buildCreditAccounts({ store: f.store, document, height: 10, credits: [], crafts: [craft] }), /account_signature/);
  await assert.rejects(buildCreditAccounts({ store: f.store, document, height: 10, credits: [], crafts: [{ action: action('one', '2') }] }), /account_replay/);
  assert.deepEqual([...f.rows], after);
});
test('signer/notary rejects forged balance, nonce and supply proofs before any state write', async () => {
  const f = await fixture(), built = await buildCreditAccounts({ store: f.store, document, height: 10, credits: [], crafts: [{ action: action() }] });
  for (const alter of [
    o => o.accounts[0].revision = '0',
    o => o.accounts[0].proof.leaves.find(l => l.key === accountKey('balance', 'p2:0')).value.available = '1000',
    o => o.accounts[0].proof.leaves = o.accounts[0].proof.leaves.filter(l => l.key !== accountKey('nonce', r.hash('one'))),
    o => o.supply.proof.leaves[0].value = { issued: '1000', burned: '0' },
    o => o.actions[0].out[0][1] = '1000'
  ]) {
    const forged = structuredClone(built.operations[0]); alter(forged); const writes = [];
    await assert.rejects(applyRootAccounts({ get: async id => f.store.get('accountRecords', id), put: (...args) => writes.push(args) }, forged,
      { network: document.network, height: 10, settings: accountSettings(document) }));
    assert.deepEqual(writes, []);
  }
});
