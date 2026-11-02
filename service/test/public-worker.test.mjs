import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeTracAddress } from '../src/public-identities.mjs';
import { PublicReadStore } from '../src/public-read-store.mjs';
import { publicWorkerFixture } from './public-worker-fixture.mjs';
import { lists, requests } from './site-v2-query-fixture.mjs';
import { hash } from '../src/util.mjs';

async function response(server, path, options) {
  const r = await fetch(server.url + path, options);
  return { status: r.status, headers: Object.fromEntries([...r.headers].filter(([k]) => k !== 'date')), bytes: Buffer.from(await r.arrayBuffer()) };
}
async function same(f, path, options = {}) {
  if (options.method !== 'HEAD' || !/^\/(receipt-renewals|bind-payout|financial\/action)/.test(path))
    assert.equal(f.pool.handles({ method: options.method ?? 'GET', url: path, headers: options.headers ?? {} }), true, path + ' is dispatched');
  const expected = await response(f.direct, path, options), actual = await response(f.threaded, path, options);
  assert.deepEqual(actual, expected, path + ' ' + JSON.stringify(options)); return actual;
}

test('worker routes preserve body, status and every deterministic HTTP header', async t => {
  const f = await publicWorkerFixture(); t.after(f.close);
  const owner = encodeTracAddress(f.owner), id = 'a'.repeat(64);
  const paths = new Set(lists.flatMap(requests));
  for (const path of ['/patterns/taken', '/patterns/p2:0/claimed-pages', '/patterns/p0/blocks', '/patterns/p0/claimed-blocks',
    '/window-eligibility', '/window-eligibility/1', ...['claims', 'winners', 'headers'].map(k => '/windows/1/' + k),
    `/accounts/${f.owner}/balances/p0`, '/payouts/beneficiaries', '/payouts/owed', '/payouts/paid',
    '/receipts', '/events', '/events/1', '/feed/1', '/events/999', '/records/batches/1', '/records/highlights', '/table',
    '/financial/action/' + id, '/financial/action/' + 'b'.repeat(64),
    ...['/mint/bulk/', '/web-api/mint/bulk/'].flatMap(prefix => ['terms', 'members', 'members?offset=1&limit=1', 'members?limit=0'].map(suffix => prefix + id + '/' + suffix)),
    '/mint-rights?owner=' + owner, ...['finds', 'assets', 'mintRights', 'bitmaps'].map(k => '/agents/' + owner + '/' + k),
    ...['finds', 'slotList'].map(k => '/blocks/5/' + k), ...['credits', 'custody', 'linkRequests', 'supply'].map(k => '/results/' + k),
    '/results?kind=links', '/links', '/results/treasury', '/results/burn', '/results/', '/patterns?limit=0', '/agents/invalid', '/patterns?q=hello&unknown=1',
    '/payout-bindings/' + owner + '/tap', '/payout-bindings/' + owner + '/tap/history', '/payout-bindings/' + owner + '/ethereum', '/payout-bindings/' + owner + '/ethereum/history', '/payout-bindings/requests/' + f.record.id,
    '/wallets/' + f.record.request.address, '/bind-payout/' + id, '/bind-payout.js', '/operator', '/operator.js',
    '/receipt-renewals/' + hash('renewal') + '/1', '/receipt-renewals/' + id + '/1',
    '/headers/manifest.json', '/headers/manifest-v2.json', '/headers/height/2.json', '/headers/height/999.json',
    f.chunk.path, f.tree.path, f.archive.path, f.artifact.path, ...f.artifacts.map(a => a.path), '/latest.json', '/blocks/missing.bin',
    '/list?' + new URLSearchParams({ source: f.artifact.path, path: '/rows', limit: '1' }),
    '/list?' + new URLSearchParams({ source: '/results', path: '/absent' })]) paths.add(path);
  for (const path of paths) {
    const get = await same(f, path);
    await same(f, path, { method: 'HEAD' });
    if (get.headers.etag) await same(f, path, { headers: { 'if-none-match': get.headers.etag } });
  }
  for (const path of ['/', '/about', '/explore', '/feed', '/blocks', '/patterns', '/table', '/compounds', '/agents', '/agents/' + owner,
    '/records', '/records/batches/1', '/results', '/results/mints', '/block/5', '/plot/5', '/pattern/p2:0', '/compound/c1', '/events/1',
    '/mint', '/mint/' + id, '/mint/bulk/' + id, '/link', '/link/' + id, '/bind-payout', '/bind-payout/' + id]) {
    await same(f, path, { headers: { accept: 'text/html' } });
    await same(f, path, { method: 'HEAD', headers: { accept: 'text/html' } });
  }
  const assets = ['app', 'data', 'records', 'wallets', 'connect', 'money', 'ticker-deploy', 'bulk-mint', 'bulk-wallet', 'amount-format', 'trac-address'].map(n => '/web/' + n + '.js');
  for (const name of ['dom', 'paged', 'spiral', 'words', 'money', 'amount-format', 'wallet-errors', 'requester-storage', 'tickers', 'inscribe/wallet', 'inscribe/public', 'views/world', 'views/about', 'views/table', 'views/agents', 'views/feed', 'views/results', 'api', 'flows']) assets.push('/web/console/js/' + name + '.js');
  assets.push('/web/console/console.css', '/rules/src/trac-address.js', '/rules/src/ticker-grammar.js', '/playground/console/js/requester-storage.js',
    ...['tap-wallet-actions', 'wallet-funds', 'tap-wallet-bulk-mint'].map(n => '/kit/lib/' + n + '.mjs'),
    ...['fraunces-latin-wght-normal', 'atkinson-hyperlegible-next-latin-wght-normal', 'ibm-plex-mono-latin-400-normal', 'ibm-plex-mono-latin-500-normal'].map(n => '/web/console/fonts/' + n + '.woff2'));
  for (const path of assets) { await same(f, path); await same(f, path, { method: 'HEAD' }); }
  for (const path of [f.chunk.path, f.archive.path]) for (const range of ['bytes=80-159', 'bytes=137-', 'bytes=-10', 'bytes=999999999-', 'bytes=2-1', 'bytes=0-1,3-4']) {
    await same(f, path, { headers: { range } });
    await same(f, path, { headers: { range, 'if-range': 'mismatch' } });
  }
  t.diagnostic(`${paths.size} JSON/artifact paths plus HTML routes/assets, HEAD, ETag and range variants`);
});

