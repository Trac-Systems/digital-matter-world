import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReplayProfile, instrumentReplay } from '../scripts/settlement-replay-profile.mjs';

test('phase profiling includes failed units and read waits without changing results or exceptions', () => {
  let time = 0;
  const profile = createReplayProfile(() => time), budget = { reads: 0, bytes: 0 };
  assert.equal(profile.phase('scan', budget, () => {
    time += 2;
    return profile.measure('rpc.claimNode', () => { time += 3; budget.reads++; budget.bytes += 17; return 42; });
  }), 42);
  const failure = Error('closure_budget');
  assert.throws(() => profile.phase('scan', budget, () => { time++; throw failure; }), error => error === failure);
  assert.deepEqual(profile.snapshot(), { workerMs: 6, phases: { scan: { units: 2, ms: 6, reads: 1, bytes: 17,
    operations: { 'rpc.claimNode': { calls: 1, ms: 3 } } } }, operations: { 'rpc.claimNode': { calls: 1, ms: 3 } } });
  profile.reset(); assert.deepEqual(profile.snapshot(), { workerMs: 0, phases: {}, operations: {} });
});
test('benchmark instrumentation matches the worker and closure sources and rejects stale replacements', async () => {
  for (const file of ['rules/src/claim-closure.js', 'committee/signer/replay-worker.mjs', 'service/src/replay-worker.mjs', 'service/src/replay-node-reader.mjs']) {
    const url = new URL('../../' + file, import.meta.url), source = await readFile(url, 'utf8');
    assert.notEqual(instrumentReplay(url.href, source), source);
    assert.throws(() => instrumentReplay(url.href, ''), /benchmark_profile_source/);
  }
  assert.equal(instrumentReplay('unrelated.js', 'source'), 'source');
});

test('SQLite profiling counts returned rows for page and point reads, including absence', () => {
  const profile = createReplayProfile(() => 0), row = { value: 'stored' };
  assert.deepEqual(profile.measure('sqlite.claimNodes', () => [row, row]), [row, row]);
  assert.equal(profile.measure('sqlitePoint.claimNodes', () => row), row);
  assert.equal(profile.measure('sqlitePoint.claimNodes', () => undefined), undefined);
  assert.deepEqual(profile.snapshot().operations, {
    'sqlite.claimNodes': { calls: 1, ms: 0, rows: 2 }, 'sqlitePoint.claimNodes': { calls: 2, ms: 0, rows: 1 }
  });
});
