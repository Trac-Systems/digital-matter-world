import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { tickerAvailable, reserveTicker, releaseTicker } from '../src/ticker-availability.mjs';

test('availability uses exactly one encoded indexed ticker point read and fails closed', async () => {
  const calls = [], reads = { tap: async key => { calls.push(key); return null; } };
  assert.equal(await tickerAvailable(reads, 'DMT-A/B'), true);
  assert.deepEqual(calls, ['getDeployment/dmt-a%2Fb']);
  assert.equal(await tickerAvailable({ tap: async () => ({ tick: 'DMT-A/B', ins: 'deployment' }) }, 'dmt-a/b'), false);
  for (const result of [undefined, false, {}, { tick: 'other', ins: 'deployment' }, { tick: 'dmt-a/b' }])
    await assert.rejects(tickerAvailable({ tap: async () => result }, 'dmt-a/b'), /ticker_lookup_binding/);
  await assert.rejects(tickerAvailable({}, 'spare'), /tap_ticker_lookup_required/);
  await assert.rejects(tickerAvailable({ tap: async () => { throw Error('unavailable'); } }, 'spare'), /unavailable/);
});

test('pending ticker reservations serialize competing callers and survive restart without expiry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticker-reservations-'));
  let store = await Store.open(directory);
  try {
    const results = await Promise.allSettled([reserveTicker(store, 'DMT-Spare', 'first'), reserveTicker(store, 'dmt-spare', 'second')]);
    assert.equal(results[0].status, 'fulfilled'); assert.match(results[1].reason.message, /ticker_reserved/);
    assert.equal(await reserveTicker(store, 'dmt-SPARE', 'first'), true);
    assert.equal(await releaseTicker(store, 'dmt-spare', 'second'), false);
    assert.equal(await reserveTicker(store, 'spare', 'compound'), true, 'ordinary tokens use a separate TAP key');
    await store.close(); store = await Store.open(directory);
    await assert.rejects(reserveTicker(store, 'dmt-spare', 'second'), /ticker_reserved/);
    assert.equal(await releaseTicker(store, 'DMT-SPARE', 'first'), true);
    assert.equal(await releaseTicker(store, 'dmt-spare', 'first'), false);
    assert.equal(await reserveTicker(store, 'dmt-spare', 'second'), true);
  } finally { await store.close(); await rm(directory, { recursive: true }); }
});