test('read-only WAL workers see committed revisions and preserve cursors', async t => {
  const f = await publicWorkerFixture(); t.after(f.close);
  const readonly = new PublicReadStore(f.root, { sqliteCacheKiB: 128 }); t.after(() => readonly.close());
  assert.throws(() => readonly.db.exec("DELETE FROM records"), /readonly/);
  const before = await same(f, '/finds?limit=1');
  const next = JSON.parse(before.bytes).next;
  if (next) await same(f, '/finds?' + new URLSearchParams({ limit: '1', cursor: next }));
  await f.store.put('jobs', 'unrelated', true);
  assert.equal((await same(f, '/finds?limit=1')).headers.etag, before.headers.etag);
  await f.store.put('finds', 'f2:20:0', { block: '20', asset: 'p2:0', pattern: '0', count: '3', finder: f.owner, findHeight: '20', finderUntil: '200' });
  assert.notEqual((await same(f, '/finds?limit=1')).headers.etag, before.headers.etag);
  if (next) assert.equal((await same(f, '/finds?' + new URLSearchParams({ limit: '1', cursor: next }))).status, 409);
});

test('live routes and nested live list sources stay on the main thread', async t => {
  const f = await publicWorkerFixture(); t.after(f.close);
  for (const path of ['/status', '/status/', '/health', '/mint/' + 'a'.repeat(64), '/public-mints', '/mint/bulk/' + 'a'.repeat(64),
    '/web-api/target', '/web-api/mint/' + 'a'.repeat(64), '/operator/status', '/internal/mint-sender/requests',
    '/account-proof/' + 'a'.repeat(64) + '/tap', '/named-record/commit/a/b']) assert.equal(f.pool.handles({ method: 'GET', url: path, headers: {} }), false, path);
  for (const source of ['/status/', '/mint/' + 'a'.repeat(64), '/list?' + new URLSearchParams({ source: '/status', path: '/x' })])
    assert.equal(f.pool.handles({ method: 'GET', url: '/list?' + new URLSearchParams({ source, path: '/x' }), headers: {} }), false);
  assert.equal(f.pool.handles({ method: 'POST', url: '/patterns', headers: {} }), false);
  for (const path of ['/status', '/results?kind=unknown', '/results?kind=mints&kind=links', '/list?source=http%3A%00&path=%2Fx'])
    assert.deepEqual(await response(f.threaded, path), await response(f.direct, path), path);
  f.pool.routing.liveRights = true;
  assert.equal(f.pool.handles({ method: 'GET', url: '/mint-rights', headers: {} }), false);
});

