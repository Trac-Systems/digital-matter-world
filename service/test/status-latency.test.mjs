import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PublicSnapshot, cachePublicReads } from '../src/public-cache.mjs';
import { PublicViews } from '../src/public-views.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { createRecordHighlights } from '../src/web-records.mjs';
import { createFeePolicy } from '../src/fees.mjs';
import { serve } from '../src/http.mjs';
import { History } from '../src/history.mjs';
import { heightKey } from '../src/util.mjs';
import { rules } from '../src/rules.mjs';
import { BitcoinSource, BitcoinViews } from '../prod/bitcoin.mjs';
import { HttpSource } from '../prod/http.mjs';
import { GENESIS } from '../../contract/beacon/bitcoin.js';
import { mockServer, json, genesis, genesisInfo } from '../prod/test/helpers.mjs';
import { temp, patterns } from './helpers.mjs';

function fixture(db) {
  db.exec('CREATE TABLE records(space TEXT,id TEXT,value TEXT,PRIMARY KEY(space,id)) WITHOUT ROWID');
  const get = db.prepare('SELECT value FROM records WHERE space=? AND id=?');
  const put = db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(space,id) DO UPDATE SET value=excluded.value');
  const list = db.prepare('SELECT id,value FROM records WHERE space=? AND id>? ORDER BY id LIMIT ?');
  return { db, get: (space, id) => { const r = get.get(space, String(id)); return r ? JSON.parse(r.value) : null; },
    put: (space, id, value) => put.run(space, String(id), JSON.stringify(value)),
    list: (space, { after = '', limit = 100 } = {}) => list.all(space, after, limit).map(r => ({ id: r.id, value: JSON.parse(r.value) })) };
}

// Frozen pre-fix catalog projection: compare names, integer totals, ordering,
// filters, nested inputs and cursor identities with the cached implementation.
async function legacyCatalog(views) {
  const registered = await views.reads.registry(), supply = await views.reads.assetSupply();
  const mints = views.rows('mints').filter(r => r.state === 'minted');
  const names = new Map(views.patterns().map(p => [rules.patternAsset(p), p.name]));
  const mapping = asset => { const entry = registered.assets[asset], job = views.store.get('provisioning', asset); return { displayLabel: entry?.displayLabel ?? names.get(asset) ?? asset, actualTicker: entry?.tick ?? null, deploymentId: entry?.id ?? null, generation: entry?.generation ?? null, jobState: job?.state ?? (entry ? 'registered' : 'queued') }; };
  const stats = asset => ({ ...mapping(asset), supply: supply[asset] ?? '0', minted: mints.filter(r => r.request.asset === asset).length,
    madeReal: mints.filter(r => r.request.asset === asset).reduce((n, r) => n + BigInt(r.request.amount ?? 0), 0n).toString() });
  return { patterns: views.patterns().map(p => ({ ...p, asset: rules.patternAsset(p), ...stats(rules.patternAsset(p)) })),
    compounds: views.rows('types').map(({ amount, ...c }) => ({ ...c, name: `${c.recipe === 'resonance' ? 'Resonance' : 'Fusion'}: ${c.inputs.map(([asset, amount]) => `${amount} ${names.get(asset) ?? ('Compound ' + asset.slice(0, 8))}`).join(' + ')}`,
      tier: c.tier ?? null, token: registered.assets[c.id]?.tick ?? null, ...stats(c.id) })) };
}

