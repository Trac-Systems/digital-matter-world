import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { serveSigner } from '../signer/service.mjs';

test('signer listens before slow reader startup and cancels an in-flight read before releasing its lock', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(fileURLToPath(new URL('../../.fr1-signer-', import.meta.url)));
  let entered, calls = 0, service;
  const receiving = new Promise(resolve => { entered = resolve; });
  const sidecar = createServer((req, res) => {
    if (req.url === '/slow') { calls++; entered(); return; }
    assert.equal(req.url, '/status', 'startup must not start a ceremony');
    res.end(JSON.stringify({ public: '02' + '11'.repeat(32), epoch: 1 }));
  });
  await new Promise(resolve => sidecar.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service?.close(); sidecar.closeAllConnections(); await new Promise(resolve => sidecar.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${sidecar.address().port}`, configPath = join(directory, 'signer.json');
  const config = { directory, network: 'fixture', id: 'one', epoch: 1, members: [], listen: '127.0.0.1:0', sidecar: url,
    secrets: join(directory, 'credentials.json'), readModule: fileURLToPath(new URL('./restart-reads.mjs', import.meta.url)), readOptions: { delayMs: 300, url } };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(config.secrets, JSON.stringify({ apiToken: 'fixture', identity: '11'.repeat(32), journalKey: 'fixture', sidecarToken: 'fixture' }), { mode: 0o600 });
  const phases = [], before = performance.now();
  service = await serveSigner(configPath, { background: true, onPhase: row => phases.push(row) });
  const listenMs = performance.now() - before;
  const initial = await fetch(service.url + '/health'); assert.equal(initial.status, 503); assert.equal((await initial.json()).ready, false);
  await service.ready;
  const readyMs = performance.now() - before;
  const post = path => fetch(service.url + path, { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: '{}' });
  const health = await post('/health'); assert.equal(health.status, 200); assert.equal((await health.json()).id, 'one');
  const pending = assert.rejects(post('/batch-ready'), /fetch failed/);
  await receiving; const closing = performance.now(), first = service.close();
  assert.equal(service.close(), first); await first; await pending;
  const closeMs = performance.now() - closing; assert.ok(closeMs < 2000); assert.equal(calls, 1);
  t.diagnostic(JSON.stringify({ signer: { listenMs, readyMs, closeMs, phases } }));
  // Reopening the same journal proves the lock was removed only after drain.
  service = await serveSigner(configPath); await service.close();
});
