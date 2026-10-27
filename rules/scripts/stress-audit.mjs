import { attest, receiptSigners } from '../test/witness-fixture.mjs';
import { discoverFixture } from './discover-fixture.mjs';
import { writeFile } from 'node:fs/promises';
import { ed25519 } from '@noble/curves/ed25519';
import { loadHeaders } from './headers-io.mjs';
import { assert, hash, hashBytes, bytesToHex, CLAIM_DEFAULTS, slotsFor,
  analyzePattern, solveMove, signReceipt, sealReceipts, processBlock } from '../src/index.js';
const [headers, output] = process.argv.slice(2); assert(headers && output, 'usage: stress-audit.mjs HEADERS OUTPUT_JSON');
const history = await loadHeaders(headers), start = 923334, network = 'dmw-local-stress', gatewaySecret = hashBytes('dmw-stress-gateway');
const gateway = bytesToHex(ed25519.getPublicKey(gatewaySecret)), hashAt = h => history.get(h).hash;
const snapshot = { length: start, field: (...a) => history.field(...a), get: h => history.get(h) };
const patterns = discoverFixture(snapshot);
const agents = Array.from({ length: 500 }, (_, i) => { const secret = hashBytes(`dmw-stress-agent-${i}`); return { secret, address: bytesToHex(ed25519.getPublicKey(secret)) }; });
let state = { lastTip: start - 1, counted: start - 6 }, sequence = 0; const rows = [];
console.log(JSON.stringify({ pid: process.pid, agents: 500, claimsPerAgent: CLAIM_DEFAULTS.claimsPerWindow, blocks: 9 }));
for (let offset = 0; offset < 9; offset++) {
  const tip = start + offset, height = tip - 5, tipHash = hashAt(tip);
  const entries = [];
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i], block = (offset * agents.length + i) % (height + 1), slots = slotsFor(history.get(block), patterns);
    const plots = slots.length ? [{ block, patterns: slots.slice(0, CLAIM_DEFAULTS.claimsPerWindow).map(s => s.pattern).sort((a, b) => a - b) }] : [];
    const move = solveMove({ v: 1, network, a: a.address, t: plots.length ? 'claim' : 'header', b: tip, h: tipHash,
      p: plots.length ? { window: tip, plots, header: { height: tip, raw: bytesToHex(history.raw(tip)) } } : { height: tip, raw: bytesToHex(history.raw(tip)) } }, a.secret, 0);
    entries.push({ move, receipt: signReceipt(move, { tip, hash: tipHash, sequence: sequence++ }, gatewaySecret) });
  }
  const receiptRoot = sealReceipts(entries.map(e => e.receipt), { network, tip, hash: tipHash }, gatewaySecret);
  const result = processBlock({ height, blockHash: hashAt(height), tip, tipHash, network, gateway, history, patterns, entries, receiptRoot, state, hashAt,
    rootAttestations: attest(receiptRoot), settings: { puzzleBits: 0, receiptSigners } }); state = result.state;
  const row = { height, auditBytes: result.auditBytes.length, summaryBytes: result.viewerBytes.length, finds: result.file.settlements.reduce((n, s) => n + s.winners.length, 0) };
  assert(result.file.moves.every(m => m.reason === 'accepted'), 'stress_moves'); rows.push(row);
  if (offset === 8) await writeFile(`${output}.sample.bin`, result.auditBytes);
}
const report = { agents: 500, blocks: rows.length, maxAuditBytes: Math.max(...rows.map(r => r.auditBytes)), maxSummaryBytes: Math.max(...rows.map(r => r.summaryBytes)), maxFinds: Math.max(...rows.map(r => r.finds)), rows };
await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
