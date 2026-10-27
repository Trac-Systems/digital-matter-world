import { discoverFixture } from './discover-fixture.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { HeaderHistory, recordObject, processBlock, decodeBinary, moveId, assert, hash } from '../src/index.js';
const [headers, simulation, checkpointText, countText, output] = process.argv.slice(2);
assert(headers && simulation && output, 'usage: replay-audit.mjs HEADERS SIMULATION_JSON CHECKPOINT BLOCKS OUTPUT_JSON');
const { receiptSigners } = JSON.parse(await readFile(simulation, 'utf8'));
const checkpoint = Number(checkpointText), count = Number(countText), start = checkpoint + 6;
const bytes = await readFile(headers), limit = process.env.DMW_HISTORY_LIMIT ? Number(process.env.DMW_HISTORY_LIMIT) : Math.floor(bytes.length / 80);
const history = new HeaderHistory(bytes.subarray(0, limit * 80)), hashAt = h => history.get(h).hash;
const snapshot = { length: checkpoint + 1, get: h => history.get(h), field: (...a) => history.field(...a) };
let patterns = discoverFixture(snapshot);
let state = { lastTip: start - 1, counted: checkpoint }, stopped = false, network = null; const rows = [];
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });
console.log(JSON.stringify({ pid: process.pid, blocks: count }));
for (let i = 0; i < count && !stopped; i++) {
  const height = checkpoint + 1 + i, path = `${simulation}.files/${height}.bin`; let bytes, file;
  for (let attempt = 0; !stopped; attempt++) {
    try { bytes = await readFile(path); file = decodeBinary(bytes); break; } catch (e) {
      if (attempt >= 240) throw e; await new Promise(r => setTimeout(r, 500));
    }
  }
  if (stopped) break;
  network = file.receiptRoot.network;
  const moves = new Map(file.moves.map(({ move }) => [moveId(move), move])), entries = file.receipts.map(receipt => ({ receipt, move: moves.get(receipt.move) }));
  const begin = performance.now();
  const result = processBlock({ height, blockHash: file.hash, tip: file.tip, tipHash: file.tipHash, network: file.receiptRoot.network,
    gateway: file.receiptRoot.gateway, history, patterns, entries, receiptRoot: file.receiptRoot, rootAttestations: file.rootAttestations, state, hashAt,
    confirmed: file.confirmed, mintOperations: file.mintOperations ?? [], linkOperations: file.linkOperations ?? [], settings: { puzzleBits: 0, receiptSigners } });
  const workMs = performance.now() - begin;
  assert(hash(result.auditBytes) === hash(bytes), `audit_mismatch:${height}`);
  state = result.state; patterns = result.patterns; rows.push({ height, workMs, signatureVerifications: file.moves.length + file.receipts.length + 1 + (file.rootAttestations?.length ?? 0), fileBytes: bytes.length, summaryBytes: result.viewerBytes.length });
  if ((i + 1) % 25 === 0) console.log(JSON.stringify({ checked: i + 1, workMs }));
}
const values = rows.map(r => r.workMs).sort((a, b) => a - b);
const report = { blocks: rows.length, complete: rows.length === count, byteIdentical: rows.length, signatureVerifications: rows.reduce((n, row) => n + row.signatureVerifications, 0),
  workMilliseconds: { mean: values.reduce((n, v) => n + v, 0) / values.length, p50: values[Math.floor(values.length / 2)], p99: values[Math.ceil(values.length * .99) - 1], max: values.at(-1) },
  note: 'Final rules replay verifies every move, gateway receipt, receipt-root and witness signature and requires byte-identical canonical audit output.', rows };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
await writeFile(`${simulation}.catalog.json`, JSON.stringify({ network, height: state.counted, finds: recordObject(state.finds), links: {}, minted: {} }));
console.log(JSON.stringify({ ...report, rows: rows.length }));
