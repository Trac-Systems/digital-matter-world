import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { HeaderHistory } from '../../rules/src/index.js';
import { gunzipSync } from 'node:zlib';
import { HeaderFiles } from '../src/header-files.mjs';
import { Files } from '../src/files.mjs';
import { serve } from '../src/http.mjs';
import { temp, fixtureHistory } from './helpers.mjs';

test('header manifest and immutable binary route support one stream, HEAD, caching and exact byte ranges', async t => {
  const bytes = Buffer.from((await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  const history = new HeaderHistory(bytes); history.hashAt = h => h < history.length ? history.get(h).hash : null;
  const files = new Files(await temp()), headers = new HeaderFiles({ history, files, network: 'mainnet' });
  const http = await serve({ intake: {}, files, headers }); t.after(() => http.close());
  const [a, b] = await Promise.all([fetch(http.url + '/headers/manifest.json'), fetch(http.url + '/headers/manifest.json')]);
  const manifest = await a.json(); assert.deepEqual(await b.json(), manifest);
  assert.equal(manifest.bytes, 5120); assert.equal(manifest.count, 64); assert.equal(manifest.tip, history.get(63).hash);
  assert.match(a.headers.get('cache-control'), /max-age=5/);
  const file = await fetch(http.url + manifest.path), etag = file.headers.get('etag');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes); assert.match(file.headers.get('cache-control'), /immutable/);
  assert.equal(file.headers.get('accept-ranges'), 'bytes');
  const gzip = await fetch(http.url + manifest.gzip.path), compressed = Buffer.from(await gzip.arrayBuffer());
  assert.equal(gzip.headers.get('content-type'), 'application/gzip'); assert.notEqual(gzip.headers.get('etag'), etag);
  assert.equal(compressed.length, manifest.gzip.bytes); assert.deepEqual(gunzipSync(compressed), bytes);
  assert.equal((await fetch(http.url + manifest.path, { headers: { 'if-none-match': etag } })).status, 304);
  const head = await fetch(http.url + manifest.path, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal(await head.text(), '');
  const headRange = await fetch(http.url + manifest.path, { method: 'HEAD', headers: { range: 'bytes=80-' } });
  assert.equal(headRange.status, 200); assert.equal(headRange.headers.get('content-length'), String(bytes.length));
  for (const [range, from, to] of [['bytes=137-', 137, bytes.length], ['bytes=80-159', 80, 160], ['bytes=5100-99999', 5100, bytes.length], ['bytes=-10', bytes.length - 10, bytes.length]]) {
    const r = await fetch(http.url + manifest.path, { headers: { range, 'if-range': etag } });
    assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes ${from}-${to - 1}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(from, to));
  }
  for (const range of ['bytes=5120-', 'bytes=2-1', 'bytes=0-1,3-4', 'bytes=-0', 'bytes=999999999999999999999-']) {
    const r = await fetch(http.url + manifest.path, { headers: { range } }); assert.equal(r.status, 416); assert.equal(r.headers.get('content-range'), 'bytes */5120'); await r.arrayBuffer();
  }
  const ignored = await fetch(http.url + manifest.path, { headers: { range: 'bytes=80-', 'if-range': '"other"' } });
  assert.equal(ignored.status, 200); assert.deepEqual(Buffer.from(await ignored.arrayBuffer()), bytes);
  assert.deepEqual(await (await fetch(http.url + '/headers/height/2.json')).json(), { height: 2, hash: history.get(2).hash, tip: { height: 63, hash: history.get(63).hash } });
  assert.equal((await fetch(http.url + '/headers/height/64.json')).status, 404);
  for (const path of ['/headers/mainnet-63-evil.bin', '/headers/manifest.json?file=private', '/headers/%2e%2e/private']) assert.equal((await fetch(http.url + path)).status, 404);
});

test('snapshots append new rows, survive restart and rebuild on a reorg without changing old files', async () => {
  const full = fixtureHistory(70), files = new Files(await temp()); let tip = 63, reads = 0;
  const history = { get length() { return tip + 1; }, hashAt: h => h <= tip ? full.hashAt(h) : null, raw: h => { reads++; return full.raw(h); } };
  let headers = new HeaderFiles({ history, files, network: 'regtest' });
  const first = await headers.manifest(), bytes = await readFile(files.path(first.path.slice(1))); assert.equal(reads, 64);
  headers = new HeaderFiles({ history, files, network: 'regtest' }); assert.deepEqual(await headers.manifest(), first); assert.equal(reads, 64);
  tip = 64; const second = await headers.manifest(); assert.equal(reads, 65); assert.notEqual(first.path, second.path);
  assert.deepEqual(await readFile(files.path(first.path.slice(1))), bytes);
  tip = 62; const reorg = await headers.manifest(); assert.equal(reads, 128); assert.equal(reorg.bytes, 63 * 80);
  assert.deepEqual(await readFile(files.path(reorg.path.slice(1))), bytes.subarray(0, 63 * 80));
  tip = 66; await headers.manifest(); tip = 67; await headers.manifest();
  assert.equal((await readdir(files.path('headers'))).filter(n => n.endsWith('.bin')).length, 3);
});

test('changing canonical tip during snapshot creation publishes no mixed file', async () => {
  const full = fixtureHistory(5), files = new Files(await temp()); let changed = false;
  const history = { length: 6, raw: h => { changed = true; return full.raw(h); }, hashAt: h => changed ? '11'.repeat(32) : full.hashAt(h) };
  const headers = new HeaderFiles({ history, files, network: 'regtest' });
  await assert.rejects(headers.manifest(), /snapshot_changed/);
  await assert.rejects(readFile(files.path('headers/manifest.json')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(files.path('headers')), []);
});
