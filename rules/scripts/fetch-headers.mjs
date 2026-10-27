// Explicit read-only HTTP maintenance command. Endpoints are supplied at run time.
import { open, mkdir, readFile, writeFile, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../src/core.js';
import { parseHeader } from '../src/headers.js';
const [mode, output, endText, startText = '0'] = process.argv.slice(2);
assert(['epochs', 'esplora'].includes(mode) && output && /^\d+$/.test(endText), 'usage: fetch-headers.mjs epochs|esplora OUTPUT END [START]');
const base = process.env.DMW_HEADER_SOURCE;
assert(base && new URL(base).protocol === 'https:', 'HTTPS source environment required');
const end = Number(endText), start = Number(startText), path = resolve(output);
const concurrency = Number(process.env.DMW_HEADER_CONCURRENCY ?? (mode === 'epochs' ? 4 : 2));
const delay = Number(process.env.DMW_HEADER_DELAY_MS ?? 500);
assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 6 && Number.isInteger(delay) && delay >= 0, 'fetch_pacing');
const disk = await statfs('/'); assert(BigInt(disk.bavail) * BigInt(disk.bsize) >= 100000000000n, 'disk_below_100GB');
await mkdir(resolve(path, '..'), { recursive: true });
const file = await open(path, 'a+'); await file.close();
const fd = await open(path, 'r+');
const pageSize = mode === 'epochs' ? 2016 : 10;
const firstPage = Math.floor(start / pageSize), lastPage = Math.floor(end / pageSize);
let done;
try { done = new Set(JSON.parse(await readFile(`${path}.${mode}.progress.json`, 'utf8'))); } catch { done = new Set(); }
let next = firstPage, completed = 0, failed = false;
// Re-read the boundary page when extending a previously partial download.
done.delete(firstPage); done.delete(lastPage);
completed = [...done].filter(p => p >= firstPage && p <= lastPage).length;
let progressWrites = Promise.resolve();
function saveProgress() {
  const text = JSON.stringify([...done].sort((a, b) => a - b));
  progressWrites = progressWrites.then(() => writeFile(`${path}.${mode}.progress.json`, text));
  return progressWrites;
}
process.on('SIGINT', () => { failed = true; });
process.on('SIGTERM', () => { failed = true; });
console.log(JSON.stringify({ pid: process.pid, mode, start, end, completed }));
async function get(pathname) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const r = await fetch(`${base.replace(/\/$/, '')}${pathname}`, { signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise(r => setTimeout(r, Math.min(30000, 500 * 2 ** attempt)));
  }
  throw new Error('header_fetch_failed');
}
function encode(row) {
  const raw = Buffer.alloc(80);
  raw.writeUInt32LE(row.version >>> 0, 0);
  Buffer.from(row.previousblockhash ?? row.prev_block ?? '0'.repeat(64), 'hex').reverse().copy(raw, 4);
  Buffer.from(row.merkle_root, 'hex').reverse().copy(raw, 36);
  raw.writeUInt32LE(row.timestamp, 68);
  raw.writeUInt32LE(typeof row.bits === 'string' ? parseInt(row.bits, 16) : row.bits, 72);
  raw.writeUInt32LE(row.nonce, 76);
  assert(parseHeader(raw).hash === (row.id ?? row.hash), 'source_header_hash'); return raw;
}
const ticker = setInterval(() => console.log(JSON.stringify({ completed, total: lastPage - firstPage + 1 })), 30000);
try {
  await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    while (!failed) {
      const page = next++; if (page > lastPage) return; if (done.has(page)) continue;
      try {
        const top = Math.min(end, (page + 1) * pageSize - 1);
        const result = await get(mode === 'epochs' ? `/headers/epoch/${page}.json` : `/blocks/${top}`);
        const rows = mode === 'epochs' ? result.headers : result;
        const wanted = rows.filter(r => r.height >= page * pageSize && r.height <= top);
        assert(wanted.length === top - page * pageSize + 1, 'source_page_incomplete');
        for (const row of wanted) await fd.write(encode(row), 0, 80, row.height * 80);
        done.add(page); completed++;
        if (completed % 20 === 0) await saveProgress();
        if (mode === 'esplora') await new Promise(r => setTimeout(r, delay));
      } catch (e) { failed = true; throw new Error(`page ${page}: ${e.message}`); }
    }
  })).then(results => { const rejected = results.find(r => r.status === 'rejected'); if (rejected) throw rejected.reason; });
} finally {
  clearInterval(ticker); await fd.close();
  await saveProgress();
}
console.log(JSON.stringify({ completed, end }));
