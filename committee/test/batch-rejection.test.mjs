import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentTipFixture } from '../../service/test/payment-batch-tip-fixture.mjs';
import { financialRetirementTarget, verifyBatchRejection, rejectionGuard } from '../signer/batch-retirement.mjs';
import { Journal } from '../signer/journal.mjs';
import { rules } from '../signer/adapter.mjs';
import { join } from 'node:path';

async function certificate(f, voters = [1, 2, 3]) {
  const votes = [];
  for (const i of voters) votes.push(await f.signers[i].handle('/reject-stale-batch', { network: f.network, proposal: f.old.proposal }));
  return { target: financialRetirementTarget(f.network, f.old.proposal), votes };
}
const apply = (f, certificate, i) => f.signers[i].handle('/retire-rejected-batch', { network: f.network, proposal: f.old.proposal, certificate });

test('three durable nonparticipants retire a stale financial digest without its deadline', async t => {
  const f = await paymentTipFixture(t), attempt = await f.startRace();
  await assert.rejects(f.signers[0].handle('/reject-stale-batch', { network: f.network, proposal: f.old.proposal }), /batch_retirement_reserved/);
  const proof = await certificate(f);
  assert.equal(verifyBatchRejection(proof, { network: f.network, members: f.members }).digest, f.digest(f.old));
  for (let i = 0; i < 5; i++) assert.equal((await apply(f, proof, i)).status, 'batch-rejected');
  for (let i = 0; i < 5; i++) {
    await f.restartSigner(i);
    await assert.rejects(f.signers[i].handle('/prepare', { proposal: f.old.proposal,
      ceremony: { id: rules.hash('late-' + i), epoch: 1, peers: f.members.slice(0, 3) } }), /batch_digest_rejected/);
  }
  await assert.rejects(f.signers[0].handle('/go', { id: attempt.id }), /ceremony_retired/);
  assert.equal((await f.signers[0].handle('/preparation-state', { id: attempt.id })).reserved, false);
  assert.equal(await f.gatewayReads.counted(), 96);
  assert.ok(96 < f.old.proposal.batch.deadline);
});

test('forged, repeated, wrong-batch and insufficient rejection votes cannot release a reservation', async t => {
  const f = await paymentTipFixture(t); await f.startRace();
  const proof = await certificate(f);
  for (const bad of [
    { ...proof, votes: proof.votes.slice(0, 2) },
    { ...proof, votes: [proof.votes[0], proof.votes[0], proof.votes[1]] },
    { ...proof, target: { ...proof.target, digest: f.digest(f.fresh) } },
    { ...proof, target: { ...proof.target, network: 'other-network' } },
    { ...proof, target: { ...proof.target, epoch: 1 } },
    { ...proof, votes: proof.votes.map((v, i) => i ? v : { ...v, signer: 'unknown' }) },
    { ...proof, votes: proof.votes.map((v, i) => i ? v : { ...v, sig: '00'.repeat(64) }) },
    { ...proof, votes: proof.votes.map((v, i) => i ? v : { ...v, stamp: { ...v.stamp, tip: 100 } }) }
  ]) await assert.rejects(apply(f, bad, 0), /batch_retirement_/);
  assert.equal((await f.records(0)).filter(r => r.type === 'retired-rejected-batch').length, 0);
  await apply(f, proof, 0);
});

test('a wire stamp cannot replace the independent newer snapshot or bind different audit files', async t => {
  const f = await paymentTipFixture(t);
  const proposal = { ...f.old.proposal, stamp: { tip: 9000, tipHash: rules.hash('forged') } };
  await assert.rejects(f.signers[1].handle('/reject-stale-batch', { network: f.network, proposal }), /batch_retirement_snapshot/);
  f.setClock(94, 99);
  await assert.rejects(f.signers[1].handle('/reject-stale-batch', { network: f.network, proposal }), /batch_retirement_snapshot/);
  f.setClock(96, 101);
  await assert.rejects(f.signers[1].handle('/reject-stale-batch', { network: f.network,
    proposal: { ...proposal, files: f.fresh.proposal.files } }), /batch_retirement_proposal/);
  assert.equal((await f.records(1)).filter(r => r.type === 'reserve').length, 0);
});

