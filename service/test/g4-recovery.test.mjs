import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Feeds } from '../src/feeds.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { PublicSnapshot } from '../src/public-cache.mjs';
import { StoredSettingsHistory } from '../src/settings-history.mjs';
import { rules as r } from '../src/rules.mjs';
import { temp, agent, secret } from './helpers.mjs';
import { FeeQuotes, createFeePolicy, LAUNCH_FEE_SETTINGS } from '../src/fees.mjs';
import { runtimeResources } from '../src/r3-settings.mjs';
import { Payouts } from '../src/payouts.mjs';
import { PublicViews } from '../src/public-views.mjs';

test('decimal journal checkpoints cross 2^53 and 2^63 without rounding on restart', async () => {
  const path = await temp(); let store = await Store.open(path);
  try {
    await store.put('meta', 'ruleState', { batchVersion: 2 });
    for (const n of ['9007199254740991', '9223372036854775807', '9'.repeat(80)]) {
      await store.compact();
      store.db.prepare('UPDATE journal_progress SET sequence=? WHERE id=1').run(n); store.sequence = n;
      await store.put('fixture', n, true);
      assert.equal(store.sequence, r.nextUint(n));
      await store.close(); store = await Store.open(path);
      assert.equal(store.sequence, r.nextUint(n)); assert.equal(store.get('fixture', n), true);
      await store.put('fixture', n, false); assert.equal(store.sequence, r.addUint(n, '2'));
    }
  } finally { await store.close(); }
});

test('v2 projections resume bounded phases and preserve decimal heights, counts and catalog attribution', async () => {
  const path = await temp(), files = new Files(join(path, 'static')), owner = agent(3).address, replacement = agent(4).address;
  let store = await Store.open(path);
  const number = '9007199254740993', asset = r.patternAssetV2(number), block = '9223372036854775808';
  const record = { number, key: r.hash('pattern'), discoverer: owner, knownMatchCount: '3', catalogRevision: '1' };
  const event = { height: block, tip: block, occurrences: Array.from({ length: 3 }, (_, i) => ({ block: r.addUint(block, String(i)), pattern: number, asset, hash: r.hash(String(i)), count: '1', agent: owner })),
    discoveries: [{ record }], finds: {}, types: {} };
  const options = { files, history: { get() { throw Error('history_scan'); } }, reads: {}, settings: { feedEventRows: 1 } };
  try {
    await store.transact([{ space: 'meta', id: 'ruleState', value: { batchVersion: 2, counted: block } }, { space: 'feedEvents', id: '1', value: event }]);
    await store.put('feedEvents', '2', { height: block, tip: block, discoveries: [{ record: { ...record, discoverer: replacement, catalogRevision: '2' } }] });
    await new Feeds({ ...options, store }).events();
    await store.close(); store = await Store.open(path);
    const feeds = new Feeds({ ...options, store }), api = createPublicAPI({ views: { store }, files });
    await assert.rejects(api.read('/patterns'), /public_projection_pending/);
    while (store.count('feedEvents')) await feeds.events();
    assert.equal(store.get('catalogPatterns', asset).discoverer, replacement, 'the later correction cannot overtake an unfinished earlier event');
    const first = await api.read('/patterns/' + asset + '/claimed-blocks?limit=2');
    assert.deepEqual(first.rows.map(r => r.height), [block, r.nextUint(block)]);
    assert.equal(first.knownMatchCount, '3');
    assert.equal((await api.read('/patterns/' + asset + '/claimed-blocks?' + new URLSearchParams({ cursor: first.nextCursor }))).rows[0].height, r.addUint(block, '2'));
    await feeds.tick(); assert.equal(store.count('feedPages'), 0);
    const manifest = store.list('claimedPageManifests/' + asset)[0].value;
    const page = JSON.parse(await readFile(files.path(manifest.path.slice(1)))); assert.equal(page.asset, asset); assert.equal(page.from, block);
    // Occurrence additions must not count as fresh discoveries; correcting
    // attribution moves the one credited discovery to its rightful owner.
    for (const [id, discoverer] of [['3', replacement], ['4', owner], ['5', replacement]]) {
      await store.put('feedEvents', id, { height: block, tip: block, discoveries: [{ record: { ...record, discoverer, catalogRevision: id } }] });
      while (store.count('feedEvents')) await feeds.events();
    }
    assert.equal(store.get('catalogAgents', owner).discoveryCount, '0'); assert.equal(store.get('catalogAgents', replacement).discoveryCount, '1');
    assert.equal(store.count('discoveriesByAgent/' + owner), 0);
    const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT value FROM claimedBlocksV2 INDEXED BY claimedBlocksV2Found WHERE asset=? AND found=? AND heightKey>? ORDER BY heightKey LIMIT ?').all(asset, 0, '', 2);
    assert.match(JSON.stringify(plan), /SEARCH.*claimedBlocksV2Found/);
  } finally { await store.close(); }
});

