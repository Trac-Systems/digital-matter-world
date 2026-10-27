import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Hypercore from 'hypercore';
import Hyperbee from 'hyperbee';
import { ed25519 } from '@noble/curves/ed25519';
import * as r from '../../rules/src/index.js';
import { attest, receiptSigners } from '../../rules/test/witness-fixture.mjs';
import { harness, person, signedBatch, deployment, invariants } from '../tests/helpers/harness.mjs';
import { BitcoinBeacon as ResetBeacon } from '../tests/helpers/reset-beacon.js';
import { beaconOptions, chain, addr } from '../tests/helpers/chain.mjs';
const bytes = v => Buffer.byteLength(JSON.stringify(v));
// Standalone real Hyperbee view-log bytes: excludes peer/runtime bookkeeping,
// replication, input/system logs, filesystem indexes, signatures and WAL costs.
async function viewLogBytes(before, writes) {
  const directory = await mkdtemp(join(tmpdir(), 'dmw-history-view-'));
  const core = new Hypercore(directory), view = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' });
  try {
    await view.ready();
    let batch = view.batch(); for (const [key, value] of before) await batch.put(key, value); await batch.flush();
    const initial = core.byteLength;
    batch = view.batch(); for (const [key, value] of writes) { if (value === undefined) await batch.del(key); else await batch.put(key, value); } await batch.flush();
    return core.byteLength - initial;
  } finally { await view.close(); await core.close(); await rm(directory, { recursive: true, force: true }); }
}
const agents = Array.from({ length: 500 }, (_, i) => person(i + 100));
const gatewaySecret = r.hashBytes('history-measurement-gateway'), gateway = r.bytesToHex(ed25519.getPublicKey(gatewaySecret));
const network = deployment.network, window = 2220, budget = 4;
const hashAt = h => r.hash(String(h));
const history = { length: window + 20, get: height => ({ height, nonce: height, bits: 1, hash: hashAt(height) }), field: h => String(h) };
const reset = new ResetBeacon(beaconOptions), headers = chain(2201);
for (let i = 0; i < headers.length - 1; i += 20) assert.equal(reset.ingest(headers.slice(i, Math.min(i + 20, headers.length - 1)), addr(1)).error, undefined);
const resetBefore = reset.exportState({ compact: true });
assert.equal(reset.ingest(headers.slice(-1), addr(1)).error, undefined);
const resetAfter = reset.exportState({ compact: true });
const resetBytes = Buffer.byteLength('beacon/state') + bytes(resetAfter);
const resetViewLogBytes = await viewLogBytes([['beacon/state', resetBefore]], [['beacon/state', resetAfter]]);
const results = [];
for (const distinctAssets of [1, budget]) {
  const h = harness(); await h.advance(6);
  for (let i = 0; i < 500; i += 100) {
    if (i) await h.advance(1);
    assert.equal(await h.batch(agents.slice(i, i + 100).map(a => ({ op: 'ac', to: a.address, assets: [['p0', '1']] }))), null);
  }
  const last = await h.state().batchLast();
  const table = Array.from({ length: distinctAssets }, (_, number) => ({ number, name: 'dmwload' + number, pat: '[0-9]', fld: 4, dt: 'n', rarity: 2000, historyHeight: 2000 }));
  let state = { lastTip: window - 1, counted: last.to }, sequence = 0, processingMs = 0;
  const files = [];
  for (let tip = window; tip <= window + 8; tip++) {
    const entries = tip === window ? agents.map((agent, i) => {
      const plots = Array.from({ length: budget }, (_, j) => ({ block: 10 + i * budget + j, patterns: [j % distinctAssets] }));
      const move = r.solveMove({ v: 1, network, a: agent.address, t: 'claim', b: tip, h: hashAt(tip), p: { window, plots } }, agent.secret, 0);
      return { move, receipt: r.signReceipt(move, { tip, hash: hashAt(tip), sequence: sequence++ }, gatewaySecret) };
    }) : [];
    const receiptRoot = r.sealReceipts(entries.map(e => e.receipt), { network, tip, hash: hashAt(tip) }, gatewaySecret);
    const started = performance.now();
    const result = r.processBlock({ height: tip, blockHash: hashAt(tip), tip, tipHash: hashAt(tip), network, gateway,
      history, patterns: table, entries, receiptRoot, rootAttestations: attest(receiptRoot), state, hashAt,
      priorOperations: r.budgetOperations(files), settings: { puzzleBits: 0, receiptSigners } });
    processingMs += performance.now() - started; state = result.state; files.push(result.file);
  }
  assert.equal(r.recordSize(state.finds), 500 * budget);
  const built = r.buildBatch({ network, epoch: 0, sequence: last.n + 1, lastTo: last.to, files, executionHeight: state.counted });
  await h.advance(state.counted - (await h.state().head()).counted);
  const batch = signedBatch(built.batch), beforeKeys = h.db.size, viewBefore = new Map(h.db), transition = h.state();
  assert.equal(await transition.transaction('bt', batch, agents[0].address), null);
  const contractViewLogBytes = await viewLogBytes(viewBefore, transition.writes);
  const before = { ...h.metrics };
  assert.equal(await h.run('bt', batch), null); invariants(h.db, 0, h.supply);
  const writes = Object.fromEntries(Object.keys(before).map(k => [k, h.metrics[k] - before[k]]));
  results.push({ agents: 500, claimsPerAgent: budget, finds: r.recordSize(state.finds), distinctAssetsPerAgent: distinctAssets,
    aggregateCreditOps: batch.ops.filter(o => o.op === 'ac').length, assetTouches: batch.ops.filter(o => o.op === 'ac').reduce((n, o) => n + o.assets.length, 0),
    signedBatchBytes: bytes(batch), envelopeBytes: bytes({ network, op: 'bt', value: batch }), contractWrites: writes, contractViewLogBytes, resetViewLogRatio: contractViewLogBytes / resetViewLogBytes,
    newViewKeys: h.db.size - beforeKeys, totalAuditBytes: built.fileBytes.reduce((n, b) => n + b.length, 0),
    maxFileBytes: Math.max(...built.fileBytes.map(b => b.length)), maxSummaryBytes: Math.max(...files.map(f => r.summaryBytes(f).length)),
    processingMs: Math.round(processingMs), resetLogicalWriteRatio: writes.bytes / resetBytes });
}
const result = { method: '500 registered synthetic agents, four historical claims each, real move/receipt/witness verification; puzzle search disabled. Contract bytes count UTF8 key + JSON value per put, key per delete. Wire bytes are signed JSON/envelope. RESET comparison counts its retained-window state rewrite using the same logical encoding. Physical view bytes are a separate local Hyperbee core.byteLength delta after applying the real buffered transition writes, excluding all peer/runtime, input/system logs, replication and filesystem overhead. RESET uses the same Hyperbee encoding for one successive retained-window rewrite. Neither number is total peer-log or disk growth.',
  resetPerHeaderLogicalBytes: resetBytes, resetViewLogBytes, defaults: { claimsPerWindow: r.CLAIM_DEFAULTS.claimsPerWindow, batchBytes: 98304, batchOps: 512, batchAssets: 4096 }, results };
const output = process.argv[2] ?? 'measurements-open-history.json';
await writeFile(output, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
