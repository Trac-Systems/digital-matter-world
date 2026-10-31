import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChosenTicker, tickerConflicts, validateOfficialTicker, compoundTickerMessage } from '../src/ticker-names.js';
import { compoundMintPermit } from '../src/tap.js';

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

test('a compound\'s official ticker is a chosen ticker that signers can rebuild official mint permits for', () => {
  for (const tick of ['abc', 'Nullspar', 'x'.repeat(32), 'dmwce9f0843e', '123']) {
    const official = validateOfficialTicker(tick);
    assert.equal(official, tick.toLowerCase());
    // The signer's permit for an official deployment uses the original grammar.
    assert.equal(compoundMintPermit({ tick: official, quantity: '1', address: 'bc1p', salt: 'ab'.repeat(32) }).payload.tick, official);
  }
  for (const tick of ['', 'dmt-abc', '-abc', 'x'.repeat(33)]) assert.throws(() => validateOfficialTicker(tick), /^Error: ticker_invalid$/);
  for (const tick of ['ab', 'ñandu', 'my-token', 'two words', '👋🏿abc']) {
    assert.throws(() => validateOfficialTicker(tick), /^Error: ticker_official_grammar$/);
    assert.throws(() => compoundMintPermit({ tick: validateChosenTicker(tick), quantity: '1', address: 'bc1p', salt: 'ab'.repeat(32) }), /compound_ticker/);
  }
  const fields = { network: 'dmw-mainnet', asset: 'c2:' + 'e9'.repeat(32), ticker: 'nullspar', revision: 1, expiry: Date.UTC(2026, 9, 31), firstMaker: 'trac1abc' };
  assert.equal(compoundTickerMessage(fields), ['Digital Matter World: choose the official TAP ticker of a compound', 'version: dmw-compound-ticker-v1',
    'network: dmw-mainnet', 'compound: c2:' + 'e9'.repeat(32), 'ticker: nullspar', 'revision: 1', 'first maker: trac1abc', 'valid until: 2026-10-31T00:00:00.000Z'].join('\n'));
  for (const patch of [{ asset: 'p2:1' }, { revision: 0 }, { expiry: 1e16 }, { firstMaker: 'cd'.repeat(32) }, { ticker: 1 }])
    assert.throws(() => compoundTickerMessage({ ...fields, ...patch }), /ticker_choice_request/);
});
