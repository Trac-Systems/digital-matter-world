import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentTipFixture } from './payment-batch-tip-fixture.mjs';

test('legacy recovery restores a financial batch after the tip race until its deadline passes', async t => {
  const f = await paymentTipFixture(t, { legacyRecovery: true });
  await f.startRace();
  for (const counted of [96, 97, 101]) {
    f.setClock(counted); await f.due();
    assert.deepEqual((await f.pipeline.reconcileDraft(f.old)).draft, f.old);
    assert.equal(f.store.get('ceremonies', f.key).recovery.restored, true);
    await f.committee.signature(f.key, f.old.proposal);
    assert.equal(f.store.get('ceremonies', f.key).stage, 'blocked');
    assert.ok(f.store.get('ceremonies', f.key).failures.every(reason => reason === 'committee_batch_snapshot'));
  }
  f.setClock(102); await f.due();
  assert.equal((await f.pipeline.reconcileDraft(f.old)).draft, null);
  assert.equal(f.states.flatMap(state => state.signed).length, 0);
});

for (const oldSigners of [[], [0], [0, 4]]) test(`tip race retires within one recovery retry with ${oldSigners.length} old signers`, async t => {
  const f = await paymentTipFixture(t, { oldSigners });
  await f.startRace();
  assert.equal((await f.pipeline.reconcileDraft(f.old)).draft, null);
  assert.equal(await f.gatewayReads.counted(), 96);
  assert.equal(f.store.count('batchRetirements'), 1);
  assert.equal(f.store.list('supersededDrafts', { limit: 1 })[0].value.proof.reason, 'financial_snapshot_retired');
  await f.restartGateway();
  assert.equal((await f.pipeline.reconcileDraft(null)).draft, null, 'a retired draft cannot be restored after restart');
  await f.finish();
  assert.deepEqual(new Set(f.states.flatMap(s => s.signed)), new Set([f.digest(f.fresh)]));
  assert.equal(f.states.flatMap(s => s.signed).length, 3);
  await assert.rejects(f.committee.signature(f.key, f.old.proposal), /batch_digest_rejected/);
});

test('insufficient upgraded nonparticipants preserve reservations and refuse unsafe replacement', async t => {
  const f = await paymentTipFixture(t, { oldSigners: [0, 3, 4] });
  await f.startRace(); await f.pipeline.reconcileDraft(f.old);
  assert.equal(f.store.count('batchRetirements'), 0);
  assert.equal(f.store.count('supersededDrafts'), 0);
  assert.equal(f.states.flatMap(s => s.signed).length, 0);
  assert.equal((await f.records(0)).filter(r => r.type === 'retired-rejected-batch').length, 0);
});

test('gateway resumes a persisted certificate after interruption before participant retirement', async t => {
  const f = await paymentTipFixture(t); await f.startRace();
  const request = f.committee.request;
  f.committee.request = async (member, path, body) => {
    if (path === '/retire-rejected-batch') throw Error('committee_http_timeout');
    return request(member, path, body);
  };
  assert.equal((await f.pipeline.reconcileDraft(f.old)).waiting, true);
  assert.equal(f.store.count('batchRetirements'), 1);
  assert.equal(f.store.count('supersededDrafts'), 0);
  await f.restartGateway(); await f.due();
  assert.equal((await f.pipeline.reconcileDraft(f.old)).draft, null);
  await f.finish();
  assert.deepEqual(new Set(f.states.flatMap(s => s.signed)), new Set([f.digest(f.fresh)]));
});

for (const legacyRecovery of [true, false]) test(`v2 payment scan tip race ${legacyRecovery ? 'remains reserved on legacy recovery' : 'retires within one retry'}`, async t => {
  const f = await paymentTipFixture(t, { legacyRecovery, v2: true });
  await f.startRace();
  const result = await f.pipeline.reconcileDraft(f.old);
  if (legacyRecovery) {
    assert.deepEqual(result.draft, f.old);
    assert.equal(f.store.get('ceremonies', f.key).recovery.restored, true);
    await f.committee.signature(f.key, f.old.proposal);
    assert.ok(f.store.get('ceremonies', f.key).failures.every(reason => reason === 'committee_batch_snapshot'));
    f.setClock('1206', '1206'); await f.due();
    assert.deepEqual((await f.pipeline.reconcileDraft(f.old)).draft, f.old);
    f.setClock('1207', '1207'); await f.due();
    assert.equal((await f.pipeline.reconcileDraft(f.old)).draft, null);
  } else {
    assert.equal(result.draft, null);
    assert.equal(f.store.count('batchRetirements'), 1);
    assert.equal(await f.gatewayReads.counted(), '1201');
    assert.equal(f.old.proposal.batch.deadline, '1206');
  }
  assert.equal(f.states.flatMap(s => s.signed).length, 0);
});
