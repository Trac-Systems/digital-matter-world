import assert from 'node:assert/strict';
import { copyFile, open, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadFileHistory } from '../../service/src/file-history.mjs';
import { parseHeader } from '../../rules/src/headers.js';

export async function laterHeaders(source, directory, { origin = 'https://dmtworld.much.fun', intervalMs = 550, maxHeaders = 400, timeoutMs = 20000 } = {}) {
  assert(intervalMs >= 500 && Number.isSafeInteger(maxHeaders) && maxHeaders > 0);
  await mkdir(directory, { mode: 0o700 });
  const original = loadFileHistory(source), first = original.length, requests = []; let lastRequest = 0;
  const get = async route => {
    await sleep(Math.max(0, intervalMs - (Date.now() - lastRequest))); lastRequest = Date.now();
    requests.push({ route, at: new Date(lastRequest).toISOString() });
    const response = await fetch(origin + route, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    assert(response.ok, 'public_header_http_' + response.status);
    const chunks = []; let size = 0; for await (const chunk of response.body) { size += chunk.length; assert(size <= 65536); chunks.push(chunk); }
    return Buffer.concat(chunks).toString().trim();
  };
  try {
    const tipText = await get('/api/blocks/tip/height'); assert.match(tipText, /^(0|[1-9][0-9]*)$/);
    const tip = Number(tipText); assert(Number.isSafeInteger(tip) && tip >= first + 3 && tip - first < maxHeaders, 'public_tail_range');
    const rows = [];
    for (let end = tip; end >= first; end -= 10) {
      const page = JSON.parse(await get('/api/blocks/' + end)); assert(Array.isArray(page) && page.length === 10);
      for (const [i, row] of page.entries()) { assert.equal(Number(row.height), end - i); assert.match(row.id, /^[0-9a-f]{64}$/); if (end - i >= first) rows.push(row); }
    }
    rows.sort((a, b) => Number(a.height) - Number(b.height));
    for (const row of rows) {
      row.raw = await get('/api/block/' + row.id + '/header'); assert.match(row.raw, /^[0-9a-f]{160}$/); assert.equal(parseHeader(row.raw).hash, row.id);
    }
    const file = join(directory, 'headers.bin'); await copyFile(source, file);
    const fd = await open(file, 'a'); try { for (const row of rows) await fd.writeFile(Buffer.from(row.raw, 'hex')); await fd.sync(); } finally { await fd.close(); }
    const history = loadFileHistory(file);
    try {
      assert.equal(history.hashAt(first - 1), original.proof.tip); assert.equal(history.length, tip + 1); assert.equal(history.proof.tip, rows.at(-1).id);
      // Recheck the sampled canonical endpoint after the complete download.
      assert.equal(await get('/api/block-height/' + tip), history.proof.tip, 'public_tip_changed');
      const result = { source: origin, first, last: tip, count: rows.length, previous: original.proof, verified: history.proof, requests, headers: rows };
      await writeFile(join(directory, 'evidence.json'), JSON.stringify(result, null, 2) + '\n'); return result;
    } finally { history.close(); }
  } finally { original.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await laterHeaders(process.argv[2], process.argv[3]); console.log(JSON.stringify({ first: result.first, last: result.last, count: result.count, verified: result.verified }));
}
