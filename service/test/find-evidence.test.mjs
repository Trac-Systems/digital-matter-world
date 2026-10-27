import test from 'node:test';
import assert from 'node:assert/strict';
import { auditedFind } from '../src/find-evidence.mjs';

for (const source of ['claim', 'header']) test(`accepted ${source} finder evidence preserves its exact recorded fields`, async () => {
  const winner = { id: 'find', block: 42, pattern: 3, asset: 'p3', count: 7, winner: 'owner', ...(source ? { source } : {}) };
  const hint = { block: 42, pattern: 3, asset: 'p3', count: 7, finder: 'owner', findHeight: 108, window: 100, ...(source ? { source } : {}) };
  const files = [{ height: 108, tip: 113, settlements: [{ window: 100, winners: [winner] }] }];
  const input = { id: 'find', asset: 'p3', block: 42, pattern: { number: 3 }, hint, batch: 1, audits: async () => files };
  assert.deepEqual(await auditedFind(input), hint);
  await assert.rejects(auditedFind({ ...input, hint: { ...hint, source: 'invented' } }), /find_audit_binding/);
});

test('a segmented header award uses its credit segment and its full finder window', async () => {
  const winner = { id: 'find', block: 42, pattern: 3, asset: 'p3', count: 7, winner: 'owner', source: 'header' };
  const hint = { block: 42, pattern: 3, asset: 'p3', count: 7, finder: 'owner', findHeight: 108, window: 100, source: 'header' };
  const files = new Map([
    [1, [{ height: 108, tip: 113, settlements: [{ window: 100, complete: false, winners: [winner] }] }]],
    [2, [{ height: 109, tip: 114, settlements: [{ window: 100, complete: true, winners: [] }] }]]
  ]);
  const calls = [], input = { id: 'find', asset: 'p3', block: 42, pattern: { number: 3 }, hint, batch: 1, audits: async n => { calls.push(n); return files.get(n); } };
  assert.deepEqual(await auditedFind(input), hint); assert.deepEqual(calls, [1]);
  files.get(1)[0].settlements[0].winners = [];
  await assert.rejects(auditedFind(input), /find_audit_missing/);
});
