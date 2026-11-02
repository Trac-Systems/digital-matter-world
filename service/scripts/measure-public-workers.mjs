import { request, Agent } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import assert from 'node:assert/strict';
import { publicWorkerFixture } from '../test/public-worker-fixture.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { serve } from '../src/http.mjs';

// Local fixture only: accepts no target URL and never contacts a live gateway.
export const LOAD_DEFAULTS = Object.freeze({ requests: 200, rows: 2000, threads: 4, window: 100, resolutionMs: 1 });
function get(url, agent) {
  return new Promise((resolve, reject) => {
    request(url, { agent }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag, bytes: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject).end();
  });
}
async function measure(server, paths, resolutionMs) {
  const agent = new Agent({ keepAlive: true, maxSockets: paths.length });
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  try {
    await get(server.url + '/patterns?limit=1', agent);
    histogram.enable(); await delay(25); histogram.reset();
    const start = performance.now();
    const responses = await Promise.all(paths.map(path => get(server.url + path, agent)));
    const elapsedMs = performance.now() - start;
    await delay(resolutionMs * 2); histogram.disable();
    const statuses = {}; for (const r of responses) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    return { responses, stats: { elapsedMs, p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6,
      statuses, responseBytes: responses.reduce((n, r) => n + r.bytes.length, 0) } };
  } finally { histogram.disable(); agent.destroy(); }
}
export async function measurePublicReadLoad(overrides = {}) {
  const { baselineRoot, ...input } = overrides, settings = { ...LOAD_DEFAULTS, ...input };
  assert.ok(Object.entries(settings).every(([k, n]) => k in LOAD_DEFAULTS && Number.isSafeInteger(n) && n > 0));
  const f = await publicWorkerFixture({ rows: settings.rows, startServers: false,
    settings: { threads: settings.threads, queuePerWorker: settings.requests } });
  const servers = [];
  try {
    await f.store.put('meta', 'head', { tip: String(Math.max(settings.rows, settings.requests + settings.window)), hash: 'fixture-tip' });
    let baselineServe = serve, baselineAPI = createPublicAPI;
    if (baselineRoot) {
      baselineServe = (await import(pathToFileURL(resolve(baselineRoot, 'service/src/http.mjs')))).serve;
      baselineAPI = (await import(pathToFileURL(resolve(baselineRoot, 'service/src/public-api.mjs')))).createPublicAPI;
    }
    const beforeServer = await baselineServe({ ...f.options, publicAPI: baselineAPI({ views: { store: f.store }, files: f.files }) }); servers.push(beforeServer);
    const afterServer = await serve({ ...f.options, readPool: f.pool }); servers.push(afterServer);
    // Distinct valid windows exercise uncached projection reads, not 200 hits
    // of one warm response. Both paths read exactly the same committed store.
    const paths = Array.from({ length: settings.requests }, (_, i) => `/world?from=${i}&to=${i + settings.window - 1}&limit=${settings.window}`);
    const before = await measure(beforeServer, paths, settings.resolutionMs);
    const after = await measure(afterServer, paths, settings.resolutionMs);
    for (let i = 0; i < paths.length; i++) {
      assert.equal(before.responses[i].status, 200, 'before ' + paths[i]);
      assert.deepEqual(after.responses[i], before.responses[i], paths[i]);
    }
    return { settings, cpus: availableParallelism(), node: process.version, baseline: baselineRoot ? 'base commit source' : 'current in-process handler',
      before: before.stats, after: after.stats, identicalResponses: paths.length };
  } finally { await Promise.all(servers.map(s => s.close())); await f.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const settings = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.+)$/.exec(arg); assert.ok(match, 'expected --setting=value');
    settings[match[1]] = match[1] === 'baselineRoot' ? match[2] : Number(match[2]);
  }
  console.log(JSON.stringify(await measurePublicReadLoad(settings), null, 2));
}
