import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChosenTicker, tickerConflicts } from '../src/ticker-names.js';

test('chosen tickers match ord-tap visible-length and JavaScript lowercase semantics', () => {
  for (const tick of ['A', 'AB', 'ABCD', 'x'.repeat(32), 'e\u0301'.repeat(32), '✈️'.repeat(32),
    '👨‍👩‍👧‍👦'.repeat(32), '🇩🇪'.repeat(32), '👋🏿', '🧑🏽‍💻', '👨‍👩‍👧‍👦/İ', 'ΟΣ', '𐐀', 'K', 'ẞ', 'ﬃ', 'ＡＢＣ', 'אבג', 'A/B', ' a ']) {
    assert.equal(validateChosenTicker(tick), tick.toLowerCase());
  }
  assert.notEqual(validateChosenTicker('é'), validateChosenTicker('e\u0301'), 'TAP does not normalize Unicode');
  for (const tick of [null, undefined, 1, {}, [], '', '-abc', 'DMT-abc', '\ud800', '\udfff', 'x'.repeat(33), '👨‍👩‍👧‍👦'.repeat(33)]) {
    assert.throws(() => validateChosenTicker(tick), /^Error: ticker_invalid$/);
  }
});

test('official name conflicts use only case-folded point lookups, including allocated fallbacks', async () => {
  const names = new Set(['florite', 'dmt-floriteamber', 'dmwc12345678']), calls = [];
  const officialName = async name => { calls.push(name); return names.has(name) ? { asset: 'p2:0' } : null; };
  for (const tick of ['FLORITE', 'FloriteAmber', 'DMWC12345678']) await assert.rejects(tickerConflicts(tick, { officialName }), /ticker_conflict/);
  calls.length = 0;
  assert.equal(await tickerConflicts('Spare', { officialName }), false);
  assert.deepEqual(calls, ['spare', 'dmt-spare']);
  await assert.rejects(tickerConflicts('spare', {}), /ticker_official_lookup_required/);
  await assert.rejects(tickerConflicts('spare', { officialName: async () => 0 }), /ticker_conflict/, 'asset zero is an occupied name');
  await assert.rejects(tickerConflicts('spare', { officialName: async () => undefined }), /ticker_conflict/, 'unknown is not explicit absence');
  await assert.rejects(tickerConflicts('spare', { officialName: async () => { throw Error('offline'); } }), /offline/);
});
