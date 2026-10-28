import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HeaderHistory } from '../../rules/src/headers.js';
import { temp } from '../../service/test/helpers.mjs';
import { laterHeaders } from './later-headers.mjs';

test('public tail fetch is paced, binds exact raw headers to metadata and verifies the complete original prefix', async t => {
  const directory = await temp('public-header-tail-'), bytes = Buffer.from((await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  const history = new HeaderHistory(bytes), requests = [], source = join(directory, 'original.bin'); await writeFile(source, bytes.subarray(0, 60 * 80));
  const server = createServer((req, res) => {
    requests.push({ route: req.url, at: Date.now() });
    if (req.url === '/api/blocks/tip/height') return res.end('63');
    if (req.url === '/api/blocks/63') return res.end(JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ height: 63 - i, id: history.get(63 - i).hash }))));
    if (req.url === '/api/block-height/63') return res.end(history.get(63).hash);
    for (let h = 60; h <= 63; h++) if (req.url === '/api/block/' + history.get(h).hash + '/header') return res.end(Buffer.from(history.raw(h)).toString('hex'));
    res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
  const output = join(directory, 'tail'), result = await laterHeaders(source, output, { origin: 'http://127.0.0.1:' + server.address().port });
  assert.equal(result.count, 4); assert.equal(result.first, 60); assert.equal(result.verified.tip, history.get(63).hash);
  assert.equal(requests.length, 7); for (let i = 1; i < requests.length; i++) assert(requests[i].at - requests[i - 1].at >= 500);
  assert.deepEqual(await readFile(join(output, 'headers.bin')), bytes); assert.deepEqual(await readFile(source), bytes.subarray(0, 60 * 80));
  await assert.rejects(laterHeaders(source, output), { code: 'EEXIST' });
});
