import test from 'node:test';
import assert from 'node:assert/strict';
import { FinancialMints } from '../src/financial-mints.mjs';
import { KeyedWork } from '../src/keyed-work.mjs';
import { rules } from '../src/rules.mjs';
const id = '11'.repeat(32), reference = '22'.repeat(32) + 'i0';
function fixture(kind = 'tap') {
  const data = new Map(), key = (s, k) => s + '/' + k;
  const store = { get: (s, k) => data.get(key(s, k)), put: async (s, k, v) => data.set(key(s, k), v),
    transact: async ws => { for (const w of ws) w.value === undefined ? data.delete(key(w.space, w.id)) : data.set(key(w.space, w.id), w.value); } };
  const m = Object.create(FinancialMints.prototype), funding = { state: 'open', fees: [{ key: id, amount: '10' }], paid: ['0'] };
  const document = rules.settingsRevision({ network: 'late-test', effectiveBatch: '1', effectiveBitcoinWindow: '100', values: { ...rules.SETTINGS_PROFILE, pendingBlocks: 6 } });
  const row = { id, kind, state: 'awaiting_payment', request: { owner: id, settingsHash: rules.hashObject(document) }, expiry: '106', quote: { fees: [] }, paymentReferences: [reference] };
  Object.assign(m, { store, document, mintWork: new KeyedWork(), reads: { batchStamp: async () => ({ counted: '107' }), financialRecord: async () => funding,
    financialReceipts: async () => [], financialEscrow: async () => { throw Error('financial_escrow_unsettled'); } }, financial: { expire: async () => true }, queued: [] });
  m.queue = async (r, transition) => { m.queued.push(transition); return { id: 'queued' }; };
  m.public = () => store.get('mints', id);
  return { m, store, row, funding };
}
for (const kind of ['tap', 'ethereum']) test(`${kind}: expiry releases the request and preserves unconfirmed references for automatic recovery`, async () => {
  const { m, store, row, funding } = fixture(kind);
  if (kind === 'ethereum') { delete row.paymentReferences; row.ethereumReferences = ['0x' + '33'.repeat(32)]; }
  m.paymentPage = async () => null;
  await m.advance(row);
  assert.deepEqual(m.queued, [{ type: 'refund', id, reason: 'credit' }]);
  assert.deepEqual(store.get('financialLegacyCredits', id).references, row.paymentReferences ?? row.ethereumReferences);
  funding.state = 'credited'; await store.put('financialActiveMints', id, true); await m.advance(row);
  assert.equal(store.get('mints', id).state, 'expired'); assert.equal(store.get('financialActiveMints', id), undefined);
});
test('expiry first allocates confirmed receipts before crediting, without requiring a legacy source', async () => {
  const { m, row } = fixture(); let checked = false;
  m.paymentPage = async (_row, refs, _at, opts) => { checked = opts.allowEmpty; assert.deepEqual(refs, [reference]); return {}; };
  await m.advance(row); assert.equal(checked, true); assert.deepEqual(m.queued, []);
});
test('a report is durable even when the payment is unconfirmed', async () => {
  const { m, row, store } = fixture(); delete row.paymentReferences; await store.put('mints', id, row);
  m.paymentPage = async () => { throw Error('payment_unconfirmed'); };
  await assert.rejects(m.payment({ id, paymentId: reference }), /payment_unconfirmed/);
  assert.deepEqual(store.get('mints', id).paymentReferences, [reference]);
});
test('unconfirmed surplus hints rotate individually, retaining both across restart', async () => {
  const { m, store, funding } = fixture(); funding.state = 'credited';
  const other = '44'.repeat(32) + 'i0', seen = [];
  await store.put('financialLegacyCredits', id, { references: [reference, other], offset: 0 });
  m.reads.financialReceipts = async (_id, refs) => { seen.push(refs); return []; };
  for (let n = 0; n < 3; n++) await assert.rejects(m.advanceLegacyCredit(id), /pending_credit_unconfirmed/);
  assert.deepEqual(seen, [[reference], [other], [reference]]);
  assert.deepEqual(store.get('financialLegacyCredits', id).references, [reference, other]);
});

test('Ethereum broadcast references survive an unavailable deposit read', async () => {
  const { m, row, store } = fixture('ethereum'); delete row.paymentReferences;
  await store.put('mints', id, row); const reference = '0x' + '55'.repeat(32);
  await assert.rejects(m.payment({ id, paymentId: reference }), /financial_escrow_unsettled/);
  assert.deepEqual(store.get('mints', id).ethereumReferences, [reference]);
});

test('a payment reported during another queued transition is saved for the next tick', async () => {
  const { m, row, store } = fixture(); delete row.paymentReferences; row.work = 'pending';
  await store.put('mints', id, row); m.paymentPage = () => assert.fail('wait for the accepted predecessor');
  await m.payment({ id, paymentId: reference });
  assert.deepEqual(store.get('mints', id).paymentReferences, [reference]);
});
