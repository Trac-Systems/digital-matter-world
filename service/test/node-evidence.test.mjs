import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeEvidence } from '../src/node-evidence.mjs';
import { rules } from '../src/rules.mjs';
import { decodeNodeHints } from '../../rules/src/node-evidence.js';

test('bounded proof packing preserves exact read hints while evicting optional rows', () => {
  const limit = 524288, proof = new NodeEvidence(limit), rows = [];
  for (let i = 0; i < 2000; i++) {
    const row = { prefix: rules.hash(String(i)), key: String(i), value: 'x'.repeat(1000) };
    const id = rules.hashObject(['dmw-stored-index-v2', row]); rows.push([id, row]); proof.add(id, row);
  }
  const saved = proof.value();
  assert.deepEqual(decodeNodeHints(saved.hints), rows.map(([id]) => id));
  assert(saved.nodes.length < rows.length && saved.nodes.length > 0);
  assert(Buffer.byteLength(rules.stableJSON(saved)) <= limit);
  const resumed = new NodeEvidence(limit, saved);
  for (const [id, row] of rows) resumed.add(id, row);
  assert.deepEqual(resumed.value().hints, saved.hints);
  assert(Buffer.byteLength(rules.stableJSON(resumed.value())) <= limit);
  for (const budget of [2, 128, 1024]) {
    const small = new NodeEvidence(budget);
    for (const [id, row] of rows) small.add(id, row);
    const value = small.value();
    assert(Buffer.byteLength(rules.stableJSON(value.hints ? value : value.nodes)) <= budget);
  }
});

test('packed hashes cover a large settlement without increasing its proof budget', () => {
  const proof = new NodeEvidence(1500000);
  for (let i = 0; i < 26092; i++) proof.add(rules.hash(String(i)), { value: i });
  const value = proof.value();
  assert.equal(decodeNodeHints(value.hints).length, 26092);
  assert(Buffer.byteLength(rules.stableJSON(value)) <= 1500000);
  for (const bad of ['AA==', '!!!!', 'A'.repeat(42) + 'B=']) assert.throws(() => decodeNodeHints(bad), /node_evidence_hints/);
});