test('accepted mint and link publication resumes named markBlock updates after restart', async () => {
  const path = await temp(), files = new Files(join(path, 'static')), asset = 'p2:9007199254740993', block = '9223372036854775808';
  let store = await Store.open(path);
  const key = r.uintKeyV2(block), row = { height: block, pattern: asset.slice(3), hash: r.hash('header'), count: '1', found: true, minted: false };
  const options = { files, history: { get() { throw Error('history_scan'); } }, reads: {}, settings: { feedEventRows: 1 } };
  try {
    await store.transact([
      { space: 'meta', id: 'ruleState', value: { batchVersion: 2 } },
      { space: 'claimed2/' + asset, id: key, value: row }, { space: 'claimedAt2/' + key, id: asset, value: true },
      { space: 'minted', id: asset + '/' + block, value: { id: r.hash('accepted-mint'), inscription: r.hash('inscription') + 'i0' } },
      { space: 'feedBlockChanges', id: 'mint/' + asset + '/' + block, value: { block, asset } },
      { space: 'feedBlockChanges', id: 'link/' + block, value: { block } }
    ]);
    await store.close(); store = await Store.open(path);
    const feeds = new Feeds({ ...options, store }), api = createPublicAPI({ views: { store }, files });
    await assert.rejects(api.read('/patterns/' + asset + '/claimed-blocks?minted=true'), /public_projection_pending/);
    const markBlock = feeds.markBlock.bind(feeds), touched = [];
    feeds.markBlock = async (...args) => { touched.push(args); return markBlock(...args); };
    await feeds.events(); assert.equal(store.count('feedBlockChanges'), 1);
    await feeds.events(); assert.equal(store.count('feedBlockChanges'), 0);
    assert.deepEqual(touched, [[block, null], [block, asset]]);
    const page = await api.read('/patterns/' + asset + '/claimed-blocks?minted=true');
    assert.equal(page.rows.length, 1); assert.equal(page.rows[0].height, block);
    await feeds.tick(); assert.equal(store.count('feedPages'), 0);
    const manifest = store.list('claimedPageManifests/' + asset)[0].value;
    assert.equal(JSON.parse(await readFile(files.path(manifest.path.slice(1)))).minted.slice(0, 2), '01');
  } finally { await store.close(); }
});

test('cold settings are point reads and cached public values cannot cross a revision', async () => {
  const path = await temp(); let store = await Store.open(path);
  try {
    const first = r.settingsRevision({ network: 'fixture', effectiveBatch: '1', effectiveBitcoinWindow: '1', values: { ...r.SETTINGS_PROFILE } });
    const second = r.settingsRevision({ network: 'fixture', previous: first, effectiveBatch: '2', effectiveBitcoinWindow: '2', values: { ...first.values, finderWindow: 2000 } });
    await new StoredSettingsHistory(store).refresh({ settings: first, settingsHash: r.hashObject(first), scheduledSettings: second });
    await store.close(); store = await Store.open(path);
    const history = new StoredSettingsHistory(store);
    await history.refresh({ settings: second, settingsHash: r.hashObject(second) });
    assert.deepEqual(history.get(r.hashObject(first)), first); assert.equal(history.at('3', '3').revision, '1');
    let revision = 'one'; const snapshot = new PublicSnapshot(async () => ({ revision }), () => revision);
    await snapshot.refresh(); assert.equal(snapshot.read().revision, 'one'); revision = 'two'; assert.throws(() => snapshot.read(), /snapshot_stale/);
    await snapshot.refresh(); assert.equal(snapshot.read().revision, 'two');
  } finally { await store.close(); }
});

test('revisioned quote lifetimes preserve accepted terms and require the actual fee-policy hash', async () => {
  const registry = { feePolicy: createFeePolicy('100', 0, LAUNCH_FEE_SETTINGS) };
  const first = r.settingsRevision({ network: 'fixture', effectiveBatch: '1', effectiveBitcoinWindow: '1', values: {
    ...r.SETTINGS_PROFILE, feePolicyRevision: registry.feePolicy.current, quoteLifetimeTips: 500, quoteLifetimeMs: 10000 } });
  const second = r.settingsRevision({ network: 'fixture', previous: first, effectiveBatch: '2', effectiveBitcoinWindow: '2', values: {
    ...first.values, quoteLifetimeTips: 10, quoteLifetimeMs: 1000 } });
  const docs = new Map([first, second].map(d => [r.hashObject(d), d])); let current = first, now = 100;
  const issuer = new FeeQuotes({ network: 'fixture', secret, registry: async () => registry, now: () => now,
    settings: () => current, settingsHistory: docs });
  const quote = await issuer.issue('fixture', 10), accepted = await issuer.accept(quote, 'fixture', 'request', 100, 10);
  assert.equal(quote.validUntil, '510'); assert.equal(quote.expiresAt, 10100);
  current = second; now = 20000;
  assert.equal((await issuer.accepted(accepted, 'fixture', 'request', 100)).baseFee, '100');
  assert.equal((await issuer.accepted(accepted, 'fixture', 'request', 100)).settingsHash, r.hashObject(first));
  assert.equal((await issuer.issue('new', 20)).validUntil, '30');
  const height = '9223372036854775808', large = await issuer.issue('large', height), until = r.addUint(height, '3');
  assert.equal(large.validUntil, r.addUint(height, '10'));
  const acceptance = await issuer.accept(large, 'large', 'large-request', until, height);
  assert.equal((await issuer.accepted(acceptance, 'large', 'large-request', until)).baseFee, '100');
  current = r.settingsRevision({ network: 'fixture', effectiveBatch: '1', effectiveBitcoinWindow: '1', values: { ...r.SETTINGS_PROFILE } });
  await assert.rejects(issuer.issue('bad', 20), /fee_settings_pin/);
});

