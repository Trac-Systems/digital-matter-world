import { readFile, writeFile } from 'node:fs/promises';
import { HeaderHistory, verifyHistory } from '../src/headers.js';
import { assert, hash } from '../src/core.js';
const [first, manifest, second] = process.argv.slice(2);
assert(first && manifest, 'usage: verify-headers.mjs HEADERS MANIFEST [SECOND_HEADERS]');
const bytes = await readFile(first), a = new HeaderHistory(bytes), verified = verifyHistory(a);
const report = { format: 'bitcoin-mainnet-80-byte-headers-v1', ...verified, bytes: bytes.length, sha256: hash(bytes),
  tipHeight: a.length - 1, tipHash: a.get(a.length - 1).hash,
  checks: ['genesis', 'previous-hash', 'proof-of-work', 'difficulty-retarget', 'median-time-past'], independentTipCrossCheck: 'pending' };
if (second) {
  const b = new HeaderHistory(await readFile(second)); report.independent = verifyHistory(b);
  const count = Math.min(a.length, b.length);
  for (let i = 0; i < count * 80; i++) assert(a.bytes[i] === b.bytes[i], `source_mismatch_byte:${i}`);
  report.crossCheckedCount = count; report.fullCrossCheck = a.length === b.length; report.checks.push('byte-equality-on-overlap');
}
await writeFile(manifest, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
