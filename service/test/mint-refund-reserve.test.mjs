import test from 'node:test';
import assert from 'node:assert/strict';
import { mintSenderSettings } from '../src/mint-sender-settings.mjs';
import { fundingAmount, fundingQuote, inscriptionBudget, refundReserve, requestKey } from '../src/mint-sender-keys.mjs';
import { refundRedeemBytes } from '../src/mint-refund-payload.mjs';
import { refundRedeem } from '../src/mint-refund-protocol.mjs';

const seed = new Uint8Array(32).fill(1), id = 'ab'.repeat(32);
const payer = requestKey(seed, id, 'mainnet').address;
const settings = mintSenderSettings({ refundsEnabled: true });
const observation = { payer, feeRate: 2, feeRateAt: 1000000, now: 1000000 };

test('dynamic refund reserve measures the redeem envelope across market rates and clamps', () => {
  assert.equal(refundRedeemBytes(payer), 823);
  for (const [feeRate, expected] of [[1, 1844], [2, 2595], [3, 3347], [5, 4850], [10, 6000], [1000, 6000]]) {
    assert.equal(refundReserve(settings, { ...observation, feeRate }), expected);
    assert.equal(fundingAmount(settings, { ...observation, feeRate }), inscriptionBudget(settings) + expected);
  }
  assert.equal(refundReserve({ ...settings, refundReserveMinSats: 2500 }, { ...observation, feeRate: 1 }), 2500);
  assert.equal(refundReserve({ ...settings, refundReserveMaxSats: 4000 }, { ...observation, feeRate: 5 }), 4000);
  assert.equal(refundReserve({ ...settings, refundFeeHeadroom: 1 }, observation), 2094);
  assert.equal(fundingAmount({ ...settings, refundsEnabled: false }, observation), inscriptionBudget(settings));
  assert.equal(fundingAmount({ ...settings, refundsEnabled: false, refundContentBytes: 1 }, observation), inscriptionBudget(settings));
});

test('redeem size bounds actual signed payloads including maximum overpayments and payer lengths', () => {
  const key = requestKey(seed, id, 'mainnet');
  try {
    for (const address of [payer, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa']) {
      const record = { id, refundId: id, reference: 'cd'.repeat(32) + 'i0', state: 'owed', tapAddress: address,
        fees: Array.from({ length: 100 }, (_, i) => ({ ticker: 'tap', amount: String(10n ** 78n - (i === 0 ? 2n : 1n)) })) };
      const signed = refundRedeem(record, 'ef'.repeat(32) + 'i9999999999', key.privateKey, 'mainnet', settings);
      assert.ok(Buffer.byteLength(signed.text) <= refundRedeemBytes(address));
      assert.ok(refundRedeemBytes(address) - Buffer.byteLength(signed.text) <= 3);
      assert.equal(signed.payload.redeem.items.length, 1);
      assert.equal(signed.payload.redeem.items[0].amt.length, 81);
      assert.ok(refundRedeemBytes(address) < settings.refundContentBytes);
    }
    assert.equal(refundRedeemBytes(payer) - refundRedeemBytes('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), payer.length - 34);
  } finally { key.privateKey.fill(0); }
});

test('fixed mode and stale, missing, future or invalid fee observations use the configured fallback', () => {
  const fixed = { ...settings, refundReserveMode: 'fixed', refundReserveSats: 4321 };
  assert.equal(refundReserve(fixed, observation), 4321);
  for (const change of [{ feeRate: undefined }, { feeRateAt: undefined }, { feeRateAt: observation.now + 1 },
    { feeRateAt: observation.now - settings.refundFeeRateMaxAgeMs - 1 }, { feeRate: 0 }, { feeRate: NaN }, { feeRate: Infinity },
    { feeRate: 1001 }, { feeRateAt: 1.5 }, { feeRateAt: -1 }, { payer: undefined }])
    assert.equal(refundReserve(settings, { ...observation, ...change }), settings.refundReserveSats);
  assert.equal(refundReserve(settings), settings.refundReserveSats);
  assert.equal(refundReserve(settings, { ...observation, feeRateAt: observation.now - settings.refundFeeRateMaxAgeMs }), 2595);
  assert.equal(refundReserve({ ...settings, refundContentBytes: 4000 }, observation), 2595);
  assert.throws(() => refundReserve({ ...settings, refundContentBytes: 500 }, observation), /mint_refund_content/);
});

test('funding quote binds its refund amount and can retain it after rate and reserve policy changes', () => {
  const quote = fundingQuote(seed, id, 'mainnet', settings, observation);
  assert.equal(quote.refundReserveSats, 2595);
  assert.equal(quote.satoshis, inscriptionBudget(settings) + 2595);
  const next = { ...settings, refundReserveSats: 9000, refundReserveMinSats: 6000, refundReserveMaxSats: 9000 };
  assert.equal(fundingQuote(seed, id, 'mainnet', next, { ...observation, feeRate: 10, refundReserveSats: quote.refundReserveSats }).satoshis, quote.satoshis);
  assert.notEqual(fundingQuote(seed, id, 'mainnet', next, { ...observation, feeRate: 10 }).satoshis, quote.satoshis);
});

test('refund reserve settings default to dynamic and validate modes, bounds, headroom and age', () => {
  assert.equal(settings.refundReserveMode, 'dynamic'); assert.equal(settings.refundFeeHeadroom, 1.5);
  assert.equal(settings.refundReserveMinSats, 1500); assert.equal(settings.refundReserveMaxSats, 6000);
  assert.equal(settings.refundFeeRateMaxAgeMs, 120000);
  for (const input of [{ refundReserveMode: 'auto' }, { refundReserveMode: null }, { refundFeeHeadroom: 0 }, { refundFeeHeadroom: 0.9 },
    { refundFeeHeadroom: 101 }, { refundFeeHeadroom: NaN }, { refundFeeHeadroom: '1.5' }, { refundReserveMinSats: 0 },
    { refundReserveMinSats: 1500.5 }, { refundReserveMaxSats: 6000.5 }, { refundReserveMinSats: 7000 },
    { refundReserveMaxSats: 100001 }, { refundFeeRateMaxAgeMs: 0 }, { refundFeeRateMaxAgeMs: 0.5 }, { refundFeeRateMaxAgeMs: 2147483648 }])
    assert.throws(() => mintSenderSettings(input), /mint_sender_/);
  assert.equal(mintSenderSettings({ refundReserveMode: 'fixed', refundReserveSats: 1500, refundFeeHeadroom: 2.25 }).refundReserveSats, 1500);
});