class SlowResponse extends Writable {
  constructor() { super({ highWaterMark: 1 }); this.headers = {}; this.headersSent = false; }
  setHeader(k, v) { this.headers[k] = v; }
  _write(bytes, encoding, done) { this.headersSent = true; this.release = done; this.emit('blocked'); }
}
const request = url => ({ method: 'GET', url, headers: {} });
test('queue admission is bounded; worker crash fails only active work and restarts', async t => {
  const f = await publicWorkerFixture({ settings: { threads: 1, queuePerWorker: 1 } }); t.after(f.close);
  const slot = f.pool.slots[0], worker = slot.worker, blocked = new SlowResponse();
  const started = once(blocked, 'blocked');
  const active = f.pool.serve(request(f.chunk.path), blocked);
  const rejected = assert.rejects(active, e => e.status === 503 && e.message === 'service_busy');
  await started;
  const queued = response(f.threaded, '/finds');
  while (slot.queue.length === 0) await delay(1);
  const full = await response(f.threaded, '/patterns');
  assert.equal(full.status, 503); assert.deepEqual(JSON.parse(full.bytes), { error: 'service_busy', retryable: true });
  assert.equal(full.headers['retry-after'], '1');
  await worker.terminate(); await rejected;
  const survived = await queued; assert.equal(survived.status, 200);
  assert.notEqual(slot.worker, worker);
  await same(f, '/patterns');
});

test('a failed worker returns the existing HTTP 503 and leaves other workers usable', async t => {
  const f = await publicWorkerFixture(); t.after(f.close);
  const serve = f.pool.serve.bind(f.pool);
  let crashed = false;
  f.pool.serve = (req, res) => {
    const result = serve(req, res);
    if (!crashed) {
      crashed = true;
      const slot = f.pool.slots.find(s => s.active?.req === req);
      // Deliver the real Worker error event before its response is dispatched.
      // The other test terminates a real worker during an active stream.
      slot.worker.emit('error', Error('fixture_worker_failure'));
    }
    return result;
  };
  const failed = await response(f.threaded, '/finds');
  assert.equal(failed.status, 503);
  assert.deepEqual(JSON.parse(failed.bytes), { error: 'service_busy', retryable: true });
  assert.equal(failed.headers['retry-after'], '1');
  await same(f, '/patterns');
});

test('deadlines remove queued requests; cancelled streams release their worker', async t => {
  const f = await publicWorkerFixture({ settings: { threads: 1 } }); t.after(f.close);
  const { serve } = await import('../src/http.mjs');
  const timed = await serve({ ...f.options, readPool: f.pool, responseTimeoutMs: 25 }); t.after(() => timed.close());
  const slot = f.pool.slots[0]; slot.ready = false;
  const expired = await response(timed, '/finds');
  assert.equal(expired.status, 503); assert.equal(JSON.parse(expired.bytes).error, 'read_not_ready');
  await delay(5); assert.equal(slot.queue.length, 0);
  slot.ready = true;
  const worker = slot.worker, blocked = new SlowResponse(), started = once(blocked, 'blocked');
  const active = f.pool.serve(request(f.chunk.path), blocked); await started;
  const queued = response(f.threaded, '/patterns');
  blocked.destroy(); await active;
  assert.equal((await queued).status, 200); assert.notEqual(slot.worker, worker);
  assert.equal(slot.queue.length, 0);
});

