import test from 'node:test';
import assert from 'node:assert/strict';
import { PAYMENT_TIMING_DEFAULTS, notePaymentSeen, paymentTiming } from '../src/payment-timing.js';
import { SETTINGS_PROFILE, validateSettings } from '../src/settings-v2.js';

test('payment grace is bounded, inclusive, durable and cannot be renewed by another report', () => {
  const row = notePaymentSeen({}, ['reference'], '106', '106', { lateConfirmBlocks: 3 });
  assert.deepEqual(row.paymentSeen, { firstSeenBlock: '106', confirmByBlock: '109' });
  assert.equal(paymentTiming(row, '106', '109').held, true);
  assert.equal(paymentTiming(row, '106', '110').held, false);
  assert.deepEqual(notePaymentSeen(row, ['replacement'], '106', '108', { lateConfirmBlocks: 99 }), row);
  assert.equal(notePaymentSeen({}, ['late'], '106', '107', {}).paymentSeen, undefined);
  assert.equal(notePaymentSeen({}, [], '106', '100', {}).paymentSeen, undefined);
  const exact = notePaymentSeen({}, ['payment'], '9007199254741000', '9007199254740999', {});
  assert.equal(exact.paymentSeen.confirmByBlock, String(9007199254741000n + BigInt(PAYMENT_TIMING_DEFAULTS.lateConfirmBlocks)));
});

test('retained settings stay valid and lateConfirmBlocks is an optional positive setting', () => {
  assert.doesNotThrow(() => validateSettings(SETTINGS_PROFILE));
  assert.doesNotThrow(() => validateSettings({ ...SETTINGS_PROFILE, lateConfirmBlocks: 3 }));
  for (const value of [0, -1, 0.5, '3', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => validateSettings({ ...SETTINGS_PROFILE, lateConfirmBlocks: value }), /settings_value/);
});

test('an imported boolean payment flag is not treated as a dated observation', () => {
  const legacy = { paymentSeen: true };
  assert.equal(paymentTiming(legacy, '106', '107').held, false);
  assert.equal(notePaymentSeen(legacy, ['late'], '106', '107', {}).paymentSeen, true);
  const observed = notePaymentSeen(legacy, ['timely'], '106', '106', { lateConfirmBlocks: 2 });
  assert.deepEqual(observed.paymentSeen, { firstSeenBlock: '106', confirmByBlock: '108' });
});
