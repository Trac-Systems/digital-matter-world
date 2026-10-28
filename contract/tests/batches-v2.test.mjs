import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deployment, signedBatch, alice } from './helpers/harness.mjs';
import { hash } from '../../rules/src/core.js';
test('same-height batches require the pinned activation, branch, independent sequence and predecessor', async () => {
  const checkpoint = deployment.beacon.checkpoint, previous = hash('legacy-head');
  const activation = { sequence: 1, previousRoot: previous, height: checkpoint.height, hash: checkpoint.hash, ruleset: 'sc1', settingsRevision: hash('settings') };
  const options = { ...deployment, batchActivation: activation }, h = harness(options);
  const make = (n, predecessor) => signedBatch({ v: 2, n, from: checkpoint.height, to: checkpoint.height, previous: predecessor, ruleset: activation.ruleset, settingsRevision: activation.settingsRevision,
    execution: { height: checkpoint.height, hash: checkpoint.hash }, observation: n, receipts: hash('receipts/' + n), finds: hash('finds/' + n), catalog: hash('catalog'), accounts: hash('accounts'), root: hash('batch/' + n),
    ops: [{ op: 'ac', to: alice.address, assets: [['p0', '1']] }] }, options);
  for (let n = 1; n <= 200; n++) {
    const batch = make(n, n === 1 ? previous : hash('batch/' + (n - 1)));
    assert.equal(await h.run('bt', batch), null);
    assert.equal(await h.run('bt', batch), 'batch_sequence');
  }
  const bad = make(201, hash('wrong')); assert.equal(await h.run('bt', bad), 'batch_predecessor');
  const correct = make(201, hash('batch/200')); assert.equal(await h.run('bt', correct), null);
  const disabled = harness(deployment); assert.equal(await disabled.run('bt', make(1, previous)), 'batch_activation');
});
