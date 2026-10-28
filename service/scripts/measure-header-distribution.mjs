// Offline input, disposable loopback origin, no credentials or external reads.
// Usage: nice -n 20 node measure-header-distribution.mjs INPUT NEW_DIRECTORY REPORT [CLIENTS=500] [CONCURRENCY=8] [MBPS=100]
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HeaderChunks } from '../src/header-chunks.mjs';
import { HeaderFiles } from '../src/header-files.mjs';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { History } from '../src/history.mjs';
import { LocalHeaders, localHeaderHandler } from '../src/local-headers.mjs';
import { hash } from '../src/util.mjs';
import { BitcoinViews } from '../prod/bitcoin.mjs';
import { headerManifestSigner, manifestTrust, verifyHeaderManifest } from '../../kit/lib/header-manifest.mjs';
import { loadHistoryAsync, historyProof, downloadHeaders, headerSource } from '../../kit/lib/headers.mjs';

const [input, scratch, reportFile, clientsArg = '500', concurrencyArg = '8', mbpsArg = '100'] = process.argv.slice(2);
assert.ok(input && scratch && reportFile, 'input, fresh scratch directory and report required');
const root = resolve(scratch), clients = Number(clientsArg), concurrency = Number(concurrencyArg), mbps = Number(mbpsArg);
assert.ok(clients > 0 && Number.isSafeInteger(clients) && concurrency > 0 && Number.isSafeInteger(concurrency) && mbps > 0);
await mkdir(root, { mode: 0o700 });
let store, local, server;
const result = { input: 'retained public mainnet headers', clients, concurrency, sampleCapMbps: mbps, sourceRequests: 0, samples: [] };
const started = performance.now();
try {
  const verified = await loadHistoryAsync(input), proof = historyProof(verified);
  result.chain = proof; result.initialIndependentVerificationMs = performance.now() - started;
  console.log(JSON.stringify({ phase: 'verified-input', count: proof.count, ms: result.initialIndependentVerificationMs }));
  store = await Store.open(join(root, 'gateway'));
  const history = new History(store), importStart = performance.now();
  for (let h = 0; h < verified.length; h += 2048)
    await history.appendMany(h, Array.from({ length: Math.min(2048, verified.length - h) }, (_, i) => Buffer.from(verified.raw(h + i)).toString('hex')));
  result.gatewayImportMs = performance.now() - importStart;
  const secret = randomBytes(32), signer = headerManifestSigner(secret), trust = manifestTrust(signer.key);
  const files = new Files(join(root, 'static')), chunks = new HeaderChunks({ store, files, history, network: 'mainnet', secret, settings: { chunksPerTick: 32 } });
  const generationStart = performance.now();
  do { await chunks.tick(); } while (chunks.manifest().count !== verified.length);
  result.chunkGenerationMs = performance.now() - generationStart;
  // Generate today's v1 gzip/raw representations from the same verified bytes.
  const legacy = new HeaderFiles({ history, files, network: 'mainnet' });
  const legacyStart = performance.now(), legacyManifest = await legacy.manifest(); result.legacyGenerationMs = performance.now() - legacyStart;
  const manifestFile = join(root, 'seed.json'); await writeFile(manifestFile, JSON.stringify(chunks.manifest()), { mode: 0o600 });
  // Use six actual independent stores. Completed verification is per reader;
  // restart inspects only its checkpoint and the signed root, never seed bytes.
  result.readerRestarts = [];
  for (const role of ['gateway', 'operator1', 'operator2', 'operator3', 'operator4', 'operator5']) {
    const filename = join(root, role + '.sqlite'), options = { manifestFile, directory: files.directory, trust };
    let views = new BitcoinViews({ network: 'mainnet' }, filename);
    const initial = performance.now(); await views.seedChunks(options); const initialMs = performance.now() - initial;
    views.close(); views = new BitcoinViews({ network: 'mainnet' }, filename);
    const restart = performance.now(); await views.seedChunks(options);
    result.readerRestarts.push({ role, initialMs, restartMs: performance.now() - restart, ...views.seedWork }); views.close();
    assert.equal(result.readerRestarts.at(-1).bytes, 0);
    // Only this task's closed database, not the immutable seed or another reader.
    for (const suffix of ['', '-wal', '-shm']) await rm(filename + suffix, { force: true });
    console.log(JSON.stringify({ phase: 'reader-restart', ...result.readerRestarts.at(-1) }));
  }
  local = new LocalHeaders(join(root, 'gateway/index.sqlite')); const localHandler = localHeaderHandler(local);
  const origin = { requests: 0, bodyBytes: 0 };
  server = createServer((req, res) => {
    origin.requests++; const write = res.write.bind(res), end = res.end.bind(res);
    res.write = (chunk, ...args) => { if (chunk) origin.bodyBytes += Buffer.byteLength(chunk); return write(chunk, ...args); };
    res.end = (chunk, ...args) => { if (chunk) origin.bodyBytes += Buffer.byteLength(chunk); return end(chunk, ...args); };
    const handler = req.url.startsWith('/legacy/') ? (req.url = req.url.slice(7), legacy) : chunks;
    handler.serve(req, res).then(ok => { if (!ok) localHandler(req, res); }).catch(() => res.writeHead(503).end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  const independent = { hash: async h => verified.get(h).hash };
  for (const mode of ['legacy-raw', 'legacy-gzip', 'signed-chunks']) {
    const before = { ...origin }, begun = performance.now(), output = join(root, mode + '.bin');
    const source = headerSource(url, { fetchImpl: async (target, options) => {
      const route = new URL(target).pathname;
      const response = await fetch(mode.startsWith('legacy') && route.startsWith('/headers/') ? url + '/legacy' + route : target, options);
      if (!route.endsWith('.bin') && !route.endsWith('.gz')) return response;
      const reader = response.body.getReader();
      return new Response(new ReadableStream({ async pull(controller) {
        const { value, done } = await reader.read(); if (done) { controller.close(); return; }
        await sleep(value.length * 8 / (mbps * 1000)); controller.enqueue(value);
      }, cancel: reason => reader.cancel(reason) }), { status: response.status, headers: response.headers });
    } });
    const downloaded = await downloadHeaders({ output, source, independent, network: 'mainnet', manifestTrust: trust, preferGzip: mode !== 'legacy-raw' });
    assert.equal(downloaded.tip, proof.tip); assert.equal(hash(await readFile(output)), proof.sha256);
    const sample = { mode, elapsedMs: performance.now() - begun, originBodyBytes: origin.bodyBytes - before.bodyBytes,
      requests: origin.requests - before.requests, payloadBytes: downloaded.downloadedBytes, verifiedCount: downloaded.count, independentTipChecked: downloaded.independentTipChecked };
    result.samples.push(sample); console.log(JSON.stringify({ phase: 'cold-kit', ...sample }));
    for (const suffix of ['', '.json', '.manifest.json', '.chunks-v2']) await rm(output + suffix, { force: true, recursive: true });
  }
  // Controlled transport fanout: 500 distinct cold clients authenticate the
  // manifest and hash every downloaded node/chunk. They do not each reexecute
  // Bitcoin consensus; the full fresh-kit samples above do. No byte cap here.
  const signed = chunks.manifest(), refs = [], stack = [signed.root];
  while (stack.length) {
    const ref = stack.pop(), node = JSON.parse(await readFile(files.path(ref.path.slice(1)))); refs.push(ref);
    if (node.children) stack.push(...node.children); else refs.push(node.gzip);
  }
  const manifestBytes = Buffer.byteLength(JSON.stringify(signed)), perClient = manifestBytes + refs.reduce((n, r) => n + r.bytes, 0);
  const before = { ...origin }, loadStarted = performance.now(), latencies = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, clients) }, async () => {
    while (next < clients) {
      const id = next++, start = performance.now(), m = await (await fetch(url + '/headers/manifest.json')).json(); verifyHeaderManifest(m, trust);
      for (const ref of refs) {
        const response = await fetch(url + ref.path), digest = createHash('sha256'); let bytes = 0;
        assert.equal(response.status, 200);
        for await (const chunk of response.body) { digest.update(chunk); bytes += chunk.length; }
        assert.equal(bytes, ref.bytes); assert.equal(digest.digest('hex'), ref.hash);
      }
      assert.equal(await (await fetch(url + '/api/blocks/tip/height')).text(), String(proof.count - 1));
      assert.equal(await (await fetch(url + '/api/block-height/' + (proof.count - 1))).text(), proof.tip);
      assert.equal(await (await fetch(url + '/api/block/' + proof.tip + '/header')).text(), history.raw(proof.count - 1));
      assert.equal((await (await fetch(url + '/api/blocks/' + (proof.count - 1))).json()).length, Math.min(10, proof.count));
      latencies.push(performance.now() - start);
      if ((id + 1) % 50 === 0) console.log(JSON.stringify({ phase: 'cold-transport', completed: id + 1 }));
    }
  }));
  latencies.sort((a, b) => a - b);
  result.controlledTransport = { clients, concurrency, consensusValidation: 'performed by the three fresh-kit samples, not repeated per transport client',
    elapsedMs: performance.now() - loadStarted, bodyBytes: origin.bodyBytes - before.bodyBytes, requests: origin.requests - before.requests,
    p50Ms: latencies[Math.ceil(clients * .50) - 1], p95Ms: latencies[Math.ceil(clients * .95) - 1], p99Ms: latencies[Math.ceil(clients * .99) - 1],
    headerDistributionBytes: perClient * clients, publicRouteRequests: clients * 4, sourceRequests: 0 };
  result.bandwidthModel = { clients, legacyRawBytes: legacyManifest.bytes * clients, legacyGzipBytes: legacyManifest.gzip.bytes * clients,
    signedChunkBytes: perClient * clients, note: 'Cold mainnet entropy is unchanged. Public mirrors offload origin bytes; immutable chunks save update/retry work, not cold-chain payload.' };
  result.totalMs = performance.now() - started;
  await writeFile(reportFile, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  local?.close(); await store?.close(); await rm(root, { recursive: true, force: true });
}
