import { BUILD as configuredBuildRoot } from '../../local/common.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { fixtureHistory, makeMove, agent } from '../test/helpers.mjs';
import { rules } from '../src/rules.mjs';
import { diskCheck } from '../src/util.mjs';

await diskCheck();
const blocks = Number(process.argv[2] ?? 1500), directory = resolve(process.argv[3] ?? `${configuredBuildRoot}/service/gateway-memory-${Date.now()}`);
assert.ok(Number.isSafeInteger(blocks) && blocks >= 300 && blocks <= 10000 && directory.startsWith(`${configuredBuildRoot}/`));
await mkdir(directory, { recursive: true, mode: 0o700 });
const history = fixtureHistory(blocks + 30), identities = Array.from({ length: 20 }, (_, i) => agent(i));
const child = spawn(process.execPath, [fileURLToPath(new URL('./load-server.mjs', import.meta.url)), directory, String(blocks)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
await writeFile(join(directory, 'pids.json'), JSON.stringify({ supervisor: process.pid, gateway: child.pid }));
let serial = 0; const pending = new Map(), samples = [], started = Date.now();
child.on('message', m => { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(Error(m.error)) : p.resolve(m.result); } });
child.once('exit', () => { for (const p of pending.values()) p.reject(Error('gateway_exited')); pending.clear(); });
const call = (op, args = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); child.send({ id, op, ...args }); });
const timeout = setTimeout(() => child.kill('SIGTERM'), 40 * 60 * 1000);
try {
  const url = await new Promise((resolve, reject) => { child.on('message', m => { if (m.ready) resolve(m.ready); }); child.once('error', reject); child.once('exit', () => reject(Error('gateway_start_failed'))); });
  await call('observe', { tip: 6 });
  for (let block = 0; block <= blocks; block++) {
    if (block % 25 === 0) {
      const sample = { block, elapsedSeconds: (Date.now() - started) / 1000, ...await call('stats') }; samples.push(sample);
      console.log(JSON.stringify({ block, rss: sample.memory.rss, heap: sample.memory.heapUsed, worker: sample.worker.threadId }));
    }
    if (block === blocks) break;
    await Promise.all(identities.map(async who => {
      const response = await fetch(url + '/moves', { method: 'POST', headers: { 'content-type': 'application/json' }, body: rules.stableJSON(makeMove(history, block + 6, who)) });
      assert.equal(response.status, 200); await response.json();
    }));
    await call('observe', { tip: block + 7 });
    assert.equal((await call('drain')).error, null);
    const response = await fetch(url + '/world'); assert.equal(response.status, 200); await response.arrayBuffer();
  }
  const late = samples.filter(s => s.block >= blocks / 2), x = late.reduce((n, s) => n + s.block, 0) / late.length;
  const y = late.reduce((n, s) => n + s.memory.rss, 0) / late.length;
  const slope = late.reduce((n, s) => n + (s.block - x) * (s.memory.rss - y), 0) / late.reduce((n, s) => n + (s.block - x) ** 2, 0);
  const result = { blocks, agents: identities.length, forcedGC: false, restarts: 0, elapsedSeconds: (Date.now() - started) / 1000, rssBytesPerBlock: slope, pass: slope < 20000, samples };
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...result, samples: undefined })); assert.ok(result.pass, 'gateway_rss_slope');
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && !child.signalCode) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await call('close'); await exited; } finally { clearTimeout(deadline); }
  }
  await writeFile(join(directory, 'stopped.json'), JSON.stringify({ pid: child.pid, stopped: child.exitCode !== null || !!child.signalCode }));
}