test('a rejection guard survives legacy journal replay and cannot expire before its batch', async t => {
  const f = await paymentTipFixture(t); await f.startRace();
  const proof = await certificate(f);
  await apply(f, proof, 1); await f.signers[1].close();
  // A reader predating rejection records ignores only the new record types.
  class LegacyJournal extends Journal {
    apply(entry) { if (!['batch-rejection-vote', 'retired-rejected-batch'].includes(entry.type)) super.apply(entry); }
  }
  const legacy = await new LegacyJournal(join(f.configs[1].directory, 'signed.log'), 'disposable-test', f.network, f.members[1].id).load();
  try {
    assert.equal(legacy.slots.get(f.key).digest, rejectionGuard(proof.target));
    await assert.rejects(legacy.reserve([f.key], f.digest(f.old), rules.hash('late'), f.old.proposal.batch), /slot_conflict/);
    await assert.rejects(legacy.retireBatch(f.key, f.reads[1]), /batch_retirement_unproven/);
    f.setClock(101);
    await assert.rejects(legacy.retireBatch(f.key, f.reads[1]), /batch_retirement_unproven/);
  } finally { await legacy.close(); }
});

test('three prior reservations prevent a retirement certificate even after the tip changes', async t => {
  const f = await paymentTipFixture(t), id = rules.hash('all-prepared');
  for (const i of [0, 1, 2]) await f.signers[i].handle('/prepare', { proposal: f.old.proposal,
    ceremony: { id, epoch: 1, peers: f.members.slice(0, 3) } });
  f.setClock(96, 101);
  for (const i of [0, 1, 2]) await assert.rejects(f.signers[i].handle('/reject-stale-batch',
    { network: f.network, proposal: f.old.proposal }), /batch_retirement_reserved/);
  const proof = await certificate(f, [3, 4]);
  await assert.rejects(apply(f, proof, 0), /batch_retirement_quorum/);
  for (const i of [0, 1, 2]) {
    await f.signers[i].handle('/go', { id });
    assert.equal((await f.signers[i].handle('/status', { id })).status, 'complete');
    await assert.rejects(f.signers[i].handle('/reject-stale-batch',
      { network: f.network, proposal: f.old.proposal }), /batch_retirement_reserved/);
  }
  assert.deepEqual(new Set(f.states.flatMap(s => s.signed)), new Set([f.digest(f.old)]));
});

test('a signed replacement cannot itself be retired to sign a second digest at that number', async t => {
  const f = await paymentTipFixture(t); await f.startRace();
  assert.equal((await f.pipeline.reconcileDraft(f.old)).draft, null); await f.finish();
  for (let i = 0; i < 5; i++) await f.restartSigner(i);
  f.setClock(97, 102);
  const votes = [];
  for (let i = 0; i < 5; i++) {
    try { votes.push(await f.signers[i].handle('/reject-stale-batch', { network: f.network, proposal: f.fresh.proposal })); }
    catch (error) { assert.equal(error.message, 'batch_retirement_reserved'); }
  }
  assert.equal(votes.length, 2);
  const proof = { target: financialRetirementTarget(f.network, f.fresh.proposal), votes };
  assert.throws(() => verifyBatchRejection(proof, { network: f.network, members: f.members }), /batch_retirement_quorum/);
  assert.deepEqual(new Set(f.states.flatMap(s => s.signed)), new Set([f.digest(f.fresh)]));
});

for (const afterWrite of [false, true]) test(`an ambiguous rejection write ${afterWrite ? 'after' : 'before'} its vote persists fails closed and recovers`, async t => {
  const f = await paymentTipFixture(t); await f.startRace();
  const append = Journal.prototype.append;
  Journal.prototype.append = async function(type, fields) {
    if (type !== 'batch-rejection-vote') return append.call(this, type, fields);
    if (afterWrite) await append.call(this, type, fields);
    throw Error('disposable_write_failure');
  };
  try {
    await assert.rejects(f.signers[1].handle('/reject-stale-batch', { network: f.network, proposal: f.old.proposal }), /disposable_write_failure/);
  } finally { Journal.prototype.append = append; }
  await assert.rejects(f.signers[1].handle('/prepare', { proposal: f.old.proposal,
    ceremony: { id: rules.hash('ambiguous'), epoch: 1, peers: f.members.slice(0, 3) } }), /batch_retirement_uncertain/);
  await f.restartSigner(1);
  const proof = await certificate(f);
  await apply(f, proof, 1);
  assert.equal((await f.records(1)).filter(r => r.type === 'batch-rejection-vote').length, 1);
});