test('legacy list cursors survive load balancing and a worker replacement', async t => {
  const f = await publicWorkerFixture(); t.after(f.close);
  const path = '/list?' + new URLSearchParams({ source: f.artifact.path, path: '/rows', limit: '1' });
  const first = await same(f, path), next = JSON.parse(first.bytes).next;
  assert.ok(next);
  await f.pool.slots[0].worker.terminate();
  const continuation = path + '&cursor=' + encodeURIComponent(next);
  assert.deepEqual(JSON.parse((await same(f, continuation)).bytes).items, [2]);
  await delay(f.pool.settings.restartDelayMs + 200);
  await same(f, continuation);
});

test('pool settings reject invalid budgets and shutdown joins initializing workers', async t => {
  const { publicReadSettings } = await import('../src/public-read-settings.mjs');
  const { PublicReadPool } = await import('../src/public-read-pool.mjs');
  for (const settings of [{ threads: 0 }, { queuePerWorker: -1 }, { sqliteCacheKiB: 1.5 }, { restartDelayMs: 2 ** 32 }, { unexpected: 1 }])
    assert.throws(() => publicReadSettings(settings), /public_read_settings/);
  assert.equal(publicReadSettings({ identityCacheEntries: 0 }).identityCacheEntries, 0);
  const f = await publicWorkerFixture(); t.after(f.close);
  const initializing = new PublicReadPool({ ...f.poolOptions, settings: { threads: 1 } });
  const rejected = assert.rejects(initializing.ready, /service_busy/);
  await initializing.close(); await rejected;
  assert.ok(initializing.slots.every(s => !s.worker && !s.active && !s.queue.length));
});

test('gateway startup installs the configured pool and shutdown joins it', { timeout: 10000 }, async t => {
  const { restartFixture } = await import('./restart-fixture.mjs');
  const { start } = await import('../run.mjs');
  const fixture = await restartFixture({ adapterMs: 0, notaryMs: 0, committeeMs: 0, publicMs: 30000, pollMs: 30000 });
  fixture.config.listen.publicReads = { threads: 1, queuePerWorker: 3 };
  let gateway;
  t.after(async () => { await gateway?.close(); await fixture.close(); });
  gateway = await start(fixture.config);
  assert.equal(gateway.readPool.slots.length, 1);
  let dispatched = 0;
  const send = gateway.readPool.serve.bind(gateway.readPool);
  gateway.readPool.serve = (...args) => { dispatched++; return send(...args); };
  assert.equal((await response(gateway, '/patterns')).status, 200);
  assert.equal((await response(gateway, '/health')).status, 200);
  assert.equal(dispatched, 1);
  const worker = gateway.readPool.slots[0].worker;
  await gateway.close(); assert.equal(worker.threadId, -1);
});

test('workers wait out a short projection window and answer after the bound when it stays', async t => {
  const f = await publicWorkerFixture({ settings: { pendingWaitMs: 1500, pendingPollMs: 20 } }); t.after(f.close);
  const insert = () => f.store.db.prepare('INSERT OR IGNORE INTO projectionPending VALUES(?,?)').run('fixture/', 'event');
  const clear = () => f.store.db.prepare('DELETE FROM projectionPending WHERE event=?').run('event');
  insert(); setTimeout(clear, 300);
  let started = Date.now(), response = await fetch(f.threaded.url + '/finds?limit=1', { headers: { accept: 'application/json' } });
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.ok(Date.now() - started >= 250, 'the read waited for the window to close');
  insert();
  started = Date.now(); response = await fetch(f.threaded.url + '/finds?limit=1', { headers: { accept: 'application/json' } }); await response.arrayBuffer();
  const waited = Date.now() - started; clear();
  assert.ok(waited >= 1400 && waited < 5000, `a stuck projection is answered after the bound (${waited} ms)`);
});
