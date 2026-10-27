import { readFile, writeFile } from 'node:fs/promises';
import { StateTransition } from '../../contract/state.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { HeaderHistory, assert, hashBytes, bytesToHex, stableJSON, targetFromBits } from '../src/index.js';
const [headers, simulation, output] = process.argv.slice(2);
assert(headers && simulation && output, 'usage: replay-contract.mjs HEADERS SIMULATION_JSON OUTPUT_JSON');
const history = new HeaderHistory(await readFile(headers)), report = JSON.parse(await readFile(simulation, 'utf8'));
const cp = history.get(report.checkpoint), owner = bytesToHex(ed25519.getPublicKey(hashBytes('dmw-simulation-agent-0')));
let chainwork = 0n;
for (let h = 0; h <= report.checkpoint; h++) chainwork += (1n << 256n) / (targetFromBits(Number(history.field(h, 11))) + 1n);
const deployment = { network: report.network, admin: owner, committee: bytesToHex(secp256k1.getPublicKey(hashBytes('dmw-simulation-committee'))),
  beacon: { checkpoint: { ...cp, chainwork: chainwork.toString(), times: Array.from({ length: 11 }, (_, i) => history.get(report.checkpoint - 10 + i).time) },
    params: { powLimitBits: 0x1d00ffff, interval: 2016, timespan: 1209600, retarget: true, confirmations: 6, branchDepth: 12 } } };
const db = new Map(), results = [];
const batches = (await readFile(`${simulation}.batches.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
console.log(JSON.stringify({ pid: process.pid, blocks: batches.length }));
for (const batch of batches) {
  const state = new StateTransition(async key => db.get(key) ?? null, deployment);
  const error = await state.transaction('bt', batch, owner); assert(!error, `contract_batch:${batch.n}:${error}`);
  let retainedDelta = 0, writeBytes = 0;
  for (const [key, value] of state.writes) {
    if (db.has(key)) retainedDelta -= Buffer.byteLength(key) + Buffer.byteLength(stableJSON(db.get(key)));
    if (value === undefined) db.delete(key);
    else { const bytes = Buffer.byteLength(key) + Buffer.byteLength(stableJSON(value)); retainedDelta += bytes; writeBytes += bytes; db.set(key, value); }
  }
  results.push({ n: batch.n, height: batch.to, retainedDelta, writeBytes });
  if (batch.n % 100 === 0) console.log(JSON.stringify({ completed: batch.n }));
}
const stats = key => { const a = results.map(r => r[key]).sort((a, b) => a - b); return { mean: a.reduce((n, v) => n + v, 0) / a.length, p99: a[Math.ceil(a.length * .99) - 1], max: a.at(-1) }; };
const measured = { blocks: results.length, accepted: results.length, retainedDelta: stats('retainedDelta'), writeBytes: stats('writeBytes'),
  retainedBytes: [...db].reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(stableJSON(v)), 0),
  note: 'Actual StateTransition applied to an in-memory key/value store. JSON key/value bytes are not physical peer-log bytes.', results };
await writeFile(output, JSON.stringify(measured, null, 2) + '\n'); console.log(JSON.stringify({ ...measured, results: results.length }));
