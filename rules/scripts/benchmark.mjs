import { discoverFixture } from './discover-fixture.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { loadHeaders } from './headers-io.mjs';
import { analyzePattern, markMainnetPatterns, sameCounts } from '../src/index.js';
const [path, snapshot, output] = process.argv.slice(2);
if (!path || !snapshot || !output) throw new Error('usage: benchmark.mjs HEADERS ELEMENTS OUTPUT');
const history = await loadHeaders(path), elements = JSON.parse(await readFile(snapshot, 'utf8')).result;
const patterns = discoverFixture(history);
const oneStart = performance.now(); const one = analyzePattern(patterns[6], history); const oneMs = performance.now() - oneStart;
const start = performance.now(), analyzed = [], table = [];
for (const p of markMainnetPatterns(patterns, elements)) {
  const result = analyzePattern(p, history), duplicate = analyzed.find(a => sameCounts(a.counts, result.counts));
  table.push({ ...p, rarity: result.rarity, total: result.total, tier: result.tier, fingerprint: result.fingerprint,
    historyHeight: history.length - 1, minHistoryPass: result.rarity >= 12, duplicateOf: duplicate?.number ?? null });
  analyzed.push({ number: p.number, counts: result.counts });
}
const report = { runtime: process.version, headers: history.length, historyHash: history.get(history.length - 1).hash,
  singlePattern: { pat: patterns[6].pat, rarity: one.rarity, milliseconds: oneMs },
  wholeTableMilliseconds: performance.now() - start, patterns: table };
await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ ...report, patterns: table.length }));
