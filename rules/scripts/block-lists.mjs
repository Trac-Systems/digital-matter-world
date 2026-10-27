import { readFile, writeFile, mkdir, statfs } from 'node:fs/promises';
import { loadHeaders } from './headers-io.mjs';
import { assert, patternBlockPages, patternAsset } from '../src/index.js';
const [headers, output, catalog] = process.argv.slice(2);
assert(headers && output, 'usage: block-lists.mjs HEADERS OUTPUT_DIRECTORY [CATALOG_JSON]');
console.log(JSON.stringify({ pid: process.pid }));
const disk = await statfs('/'); assert(BigInt(disk.bavail) * BigInt(disk.bsize) >= 100000000000n, 'disk_below_100GB');
const history = await loadHeaders(headers), state = catalog ? JSON.parse(await readFile(catalog, 'utf8')) : {};
await mkdir(output, { recursive: true });
const manifest = { v: 1, height: history.length - 1, hash: history.get(history.length - 1).hash, pageSize: 4096, stateSnapshot: catalog ? 'provided' : 'empty', stateNetwork: state.network ?? null, stateHeight: state.height ?? null, patterns: [] };
for (const pattern of (state.patterns ?? [])) {
  const asset = patternAsset(pattern), pages = []; let totalBytes = 0, matches = 0;
  await mkdir(`${output}/${asset}`, { recursive: true });
  for (const page of patternBlockPages({ pattern, history, ...state })) {
    const name = `${asset}/${page.from}.bin`; await writeFile(`${output}/${name}`, page.bytes);
    pages.push({ file: name, from: page.from, to: page.to, rows: page.count, bytes: page.bytes.length, hash: page.hash });
    totalBytes += page.bytes.length; matches += page.count;
  }
  manifest.patterns.push({ asset, pattern, totalBytes, matches, pages });
  console.log(JSON.stringify({ asset, pages: pages.length, matches, totalBytes }));
}
await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
