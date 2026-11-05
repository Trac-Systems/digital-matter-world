import test from 'node:test';
import assert from 'node:assert/strict';
import { signerRebaseFixture } from './signer-rebase-fixture.mjs';

for (const inputs of [8, 44]) test(`signer prepares ${inputs} deployment inputs across a 430-batch shallow rebase`, { timeout: 420000 }, async t => {
  const f = await signerRebaseFixture(t, { inputs, blockDelayMs: Number(process.env.DMW_TEST_BLOCK_DELAY_MS ?? 0) });
  assert.equal(f.budget.prepareMs, 59204);
  const first = await f.prepare(), second = await f.prepare();
  await f.restart(); const restarted = await f.prepare();
  t.diagnostic(JSON.stringify({ inputs, first, second, restarted }));
  assert.equal(second.proposalHash, first.proposalHash); assert.equal(restarted.digest, first.digest);
  assert.equal(first.counts.acceptedRootReads, 431);
  assert.equal(second.counts.acceptedRootReads ?? 0, 0);
  assert.equal(restarted.counts.acceptedRootReads, 431);
  assert.equal(first.counts['indexer:/block'], 1);
  assert.equal(second.counts['indexer:/block'] ?? 0, 0);
  assert.equal(restarted.counts['indexer:/block'], 1);
  assert.ok(first.ms < f.budget.prepareMs, 'the first preparation fits the existing budget');
  assert.ok(second.ms < f.budget.prepareMs, 'preparation fits the existing budget by the second attempt');
  assert.ok(restarted.ms < f.budget.prepareMs, 'cold proof verification fits the existing budget');
});

test('deployment registration and an expired credit refund prepare together after rebase', { timeout: 120000 }, async t => {
  const f = await signerRebaseFixture(t, { inputs: 44, mixed: true });
  const result = await f.prepare();
  assert.equal(f.financial.inputs.length, 44);
  assert.equal(f.financial.inputs.at(-1).transition.type, 'refund');
  assert.ok(f.financial.inputs.at(-1).operations.some(op => op.op === 'ar' && op.actions.some(a => a.type === 'refund')));
  assert.equal(result.counts.acceptedRootReads, 431);
  assert.equal(result.counts['indexer:/block'], 1);
  assert.ok(result.ms < f.budget.prepareMs);
  t.diagnostic(JSON.stringify({ mixed: true, ...result }));
});
