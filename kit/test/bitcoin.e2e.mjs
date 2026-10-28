import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { regtestSource } from '../lib/regtest-source.mjs';
import { checkedHeader } from '../lib/headers.mjs';
import { diskSpace } from '../lib/check.mjs';
import { temp, cleanup } from './helpers.mjs';

test('real isolated Bitcoin regtest supplies linked PoW headers without public peers', { timeout: 60000 }, async t => {
  const dir = await temp(t), probe = createServer(); await diskSpace(join(dir, 'regtest'), 0);
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.env.DMW_BITCOIND ?? 'bitcoind', [`-datadir=${dir}`, '-regtest', '-server=1', '-listen=0', '-discover=0', '-dnsseed=0', '-fixedseeds=0', '-connect=0', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${port}`, '-printtoconsole=0'], { stdio: 'ignore' });
  let failure; const exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', e => { failure = e; resolve({ error: e.code }); }); });
  if (child.pid) await writeFile(join(dir, 'pid.json'), JSON.stringify({ pid: child.pid }));
  cleanup(t, async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 10000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  const cookiePath = join(dir, 'regtest/.cookie'), origin = `http://127.0.0.1:${port}`, source = regtestSource({ origin, cookiePath });
  const until = async fn => { const end = Date.now() + 20000; while (Date.now() < end) { if (failure) throw failure; try { return await fn(); } catch {} await new Promise(r => setTimeout(r, 50)); } throw Error('Local Bitcoin did not start'); };
  assert.equal(await until(() => source.height()), 0);
  const rpc = async (method, params = [], wallet = '') => {
    const cookie = (await readFile(cookiePath, 'utf8')).trim();
    const response = await fetch(origin + wallet, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cookie).toString('base64') }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const result = await response.json(); assert.equal(result.error, undefined); return result.result;
  };
  await rpc('createwallet', ['kit-test']); const address = await rpc('getnewaddress', [], '/wallet/kit-test');
  await rpc('generatetoaddress', [12, address]); assert.equal(await source.height(), 12);
  const hash = await source.hash(12), raw = await source.header(hash), previous = await source.hash(11);
  assert.equal(checkedHeader(raw, 12, hash, { powLimitBits: 0x207fffff, previous }).height, 12);
  assert.equal((await rpc('getnetworkinfo')).connections, 0);
  t.diagnostic(JSON.stringify({ height: 12, pow: true, externalConnections: 0, pid: child.pid }));
});
