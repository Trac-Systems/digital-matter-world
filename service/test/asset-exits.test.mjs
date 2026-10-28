import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { temp } from './helpers.mjs';
import { MintOperations } from '../src/operations.mjs';
import { creditOperations, creditSpace, migrateCreditPage, selectCredits, surplusReceipts } from '../src/mint-credits.mjs';
import { assetResources } from '../src/asset-resources.mjs';

test('credit migration and scoped selection reach beyond 4096 historical rows after restart', async t => {
  const directory = await temp(); let store = await Store.open(directory); t.after(() => store.close());
  const fee = { role: 'treasury', to: 'destination', ticker: 'tap', tt: 'a', amount: '10' };
  const source = { owner: 'owner', payer: 'payer', rail: 'tap', items: [fee] };
  for (let offset = 0; offset < 4200; offset += 100) await store.transact(Array.from({ length: 100 }, (_, i) => ({
    space: 'mintCredits', id: String(offset + i).padStart(6, '0'), value: { ...source, owner: offset + i === 4199 ? 'owner' : 'someone_else' },
  })));
  const settings = assetResources({ creditPage: 128 });
  for (let n = 0; n < 20; n++) await migrateCreditPage(store, settings.creditPage);
  await store.close(); store = await Store.open(directory);
  for (let n = 0; n < 14; n++) await migrateCreditPage(store, settings.creditPage);
  assert.deepEqual(await selectCredits(store, { ...source, fees: [fee] }, settings), ['004199']);
  const row = { id: '004199', request: { owner: 'owner' }, payer: 'payer', kind: 'tap' };
  await store.transact(creditOperations(store, row, []));
  assert.equal(store.get('mintCredits', row.id), null);
  assert.equal(store.get(creditSpace(source), row.id), null);
});

test('terminal reservation rejection releases only its own credit claims and enrolls late payments', async t => {
  const store = await Store.open(await temp()); t.after(() => store.close());
  const row = { id: 'request', request: { owner: 'owner', asset: 'p0' }, creditIds: ['ours', 'theirs'], key: 'p0/10', state: 'reserving' };
  await store.transact([{ space: 'creditClaims', id: 'ours', value: row.id }, { space: 'creditClaims', id: 'theirs', value: 'other' },
    { space: 'activeMints', id: row.id, value: true }, { space: 'holds', id: row.key, value: { id: row.id, safeToReplace: false } }]);
  await new MintOperations({ store }).retire('rq/request', row, 'mint_balance', 100);
  assert.equal(store.get('creditClaims', 'ours'), null);
  assert.equal(store.get('creditClaims', 'theirs'), 'other');
  assert.equal(store.get('activeMints', row.id), null);
  assert.equal(store.get('expiredMints', row.id), true);
  assert.equal(store.get('holds', row.key).safeToReplace, true);
  await store.put('holds', row.key, { id: 'newer', safeToReplace: false });
  await new MintOperations({ store }).retire('rq/request', row, 'mint_balance', 101);
  assert.equal(store.get('holds', row.key).id, 'newer');
  assert.equal(store.get('holds', row.key).safeToReplace, false);
});

test('successful consumption credits only confirmed own surplus, excluding already spent amounts', () => {
  const receipt = { key: 'k', origin: 'request', amount: '100', used: '20', accepted: true, confirmations: 1 };
  const row = { id: 'request', payment: { receipts: [receipt, { ...receipt, key: 'foreign', origin: 'old' }] }, progress: { allocations: [{ key: 'k', amount: '30' }] } };
  assert.deepEqual(surplusReceipts(row), [{ ...receipt, used: '50' }]);
  row.progress.allocations[0].amount = '80'; assert.deepEqual(surplusReceipts(row), []);
});
