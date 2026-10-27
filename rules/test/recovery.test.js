import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../src/index.js';
import { observationFixture, hashAt, owner } from './observation-fixture.mjs';
const claim = { window: 100, plots: [{ block: 100, patterns: [0] }] };

test('50 stalled Bitcoin observations then catch-up retain one window and one credit', () => {
  const f = observationFixture(); f.add(100, 95, { moves: [claim] });
  for (let i = 0; i < 50; i++) assert.equal(f.add(100, 95).state.rounds.filter(r => r.window === 100).length, 1);
  for (let h = 101; h <= 150; h++) f.add(h);
  const built = f.build(); assert.equal(built.batch.from, 95); assert.equal(built.batch.to, 145);
  assert.equal(built.fileBytes.length, 101); assert.equal(built.batch.ops.filter(o => o.op === 'ac').length, 1);
  assert.equal(rules.recordGet(f.state.balances, owner).p0, '3'); assert.equal(built.batch.ops.filter(o => o.op === 'kv').length, 2);
});
test('counted clock can stall for 50 advancing tips and catch up in one observation', () => {
  const f = observationFixture(); f.add(100, 95, { moves: [claim] });
  for (let tip = 101; tip <= 150; tip++) f.add(tip, 95);
  assert.equal(rules.recordGet(f.state.balances, owner), undefined);
  f.add(150, 145); const b = f.build(); assert.equal(b.batch.to, 145); assert.equal(rules.recordGet(f.state.balances, owner).p0, '3');
});
test('committee offline for 100 blocks recovers with one bounded batch and all receipt commitments', () => {
  const f = observationFixture();
  for (let tip = 100; tip < 200; tip++) f.add(tip, tip - 5, { moves: tip === 100 ? [claim] : [] });
  const b = f.build(); assert.equal(b.batch.to - b.batch.from + 1, 100);
  assert.equal(b.batch.ops.length, 3); assert.ok(b.fileBytes.every(b => b.length <= 200000));
  assert.ok(Buffer.byteLength(rules.stableJSON({ ...b.batch, sig: '0'.repeat(128) })) < 16384);
  const changed = structuredClone(f.files); changed[50].receiptRoot.root = rules.hash('omitted');
  const other = f.build({ files: changed }); assert.notEqual(other.batch.root, b.batch.root);
  assert.notDeepEqual(other.batch.ops, b.batch.ops);
  assert.throws(() => f.build({ files: f.files.filter((_, i) => i !== 50) }), /continuity/);
  assert.throws(() => f.build({ files: [...f.files].reverse() }), /continuity/);
});
for (const depth of [3, 8]) for (const settled of [false, true]) test(`${depth}-deep reorg ${settled ? 'after' : 'before'} settlement preserves finality policy`, () => {
  const f = observationFixture(), oldTip = settled ? 108 : 104;
  for (let tip = 100; tip <= oldTip; tip++) f.add(tip, tip - 5, { moves: tip === 100 ? [claim] : [] });
  const ancestor = oldTip - depth, fork = h => h <= ancestor ? hashAt(h) : rules.hash(`fork-${h}`);
  f.add(oldTip, oldTip - 5, { hashAt: fork });
  for (let tip = oldTip + 1; tip <= oldTip + 9; tip++) f.add(tip, tip - 5, { hashAt: fork });
  assert.equal(rules.recordGet(f.state.balances, owner)?.p0 ?? '0', settled ? '3' : '0');
  const event = f.files.flatMap(f => f.settlements).filter(s => s.window === 100);
  assert.equal(event.length, 1); assert.equal(event[0].void, !settled); f.build();
});
test('stalled-only coverage waits for a new counted height; caps and observation order fail closed', () => {
  const f = observationFixture({ counted: 95 }); f.add(100, 95);
  assert.throws(() => f.build(), /no_progress/); f.add(101, 96);
  assert.throws(() => f.build({ maxObservations: 1 }), /observations/);
  assert.throws(() => f.build({ maxAuditBytes: 1 }), /audit_budget/);
  const files = structuredClone(f.files); files[1].observation += 1;
  assert.throws(() => f.build({ files }), /continuity/);
});
