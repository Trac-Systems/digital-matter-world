import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeEvidence } from '../src/node-evidence.mjs';
import { encodeReplayContext } from '../src/replay-context.mjs';
import { EvidenceStore } from '../prod/evidence.mjs';
import { rules } from '../src/rules.mjs';
import { decodeNodeHints } from '../../rules/src/node-evidence.js';

test('supplemental read order is bounded and leaves the original proof bytes unchanged', () => {
  const original = new NodeEvidence(2048), extended = new NodeEvidence(2048, {}, 17);
  for (let i = 0; i < 1000; i++) {
    const id = rules.hash(String(i)), row = { key: String(i), value: 'x'.repeat(100) };
    original.add(id, row); extended.add(id, row); extended.add(id, row);
  }
  assert.deepEqual(extended.value(), original.value());
  assert.ok(Buffer.byteLength(rules.stableJSON(extended.value())) <= 2048);
  const extra = decodeNodeHints(extended.overflowValue()), primary = new Set(decodeNodeHints(extended.value().hints));
  assert.equal(extra.length, 17); assert.equal(new Set(extra).size, 17);
  assert.ok(extra.every(id => !primary.has(id)));
  assert.equal(original.overflowValue(), undefined);
  assert.throws(() => new NodeEvidence(2048, {}, 65537), /node_hint_limit/);
});

test('the reader combines optional hints in order under its existing entry limit', () => {
  const reader = new EvidenceStore({ config: { settings: { nodeHintEntries: 5 } } });
  const ids = Array.from({ length: 8 }, (_, i) => rules.hash(String(i)));
  const packed = Buffer.from(ids.slice(3).join(''), 'hex').toString('base64');
  reader.hintNodes('claimNodes', ids.slice(0, 3), packed);
  assert.deepEqual([...reader.nodeHints.keys()], ids.slice(0, 5).map(id => 'claimNodes/' + id));
  assert.deepEqual(reader.nodeHints.get('claimNodes/' + ids[3]).hints, ids.slice(0, 5));
  reader.nodeHints.clear(); reader.hintNodes('claimNodes', ids.slice(0, 3), '!!!!');
  assert.equal(reader.nodeHints.size, 3);
  assert.throws(() => reader.hintNodes('claimNodes', '!!!!'), /evidence_node_hints/);
});

test('archive packing drops only optional read hints when they exceed the existing limit', () => {
  const base = { state: { counted: '1' }, inputs: [{ receipt: 'retained' }, { deliveryRows: 100 }] };
  const hinted = { ...base, inputs: base.inputs.map(input => ({ ...input, claimReadHints: 'A'.repeat(1000) })) };
  const limit = Buffer.byteLength(JSON.stringify(base));
  assert.equal(encodeReplayContext(hinted, limit), JSON.stringify(base));
  assert.equal(encodeReplayContext(hinted, 10000), JSON.stringify(hinted));
  assert.equal(hinted.inputs[0].claimReadHints.length, 1000, 'packing must leave the source context untouched');
  assert.equal(encodeReplayContext(base, 1), JSON.stringify(base), 'an already oversized original context retains its prior behavior');
});
