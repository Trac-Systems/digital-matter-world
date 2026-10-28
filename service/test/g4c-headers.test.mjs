import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { HeaderChunks } from '../src/header-chunks.mjs';
import { LocalHeaders, localHeaderHandler } from '../src/local-headers.mjs';
import { History } from '../src/history.mjs';
import { downloadArchive } from '../../kit/lib/header-download.mjs';
import { manifestTrust } from '../../kit/lib/header-manifest.mjs';
import { temp, secret, gateway } from './helpers.mjs';

test('immutable header tree resumes, appends bounded suffixes and downloads with independent verification', async t => {
  const root = await temp(), bytes = Buffer.from((await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  let store = await Store.open(join(root, 'store')), tip = 40, reads = 0;
  t.after(() => store.close());
  const { HeaderHistory } = await import('../../rules/src/index.js'), chain = new HeaderHistory(bytes);
  const history = { get length() { return tip + 1; }, hashAt: h => h >= 0 && h <= tip ? chain.get(h).hash : null,
    raw: h => { reads++; return bytes.subarray(h * 80, (h + 1) * 80).toString('hex'); } };
  const files = new Files(join(root, 'static')), settings = { chunkRows: 8, chunksPerTick: 2, manifestRetention: 2 };
  let chunks = new HeaderChunks({ store, history, files, network: 'mainnet', secret, settings });
  await chunks.tick(); assert.equal(chunks.manifest().count, 16);
  await store.close(); store = await Store.open(join(root, 'store'));
  chunks = new HeaderChunks({ store, history, files, network: 'mainnet', secret, settings });
  while (chunks.manifest().count < tip + 1) await chunks.tick();
  assert.equal(reads, 41); const first = chunks.manifest(); await chunks.tick(); assert.equal(reads, 41);
  const server = createServer((req, res) => chunks.serve(req, res).then(ok => { if (!ok) res.writeHead(404).end(); }).catch(() => res.writeHead(503).end()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const source = { manifest: async () => (await fetch(origin + '/headers/manifest.json')).json(), hash: async h => history.hashAt(h),
    archive: (path, { start = 0 }) => fetch(origin + path, { headers: start ? { range: `bytes=${start}-` } : {} }) };
  let interrupt = true, resumed = false;
  const interrupted = { ...source, archive: async (path, options) => {
    const response = await source.archive(path, options);
    if (path.endsWith('.gz') && interrupt) { interrupt = false; const b = Buffer.from(await response.arrayBuffer()); return new Response(b.subarray(0, 11)); }
    if (path.endsWith('.gz') && options.start) resumed = true;
    return response;
  } };
  const resumedPath = join(root, 'resume.bin');
  await assert.rejects(downloadArchive({ output: resumedPath, source: interrupted, independent: { hash: source.hash }, network: 'mainnet', manifestTrust: manifestTrust(gateway) }), /interrupted/);
  await assert.rejects(access(resumedPath));
  await downloadArchive({ output: resumedPath, source: interrupted, independent: { hash: source.hash }, network: 'mainnet', manifestTrust: manifestTrust(gateway) }); assert.equal(resumed, true);
  const corrupt = { ...source, archive: async (path, options) => {
    const response = await source.archive(path, options); if (!path.endsWith('.gz')) return response;
    const b = Buffer.from(await response.arrayBuffer()); b[0] ^= 1; return new Response(b);
  } };
  await assert.rejects(downloadArchive({ output: join(root, 'corrupt.bin'), source: corrupt, independent: { hash: source.hash }, network: 'mainnet', manifestTrust: manifestTrust(gateway) }), /checksum/);
  await assert.rejects(access(join(root, 'corrupt.bin')));
  let verified;
  const download = () => downloadArchive({ output: join(root, 'client.bin'), source, independent: { hash: source.hash }, network: 'mainnet', manifestTrust: manifestTrust(gateway), currentHistory: verified, onHistory: h => { verified = h; } });
  await download(); assert.deepEqual(await readFile(join(root, 'client.bin')), bytes.subarray(0, 41 * 80));
  tip = 42; reads = 0; await chunks.tick(); assert.equal(reads, 2);
  const update = await download(); assert.ok(update.downloadedBytes < 5000); assert.equal(verified.length, 43);
  tip = 36; reads = 0; await chunks.tick(); assert.ok(reads <= 8); await download(); assert.equal(verified.length, 37);
  assert.notEqual(chunks.manifest().root.hash, first.root.hash);
  const cached = await fetch(origin + '/headers/manifest.json'); const etag = cached.headers.get('etag'); await cached.arrayBuffer();
  assert.equal((await fetch(origin + '/headers/manifest.json', { headers: { 'if-none-match': etag } })).status, 304);
});

test('public header API reads the verified local store with no upstream client', async t => {
  const root = await temp(), store = await Store.open(root); t.after(() => store.close());
  const bytes = Buffer.from((await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  const history = new History(store); await history.appendMany(0, Array.from({ length: 64 }, (_, i) => bytes.subarray(i * 80, (i + 1) * 80).toString('hex')));
  const reader = new LocalHeaders(join(root, 'index.sqlite')); t.after(() => reader.close());
  const server = createServer(localHeaderHandler(reader)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(origin + '/api/blocks/tip/height')).text(), '63');
  assert.equal(await (await fetch(origin + '/api/block-height/3')).text(), history.hashAt(3));
  assert.equal(await (await fetch(origin + '/api/block/' + history.hashAt(3) + '/header')).text(), history.raw(3));
  assert.equal((await (await fetch(origin + '/api/blocks/63')).json()).length, 10);
  assert.equal((await fetch(origin + '/api/block-height/64')).status, 404);
});