test('status and catalog HTTP reads stay bounded with one million stored headers', { timeout: 120000 }, async t => {
  const directory = await temp('status-scale-'), filename = join(directory, 'scale.sqlite'), count = 1000000;
  let sourceCalls = 0;
  const sourceURL = await mockServer(t, (req, res) => {
    sourceCalls++;
    if (req.url === '/r/blockheight') return json(res, count - 1);
    if (req.url === '/r/blockinfo/' + GENESIS.hash) return json(res, { ...genesisInfo, height: count - 1, previous_block: '0'.repeat(64) });
    assert.ok(['/r/blockhash', '/r/blockhash/' + (count - 1)].includes(req.url), req.url);
    json(res, GENESIS.hash);
  });
  const client = new BitcoinSource({ source: new HttpSource({ url: sourceURL, requestsPerSecond: 1, retries: 0 }) });
  const bitcoin = new BitcoinViews(client, filename), store = fixture(bitcoin.db);
  t.after(async () => { bitcoin.close(); await rm(directory, { recursive: true, force: true }); });
  // Synthetic, already-stored history measures database size, not consensus
  // validation. Only the tip is queried; the source supplies a real PoW header.
  const times = JSON.stringify(Array(11).fill(GENESIS.time));
  bitcoin.db.exec('BEGIN');
  for (let h = 0; h < count; h++) {
    const hash = h === count - 1 ? GENESIS.hash : h.toString(16).padStart(64, '0');
    bitcoin.put.run(hash, h, Math.max(0, h - 1).toString(16).padStart(64, '0'), genesis, GENESIS.time, times);
    store.put('headers', heightKey(h), { raw: genesis, hash });
  }
  store.put('meta', 'headerHeight', count - 1);
  store.put('meta', 'head', { tip: count - 1 });
  store.put('meta', 'patterns', Array.from({ length: 16 }, (_, number) => ({ ...patterns[0], number, name: 'Pattern ' + number })));
  store.put('meta', 'publicObservation', 7);
  store.put('meta', 'publicBatch', 3);
  store.put('meta', 'publicSequence', 12);
  store.put('meta', 'latest', { observation: 8, height: count - 6, tip: count - 1 });
  store.put('publishedObservations', heightKey(7), { height: count - 7, tip: count - 2 });
  store.put('batches', heightKey(3), { batch: { to: count - 7 } });
  bitcoin.db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  const history = new History(store), registry = { feePolicy: createFeePolicy('100'), assets: {} };
  history.get = history.raw = () => assert.fail('status must not walk header history');
  const reads = { counted: async () => count - 6, batchLast: async () => ({ n: 4, to: count - 6 }),
    registry: async () => registry, settings: async () => ({ pending_blocks: 432 }), assetSupply: async () => ({ p0: '123456789012345678901234567890' }),
    tip: async () => { const chain = await client.tip(); await bitcoin.view(chain.height, chain.hash); return { tip: chain.height }; } };
  const views = new PublicViews({ store, history, reads, network: 'fixture-main' }), api = createPublicAPI({ views });
  const http = await serve({ intake: { store }, files: { serve: async () => false }, publicAPI: api });
  t.after(() => http.close());
  const timed = async path => {
    // The deliberately synchronous legacy catalog oracle below can outlive
    // HTTP's idle timeout. Measure a fresh connection instead of racing a
    // pooled socket's close after that CPU-bound fixture work.
    const start = performance.now(), response = await fetch(http.url + path, { headers: { connection: 'close' } }), value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return { value, ms: performance.now() - start };
  };
  // The uncached oracle deliberately takes several seconds at one source
  // request per second. Measure it directly: HTTP now has a 2 s response budget.
  const uncached = async () => { const start = performance.now(); return { value: await api.read('/status'), ms: performance.now() - start }; };
  const before = [await uncached(), await uncached()];
  assert.equal(sourceCalls, 12, 'six source reads on every uncached status');
  assert.deepEqual(before[0].value, before[1].value);
  const cache = cachePublicReads(views, { records: async () => ({}) });
  assert.equal((await fetch(http.url + '/status')).status, 503, 'cold reads never start a source refresh');
  assert.equal(sourceCalls, 12);
  await cache.status.refresh();
  const after = [];
  for (let i = 0; i < 12; i++) {
    const result = await timed('/status'); after.push(result.ms);
    assert.deepEqual(result.value, before[0].value);
    assert.ok(result.ms < 500, `cached status ${result.ms} ms (generous CI bound)`);
  }
  assert.equal(sourceCalls, 18, 'cached GETs make no source calls');
  const bytes = (await stat(filename)).size;
  t.diagnostic(`1,000,000 headers in each SQLite table; ${(bytes / 1024 ** 2).toFixed(1)} MiB; uncached status ${before.map(r => r.ms.toFixed(1))} ms; cached status min/max ${Math.min(...after).toFixed(2)}/${Math.max(...after).toFixed(2)} ms; source calls 6 -> 0 per GET`);

  bitcoin.db.exec('BEGIN');
  for (let i = 0; i < 1000; i++) store.put('types', 'c' + i.toString().padStart(4, '0'), {
    recipe: i % 2 ? 'fusion' : 'resonance', tier: i % 5, inputs: [['p0', '2'], ['p1', '3'], ['p2', '1']], properties: { mass: String(i) } });
  for (let i = 0; i < 100000; i++) store.put('mints', heightKey(i), { state: i % 5 ? 'minted' : 'waiting_payment',
    request: { asset: i % 3 ? 'c' + (i % 1000).toString().padStart(4, '0') : 'p' + i % 16, amount: '9007199254740993' } });
  bitcoin.db.exec('COMMIT');
  const start = performance.now(), expected = await legacyCatalog(views), oldCatalogMs = performance.now() - start;
  const refreshAt = performance.now(), refreshing = cache.catalog.refresh();
  const duringRefresh = await timed('/status');
  assert.deepEqual(duringRefresh.value, before[0].value);
  assert.ok(duringRefresh.ms < 500, `status during catalog refresh: ${duringRefresh.ms} ms`);
  await refreshing; const refreshMs = performance.now() - refreshAt;
  assert.deepEqual(await views.catalog(), expected);
  const oracle = createPublicAPI({ views: { catalog: async () => expected } });
  reads.registry = reads.assetSupply = () => assert.fail('cached catalog must not make live reads');
  views.catalogRows = () => assert.fail('cached catalog must not scan history');
  const catalogTimes = [];
  for (const path of ['/patterns?limit=2', '/table?sort=madeReal&order=desc&limit=2', '/compounds?sort=madeReal&order=desc&limit=2',
    '/compounds?recipe=fusion&tier=1&limit=2', '/compounds?q=p0&limit=2', '/compounds?asset=c0010',
    '/list?' + new URLSearchParams({ source: '/compounds?limit=2', path: '/compounds/0/inputs', limit: '1' })]) {
    const result = await timed(path); catalogTimes.push(result.ms);
    assert.deepEqual(result.value, await oracle.read(path), path);
    assert.ok(result.ms < 500, `${path}: ${result.ms} ms`);
    if (result.value.next) {
      const url = new URL(path, 'http://local'); url.searchParams.set('cursor', result.value.next);
      const next = url.pathname + url.search;
      assert.deepEqual((await timed(next)).value, await oracle.read(next), 'cursor ' + path);
    }
  }
  t.diagnostic(`100,000 mints / 1,000 compounds: legacy catalog ${oldCatalogMs.toFixed(1)} ms; poll rebuild ${refreshMs.toFixed(1)} ms; cached HTTP catalog min/max ${Math.min(...catalogTimes).toFixed(2)}/${Math.max(...catalogTimes).toFixed(2)} ms; status during rebuild ${duringRefresh.ms.toFixed(2)} ms`);
});

