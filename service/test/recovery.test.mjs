import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Intake } from '../src/intake.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Outbox } from '../src/transport.mjs';
import { harness, deployment, signedBatch } from '../../contract/tests/helpers/harness.mjs';
import { temp, fixtureHistory, network, secret, patterns, receiptSigners, attestRoot } from './helpers.mjs';

test('50 frozen observations and 100 offline blocks recover without overwriting audits or reserving unavailable signers', async () => {
  const store = await Store.open(await temp('recovery-')), history = fixtureHistory(200), contract = harness({ ...deployment, network });
  const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 }), files = new Files(join(store.directory, 'static'));
  let online = true, signatures = 0;
  const reads = { batchLast: () => contract.state().batchLast(), committeeEpoch: () => contract.state().committeeEpoch(), batchHeaders: async () => [], counted: async () => (await contract.state().head()).counted };
  const committee = { ready: async () => online, attestRoot, signature: async (_key, proposal) => { signatures++; return { signature: { compact: signedBatch(proposal.batch, { ...deployment, network }).sig } }; } };
  const outbox = new Outbox({ store, retryMs: 0, transport: { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => assert.equal(await contract.run(m.op, m.value), null), status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) } });
  const pipeline = new Pipeline({ store, files, history, intake, reads, committee, outbox, patterns, settings: { puzzleBits: 0, receiptSigners } });
  const observe = tip => intake.observe({ tip, hash: history.hashAt(tip), counted: tip - 5, confirmed: tip - 5 });
  const drain = async () => { await pipeline.tick(); await pipeline.tick(); };
  try {
    assert.equal(await contract.run('hd', { headers: Array.from({ length: 6 }, (_, i) => history.raw(i + 1)) }), null);
    await observe(6); await intake.seal(); await drain(); assert.equal((await reads.batchLast()).n, 1);
    const first = store.get('meta', 'latest');
    for (let i = 0; i < 50; i++) { await intake.seal(); await pipeline.tick(); }
    assert.equal(signatures, 1); assert.equal(store.count('observations'), 50);
    assert.equal(await contract.run('hd', { headers: [history.raw(7)] }), null);
    await observe(7); await intake.seal(); await drain();
    assert.equal((await reads.batchLast()).n, 2); assert.equal(store.count('observations'), 0);
    assert.notEqual(first.audit.path, store.get('meta', 'latest').audit.path);
    online = false;
    for (let tip = 8; tip <= 107; tip++) {
      assert.equal(await contract.run('hd', { headers: [history.raw(tip)] }), null); await observe(tip); await pipeline.tick();
    }
    await intake.seal(); assert.equal(signatures, 2); assert.equal(store.get('meta', 'draft'), null);
    online = true; await drain(); assert.deepEqual(await reads.batchLast(), { n: 3, to: 102 });
    assert.equal(store.count('observations'), 0); assert.equal(signatures, 3);
    assert.ok(store.get('batches', '0000000000000003').publications.length >= 100);
  } finally { await pipeline.close(); await store.close(); }
});

test('a preparation every member left unreserved is retired once the execution snapshot moves', async () => {
  const directory = await temp('draft-unprepared-'), store = await Store.open(directory);
  let counted = 10;
  const pipeline = new Pipeline({ store, reads: { batchLast: async () => ({ n: 0, to: 0 }), committeeEpoch: async () => 0, counted: async () => counted, batchRoot: async () => null } });
  try {
    const draft = { version: 3, execution: 10, proposal: { kind: 'batch', batch: { epoch: 0, n: 1, deadline: 16 } } };
    const blocked = { proposal: draft.proposal, stage: 'blocked', reason: 'prepare_incomplete', id: 'ef'.repeat(32), retry: 'same-batch', retryPrepare: true,
      peers: ['operator1', 'operator2', 'operator3'], unreserved: ['operator1', 'operator2'], failures: ['committee_batch_snapshot', 'committee_batch_snapshot'] };
    await store.put('ceremonies', 'batch/0/1', blocked); await pipeline.saveDraft(draft);
    counted = 11;
    assert.deepEqual(await pipeline.reconcileDraft(await pipeline.loadDraft()), { draft, accepted: false }, 'one member may still hold a reservation');
    await store.put('ceremonies', 'batch/0/1', { ...blocked, unreserved: blocked.peers });
    counted = 10;
    assert.deepEqual(await pipeline.reconcileDraft(await pipeline.loadDraft()), { draft, accepted: false }, 'an unchanged snapshot keeps retrying');
    counted = 11;
    assert.deepEqual(await pipeline.reconcileDraft(await pipeline.loadDraft()), { draft: null, accepted: false });
    assert.equal(store.get('meta', 'draft'), null); assert.equal(store.get('ceremonies', 'batch/0/1'), null);
    assert.equal(store.list('supersededDrafts')[0].value.proof.reason, 'execution_snapshot_changed');
  } finally { await pipeline.close(); await store.close(); }
});
test('drafts use one checksummed external representation and retain signing reservations after restart', async () => {
  const directory = await temp('draft-'); let store = await Store.open(directory), pipeline = new Pipeline({ store });
  try {
    const draft = { version: 3, execution: 10, proposal: { kind: 'batch', batch: { epoch: 0, n: 1, deadline: 16 } } };
    const reservation = { proposal: draft.proposal, stage: 'blocked', id: 'cd'.repeat(32) };
    await store.put('ceremonies', 'batch/0/1', reservation); await pipeline.saveDraft(draft);
    await pipeline.close(); await store.close(); store = await Store.open(directory); pipeline = new Pipeline({ store,
      reads: { batchLast: async () => ({ n: 0, to: 0 }), committeeEpoch: async () => 0, counted: async () => 11, batchRoot: async () => null } });
    assert.deepEqual(await pipeline.reconcileDraft(await pipeline.loadDraft()), { draft, accepted: false });
    assert.equal(store.count('supersededDrafts'), 0);
    assert.deepEqual(store.get('ceremonies', 'batch/0/1'), reservation);
    // An inline object is not a durable draft reference and must never be rebuilt.
    await store.put('meta', 'draft', draft);
    await assert.rejects(pipeline.loadDraft(), /draft_reference/);
    assert.deepEqual(store.get('meta', 'draft'), draft);
  } finally { await pipeline.close(); await store.close(); }
});
