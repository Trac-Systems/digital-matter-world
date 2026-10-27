import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { temp, fixtureHistory, makeMove, agent, network, feeFixture } from '../test/helpers.mjs';
import { rules } from '../src/rules.mjs';
import { diskCheck, hash } from '../src/util.mjs';
await diskCheck();
const blocks = Number(process.argv[2] ?? 144), agents = 500, viewers = 60;
assert.ok(Number.isSafeInteger(blocks) && blocks >= 12 && blocks <= 10000);
const directory = await temp('load-'), history = fixtureHistory(blocks + 30), identities = Array.from({ length: agents }, (_, i) => agent(i));
await writeFile(join(directory, 'supervisor-pid.json'), JSON.stringify({ pid: process.pid }));
const latencies = { moves: [], viewers: [] }, memory = [], pids = [], etags = new Array(viewers); let child, url, serial = 0, restartAcknowledged = 0, cacheHits = 0, totalMoves = 0;
const pending = new Map();
function call(op, args = {}) { return new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); child.send({ id, op, ...args }); }); }
async function start() {
  child = spawn(process.execPath, ['--expose-gc', fileURLToPath(new URL('./load-server.mjs', import.meta.url)), directory, String(blocks)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  pids.push(child.pid); await writeFile(join(directory, 'pids.json'), JSON.stringify(pids));
  child.on('message', m => { const waiter = pending.get(m.id); if (waiter) { pending.delete(m.id); m.error ? waiter.reject(Error(m.error)) : waiter.resolve(m.result); } });
  child.once('exit', () => { for (const waiter of pending.values()) waiter.reject(Error('gateway_exited')); pending.clear(); });
  url = await new Promise((resolve, reject) => { child.on('message', m => { if (m.ready) resolve(m.ready); }); child.once('error', reject); child.once('exit', () => reject(Error('gateway_start_failed'))); });
}
async function stop(kill = false) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (kill) child.kill('SIGKILL'); else await call('close'); await exited;
}
async function sendMoves(moves) {
  await Promise.all(moves.map(async text => { const start = performance.now(); const response = await fetch(url + '/moves', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text }); const receipt = await response.json(); assert.equal(response.status, 200, JSON.stringify(receipt)); latencies.moves.push(performance.now() - start); assert.equal(typeof receipt.sequence, 'number'); totalMoves++; }));
}
async function view() {
  await Promise.all(Array.from({ length: viewers }, async (_, i) => { const start = performance.now(), response = await fetch(url + '/world', { headers: etags[i] ? { 'if-none-match': etags[i] } : {} });
    if (response.status === 304) cacheHits++; else { assert.equal(response.status, 200); const data = await response.arrayBuffer(); assert.ok(data.byteLength <= 60000); etags[i] = response.headers.get('etag'); }
    latencies.viewers.push(performance.now() - start); }));
}
const startTime = performance.now(); let result;
try {
  await start(); await call('observe', { tip: 6 });
  for (let block = 0; block < blocks; block++) {
    const tip = 6 + block, moves = identities.map(who => rules.stableJSON(makeMove(history, tip, who)));
    if (block === Math.floor(blocks / 2)) {
      await Promise.all([sendMoves(moves.slice(0, 250)), view()]); const before = await call('stats'); restartAcknowledged = before.sequence;
      await stop(true); await start(); const after = await call('stats'); assert.equal(after.sequence, before.sequence); assert.equal(after.pending, before.pending);
      await sendMoves(moves.slice(250));
    } else await Promise.all([sendMoves(moves), block ? view() : Promise.resolve()]);
    await call('observe', { tip: tip + 1 });
    const draining = call('drain');
    if (block) for (let poll = 0; poll < 19; poll++) await view();
    const publication = await draining; assert.equal(publication.error, null, 'batch must be committed');
    if (!block) for (let poll = 0; poll < 20; poll++) await view();
    if (block % 12 === 0 || block === blocks - 1) {
      const sample = await call('stats'); memory.push({ block, rss: sample.memory.rss, heap: sample.memory.heapUsed, pending: sample.pending });
      console.log(JSON.stringify({ block: block + 1, moves: totalMoves, rssMB: Math.round(sample.memory.rss / 1e6), elapsedSeconds: Math.round((performance.now() - startTime) / 1000) }));
    }
  }
  const final = await call('stats'); assert.equal(final.sequence, blocks * agents); assert.equal(final.pending, 0); assert.equal(final.observations, 0);
  const distribution = values => { values.sort((a, b) => a - b); return { count: values.length, p50: values[Math.floor(values.length * .5)], p99: values[Math.ceil(values.length * .99) - 1], max: values.at(-1) }; };
  const settled = memory.filter(m => m.block >= 12 && m.block < Math.floor(blocks / 2));
  const late = memory.filter(m => m.block >= Math.floor(blocks / 2) + 12);
  const span = samples => samples.length ? Math.max(...samples.map(s => s.heap)) - Math.min(...samples.map(s => s.heap)) : 0;
  const times = { moves: distribution(latencies.moves), viewers: distribution(latencies.viewers) };
  result = { runtime: process.version, blocks, simulatedHours: blocks / 6, agents, bundledHeadersAndClaims: true, viewers, rooms: 2, pollsPerViewerPerBlock: 20, viewerIntakeOverlap: true,
    puzzleBits: 0, puzzleNote: 'Puzzle search disabled in the accelerated workload; signatures and receipts are verified. The unit suite checks a real 12-bit puzzle.',
    signatureMode: 'disposable single-key committee fixture; actual contract state machine applied to disk-backed storage',
    latencyMilliseconds: times, latencyPass: times.moves.p99 < 1000 && times.viewers.p99 < 1000, cacheHits, acknowledgedMoves: totalMoves, restartAcknowledged,
    noLostMoves: final.sequence === totalMoves && final.pending === 0,
    heapSpanBytes: Math.max(span(settled), span(late)), memory, contractLogicalWrites: final.metrics,
    contractGrowthNote: 'Logical contract writes only; excludes physical trac-peer/MSB overhead. This workload has one pattern find per window.',
    elapsedSeconds: (performance.now() - startTime) / 1000, diskIndexBytes: (await stat(join(directory, 'index.sqlite'))).size, directory };
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await stop(); await writeFile(join(directory, 'stopped.json'), JSON.stringify({ pids, stopped: true })); }
