import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Payouts } from '../src/payouts.mjs';
import { payoutBalance } from '../src/payout-values.mjs';
import { itemPage, publicProjectionRevision } from '../src/public-projections.mjs';
import { claimedPublicRead } from '../src/claimed-public.mjs';
import { deploymentHolders } from '../prod/public-reads.mjs';
import { TapReader } from '../prod/tap.mjs';
import { temp } from './helpers.mjs';
import { hash, heightKey } from '../src/util.mjs';
import { rules as r } from '../src/rules.mjs';

const address = '1BitcoinEaterAddressDontSendf59kuE';
const minimum = '1000000000000000000';
const draft = (id, amount, owner = address, duplicate = false) => {
  const input = { transition: { id, type: 'lifecycle', action: { type: 'capacity-finish' } }, evidence: {
    inscription: hash('mint/' + id) + 'i0', commissions: [0, 1].map(i => ({ id, role: 'legacyDeploy', deployment: hash('deploy/' + i) + 'i0',
      to: owner, amount, payoutMinAtoms: minimum })) } };
  const file = { observation: '2100000000', financialOperations: [input] };
  return { proposal: { batch: { n: '5' } }, items: [{ output: { file } }, ...(duplicate ? [{ output: { file } }] : [])] };
};
test('address accrual is exactly once per deploy and mint, survives restart and pays only at the configured minimum', async t => {
  let store = await Store.open(await temp('legacy-payout-')); t.after(() => store.close());
  const published = new Map(), files = { json: async (path, value) => published.set(path, value) };
  let ledger = new Payouts({ store, files });
  const first = draft(hash('one'), '249999999999999999', address, true);
  await store.transact(ledger.accruals(first)); assert.deepEqual(ledger.accruals(first), []);
  assert.equal(store.get('payoutTotals', hash(address)).accrued, '499999999999999998');
  assert.throws(() => ledger.prepare(address), /below_minimum/);
  await assert.rejects(ledger.record({ beneficiary: address, amount: '1', txid: hash('tx1'), reference: 'premature' }), /below_minimum/);
  await ledger.publish(); assert.equal(published.get('records/payouts/beneficiaries/0.json').rows[0].eligible, false);
  const path = store.directory; await store.close(); store = await Store.open(path); ledger = new Payouts({ store, files });
  await store.transact(ledger.accruals(draft(hash('two'), '250000000000000001')));
  assert.equal(ledger.prepare(address).amount, minimum);
  assert.deepEqual(ledger.prepare(address).items, [{ tick: 'tap', amt: '1', address }]);
  const payment = { beneficiary: address, amount: minimum, txid: hash('paid'), reference: 'paid-once' };
  await ledger.record(payment); await ledger.record(payment);
  assert.equal(store.get('payoutTotals', hash(address)).paid, minimum);
  assert.equal(store.count('commissionOwed'), 4); assert.equal(store.count('payoutPaid'), 1);
  assert.equal(published.get('records/payouts/beneficiaries/0.json').rows[0].owed, '0');
  assert.equal(published.get('records/payouts/beneficiaries/0.json').rows[0].eligible, false);
  assert.throws(() => ledger.prepare(address), /below_minimum/);
});
test('holder transfer accrues to new addresses and an accepted settings successor changes the payout threshold by point reads', async t => {
  const store = await Store.open(await temp('legacy-threshold-')); t.after(() => store.close());
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: r.LEGACY_DEPLOY_SHARE_HEIGHT });
  const ledger = new Payouts({ store, files: { json: async () => {} } });
  const second = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
  await store.transact(ledger.accruals(draft(hash('old'), '2')));
  await store.transact(ledger.accruals(draft(hash('new'), '3', second)));
  assert.equal(store.get('payoutTotals', hash(address)).accrued, '4');
  assert.equal(store.get('payoutTotals', hash(second)).accrued, '6');
  const oldRevision = publicProjectionRevision(store, '/payouts/beneficiaries');
  const oldPage = itemPage(store, 'payouts', '', new URLSearchParams('limit=1'));
  const oldRecords = claimedPublicRead(store, new URL('https://local/payouts/beneficiaries?limit=1'));
  const doc = r.settingsRevision({ network: 'test', effectiveBatch: '6', effectiveBitcoinWindow: r.LEGACY_DEPLOY_SHARE_HEIGHT,
    values: { ...r.SETTINGS_PROFILE, legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '5' } });
  await store.transact([{ space: 'meta', id: 'v2Last', value: { n: '6', to: r.LEGACY_DEPLOY_SHARE_HEIGHT } },
    { space: 'batches', id: heightKey('6'), value: { batch: { settingsHash: r.hashObject(doc) } } },
    { space: 'settingsHistory', id: r.hashObject(doc), value: doc }]);
  const pointOnly = { get: (...args) => store.get(...args), list: () => assert.fail('history scan'), count: () => assert.fail('totals scan') };
  assert.equal(payoutBalance(pointOnly, store.get('payoutTotals', hash(second))).payoutMinAtoms, '5');
  assert.equal(new Payouts({ store: pointOnly }).prepare(second).amount, '6');
  assert.throws(() => new Payouts({ store: pointOnly }).prepare(address), /below_minimum/);
  assert.notEqual(publicProjectionRevision(store, '/payouts/beneficiaries'), oldRevision);
  assert.throws(() => itemPage(store, 'payouts', '', new URLSearchParams({ limit: '1', cursor: oldPage.next })), /cursor_stale/);
  assert.throws(() => claimedPublicRead(store, new URL('https://local/payouts/beneficiaries?cursor=' + oldRecords.next)), /cursor_stale/);
  const rows = itemPage(store, 'payouts', '', new URLSearchParams()).payouts;
  assert.equal(rows.find(row => row.beneficiary === second).eligible, true);
  assert.equal(rows.find(row => row.beneficiary === address).eligible, false);
});
test('holder verification uses only named inscriptions inside the canonical TAP snapshot and fails closed', async () => {
  const id = hash('deploy') + 'i0', tipHash = hash('tip'), calls = [];
  let height = 973900, wrongId = false, invalidAddress = false, move = false;
  const indexer = new TapReader({ agreement: 1, bitcoin: { blockHash: async () => tipHash }, sources: [{ request: async path => {
    calls.push(path);
    if (path === '/r/tap/getCurrentBlock') return { result: move ? height++ : height };
    if (path.startsWith('/r/blockhash/')) return tipHash;
    assert.equal(path, '/inscription/' + id);
    return { id: wrongId ? hash('other') + 'i0' : id, address: invalidAddress ? 'not-an-address' : address };
  } }] });
  assert.deepEqual(await deploymentHolders(indexer, [id], { tip: height, tipHash }), [{ id, address }]);
  assert.equal(calls.filter(p => p.startsWith('/inscription/')).length, 1);
  wrongId = true; await assert.rejects(deploymentHolders(indexer, [id]), /legacy_deploy_holder/); wrongId = false;
  invalidAddress = true; await assert.rejects(deploymentHolders(indexer, [id])); invalidAddress = false;
  await assert.rejects(deploymentHolders(indexer, [id], { tip: height - 1, tipHash }), /historical_snapshot/);
  move = true; await assert.rejects(deploymentHolders(indexer, [id]), /snapshot_changed/);
});
