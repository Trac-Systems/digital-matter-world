import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import * as r from '../../rules/src/index.js';
import { accountSettings } from '../../rules/src/account-settings.js';
import { verifyCreditOperations } from '../../rules/src/account-batch.js';
import { financialPlan } from '../../rules/src/financial-execution.js';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { accountActionDigest, applyRootAccounts } from '../../contract/root-accounts.js';
import { AccountExecution, buildCreditAccounts } from '../src/account-batch.mjs';
import { AccountAvailability } from '../src/account-availability.mjs';

const key = r.hashBytes('account-transfer-owner'), otherKey = r.hashBytes('account-transfer-recipient');
const owner = r.bytesToHex(ed25519.getPublicKey(key)), to = r.bytesToHex(ed25519.getPublicKey(otherKey));
const document = r.settingsRevision({ network: 'account-transfer-test', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
const sign = (action, secret = key) => ({ ...action, sig: r.bytesToHex(ed25519.sign(accountActionDigest(document.network, action), secret)) });
const transfer = (asset = 'p2:1', amount = '2', extra = {}) => sign({ type: 'transfer', owner, to, asset, amount,
  revision: '1', nonce: r.hash(asset), until: '100', ...extra });
const compound = 'c2:' + r.hash('transfer-compound');
async function fixture() {
  const rows = new Map(), store = { get: (space, id) => rows.get(space + '/' + id) };
  const commit = result => { for (const w of result.writes) rows.set(w.space + '/' + w.id, w.value); };
  commit(await buildCreditAccounts({ store, document, height: '1', credits: [{ op: 'ac', to: owner, assets: [['p2:1', '5'], ['p0', '3'], [compound, '2']] }] }));
  const leaf = (who, kind, asset) => {
    const root = store.get('accountRecords', 'ar/' + who)?.root;
    if (!root) return null;
    const key = accountKey(kind, asset); return readAccountLeaf(root, new AccountAvailability(store).prove(root, [key]), key);
  };
  const execute = async actions => { const execution = new AccountExecution({ store, document, height: '10' }); await execution.accounts(actions); return execution.result(); };
  return { rows, store, commit, leaf, execute };
}

test('account engine transfers p2, imported p0 and c2 units with conserved supply and both public balances', async () => {
  const f = await fixture(), supply = structuredClone(f.store.get('accountRecords', 'ar/supply')), before = structuredClone([...f.rows]);
  const result = await f.execute([transfer(), transfer('p0', '1'), transfer(compound, '2')]);
  assert.deepEqual([...f.rows], before, 'preparing an account operation never spends');
  f.commit(result);
  for (const [asset, remaining, received] of [['p2:1', '3', '2'], ['p0', '2', '1'], [compound, '0', '2']]) {
    assert.equal(f.leaf(owner, 'balance', asset)?.available ?? '0', remaining);
    assert.deepEqual(f.leaf(to, 'balance', asset), { available: received, held: '0' });
    assert.equal(f.leaf(owner, 'nonce', r.hash(asset)), 'used');
    assert.equal(f.store.get('publicBalances', owner + '/' + asset).amount, remaining);
    assert.equal(f.store.get('publicBalances', to + '/' + asset).amount, received);
    assert.equal(f.store.get('publicSupply', asset).burned, '0');
  }
  assert.deepEqual(f.store.get('accountRecords', 'ar/supply'), supply);
  assert.equal(f.store.get('publicSummaries', 'outstandingSupply').matter, '10');
  for (const who of [owner, to]) assert.deepEqual(f.store.get('publicBalanceHeads', who), f.store.get('accountRecords', 'ar/' + who));
});

test('account transfer rejects bad signatures, stale revisions, replay, expiry and overspending atomically', async () => {
  const f = await fixture(), before = structuredClone([...f.rows]);
  for (const [actions, reason] of [
    [[{ ...transfer(), amount: '3' }], /account_signature/],
    [[transfer('p2:1', '1', { revision: '0' })], /account_signature/],
    [[transfer('p2:1', '1', { until: '9' })], /account_signature/],
    [[transfer('p2:1', '6')], /account_insufficient/],
    [[transfer('p2:1', '1'), transfer('p0', '4')], /account_insufficient/],
    [[transfer('p2:99', '1')], /account_insufficient/]
  ]) { await assert.rejects(f.execute(actions), reason); assert.deepEqual([...f.rows], before); }
  f.commit(await f.execute([transfer()])); const accepted = structuredClone([...f.rows]);
  await assert.rejects(f.execute([transfer()]), /account_signature/);
  await assert.rejects(f.execute([transfer('p2:1', '2', { revision: '2' })]), /account_replay/);
  assert.deepEqual([...f.rows], accepted);
});

test('account transfer rejects forged sender/recipient proofs before writing', async () => {
  const f = await fixture(), result = await f.execute([transfer()]);
  for (const alter of [
    o => o.accounts.find(a => a.owner === owner).proof.leaves.find(l => l.key === accountKey('balance', 'p2:1')).value.available = '100',
    o => o.accounts.find(a => a.owner === owner).proof.leaves = o.accounts.find(a => a.owner === owner).proof.leaves.filter(l => l.key !== accountKey('nonce', r.hash('p2:1'))),
    o => o.accounts.find(a => a.owner === to).proof.empty = false,
    o => o.actions[0].to = r.hash('different-recipient')
  ]) {
    const operation = structuredClone(result.operations[0]), writes = []; alter(operation);
    await assert.rejects(applyRootAccounts({ get: async id => f.store.get('accountRecords', id), put: (...args) => writes.push(args) }, operation,
      { network: document.network, height: '10', settings: accountSettings(document) }));
    assert.deepEqual(writes, []);
  }
});

test('signer rules require explicit receipt-derived transfers and reject pre-activation admission', async () => {
  const f = await fixture(), result = await f.execute([transfer()]);
  assert.throws(() => verifyCreditOperations([], result.operations, []), /account_credit_derivation/);
  assert.throws(() => r.validateNamedPayload('transfer-v2', { actions: [transfer()] }, document), /move_type/);
  assert.throws(() => r.validateNamedPayload('craft-v2', { recipe: 'fusion', snapshot: { height: '10', hash: r.hash('snapshot') }, action: transfer() }, document), /craft_authorization/);
  await assert.rejects(financialPlan({ transition: { type: 'reserve', id: r.hash('reservation'), action: transfer(), fees: [] }, evidence: {} },
    { read: async () => null, height: '10', document }), /financial_reservation/);
});

test('transferred units can fund the existing public-role mint reservation after the finder week in the account engine', async () => {
  const f = await fixture();
  const find = { asset: 'p2:1', block: '1', count: '2', finder: owner, findHeight: '10', finderUntil: '1018', settingsHash: r.hashObject(document) };
  assert.equal(r.mintRight({ find, owner: to, counted: '1017' }).allowed, false);
  assert.deepEqual(r.mintRight({ find, owner: to, counted: '1018' }), { allowed: true, role: 'public', until: null });
  const id = r.hash('recipient-mint'), reserve = sign({ type: 'reserve', id, owner: to, asset: find.asset, amount: find.count,
    terms: r.hash('terms'), revision: '1', nonce: r.hash('recipient-reserve'), until: '1030' }, otherKey);
  const empty = new AccountExecution({ store: f.store, document, height: '1018' });
  await assert.rejects(empty.accounts([sign({ ...reserve, revision: '0' }, otherKey)]), /account_insufficient/);
  f.commit(await f.execute([transfer()]));
  const execution = new AccountExecution({ store: f.store, document, height: '1018' }); await execution.accounts([reserve]); f.commit(execution.result());
  assert.deepEqual(f.leaf(to, 'balance', find.asset), { available: '0', held: '2' });
  assert.equal(f.store.get('accountRecords', 'ao/' + id).state, 'reserved');
});