test('public snapshots coalesce polls, serve during refresh, fail closed, and recover', async () => {
  let finish, fail = false, calls = 0;
  const snapshot = new PublicSnapshot(async () => { calls++; if (fail) throw Error('source_unavailable'); return new Promise(resolve => { finish = resolve; }); });
  assert.throws(() => snapshot.read(), { message: 'public_snapshot_pending', status: 503 });
  const first = snapshot.refresh(), duplicate = snapshot.refresh(); finish({ tip: 1 });
  assert.deepEqual(await first, await duplicate); assert.equal(calls, 1);
  const next = snapshot.refresh(); assert.deepEqual(snapshot.read(), { tip: 1 });
  finish({ tip: 2 }); await next; assert.deepEqual(snapshot.read(), { tip: 2 });
  fail = true; await assert.rejects(snapshot.refresh(), /source_unavailable/);
  assert.throws(() => snapshot.read(), /source_unavailable/);
  fail = false; const recovery = snapshot.refresh(); finish({ tip: 3 }); await recovery;
  assert.deepEqual(snapshot.read(), { tip: 3 });
});

test('cached status, records and indexed lists follow poll updates without request backfills', async t => {
  const db = new DatabaseSync(':memory:'), store = fixture(db); t.after(() => db.close());
  store.put('meta', 'patterns', patterns);
  store.put('meta', 'head', { tip: 9 });
  store.put('meta', 'publicSequence', 1);
  store.put('meta', 'headerHeight', 9);
  store.put('headers', heightKey(3), { raw: genesis, hash: GENESIS.hash });
  store.put('finds', 'find', { block: 3, asset: 'p0', count: 1, finder: null, findHeight: 3 });
  let tip = 9, now = GENESIS.time * 1000 + 1;
  const registry = { feePolicy: createFeePolicy('100'), assets: {} }, supply = {};
  const reads = { head: async () => ({ tip: { height: tip }, counted: tip - 5 }), batchLast: async () => ({ n: 1, to: tip - 5 }),
    tip: async () => ({ tip }), registry: async () => registry, assetSupply: async () => supply, settings: async () => ({ pending_blocks: tip }) };
  const history = { length: 10, hashAt: h => String(h), get: h => ({ height: h, time: h, nonce: 1, bits: 1 }) };
  const views = new PublicViews({ store, reads, history }), api = createPublicAPI({ views });
  const liveStatus = views.status.bind(views), checkout = { records: createRecordHighlights(store, () => now) }, liveRecords = checkout.records;
  const cache = cachePublicReads(views, checkout);
  await assert.rejects(api.read('/world'), /public_index_pending/);
  assert.equal(views.readIndex.ready, false);
  // Model normal ingestion with persisted fields; legacy patterns without
  // fields or feed coverage intentionally remain index_catching_up.
  for (let h = 0; h < history.length; h++) store.put('headers', heightKey(h), {
    raw: genesis, hash: history.hashAt(h), fields: history.get(h),
  });
  await cache.status.refresh(); assert.deepEqual(await views.status(), await liveStatus());
  await cache.records.refresh(); assert.deepEqual(await checkout.records(), await liveRecords());
  await cache.catalog.refresh(); assert.deepEqual(await views.catalog(), await legacyCatalog(views));
  await views.readIndex.sync();
  const routes = ['/world?limit=2', '/finds', '/agents', '/receipts', '/records/batches', '/patterns/p0/blocks?limit=2'];
  const expected = await Promise.all(routes.map(path => api.read(path)));
  const sync = views.readIndex.sync.bind(views.readIndex);
  views.readIndex.sync = () => assert.fail('HTTP must not refresh the world index');
  for (let i = 0; i < routes.length; i++) assert.deepEqual(await api.read(routes[i]), expected[i]);
  const head = reads.head;
  let releaseHead;
  reads.head = () => new Promise(resolve => { releaseHead = resolve; });
  const polling = sync();
  assert.deepEqual(await api.read(routes[0]), expected[0], 'serve the completed index while the poll reads its head');
  releaseHead(await head()); await polling; reads.head = head;
  tip = 10; now += 86400000;
  store.put('meta', 'publicSequence', 2);
  store.put('meta', 'latest', { observation: 2, tip: 10, height: 5 });
  store.put('types', 'c1', { properties: { mass: '10', generation: 1 }, recipe: 'fusion', inputs: [['p0', '2']] });
  store.put('mints', 'job', { state: 'minted', request: { asset: 'c1', amount: '9007199254740993' } });
  store.put('provisioning', 'c1', { state: 'registered' });
  registry.assets.c1 = { tick: 'compound', id: 'deployment', generation: 2 }; supply.c1 = '7';
  await cache.status.refresh(); await cache.records.refresh(); await cache.catalog.refresh(); await sync();
  assert.deepEqual(await views.status(), await liveStatus());
  assert.deepEqual(await checkout.records(), await liveRecords());
  assert.deepEqual(await views.catalog(), await legacyCatalog(views));
  db.prepare("DELETE FROM records WHERE space='mints' AND id='job'").run();
  supply.c1 = '0';
  await cache.catalog.refresh(); assert.deepEqual(await views.catalog(), await legacyCatalog(views));
  assert.equal((await checkout.records()).biggestCompound.mass, '10');
  assert.equal((await api.read('/world?limit=2')).counted, 5);
});
