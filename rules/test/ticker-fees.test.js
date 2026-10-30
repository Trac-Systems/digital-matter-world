import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../src/index.js';

const height = rules.MULTI_TICKER_HEIGHT, before = (BigInt(height) - 1n).toString();
const document = values => rules.settingsRevision({ network: 'dmw-regtest', effectiveBatch: '0', effectiveBitcoinWindow: '0',
  values: { ...rules.SETTINGS_PROFILE, ...values } });

test('ticker fee kind is refused before activation and uses operator settings exactly at activation', () => {
  for (const executionHeight of ['0', before]) {
    assert.throws(() => rules.feeFor('ticker', '100', 1, { tickerDeployMultiplier: 7 }, executionHeight), /fee_kind/);
    assert.throws(() => rules.financialSplit('100', { kind: 'ticker', executionHeight }, document()), /fee_kind/);
  }
  assert.equal(rules.feeFor('ticker', '100', 1, {}, height), '0');
  assert.equal(rules.feeFor('ticker', '101', 1, { tickerDeployMultiplier: 7 }, height), '707');
  const split = rules.financialSplit('707', { kind: 'ticker', executionHeight: height }, document({ tickerDeployMultiplier: 7, tickerDeployBurnBps: 3333 }));
  assert.deepEqual(split, { firstMaker: '0', finder: '0', landowner: '0', burn: '235', treasury: '472', discoverer: '0' });
  assert.equal(rules.financialSplit('707', { kind: 'ticker', executionHeight: height }, document()).treasury, '707');
  for (const tickerDeployMultiplier of [-1, 1.5, '2', Infinity]) assert.throws(() => rules.feeFor('ticker', '100', 1, { tickerDeployMultiplier }, height), /fee_settings/);
  assert.throws(() => rules.feeFor('ticker', rules.TAP_MAX_ATOMS.toString(), 1, { tickerDeployMultiplier: 2 }, height), /tap_amount_range/);
});

test('ticker settings form a complete optional group without rewriting retained documents', () => {
  const old = document(), bytes = rules.stableJSON(old), hash = rules.hashObject(old);
  assert.equal(Object.hasOwn(old.values, 'tickerDeployMultiplier'), false);
  rules.validateSettingsDocument(old);
  assert.equal(rules.stableJSON(old), bytes); assert.equal(rules.hashObject(old), hash);
  for (const values of [{ tickerDeployMultiplier: 0 }, { tickerDeployBurnBps: 0 },
    { tickerDeployMultiplier: -1, tickerDeployBurnBps: 0 }, { tickerDeployMultiplier: 1.5, tickerDeployBurnBps: 0 },
    { tickerDeployMultiplier: 1, tickerDeployBurnBps: -1 }, { tickerDeployMultiplier: 1, tickerDeployBurnBps: 10001 }]) assert.throws(() => document(values));
  for (const tickerDeployBurnBps of [0, 1, 5000, 10000]) document({ tickerDeployMultiplier: 0, tickerDeployBurnBps });
});

test('link split changes at execution activation only and preserves rounding and payment parity', () => {
  for (const total of ['0', '1', '999', '11142309577929313189']) for (const bps of [0, 1234, 5000, 10000]) {
    const d = document({ linkBurnBps: bps }), old = rules.splitFee(total, { kind: 'link' });
    assert.deepEqual(rules.linkPaymentSplit(total, d, before), old);
    assert.deepEqual(rules.linkPaymentSplit(total, null, before), old);
    const split = rules.linkPaymentSplit(total, d, height);
    assert.equal(split.burn, (BigInt(total) * BigInt(bps) / 10000n).toString());
    assert.equal(BigInt(split.burn) + BigInt(split.treasury), BigInt(total));
    if (bps === 5000) assert.deepEqual(split, old);
    for (const rail of ['tap', 'ethereum']) {
      const destinations = { treasury: rail === 'tap' ? 'bc1qtreasury' : '0x' + '11'.repeat(20) };
      assert.deepEqual(rules.mintFeeItems(rules.linkPaymentSplit(total, d, before), destinations, 'id', 'payer', rail),
        rules.mintFeeItems(old, destinations, 'id', 'payer', rail));
    }
  }
  assert.throws(() => rules.linkPaymentSplit('100', null, height), /link_settings/);
});
