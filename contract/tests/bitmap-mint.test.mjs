import test from 'node:test';
import assert from 'node:assert/strict';
import { bitmapMintFixture } from '../../service/test/bitmap-mint-fixture.mjs';
import { applyRootAccounts } from '../root-accounts.js';
import { applyPaymentPage } from '../payment-pages.js';
import { accountSettings } from '../../rules/src/account-settings.js';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';

for (const height of ['109', '110']) test(`contract accepts independently verified linked mint reservations at ${height}`, async t => {
  const f = await bitmapMintFixture(t, { height });
  if (height === '109') {
    await assert.rejects(f.prepare(), /financial_mint_right/);
    assert.equal(f.store.get('accountRecords', 'ao/' + f.id) ?? null, null);
    return;
  }
  const { files, result } = await f.prepare();
  await verifyFinancialExecution({ files, reads: f.independent, document: f.document, network: f.network, height, at: await f.stamp() });
  const records = new Map(), store = { get: async key => records.has(key) ? records.get(key) : f.store.get('accountRecords', key),
    put: (key, value) => records.set(key, value), del: key => records.set(key, null) };
  const context = { network: f.network, height, settings: accountSettings(f.document) };
  for (const op of result.operations) {
    if (op.op === 'ar') await applyRootAccounts(store, op, context);
    else await applyPaymentPage(store, op, context);
  }
  assert.equal(records.get('ao/' + f.id).state, 'reserved');
  assert.equal(records.get('fp/' + f.id).state, 'open');
  for (const write of result.writes.filter(w => w.space === 'accountRecords')) assert.deepEqual(records.get(write.id), write.value);
});
