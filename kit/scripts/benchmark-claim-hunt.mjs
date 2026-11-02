// Offline only. The archive is opened read-only and is never copied into the repo.
// node kit/scripts/benchmark-claim-hunt.mjs /absolute/headers.bin old|new|sample
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import { HeaderHistory } from '../../rules/src/headers.js';
import { legacyChooseClaims } from '../test/support/legacy-choose-claims.mjs';
import { huntFixture } from '../test/support/hunt-fixture.mjs';
const [path, mode = 'new'] = process.argv.slice(2);
assert.ok(path && ['old', 'new', 'sample'].includes(mode), 'Expected archive path and old|new|sample');
const history = new HeaderHistory(await readFile(path));
const args = huntFixture(history, mode === 'sample' ? 1 : 1151);
console.log(JSON.stringify({ mode, headers: history.length, patterns: args.patterns.length, exhaustedPatterns: Object.keys(args.taken).length }));
const selector = mode === 'new' ? (await import('../strategies/default.mjs')).chooseClaims : legacyChooseClaims;
const server = mode === 'new' ? createServer((_req, res) => res.end('ready')) : undefined;
if (server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
async function measure(label) {
  let last = performance.now(), maxGap = 0, ticks = 0, maxHTTP = 0, requests = 0, pending = false;
  const inFlight = [];
  const timer = setInterval(() => {
    const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++;
    if (!server || pending) return; pending = true;
    inFlight.push(new Promise((resolve, reject) => {
      const start = performance.now();
      get(`http://127.0.0.1:${server.address().port}/`, res => {
        res.resume(); res.on('end', () => { maxHTTP = Math.max(maxHTTP, performance.now() - start); requests++; pending = false; resolve(); });
      }).on('error', reject);
    }));
  }, 5);
  const start = performance.now();
  let plots, ms;
  try { plots = await selector(args); ms = performance.now() - start; await new Promise(resolve => setTimeout(resolve, 10)); }
  finally { clearInterval(timer); }
  await Promise.all(inFlight);
  console.log(JSON.stringify({ label, ms: +ms.toFixed(2), maxGapMs: +maxGap.toFixed(2), ticks,
    ...(server ? { maxHTTPMs: +maxHTTP.toFixed(2), requests } : {}), plots }));
  return plots;
}
try {
  const first = await measure('cold');
  if (mode === 'new') {
    assert.deepEqual(await measure('warm'), first);
    // A fresh HeaderHistory is how the dashboard receives an extended archive.
    const bytes = new Uint8Array(history.bytes.length + 80); bytes.set(history.bytes);
    bytes.set(history.bytes.subarray(-80), history.bytes.length);
    args.history = new HeaderHistory(bytes); args.claimableHeight++; args.window++;
    assert.deepEqual(await measure('one-new-block'), first);
  }
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
}
