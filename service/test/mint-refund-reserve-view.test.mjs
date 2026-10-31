import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { newStore } from './helpers.mjs';
import { Store } from '../src/store.mjs';
import { reserveView } from './refund-reserve-fixture.mjs';
import { requestKey, fundingAmount, refundReserve } from '../src/mint-sender-keys.mjs';
import { senderPolicy } from '../src/mint-sender-view.mjs';
import { acceptedRefund } from '../src/mint-refund-view.mjs';
import { publicRefundKey } from '../../contract/public-mint.js';
const id = 'ab'.repeat(32), payer = requestKey(new Uint8Array(32).fill(1), id, 'regtest').address;

test('persisted funding survives a gateway restart, changed market and settings; discovery and accepted refunds carry its reserve', async t => {
  let store = await newStore();
  t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  const f = await reserveView(t, store.directory); f.publish(1);
  const row = f.view.bind({ id, kind: 'tap', payer, receiver: payer, request: { expires: '100' } });
  const quoted = row.mintFunding;
  await store.put('mints', id, row); await store.close(); store = await Store.open(store.directory);
  f.restart({ refundReserveSats: 5000, feeMargin: 3, refundFeeHeadroom: 3 }); f.publish(10);
  const saved = store.get('mints', id), status = { state: 'awaiting_payment', payable: true };
  assert.deepEqual(f.view.decorate(saved, status).mintFunding, quoted);
  assert.deepEqual(f.view.bind(saved), saved);
  assert.notEqual(f.view.bind({ ...saved, id: 'cd'.repeat(32), mintFunding: undefined }).mintFunding.satoshis, quoted.satoshis);
  assert.equal(f.view.page({ store }, new URLSearchParams()).rows[0].refundReserveSats, quoted.refundReserveSats);
  const record = { id, reference: 'ef'.repeat(32) + 'i0', state: 'owed', tapAddress: payer, fees: [{ ticker: 'tap', amount: '1' }] };
  const key = publicRefundKey(record), refundId = key.split('/').at(-1);
  await store.put('accountRecords', key, record);
  assert.equal(acceptedRefund({ store }, refundId).refundReserveSats, quoted.refundReserveSats);
  assert.deepEqual(store.get('accountRecords', key), record, 'local funding does not alter accepted consensus evidence');
  await store.put('mints', id, { ...saved, mintFunding: undefined });
  assert.equal(acceptedRefund({ store }, refundId).refundReserveSats, undefined);
  assert.equal(f.view.decorate(store.get('mints', id), status).mintFunding.satoshis, fundingAmount(f.view.settings));
});

test('gateway uses only matching fresh fee observations and previews follow the market', async t => {
  const store = await newStore(); t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  const f = await reserveView(t, store.directory), s = f.view.settings;
  const quote = () => f.view.bind({ id, kind: 'tap', payer, receiver: payer }).mintFunding;
  assert.equal(quote().refundReserveSats, s.refundReserveSats);
  for (const changes of [{ feeRateAt: undefined }, { feeRateAt: f.now + 1 }, { feeRateAt: f.now - s.refundFeeRateMaxAgeMs - 1 },
    { keyId: 'other' }, { policy: 'other' }]) {
    f.publish(5, changes); assert.equal(quote().refundReserveSats, s.refundReserveSats);
  }
  f.publish(1); const low = quote(); f.publish(5); const high = quote();
  assert.ok(high.satoshis > low.satoshis);
  const preview = f.view.estimate({ publicMint: true, kind: 'tap', state: 'awaiting_payment', receiver: payer });
  assert.equal(preview.mintFundingEstimate.satoshis, high.satoshis);
  assert.equal(f.view.refundFunding(id, payer).satoshis, high.refundReserveSats);
  assert.equal(high.refundReserveSats, refundReserve(s, { payer, feeRate: 5, feeRateAt: f.now, now: f.now }));
});

test('sender policy hash covers every dynamic refund setting', async t => {
  const store = await newStore(); t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  const f = await reserveView(t, store.directory), s = f.view.settings, original = senderPolicy(s);
  for (const [name, value] of Object.entries({ refundReserveMode: 'fixed', refundFeeHeadroom: 2,
    refundReserveMinSats: 1600, refundReserveMaxSats: 6500, refundFeeRateMaxAgeMs: 180000 }))
    assert.notEqual(senderPolicy({ ...s, [name]: value }), original, name);
});