test('a certificate recipient cannot create a new guard for an already retired digest', async t => {
  const f = await paymentTipFixture(t); await f.startRace();
  const proof = await certificate(f); await apply(f, proof, 4);
  await assert.rejects(f.signers[4].handle('/reject-stale-batch', { network: f.network, proposal: f.old.proposal }), /batch_digest_rejected/);
  assert.equal((await f.records(4)).filter(r => r.type === 'reserve').length, 0);
});

test('an old or forged proposal stamp cannot bypass financial policy', async t => {
  const f = await paymentTipFixture(t); await f.startRace();
  for (const stamp of [
    { counted: 95, tip: 100, tipHash: rules.hash('100'), revision: '0', last: { n: 0, to: 94 } },
    { counted: 96, tip: 101, tipHash: rules.hash('forged'), revision: '999', last: { n: 0, to: 94 } }
  ]) await assert.rejects(f.signers[4].handle('/prepare', { proposal: { ...f.old.proposal, stamp },
    ceremony: { id: rules.hash(JSON.stringify(stamp)), epoch: 1, peers: f.members.slice(2) } }), /batch_snapshot/);
  assert.equal((await f.records(4)).filter(r => r.type === 'reserve').length, 0);
});

for (const change of ['revision', 'authority', 'predecessor']) test(`changing ${change} cannot issue a rejection vote`, async t => {
  const f = await paymentTipFixture(t); await f.startRace();
  const reads = f.reads[1], stamp = reads.batchStamp, authority = reads.authority;
  let n = 0;
  if (change === 'revision') reads.batchStamp = async () => ({ ...await stamp(), revision: String(n++) });
  if (change === 'authority') reads.authority = async () => ({ ...await authority(), epoch: n++ });
  if (change === 'predecessor') reads.batchStamp = async () => ({ ...await stamp(), last: { n: 1, to: 95 } });
  await assert.rejects(f.signers[1].handle('/reject-stale-batch', { network: f.network, proposal: f.old.proposal }), /batch_retirement_snapshot/);
  assert.equal((await f.records(1)).filter(r => r.type === 'reserve').length, 0);
});

test('a crash between certificate persistence and attempt fencing resumes without unlocking the old digest', async t => {
  const f = await paymentTipFixture(t), attempt = await f.startRace(), proof = await certificate(f);
  const append = Journal.prototype.append;
  Journal.prototype.append = async function(type, fields) {
    if (type === 'retired-preparation') throw Error('disposable_fence_failure');
    return append.call(this, type, fields);
  };
  try { await assert.rejects(apply(f, proof, 0), /disposable_fence_failure/); }
  finally { Journal.prototype.append = append; }
  await assert.rejects(f.signers[0].handle('/go', { id: attempt.id }), /batch_retirement_uncertain/);
  await f.restartSigner(0); await apply(f, proof, 0);
  await assert.rejects(f.signers[0].handle('/go', { id: attempt.id }), /ceremony_retired/);
  assert.equal((await f.records(0)).filter(r => r.type === 'retired-rejected-batch').length, 1);
  assert.equal(f.states[0].signed.length, 0);
});

for (const v2 of [false, true]) test(`v${v2 ? 2 : 1} rejection cannot lock a future slot or an unbounded deadline`, async t => {
  const f = await paymentTipFixture(t, { v2 }); await f.startRace();
  const b = f.old.proposal.batch;
  const changed = value => v2 ? String(BigInt(value) + 100000n) : value + 100000;
  for (const [batch, reason] of [
    [{ ...b, n: changed(b.n) }, /batch_retirement_snapshot/],
    [{ ...b, deadline: changed(b.deadline) }, /batch_deadline/]
  ]) await assert.rejects(f.signers[4].handle('/reject-stale-batch', { network: f.network,
    proposal: { ...f.old.proposal, batch } }), reason);
  assert.equal((await f.records(4)).filter(r => r.type === 'reserve').length, 0);
  const vote = await f.signers[4].handle('/reject-stale-batch', { network: f.network, proposal: f.old.proposal });
  assert.equal(vote.signer, f.members[4].id);
});
