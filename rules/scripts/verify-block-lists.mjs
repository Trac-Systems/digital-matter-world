import { readFile, writeFile } from 'node:fs/promises';
import { loadHeaders } from './headers-io.mjs';
import { assert, hash, analyzePattern, readBlockPage, patternAsset } from '../src/index.js';
const [headers, directory, output] = process.argv.slice(2);
assert(headers && directory && output, 'usage: verify-block-lists.mjs HEADERS DIRECTORY OUTPUT_JSON');
const history = await loadHeaders(headers), manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
assert(manifest.height === history.length - 1 && manifest.hash === history.get(history.length - 1).hash, 'manifest_history');
let pages = 0, rows = 0, bytes = 0, maxPageBytes = 0;
console.log(JSON.stringify({ pid: process.pid, patterns: manifest.patterns.length }));
for (const entry of manifest.patterns) {
  const analysis = analyzePattern(entry.pattern, history); let found = 0, previous = -1, next = 0;
  assert(entry.asset === patternAsset(entry.pattern), 'manifest_asset');
  for (const metadata of entry.pages) {
    assert(metadata.from === next && metadata.file === `${entry.asset}/${metadata.from}.bin`, 'manifest_page');
    const encoded = await readFile(`${directory}/${metadata.file}`); assert(hash(encoded) === metadata.hash && encoded.length === metadata.bytes, 'page_hash');
    const page = readBlockPage(encoded); assert(page.from === metadata.from && page.to === metadata.to && page.rows.length === metadata.rows && page.asset === entry.asset, 'page_metadata');
    assert(page.hash === history.get(page.to).hash, 'page_history');
    for (const row of page.rows) { assert(row.block > previous && analysis.counts[row.block] === row.count, 'page_count'); previous = row.block; found++; }
    next = page.to + 1; pages++; rows += page.rows.length; bytes += encoded.length; maxPageBytes = Math.max(maxPageBytes, encoded.length);
  }
  assert(next === history.length && found === analysis.rarity && found === entry.matches, 'page_completeness');
}
const result = { patterns: manifest.patterns.length, pages, matchingRows: rows, binaryBytes: bytes, maxPageBytes, height: manifest.height, hash: manifest.hash, allCountsAndHashesVerified: true };
await writeFile(output, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
