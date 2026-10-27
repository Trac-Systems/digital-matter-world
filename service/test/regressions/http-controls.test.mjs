import { BUILD as configuredBuildRoot } from '../../../local/common.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Files } from '../../src/files.mjs';
import { serve } from '../../src/http.mjs';
import { Limiter } from '../../src/limiter.mjs';
import { loadConfig } from '../../src/config.mjs';

const root = `${configuredBuildRoot}/service/regressions/http-data`;
const send = (url, path, parts, headers = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
    let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject); for (const p of parts) req.write(p); req.end();
});
test('control: HTTP bodies, traversal, errors, HEAD and ETags stay bounded/public', async () => {
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, 'case-')), files = new Files(join(directory, 'static'));
  await writeFile(join(directory, 'private.json'), 'private-test-marker'); await files.json('latest.json', { pollAfter: 30 }); await files.immutable('blocks/one.bin', Buffer.from('audit'));
  let accepted = 0;
  const server = await serve({ files, intake: { accept: async () => { accepted++; throw Error('upstream private-test-marker with spaces'); } } });
  try {
    assert.equal((await send(server.url, '/moves', ['x'.repeat(16385)], { 'content-length': '16385' })).status, 413);
    assert.equal((await send(server.url, '/moves', ['x'.repeat(8192), 'y'.repeat(8193)])).status, 413);
    assert.equal((await send(server.url, '/moves', ['{}'], { 'content-type': 'text/plain' })).status, 415);
    assert.equal(accepted, 0);
    assert.equal((await send(server.url, '/moves', ['{}'])).body, '{"error":"request_failed"}');
    for (const path of ['/blocks/%2e%2e%2f%2e%2e%2fprivate.json', '/%2e%2e/private.json', '/index.sqlite', '/gateway.key']) {
      const response = await fetch(server.url + path); assert.equal(response.status, 404); assert.ok(!(await response.text()).includes('private-test-marker'));
    }
    const r = await fetch(server.url + '/latest.json'); assert.equal(r.headers.get('cache-control'), 'public, max-age=1, must-revalidate');
    assert.equal((await fetch(server.url + '/latest.json', { headers: { 'if-none-match': r.headers.get('etag') } })).status, 304);
    const head = await fetch(server.url + '/blocks/one.bin', { method: 'HEAD' }); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), '5'); assert.match(head.headers.get('cache-control'), /immutable/);
    assert.equal(server.server.headersTimeout, 5000); assert.equal(server.server.requestTimeout, 10000); assert.equal(server.server.timeout, 15000); assert.equal(server.server.maxConnections, 1200);
  } finally { await server.close(); }
});

test('control: sender churn cannot expand the limiter arrays or key map', () => {
  const limiter = new Limiter({ capacity: 8, burst: 1, perSecond: 0 });
  for (let i = 0; i < 10000; i++) limiter.take('sender-' + i, 0);
  assert.equal(limiter.keys.size, 8); assert.equal(limiter.tokens.length, 8); assert.equal(limiter.take('sender-0', 0), false);
});

test('control: configuration rejects a nonloopback endpoint before connecting', async () => {
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, 'config-')), path = join(directory, 'gateway.json');
  await writeFile(path, JSON.stringify({ version: 1, mode: 'regtest', network: 'dmw-regtest', listen: { host: '127.0.0.1', port: 0 },
    endpoints: { ethereum: 'https://example.invalid', trac: 'http://127.0.0.1:59000' }, local: { tapSourceFile: '/disposable/source.url' } }));
  await assert.rejects(loadConfig(path), /endpoint_must_be_loopback/);
});
