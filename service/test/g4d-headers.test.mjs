import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { HeaderChunks } from '../src/header-chunks.mjs';
import { HeaderCache } from '../../kit/lib/header-cache.mjs';
import { headerManifestSigner, manifestTrust, verifyHeaderManifest } from '../../kit/lib/header-manifest.mjs';
import { headerSource, downloadHeaders, historyProof } from '../../kit/lib/headers.mjs';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { History } from '../src/history.mjs';
import { LocalHeaders, localHeaderHandler } from '../src/local-headers.mjs';
import { BitcoinViews } from '../prod/bitcoin.mjs';
import { temp, secret, gateway } from './helpers.mjs';

const bytes = Buffer.from((await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
async function fixture(t) {
  const root = await temp('g4d-'), store = await Store.open(join(root, 'store')), history = new History(store);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  await history.appendMany(0, Array.from({ length: 64 }, (_, n) => bytes.subarray(n * 80, (n + 1) * 80).toString('hex')));
  const files = new Files(join(root, 'static')), headers = new HeaderChunks({ store, files, history, network: 'mainnet', secret, settings: { chunkRows: 8, chunksPerTick: 8 } });
  await headers.tick();
  const local = new LocalHeaders(join(root, 'store/index.sqlite')), handler = localHeaderHandler(local); t.after(() => local.close());
  let calls = 0;
  const server = createServer((req, res) => { calls++; headers.serve(req, res).then(ok => { if (!ok) handler(req, res); }).catch(() => res.writeHead(503).end()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const source = headerSource(`http://127.0.0.1:${server.address().port}`), trust = manifestTrust(gateway);
  return { root, store, history, files, headers, source, trust, calls: () => calls,
    options: { output: join(root, 'client.bin'), source, network: 'mainnet', independent: { hash: async h => history.hashAt(h) }, manifestTrust: trust } };
}

test('real kit adapter verifies signed chunks and local routes, caches ETags/ranges and pins against rollback', async t => {
  const f = await fixture(t); let verified;
  const first = await downloadHeaders({ ...f.options, onHistory: h => { verified = h; } });
  assert.deepEqual(await readFile(f.options.output), bytes); assert.equal(first.distribution, 'immutable_chunks');
  assert.equal(historyProof(verified).tip, f.history.hashAt(63));
  const warm = await downloadHeaders({ ...f.options, currentHistory: verified }); assert.equal(warm.downloadedBytes, 0);
  const root = f.headers.manifest().root, url = f.source.origin + root.path;
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(Number(head.headers.get('content-length')), root.bytes);
  assert.equal((await fetch(url, { headers: { 'if-none-match': head.headers.get('etag') } })).status, 304);
  const range = await fetch(url, { headers: { range: 'bytes=2-5', 'if-range': head.headers.get('etag') } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 4);
  assert.equal((await fetch(url, { headers: { range: 'bytes=999999-' } })).status, 416);
  assert.equal(await f.source.height(), 63); assert.equal(await f.source.hash(3), f.history.hashAt(3));
  assert.equal(await f.source.header(f.history.hashAt(3)), f.history.raw(3)); assert.equal((await f.source.blocks(63)).length, 10);
  const signed = f.headers.manifest(), signer = headerManifestSigner(secret), { authentication, ...unsigned } = signed;
  const higher = signer.sign({ ...unsigned, sequence: '5' });
  await downloadHeaders({ ...f.options, source: { ...f.source, manifest: async () => higher }, currentHistory: verified });
  await assert.rejects(downloadHeaders({ ...f.options, currentHistory: verified }), /rollback/);
  await assert.rejects(downloadHeaders({ ...f.options, source: { ...f.source, manifest: async () => ({ version: 1 }) } }), /downgrade/);
});

test('missing, tampered, wrong-network and unpinned manifests fail before chunk requests; rotation is explicit', async t => {
  const f = await fixture(t), original = f.headers.manifest(), a = original.authentication;
  const changed = [ { ...original, authentication: undefined }, { ...original, count: original.count + 1 },
    { ...original, verification: 'changed' }, { ...original, network: 'regtest' },
    { ...original, authentication: { ...a, key: 'ff'.repeat(32) } } ];
  for (const m of changed) {
    let downloads = 0;
    await assert.rejects(downloadHeaders({ ...f.options, source: { ...f.source, manifest: async () => m, archive: () => { downloads++; throw Error('unexpected'); } } }));
    assert.equal(downloads, 0); await assert.rejects(access(f.options.output));
  }
  await assert.rejects(downloadHeaders({ ...f.options, manifestTrust: undefined }), /Pinned/);
  const newSigner = headerManifestSigner(Buffer.alloc(32, 21), '1'), { authentication, ...body } = original;
  const rotated = newSigner.sign({ ...body, sequence: '0' });
  assert.throws(() => verifyHeaderManifest(rotated, f.trust), /Untrusted/);
  const trust = { keys: [...f.trust.keys, { key: newSigner.key, epoch: '1' }] };
  const before = verifyHeaderManifest(original, trust), after = verifyHeaderManifest(rotated, trust, { previous: before });
  assert.throws(() => verifyHeaderManifest(original, trust, { previous: after }), /rollback/);
  const chunks = new HeaderChunks({ store: f.store, files: f.files, history: f.history, network: 'mainnet', secret: Buffer.alloc(32, 21), signingEpoch: '1' });
  const retained = f.store.get('meta', 'headerChunkVersions'); await chunks.tick();
  verifyHeaderManifest(chunks.manifest(), trust); assert.deepEqual(f.store.get('meta', 'headerChunkVersions'), retained);
});

test('abandoned cache collection is bounded and restartable while the active partial chunk stays pinned', async t => {
  const root = await temp('g4d-cache-'); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'client'), old = '11'.repeat(32), current = '22'.repeat(32);
  let cache = await HeaderCache.open(path, old, { cleanupFiles: 2 });
  for (let i = 0; i < 7; i++) { const name = await cache.file(String(i).padStart(64, '0'), 'gz'); await writeFile(name + '.part', 'interrupted'); }
  cache.close();
  cache = await HeaderCache.open(path, current, { cleanupFiles: 2 });
  const active = await cache.file('aa'.repeat(32), 'gz'); await writeFile(active + '.part', 'needed');
  assert.equal(await cache.sweep(), 2); cache.close();
  for (let i = 0; i < 3; i++) {
    cache = await HeaderCache.open(path, current, { cleanupFiles: 2 });
    assert.ok(await cache.sweep() <= 2); assert.equal(await readFile(active + '.part', 'utf8'), 'needed'); cache.close();
  }
  await assert.rejects(access(join(path + '.chunks-v2', old)));
  cache = await HeaderCache.open(path, current, { cleanupFiles: 2 });
  assert.equal(await cache.sweep({ complete: true }), 1); cache.close(); await assert.rejects(access(active + '.part'));
});

test('failed current download retains exact range resume and the live lock excludes another downloader', async t => {
  const f = await fixture(t), archive = f.source.archive; let interrupt = true, resumed = false;
  f.source.archive = async (path, options) => {
    const response = await archive(path, options);
    if (path.endsWith('.gz') && interrupt) { interrupt = false; return new Response(Buffer.from(await response.arrayBuffer()).subarray(0, 17)); }
    if (options.start) resumed = true;
    return response;
  };
  await assert.rejects(downloadHeaders(f.options), /interrupted/);
  await downloadHeaders(f.options); assert.equal(resumed, true);
  // A live lock protects the cache from another process, even when its chosen
  // manifest differs. The lock is checked before a remote manifest is read.
  await writeFile(f.options.output + '.lock', String(process.pid));
  await assert.rejects(downloadHeaders(f.options), /another local process/);
});

test('gateway and all five signer stores resume authenticated immutable seeds without whole-seed reads', async t => {
  const f = await fixture(t), manifestFile = join(f.root, 'seed.json');
  await writeFile(manifestFile, JSON.stringify(f.headers.manifest()), { mode: 0o600 });
  const options = { manifestFile, directory: f.files.directory, trust: f.trust };
  for (const integerVersion of [1, 2]) for (const role of ['gateway', 'operator1', 'operator2', 'operator3', 'operator4', 'operator5']) {
    const file = join(f.root, role + '.sqlite'); let views = new BitcoinViews({ network: 'mainnet' }, file, { integerVersion, settings: { seedChunkRows: 4 } });
    try {
      await assert.rejects(views.seedChunks({ ...options, onCheckpoint: c => { if (c.count === 12) throw Error('interrupted'); } }), /interrupted/);
      assert.equal(views.seedWork.headers, 12); views.close(); views = new BitcoinViews({ network: 'mainnet' }, file, { integerVersion });
      await views.seedChunks(options); assert.equal(views.seedWork.headers, 52); assert.equal(views.seedWork.bytes, 56 * 80);
      views.close(); views = new BitcoinViews({ network: 'mainnet' }, file, { integerVersion });
      await views.seedChunks(options); assert.deepEqual(views.seedWork, { bytes: 0, headers: 0, nodes: 0, reused: true });
      assert.equal(views.get.get(f.history.hashAt(63)).height, integerVersion === 2 ? '63' : 63);
    } finally { views.close(); }
  }
  // An audit is explicitly requested; it rereads chunks and detects corruption.
  const leaf = f.store.list('headerTreeNodes', { limit: 100 }).find(r => r.value.chunk).value;
  await writeFile(f.files.path(leaf.chunk.path.slice(1)), Buffer.alloc(leaf.chunk.bytes));
  const views = new BitcoinViews({ network: 'mainnet' }, join(f.root, 'gateway.sqlite'));
  try { await assert.rejects(views.seedChunks({ ...options, audit: true }), /checksum/); } finally { views.close(); }
});

for (const integerVersion of [1, 2]) test(`flat-seed checkpoint survives interruption and identity changes, integer schema ${integerVersion}`, async t => {
  const root = await temp('g4d-flat-'), path = join(root, 'seed.bin'), db = join(root, 'seed.sqlite');
  t.after(() => rm(root, { recursive: true, force: true })); await writeFile(path, bytes, { mode: 0o600 });
  let views = new BitcoinViews({}, db, { integerVersion, settings: { seedChunkRows: 8 } });
  try {
    await assert.rejects(views.seed(path, { onCheckpoint: c => { if (String(c.height) === '15') throw Error('crash'); } }), /crash/);
    views.close(); views = new BitcoinViews({}, db, { integerVersion, settings: { seedChunkRows: 8 } }); await views.seed(path);
    assert.equal(views.seedWork.bytes, 48 * 80); assert.equal(views.seedWork.headers, 48);
    await views.seed(path); assert.equal(views.seedWork.bytes, 0);
    const altered = Buffer.from(bytes); altered[30 * 80 + 76] ^= 1; await writeFile(path, altered);
    await assert.rejects(views.seed(path), /bitcoin_pow/);
  } finally { views.close(); }
});

test('a signer checkpoint cannot silently switch consensus parameters', async t => {
  const root = await temp('g4d-consensus-'), path = join(root, 'seed.bin'), db = join(root, 'seed.sqlite');
  t.after(() => rm(root, { recursive: true, force: true })); await writeFile(path, bytes, { mode: 0o600 });
  const original = new BitcoinViews({}, db); await original.seed(path); const params = { ...original.params, interval: 4 }; original.close();
  const changed = new BitcoinViews({ params }, db);
  try { await assert.rejects(changed.seed(path), /consensus_changed/); } finally { changed.close(); }
});

test('an authenticated but corrupt chain or independent-tip mismatch preserves the installed archive', async t => {
  const f = await fixture(t); await downloadHeaders(f.options);
  const before = await readFile(f.options.output);
  await assert.rejects(downloadHeaders({ ...f.options, independent: { hash: async () => '00'.repeat(32) } }), /Independent tip mismatch/);
  assert.deepEqual(await readFile(f.options.output), before);
  const bad = Buffer.from(bytes); bad[10 * 80 + 76] ^= 1;
  const fakeHistory = { length: 64, raw: n => bad.subarray(n * 80, (n + 1) * 80).toString('hex'), hashAt: f.history.hashAt };
  const poisoned = new HeaderChunks({ store: f.store, files: f.files, history: fakeHistory, network: 'mainnet', secret });
  // A fresh publication with correct content hashes and an authentic signature
  // still cannot bypass Bitcoin verification at the receiving kit.
  await f.store.put('meta', 'headerChunks'); await f.store.put('meta', 'headerChunkVersions'); await poisoned.tick();
  await assert.rejects(downloadHeaders({ ...f.options, output: join(f.root, 'bad-client.bin'), source: { ...f.source, manifest: async () => poisoned.manifest() } }), /header_pow|header_link/);
  await assert.rejects(access(join(f.root, 'bad-client.bin')));
});

test('invalid chunk response ranges are cancelled without publishing an output', async t => {
  const f = await fixture(t); let cancelled = false;
  const source = { ...f.source, archive: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    status: 206, headers: { 'content-range': 'bytes 1-2/3' }
  }) };
  await assert.rejects(downloadHeaders({ ...f.options, source }), /Content-Range/);
  assert.equal(cancelled, true); await assert.rejects(access(f.options.output));
});

test('cache database excludes a second collector even during stale outer-lock recovery', async t => {
  const root = await temp('g4d-cache-lock-'); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'client'), active = await HeaderCache.open(path, '11'.repeat(32), { cleanupFiles: 2 });
  try {
    const file = await active.file('aa'.repeat(32), 'gz'); await writeFile(file + '.part', 'needed');
    await assert.rejects(HeaderCache.open(path, '22'.repeat(32), { cleanupFiles: 2 }), /locked/);
    assert.equal(await readFile(file + '.part', 'utf8'), 'needed');
    assert.equal(await active.sweep(), 0);
  } finally { active.close(); }
  const next = await HeaderCache.open(path, '22'.repeat(32), { cleanupFiles: 2 });
  try { assert.equal(await next.sweep(), 1); } finally { next.close(); }
});
