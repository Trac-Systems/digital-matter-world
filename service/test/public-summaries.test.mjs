import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { PublicSummaries } from '../src/public-summaries.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { temp } from './helpers.mjs';

test('treasury and external supply refresh bounded verified pages with durable cursors and no per-view reads', async t => {
  const path = await temp('g4e-summaries-'); let store = await Store.open(path); t.after(() => store.close());
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '10' });
  let revision = 1, now = 1000, calls = 0, fail = false, multiplier = 1n;
  const registry = () => ({ revision, settings: { pageRows: 2 }, page(space, { after, limit }) {
    assert.equal(limit, 2);
    return (space.endsWith('/tap') ? revision === 1 ? ['a', 'b', 'c'] : ['b'] : ['e']).filter(id => id > after).slice(0, limit).map(id => ({ id }));
  } });
  const reads = { registry: async () => registry(), publicTreasuryAccount: async (rail, address) => {
    calls++; if (fail) throw Error('source_unavailable');
    return { rail, address, balance: String(900719925474099312345n * multiplier), anchor: { height: '10', hash: 'a'.repeat(64) } };
  }, publicExternalSupply: async () => { calls++; return { ethereum: '900719925474099312346', anchor: { height: '11', hash: 'b'.repeat(64) } }; } };
  const producer = () => new PublicSummaries({ store, reads, rows: 2, refreshMs: 100, now: () => now });
  let p = producer(); await p.tick(); assert.equal(calls, 2); assert.equal(store.get('publicSummaries', 'treasury'), null);
  assert.equal(store.get('meta', 'publicSummaryCursor').after, 'b');
  await store.close(); store = await Store.open(path); p = producer();
  await p.tick(); await p.tick(); assert.equal(calls, 5);
  const published = store.get('publicSummaries', 'treasury'); assert.equal(published.tap, String(3n * 900719925474099312345n));
  await p.tick(); assert.equal(calls, 5, 'refresh interval is an operator setting');
  const api = createPublicAPI({ views: { store, results() { throw Error('legacy_history_scan'); } } });
  const cached = await api.response('/results');
  for (let n = 0; n < 20; n++) assert.equal(await api.response('/results'), cached);
  assert.equal(calls, 5);
  now += 101; fail = true; await assert.rejects(p.tick(), /source_unavailable/);
  assert.deepEqual(store.get('publicSummaries', 'treasury'), published, 'failed verification preserves the labelled prior snapshot');
  fail = false; multiplier = 2n; revision = 2;
  await p.tick(); await p.tick();
  assert.equal(store.get('publicSummaries', 'treasury').tap, String(2n * 900719925474099312345n), 'removed addresses do not remain in new registry totals');
  assert.notEqual(await api.response('/results'), cached);
  const result = await api.read('/results'); assert.equal(result.outstandingSupply.ethereum, '900719925474099312346');
});

test('summary production rejects a registry replacement during a source page', async t => {
  const store = await Store.open(await temp('g4e-summary-race-')); t.after(() => store.close());
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '1' }); let revision = 1;
  const reads = { registry: async () => ({ revision, settings: { pageRows: 1 }, page: () => [{ id: 'treasury' }] }),
    publicTreasuryAccount: async () => { revision++; return { rail: 'tap', address: 'treasury', balance: '1', anchor: {} }; }, publicExternalSupply: async () => ({}) };
  await assert.rejects(new PublicSummaries({ store, reads, rows: 1 }).tick(), /public_registry_changed/);
  assert.equal(store.get('meta', 'publicSummaryCursor'), null); assert.equal(store.count('publicTreasuryFacts'), 0);
});
