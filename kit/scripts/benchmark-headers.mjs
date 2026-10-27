// Run under nice -n 20. Disposable, loopback-only, no signer or public source.
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep, setImmediate as yieldIO } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { HeaderHistory, parseHeader, targetFromBits } from '../../rules/src/index.js';
import { Files } from '../../service/src/files.mjs';
import { HeaderFiles } from '../../service/src/header-files.mjs';
import { serve } from '../../service/src/http.mjs';
import { downloadHeaders, headerSource, loadHistoryAsync, historyProof } from '../lib/headers.mjs';

const count = Number(process.argv[2] ?? 970000), mbps = Number(process.argv[3] ?? 20);
const representation = process.argv[4] ?? 'raw';
if (!['raw', 'gzip'].includes(representation)) throw Error('Choose raw or gzip');
if (!Number.isInteger(count) || count < 2 || count > 1000000 || !(mbps > 0)) throw Error('Use 2..1000000 headers and a positive Mbps cap');
const root = await mkdtemp(join(tmpdir(), 'dmw-kit2-benchmark-'));
let http, heartbeat;
try {
  const started = performance.now(), bytes = Buffer.alloc(count * 80), raw = Buffer.alloc(80);
  const genesis = Buffer.from('01000000' + '00'.repeat(32) + '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' + 'dae5494dffff7f2002000000', 'hex');
  genesis.copy(bytes); const first = parseHeader(genesis);
  if (first.hash !== '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206') throw Error('regtest genesis');
  let previous = Buffer.from(first.hash, 'hex').reverse();
  const target = targetFromBits(0x207fffff);
  raw.writeInt32LE(1); raw.writeUInt32LE(0x207fffff, 72);
  for (let h = 1; h < count; h++) {
    previous.copy(raw, 4); raw.writeUInt32LE(h, 36); raw.writeUInt32LE(first.time + h * 600, 68);
    for (let nonce = 0; ; nonce++) {
      raw.writeUInt32LE(nonce, 76);
      const digest = createHash('sha256').update(createHash('sha256').update(raw).digest()).digest();
      if (BigInt('0x' + Buffer.from(digest).reverse().toString('hex')) <= target) { previous = digest; break; }
    }
    raw.copy(bytes, h * 80); if (h % 4096 === 0) await yieldIO();
  }
  const generatedMs = performance.now() - started, history = new HeaderHistory(bytes);
  history.hashAt = h => h >= 0 && h < history.length ? history.get(h).hash : null;
  const files = new Files(join(root, 'static')), headers = new HeaderFiles({ history, files, network: 'regtest' });
  let last = performance.now(), maxEventLoopGapMs = 0;
  heartbeat = setInterval(() => { const now = performance.now(); maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - last); last = now; }, 10);
  const snapshotStart = performance.now(), manifest = await headers.manifest(), snapshotMs = performance.now() - snapshotStart;
  http = await serve({ intake: {}, files, headers });
  const source = headerSource(http.url), rawArchive = source.archive;
  let transfers = 0, transferredBytes = 0, verificationStart, firstByte;
  source.hash = async h => history.hashAt(h);
  source.archive = async (...args) => {
    transfers++;
    const response = await rawArchive(...args), reader = response.body.getReader();
    const body = new ReadableStream({ async pull(controller) {
      const { value, done } = await reader.read();
      if (done) { controller.close(); return; }
      firstByte ??= performance.now(); transferredBytes += value.length;
      await sleep(value.length * 8 / (mbps * 1000)); controller.enqueue(value);
    }, cancel: reason => reader.cancel(reason) });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const output = join(root, 'headers.bin'), transferStart = performance.now();
  const result = await downloadHeaders({ output, source, independent: { hash: async h => history.hashAt(h) }, network: 'regtest', preferGzip: representation === 'gzip',
    onProgress: p => { if (p.phase === 'verifying') verificationStart ??= performance.now(); } });
  const finished = performance.now(), verifyStart = performance.now();
  const verified = await loadHistoryAsync(output, { network: 'regtest' }), verifyMs = performance.now() - verifyStart;
  clearInterval(heartbeat);
  if (historyProof(verified).tip !== manifest.tip) throw Error('benchmark tip mismatch');
  console.log(JSON.stringify({ network: 'synthetic regtest from real regtest genesis', count, bytes: manifest.bytes, generatedMs, snapshotMs, compression: result.compression,
    capMbps: mbps, transfers, transferredBytes, timeToFirstByteMs: firstByte - transferStart, transferAndVerificationMs: finished - transferStart,
    verificationDuringDownloadMs: finished - verificationStart, separateVerificationMs: verifyMs, maxEventLoopGapMs,
    tip: result.tip, independentTipChecked: result.independentTipChecked, independentSource: 'local generated-chain fixture; no public request' }, null, 2));
} finally { clearInterval(heartbeat); await http?.close(); await rm(root, { recursive: true, force: true }); }