test('operator resource documents reach storage, feed, outbox and HTTP limits', async () => {
  const document = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE, feedEventRows: 7, outboxCapacity: 9, httpInFlight: 11 } });
  const mapped = runtimeResources(document);
  assert.equal(mapped.feeds.feedEventRows, 7); assert.equal(mapped.outbox.maxJobs, 9); assert.equal(mapped.http.maxInFlight, 11);
  const store = await Store.open(await temp(), mapped.store);
  try { assert.equal(store.journalFrameBytes, document.values.journalFrameBytes); await store.put('test', 'resource', true); }
  finally { await store.close(); }
});

test('v2 payout publication is constant work and public cursors and serialized caches fence writes', async () => {
  const path = await temp(), store = await Store.open(path), files = new Files(join(path, 'static'));
  try {
    await store.transact([{ space: 'meta', id: 'ruleState', value: { batchVersion: 2 } },
      ...['alice', 'bob'].map(id => ({ space: 'payoutTotals', id, value: { beneficiary: id, accrued: '10', paid: '0' } }))]);
    const list = store.list.bind(store); let reads = 0, statusReads = 0;
    store.list = () => { throw Error('lifetime_scan'); };
    await new Payouts({ store, files }).publish();
    const manifest = JSON.parse(await readFile(files.path('records/payouts/index.json')));
    assert.equal(manifest.beneficiaries.count, '2'); assert.equal(manifest.beneficiaries.page, '/payouts/beneficiaries');
    store.list = (...args) => { reads++; return list(...args); };
    const api = createPublicAPI({ views: { store, status: () => ({ calls: ++statusReads }) }, files });
    const first = await api.response('/payouts/beneficiaries?limit=1'), page = JSON.parse(first.bytes);
    const again = await api.response('/payouts/beneficiaries?limit=1'); assert.equal(first, again); assert.equal(reads, 1);
    assert.equal(page.beneficiaries[0].owed, '10');
    await store.put('payoutTotals', 'alice', { beneficiary: 'alice', accrued: '10', paid: '1' });
    const changed = await api.response('/payouts/beneficiaries?limit=1'); assert.notEqual(changed.etag, first.etag);
    assert.equal(JSON.parse(changed.bytes).beneficiaries[0].owed, '9');
    await assert.rejects(api.read('/payouts/beneficiaries?' + new URLSearchParams({ cursor: page.nextCursor })), /page_cursor_stale/);
    await api.response('/status'); await api.response('/status'); assert.equal(statusReads, 2);
  } finally { await store.close(); }
});

test('v2 status uses named policy reads and retains decimal batch, observation and Bitcoin clocks', async () => {
  const store = await Store.open(await temp()), high = '9223372036854775808';
  const document = r.settingsRevision({ network: 'fixture', effectiveBatch: '1', effectiveBitcoinWindow: '1', values: { ...r.SETTINGS_PROFILE } });
  try {
    await store.transact([{ space: 'meta', id: 'ruleState', value: { batchVersion: 2 } },
      { space: 'meta', id: 'v2Last', value: { n: high, to: high } },
      { space: 'meta', id: 'latest', value: { observation: high } }]);
    const views = new PublicViews({ store, network: 'fixture', reads: {
      rulesContext: async () => ({ ready: true, settings: document, settingsHash: r.hashObject(document), last: { n: high, to: high } }),
      head: async () => ({ tip: { height: high }, counted: high }), tip: async () => ({ tip: high }),
      registry() { throw Error('registry_scan'); }
    } });
    assert.equal(views.readIndex, null);
    const value = await views.status();
    assert.equal(value.batch.n, high); assert.equal(value.counted, high); assert.equal(value.publicIndex.latestObservation, high);
    assert.equal(value.publicIndex.caughtUp, true);
    await store.put('feedEvents', 'pending', {});
    assert.equal((await views.status()).publicIndex.caughtUp, false);
  } finally { await store.close(); }
});
