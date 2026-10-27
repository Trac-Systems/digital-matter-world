import { discoverFixture } from './discover-fixture.mjs';
import { attest, receiptSigners } from '../test/witness-fixture.mjs';
import { recordObject, recordSize } from '../src/index.js';
import { readFile, writeFile, mkdir, open, statfs } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { assert, hashBytes, bytesToHex, stableJSON, CLAIM_DEFAULTS,
  slotsFor, solveMove, processBlock, buildBatch, HeaderHistory, verifyHistory, signReceipt, sealReceipts, decodeBinary } from '../src/index.js';
const [path, output, countText = '1000'] = process.argv.slice(2);
assert(path && output, 'usage: simulate.mjs HEADERS OUTPUT [BLOCKS]');
const disk = await statfs('/'); assert(BigInt(disk.bavail) * BigInt(disk.bsize) >= 100000000000n, 'disk_below_100GB');
let bytes = await readFile(path);
if (process.env.DMW_HISTORY_LIMIT) bytes = bytes.subarray(0, Number(process.env.DMW_HISTORY_LIMIT) * 80);
const history = new HeaderHistory(bytes), verified = verifyHistory(history), count = Number(countText);
assert(Number.isInteger(count) && count > 0 && count <= 10000, 'simulation_count');
const checkpoint = Math.floor((history.length - count - 12) / 2016) * 2016, start = checkpoint + 6;
const snapshot = { length: checkpoint + 1, field: (...a) => history.field(...a), get: h => history.get(h) };
const patterns = discoverFixture(snapshot);
const agents = Array.from({ length: 500 }, (_, i) => { const secret = hashBytes(`dmw-simulation-agent-${i}`); return { secret, address: bytesToHex(ed25519.getPublicKey(secret)) }; });
const committeeSecret = hashBytes('dmw-simulation-committee'), gatewaySecret = hashBytes('dmw-simulation-gateway'), gateway = bytesToHex(ed25519.getPublicKey(gatewaySecret)), network = 'dmw-local-simulation';
let state = { lastTip: start - 1, counted: checkpoint }, sequence = 0, results = [], maxAudit = 0, completed = 0, stopped = false;
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });
await mkdir(`${output}.files`, { recursive: true });
const batches = await open(`${output}.batches.jsonl`, 'w');
console.log(JSON.stringify({ pid: process.pid, start, countedStart: start - 5, blocks: count, agents: agents.length, fixtureTip: verified.tipHeight }));
const hashAt = h => history.get(h).hash;
try {
  for (let offset = 0; offset < count && !stopped; offset++) {
    const tip = start + offset, height = tip - 5, tipHash = hashAt(tip), blockHash = hashAt(height), prepareStart = performance.now();
    const entries = [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i], block = (offset * agents.length + i) % (height + 1);
      const slots = slotsFor(history.get(block), patterns);
      const plots = slots.length ? [{ block, patterns: slots.slice(0, CLAIM_DEFAULTS.claimsPerWindow).map(s => s.pattern).sort((a, b) => a - b) }] : [];
      const common = { v: 1, network, a: a.address, b: tip, h: tipHash };
      const header = { height: tip, raw: bytesToHex(history.raw(tip)) };
      const move = solveMove({ ...common, t: plots.length ? 'claim' : 'header', p: plots.length ? { window: tip, plots, header } : header }, a.secret, 0);
      const receipt = signReceipt(move, { tip, hash: tipHash, sequence: sequence++ }, gatewaySecret); entries.push({ move, receipt });
    }
    const receiptRoot = sealReceipts(entries.map(e => e.receipt), { network, tip, hash: tipHash }, gatewaySecret);
    const prepareMs = performance.now() - prepareStart, workStart = performance.now();
    const processed = processBlock({ height, blockHash, tip, tipHash, network, gateway, history, patterns, entries, receiptRoot, rootAttestations: attest(receiptRoot), state, hashAt, settings: { puzzleBits: 0, receiptSigners } });
    const headerHeights = offset === 0 ? Array.from({ length: 6 }, (_, i) => checkpoint + 1 + i) : [tip];
    const built = buildBatch({ network, executionHeight: height, epoch: 0, sequence: offset + 1, lastTo: height - 1, files: [processed.file], headers: headerHeights.map(h => bytesToHex(history.raw(h))) });
    assert(built.fileBytes[0].length === processed.auditBytes.length, 'audit_size');
    if (offset === 0) assert(stableJSON(decodeBinary(processed.auditBytes)) === stableJSON(processed.file), 'audit_roundtrip');
    const workMs = performance.now() - workStart;
    const sig = secp256k1.sign(built.signingDigest, committeeSecret, { lowS: true, prehash: false }).toCompactHex(), batch = { ...built.batch, sig };
    const row = { height, tip, moves: entries.length, finds: processed.file.settlements.reduce((n, s) => n + s.winners.length, 0), prepareMs, workMs,
      fileBytes: processed.auditBytes.length, summaryBytes: processed.viewerBytes.length, operationBytes: Buffer.byteLength(stableJSON(processed.operations)),
      batchBytes: Buffer.byteLength(stableJSON(batch)), envelopeBytes: Buffer.byteLength(stableJSON({ network, op: 'bt', value: batch })) };
    results.push(row); state = processed.state; completed++;
    await batches.write(stableJSON(batch) + '\n'); await writeFile(`${output}.files/${height}.bin`, processed.auditBytes);
    await writeFile(`${output}.files/${height}.json`, processed.viewerBytes);
    if (row.fileBytes > maxAudit) { maxAudit = row.fileBytes; await writeFile(`${output}.sample.bin`, processed.auditBytes); await writeFile(`${output}.sample.json`, processed.viewerBytes); }
    if (completed % 25 === 0) { await writeFile(`${output}.progress.json`, JSON.stringify({ completed, results })); console.log(JSON.stringify({ completed, workMs, fileBytes: row.fileBytes, batchBytes: row.batchBytes })); }
  }
} finally { await batches.close(); }
function distribution(key) { const values = results.map(r => r[key]).sort((a, b) => a - b); return { mean: values.reduce((a, b) => a + b, 0) / values.length, p50: values[Math.floor(values.length / 2)], p99: values[Math.min(values.length - 1, Math.ceil(values.length * 99 / 100) - 1)], max: values.at(-1) }; }
const report = { runtime: process.version, network, gateway, receiptSigners, agents: 500, checkpoint, start: start - 5, end: start - 6 + completed,
  tipStart: start, tipEnd: start - 1 + completed, blocks: completed, requestedBlocks: count, complete: completed === count, patternCount: patterns.length,
  fixtureTip: history.length - 1, fixtureTipHash: hashAt(history.length - 1), puzzleBits: 0,
  puzzleNote: 'Synthetic inputs skip puzzle search; every move, receipt and receipt root is really signed and verified. Each agent bundles all plot claims and its header in one signed move.',
  workMilliseconds: distribution('workMs'), prepareMilliseconds: distribution('prepareMs'), fileBytes: distribution('fileBytes'), summaryBytes: distribution('summaryBytes'),
  operationBytes: distribution('operationBytes'), batchBytes: distribution('batchBytes'), envelopeBytes: distribution('envelopeBytes'),
  auditBudgetPass: distribution('fileBytes').max <= 1500000, summaryBudgetPass: distribution('summaryBytes').max <= 1000000,
  totalFinds: recordSize(state.finds), contractMeasurement: 'Signed batch and command envelope wire bytes only. Physical peer log growth must be measured by replay on a peer.', results };
await writeFile(`${output}.catalog.json`, JSON.stringify({ network, height: state.counted, finds: recordObject(state.finds), links: {}, minted: {} }));
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: results.length }));
