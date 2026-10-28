import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeaderHistory, parseHeader } from '../../rules/src/index.js';
import { chain } from '../../contract/tests/helpers/chain.mjs';
import { Files } from '../../service/src/files.mjs';
import { HeaderFiles } from '../../service/src/header-files.mjs';
import { setup } from '../lib/setup.mjs';
import { FakeService } from './fake-service.mjs';
import { temp, cleanup } from './helpers.mjs';

const run = promisify(execFile), cwd = fileURLToPath(new URL('..', import.meta.url));
for (const mode of ['cache', 'download', 'empty']) test(`README once --live uses setup config and ${mode} history for free moves`, async t => {
  const dir = await temp(t), genesis = Buffer.from('01000000' + '00'.repeat(32) + '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' + 'dae5494dffff7f2002000000', 'hex');
  const bytes = Buffer.from([genesis.toString('hex'), ...chain(20, parseHeader(genesis))].join(''), 'hex');
  const history = new HeaderHistory(bytes), testHistory = join(dir, 'source.bin'); await writeFile(testHistory, bytes);
  const network = 'dmw-kit-test', fake = new FakeService({ network, history, tip: 20 });
  const pattern = { number: 0, name: 'dmwtest', fld: 4, dt: 'n', pat: '[0-9]', rarity: 21 };
  const summary = Buffer.from(JSON.stringify({ tip: 20, height: 20, tipHash: history.get(20).hash }));
  const descriptor = { path: '/summary.json', bytes: summary.length, hash: createHash('sha256').update(summary).digest('hex') };
  const files = new Files(join(dir, 'static')), headers = new HeaderFiles({ files, network: 'regtest', history: {
    length: history.length, hashAt: h => history.get(h).hash, raw: h => history.raw(h),
  } });
  const posts = [];
  const server = createServer(async (req, res) => {
    try {
      if (await headers.serve(req, res) || await files.serve(req, res)) return;
      const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname;
      if (path === '/summary.json') { res.end(summary); return; }
      if (path.startsWith('/api/block-height/')) { res.end(history.get(Number(path.split('/').at(-1))).hash); return; }
      let value;
      if (path === '/patterns') value = { patterns: mode === 'empty' ? [] : [pattern], total: mode === 'empty' ? 0 : 1, limit: 50, next: null };
      else if (path === '/patterns/p0/blocks') value = { rows: [], total: 0, limit: 200, next: null };
      else if (path === '/latest.json') value = { summary: descriptor };
      else if (path === '/moves' && req.method === 'POST') {
        let body = ''; for await (const part of req) body += part;
        posts.push(JSON.parse(body)); const response = await fake.fetch(url, { body });
        res.statusCode = response.status; res.end(await response.text()); return;
      } else { res.statusCode = 404; value = { error: 'unexpected_route' }; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, profile = join(dir, 'network.json');
  await writeFile(profile, JSON.stringify({ localOnly: true, mode: 'regtest', bitcoinNetwork: 'regtest', network, gateway: origin,
    gatewayKey: fake.gateway, receiptSigners: fake.witness.members, puzzleBits: 0, powLimitBits: 0x207fffff,
    adapter: fileURLToPath(new URL('./fixtures/once-adapter.mjs', import.meta.url)), testHistory,
    ...(mode === 'cache' ? { headers: testHistory } : { headerSource: origin }) }));
  const password = 'disposable once test password';
  const created = await setup({ network: 'regtest', networkFile: profile, directory: join(dir, 'signer'), password });
  assert.ok(created.next.at(-1).includes(created.config));
  const { stdout, stderr } = await run(process.execPath, ['bin/dmw.mjs', 'once', '--live', '--config', created.config],
    { cwd, env: { ...process.env, DMW_SIGNER_PASSWORD: password }, timeout: 20000 });
  assert.equal((stdout + stderr).includes(password), false);
  const result = JSON.parse(stdout);
  assert.equal(posts.length, 1); assert.equal(posts[0].t, mode === 'empty' ? 'header' : 'claim');
  if (mode === 'empty') { assert.equal(result.state, 'discovery_needed'); assert.equal(result.header.state, 'received'); assert.match(result.message, /wait for evaluation/); }
  else { assert.equal(result.state, 'received'); assert.equal(result.window, 20); assert.ok(result.plots.some(p => p.block < 20)); }
  if (mode !== 'cache') assert.deepEqual(await readFile(join(dir, 'signer', 'headers.bin')), bytes);
});
