import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { PublicMints } from '../src/public-mints.mjs';
import { newStore } from './helpers.mjs';
import { rules } from '../src/rules.mjs';
import { publicScanKey } from '../../contract/public-mint.js';

async function fixture(t, workPage = 2) {
  const store = await newStore();
  t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  const parent = { store, resources: { workPage } }, mints = new PublicMints(parent);
  const add = async (id, expiry, block = '1') => {
    const row = { id, publicMint: true, request: { asset: 'p2:0', block }, expiry, paymentIds: [rules.hash(id) + 'i0'], state: 'scanning' };
    await store.transact([{ space: 'mints', id, value: row }, { space: 'publicMintRequests', id, value: true },
      { space: 'publicMintPlots', id: rules.publicPlotId('p2:0', block), value: { asset: 'p2:0', block } }]);
    return row;
  };
  return { store, parent, mints, add };
}
test('expired unpaid checkouts release admission capacity while retaining delayed-payment reconciliation', async t => {
  const f = await fixture(t), expired = await f.add('a', '10'), current = await f.add('b', '11', '2');
  await f.mints.releaseFinishedRequests('11');
  assert.equal(f.store.get('publicMintRequests', 'a'), null);
  assert.equal(f.store.get('publicMintRequests', 'b'), true, 'inclusive last payment block remains open');
  assert.deepEqual(f.store.get('mints', 'a'), expired); assert.deepEqual(f.store.get('mints', 'b'), current);
  assert.equal(f.store.count('publicMintPlots'), 2, 'late and unreported payments remain discoverable');
});
test('bounded checkout cleanup resumes after restart and releases losing checkouts without discarding refunds', async t => {
  const f = await fixture(t, 1);
  await f.add('a', '50'); const loser = await f.add('b', '50', '2'); await f.add('c', '10', '3');
  const refund = { id: 'b', reference: rules.hash('payment') + 'i0', reason: 'someone_paid_first', state: 'owed' };
  await f.store.put('publicMintRefundsByRequest/b', rules.hash('refund'), refund);
  await f.store.put('accountRecords', publicScanKey(rules.publicPlotId('p2:0', '2')), { winner: { id: 'winner' } });
  await f.mints.releaseFinishedRequests('11'); assert.equal(f.store.count('publicMintRequests'), 3);
  const resumed = new PublicMints(f.parent);
  await resumed.releaseFinishedRequests('11'); assert.equal(f.store.get('publicMintRequests', 'b'), null);
  await resumed.releaseFinishedRequests('11'); assert.equal(f.store.get('publicMintRequests', 'c'), null);
  await resumed.releaseFinishedRequests('11'); assert.equal(f.store.get('publicMintRequests', 'a'), true);
  assert.deepEqual(f.store.get('mints', 'b'), loser);
  assert.deepEqual(f.store.list('publicMintRefundsByRequest/b', { limit: 1 })[0].value, refund);
});
