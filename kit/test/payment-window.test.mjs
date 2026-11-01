import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPaymentWindow, PAYMENT_MIN_BLOCKS } from '../lib/payment-window.mjs';

const status = { payBy: { untilBlock: '106' } };
test('payment window defaults to two blocks and honors a stricter wallet setting', async () => {
  assert.equal(PAYMENT_MIN_BLOCKS, 2);
  assert.deepEqual(await checkPaymentWindow({ status, readTip: async () => 104 }), { tip: '104', remainingBlocks: '2' });
  await assert.rejects(checkPaymentWindow({ status, readTip: async () => '104', minPaymentBlocks: 3 }), e => e.code === 'payment_window_short');
  for (const minPaymentBlocks of [0, -1, 1.5, '2'])
    await assert.rejects(checkPaymentWindow({ status, readTip: async () => 100, minPaymentBlocks }), /Invalid minimum/);
});

test('payment window fails closed for unavailable tips and missing deadlines', async () => {
  await assert.rejects(checkPaymentWindow({ status, readTip: async () => { throw Error('offline'); } }), e => e.code === 'payment_tip_unavailable');
  for (const tip of [null, -1, 105.5, '105x']) await assert.rejects(checkPaymentWindow({ status, readTip: async () => tip }), /current Bitcoin block/);
  await assert.rejects(checkPaymentWindow({ status: {}, readTip: async () => 100 }), /fresh request/);
});

test('default tip readers request fresh network heights and support the local reader path', async () => {
  const calls = [], fetchImpl = async (url, options) => {
    calls.push({ url, options }); return { ok: true, text: async () => '104', json: async () => ({ result: 104 }) };
  };
  await checkPaymentWindow({ status, network: 'mainnet', fetchImpl });
  await checkPaymentWindow({ status, network: 'regtest', readerPath: '/local-reader', fetchImpl });
  assert.deepEqual(calls.map(c => c.url), ['https://mempool.space/api/blocks/tip/height', '/local-reader/getCurrentBlock']);
  assert.ok(calls.every(c => c.options.cache === 'no-store' && c.options.redirect === 'error'));
});
