import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { applyPaymentPage } from '../payment-pages.js';
import { validatePublicPaymentSettlement } from '../public-payment.js';

function fixture() {
  const network = 'test', settings = { publicMintActivationHeight: '100', publicMintPageSize: 50, publicPaymentV2Height: '103' };
  const fees = [{ role: 'treasury', to: 'payer', ticker: 'tap', amount: '10' }];
  const intent = { network, asset: 'p2:0', block: '100', tapAddress: 'payer', settingsHash: r.hash('settings'),
    feeQuote: { validFrom: '103', validUntil: '120' }, paymentVersion: 2, paymentSalt: r.hash('salt'), fees, signature: '00'.repeat(64) };
  const id = r.publicPaymentCommitment(intent), registration = { network, commitment: id, payer: 'payer', validFrom: '103', validUntil: '120',
    settingsHash: intent.settingsHash, feeBindings: fees.map(f => r.publicPaymentFeeBinding(id, f.role, f.to, f.ticker)), signature: '00'.repeat(64) };
  const records = new Map(), store = { get: async key => records.get(key), put: (key, value) => records.set(key, value) };
  const register = { op: 'fp', v: 2, type: 'public-payment', id, action: 'register', previous: r.hashObject(null), registration };
  const apply = (op, height = '103') => applyPaymentPage(store, op, { network, settings, height });
  const reveal = () => ({ op: 'fp', v: 2, type: 'public-payment', id, action: 'reveal', previous: r.hashObject(records.get(r.publicPaymentKey(id))),
    intent, reference: r.hash('payment') + 'i0', paymentHeight: '104' });
  return { network, settings, intent, id, records, store, register, apply, reveal };
}

test('contract requires an activated, fresh registration and accepts only one bound reveal', async () => {
  const f = fixture();
  await assert.rejects(f.apply(f.register, '102'), /public_payment_activation/);
  await assert.rejects(f.apply(f.register, '121'), /public_payment_registration/);
  assert.equal(f.records.size, 0);
  await f.apply(f.register);
  const before = structuredClone([...f.records]), reveal = f.reveal();
  for (const bad of [{ ...reveal, intent: { ...f.intent, block: '101' } },
    { ...reveal, intent: { ...f.intent, paymentSalt: r.hash('other-salt') } },
    { ...reveal, paymentHeight: '103' }, { ...reveal, paymentHeight: '105' }, { ...reveal, previous: r.hash('wrong') }]) {
    await assert.rejects(f.apply(bad, '104'), /public_payment_(commitment|reveal|predecessor)/);
    assert.deepEqual([...f.records], before);
  }
  await f.apply(reveal, '104');
  assert.deepEqual(f.records.get(r.publicPaymentKey(f.id)).intent, f.intent);
  await assert.rejects(f.apply(reveal, '104'), /public_payment_predecessor/);
});

test('contract settlement resolves the accepted commitment and rejects target, payer, or source substitutions', async () => {
  const f = fixture(); await f.apply(f.register); await f.apply(f.reveal(), '104');
  const payment = { id: r.publicRequestId(f.network, f.intent), asset: f.intent.asset, block: f.intent.block, tapAddress: f.intent.tapAddress,
    height: '104', paymentCreated: '103', paymentVersion: 2, commitment: f.id, source: { intent: f.intent } };
  const check = p => validatePublicPaymentSettlement(f.store, p, { network: f.network, settings: f.settings, height: '104' });
  await check(payment);
  for (const changed of [{ asset: 'p2:1' }, { block: '101' }, { tapAddress: 'other' }, { id: r.hash('other') },
    { paymentCreated: '102' }, { source: { intent: { ...f.intent, block: '101' } } }]) {
    await assert.rejects(check({ ...payment, ...changed }), /public_payment_binding/);
  }
  await assert.rejects(check({ ...payment, commitment: r.hash('unknown') }), /public_payment_unrevealed/);
});

test('contract grandfathers a v1 creation height but refuses new v1 payments after the boundary', async () => {
  const f = fixture(), check = p => validatePublicPaymentSettlement(f.store, p, { settings: f.settings, height: '104' });
  await check({ paymentVersion: 1, paymentCreated: '102' });
  await assert.rejects(check({ paymentVersion: 1, paymentCreated: '103' }), /public_payment_activation/);
  await assert.rejects(check({}), /public_payment_created/);
  await validatePublicPaymentSettlement(f.store, {}, { settings: f.settings, height: '102' });
  await validatePublicPaymentSettlement(f.store, {}, { settings: {}, height: '1000000' });
});
