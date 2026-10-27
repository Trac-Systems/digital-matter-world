import { BUILD as configuredBuildRoot } from '../../local/common.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHook } from 'node:async_hooks';
import { getHeapStatistics, writeHeapSnapshot } from 'node:v8';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { installLocalFetch, jsonRequest } from '../src/http-client.mjs';
import { diskCheck } from '../src/util.mjs';

await diskCheck();
const [mode = 'http', count = '1200', output] = process.argv.slice(2), blocks = Number(count);
assert.ok(['http', 'raw'].includes(mode) && Number.isSafeInteger(blocks) && blocks >= 100 && blocks <= 10000);
const directory = resolve(output ?? `${configuredBuildRoot}/service/memory-${mode}-${Date.now()}`);
assert.ok(directory.startsWith(`${configuredBuildRoot}/`));
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(join(directory, 'pid.json'), JSON.stringify({ pid: process.pid }));
const timers = new Set(), hook = createHook({ init(id, type, trigger, resource) { if (type === 'Timeout' && [30000, 45000].includes(resource._idleTimeout)) timers.add(id); }, destroy(id) { timers.delete(id); } }).enable();
const server = createServer((req, res) => { req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: 'x'.repeat(4096) })); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`, samples = [], started = Date.now();
if (mode === 'http') installLocalFetch();
try {
  for (let block = 0; block <= blocks; block++) {
    if (block % 25 === 0) {
      await turn(); await turn();
      const sample = { block, seconds: (Date.now() - started) / 1000, ...process.memoryUsage(), v8: getHeapStatistics(), timers: timers.size, resources: process.getActiveResourcesInfo() };
      samples.push(sample); console.log(JSON.stringify({ block, rss: sample.rss, heap: sample.heapUsed, timers: sample.timers }));
    }
    if (block === blocks) break;
    await Promise.all(Array.from({ length: 50 }, async () => {
      const value = mode === 'http' ? (await jsonRequest(url)).value : await (await fetch(url)).json();
      assert.equal(value.result.length, 4096);
    }));
    assert.ok(Date.now() - started < 40 * 60 * 1000, 'profile_time_limit');
  }
  const late = samples.filter(s => s.block >= blocks / 2), mean = k => late.reduce((n, s) => n + s[k], 0) / late.length;
  const x = mean('block'), y = mean('rss'), slope = late.reduce((n, s) => n + (s.block - x) * (s.rss - y), 0) / late.reduce((n, s) => n + (s.block - x) ** 2, 0);
  const retainedDeadlines = Math.max(...samples.map(s => s.timers));
  const result = { mode, blocks, requestsPerBlock: 50, elapsedSeconds: (Date.now() - started) / 1000, rssBytesPerBlock: slope, retainedDeadlines, pass: slope < 20000 && retainedDeadlines < 5, samples };
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  // Snapshot after measurements: snapshot generation itself changes RSS.
  writeHeapSnapshot(join(directory, 'final.heapsnapshot'));
  console.log(JSON.stringify({ ...result, samples: undefined }));
  if (!result.pass) process.exitCode = 1;
} finally { hook.disable(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
