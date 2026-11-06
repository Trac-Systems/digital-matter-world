import test from 'node:test';
import assert from 'node:assert/strict';
import { BulkLinkWorker, previewLinkJob } from '../lib/bulk-link.mjs';
import { Journal } from '../lib/journal.mjs';
import { dashboardJournal } from '../lib/dashboard-state.mjs';
import { linkFixture } from './fixtures/link-service.mjs';
import { cleanup, bitcoinAddress } from './helpers.mjs';

const unpaced = { linkPacing: { intervalMs: 0, perTip: 100 } };
async function fixture(t, options = {}) {
  const f = await linkFixture(t), worker = new BulkLinkWorker(f.agent, { pollMs: 1, ...options,
    settings: { ...options.settings, linkPacing: { intervalMs: 0, perTip: 100, ...options.settings?.linkPacing } } }); cleanup(t, () => worker.close());
  return { ...f, worker, create: blocks => worker.create({ blocks }).job,
    due() { f.journal.db.prepare('UPDATE link_job_items SET retry_at=0').run(); f.journal.db.prepare('DELETE FROM link_job_backoff').run(); } };
}

test('bulk jobs resume after reopening SQLite and observe links completed while offline', async t => {
  const f = await fixture(t), job = f.create(['1', '2']);
  await f.worker.step(); const id = f.worker.jobs.detail(job.id).items[0].requestId;
  await f.worker.close();
  // The fixture owns its initial connection; open a new connection like restart.
  const journal = await Journal.open(f.directory, f.journal.scope, { intervalMs: 0, perTip: 100 }); cleanup(t, () => journal.close());
  f.agent.journal = dashboardJournal(journal); f.linkRecords.get(id).state = 'accepted';
  const resumed = new BulkLinkWorker(f.agent, { pollMs: 1, settings: unpaced }); cleanup(t, () => resumed.close());
  f.due(); await resumed.step();
  assert.equal(resumed.jobs.detail(job.id).items[0].state, 'linked');
  assert.equal(f.linkPackets.length, 4); assert.equal(resumed.jobs.get(job.id).counts.inProgress, 1);
});

test('concurrency is shared across jobs and repeated steps cannot exceed it', async t => {
  const f = await fixture(t, { settings: { linkConcurrency: 2 } }); f.create(['1', '2', '3']); f.create(['4', '5']);
  for (let i = 0; i < 7; i++) { f.due(); await Promise.all([f.worker.step(), f.worker.step()]); }
  assert.equal(f.linkRecords.size, 2); assert.equal(f.worker.jobs.active().filter(i => i.state === 'in_progress').length, 2);
  f.linkRecords.values().next().value.state = 'accepted'; f.due(); await f.worker.step(); assert.equal(f.linkRecords.size, 3);
});

test('expired request is renewed with a different signed action and request ID', async t => {
  const f = await fixture(t), job = f.create(['1']); await f.worker.step();
  const first = f.worker.jobs.active()[0], id = first.request_id;
  f.linkRecords.get(id).state = 'expired'; f.due(); await f.worker.step();
  const second = f.worker.jobs.active()[0];
  assert.notEqual(second.action_id, first.action_id); assert.notEqual(second.request_id, id);
  assert.match(second.action_id, /^[a-zA-Z0-9._-]{1,64}$/); assert.ok(f.journal.get('link/' + first.action_id));
  assert.equal(f.worker.jobs.get(job.id).counts.failed, 0);
});

for (const [code, expected] of [['financial_link_owner', 'not_in_wallet'], ['bitmap_agent_binding', 'not_in_wallet'], ['link_exists', 'already_linked'], ['bitmap_missing', 'not_a_bitmap']])
  test(`final refusal ${code} becomes ${expected}`, async t => {
    const f = await fixture(t), job = f.create(['1']); f.failures.set('1', { code }); await f.worker.step();
    assert.equal(f.worker.jobs.detail(job.id).items[0].reason, expected); assert.equal(f.worker.jobs.get(job.id).state, 'done');
  });

test('a different payer wallet fails before any signed request or registration', async t => {
  const f = await fixture(t), { job } = f.worker.create({ blocks: ['1'], payer: bitcoinAddress() }); await f.worker.step();
  assert.equal(f.worker.jobs.detail(job.id).items[0].reason, 'not_in_wallet'); assert.equal(f.linkPackets.length, 0);
});

for (const status of [429, 503]) test(`busy ${status} stays retryable and later succeeds`, async t => {
  const f = await fixture(t), job = f.create(['1']); f.busy({ status, code: 'link_capacity' }); await f.worker.step();
  assert.equal(f.worker.jobs.get(job.id).counts.failed, 0); f.busy(null); f.due(); await f.worker.step();
  assert.equal(f.worker.jobs.get(job.id).counts.inProgress, 1);
});

test('a lost second response is polled without a new signature', async t => {
  const f = await fixture(t), job = f.create(['1']); f.lose(); await f.worker.step();
  const first = f.worker.jobs.active()[0]; assert.equal(f.journal.get('link/' + first.action_id).state, 'unknown');
  f.linkRecords.get(first.request_id).state = 'accepted'; f.due(); await f.worker.step();
  assert.equal(f.worker.jobs.get(job.id).counts.linked, 1); assert.equal(f.linkPackets.length, 2);
});

test('cancel does not renew sent requests after expiry', async t => {
  const f = await fixture(t), job = f.create(['1', '2']); await f.worker.step();
  const first = f.worker.jobs.active()[0]; f.worker.jobs.cancel(job.id); f.linkRecords.get(first.request_id).state = 'expired';
  f.due(); await f.worker.step(); assert.equal(f.linkPackets.length, 2);
  assert.equal(f.worker.jobs.get(job.id).state, 'cancelled'); assert.equal(f.worker.jobs.get(job.id).counts.cancelled, 2);
});

test('link pacing releases the FIFO queue for mining and shutdown', async t => {
  const f = await fixture(t, { settings: { linkPacing: { perTip: 1 } } }); f.create(['1', '2']);
  await f.worker.step(); f.due(); await f.worker.step();
  assert.equal(f.linkRecords.size, 1);
  let mined = false; await f.agent.exclusive(() => { mined = true; }); assert.equal(mined, true);
  await f.worker.close(); assert.equal(f.worker.stopped, true);
});

test('worker lease excludes another active process and is released on shutdown', async t => {
  const f = await fixture(t); f.worker.start();
  const other = new BulkLinkWorker(f.agent); cleanup(t, () => other.close());
  assert.throws(() => other.start(), /link_worker_running/); await f.worker.close(); other.start();
});

test('dry-run validates locally without jobs, signing or service calls', async t => {
  const f = await fixture(t); f.agent.dryRun = true;
  assert.equal(previewLinkJob(f.agent, { blocks: ['1', '1'] }).total, 1);
  assert.equal(f.worker.create({ blocks: ['1'] }).state, 'dry-run');
  await f.worker.step(); assert.deepEqual(f.worker.jobs.list().jobs, []); assert.deepEqual(f.linkCalls, []);
});

test('a definite stale quote refusal renews the action and retains refused history', async t => {
  const f = await fixture(t); f.create(['1']); const first = f.worker.jobs.active()[0];
  f.failures.set('1', { path: '/link/request', code: 'fee_quote_expired', status: 409, once: true });
  await f.worker.step(); assert.equal(f.journal.get('link/' + first.action_id).state, 'refused');
  const next = f.worker.jobs.active()[0]; assert.notEqual(next.action_id, first.action_id);
  await f.worker.step(); assert.equal(f.worker.jobs.active()[0].state, 'in_progress'); assert.equal(f.linkRecords.size, 1);
});

test('busy after signing retains the exact packet and never fails the item', async t => {
  const f = await fixture(t); f.create(['1']);
  f.failures.set('1', { path: '/link/request', code: 'link_capacity', status: 503, once: true });
  await f.worker.step(); const first = f.worker.jobs.active()[0], packet = f.journal.get('link/' + first.action_id).body;
  assert.equal(first.state, 'in_progress'); f.due(); await f.worker.step();
  assert.equal(f.worker.jobs.active()[0].action_id, first.action_id);
  assert.deepEqual(f.linkPackets[0], packet);
});

test('a refusal after uncertainty cannot authorize a replacement until absence and expiry', async t => {
  const f = await fixture(t); f.create(['1']); f.onPacket(() => { throw Error('connection_lost'); });
  await f.worker.step(); const first = f.worker.jobs.active()[0], packet = f.journal.get('link/' + first.action_id).body;
  f.onPacket(null); f.failures.set('1', { path: '/link/request', code: 'financial_link_deadline', status: 400 });
  f.due(); await f.worker.step();
  assert.equal(f.worker.jobs.active()[0].action_id, first.action_id);
  assert.equal(f.journal.get('link/' + first.action_id).state, 'unknown');
  f.clock.counted = String(BigInt(packet.request.until) + 1n); f.failures.clear(); f.due(); await f.worker.step();
  assert.notEqual(f.worker.jobs.active()[0].action_id, first.action_id);
});

test('mining and links each keep their own per-block budget', async t => {
  const f = await fixture(t, { settings: { linkPacing: { perTip: 2 } } }); f.journal.perTip = 1; f.create(['1', '2', '3']); let mining;
  f.onPacket(() => {
    mining ??= f.agent.exclusive(async () => { await f.journal.waitTurn(() => f.agent.trac.head()); f.journal.finishTurn(); return 'mined'; });
  });
  await f.worker.step(); assert.equal(await mining, 'mined', 'mining gets its turn while links run');
  for (let i = 0; i < 3; i++) { f.due(); await f.worker.step(); }
  assert.equal(f.linkRecords.size, 2, 'links stop at their own budget, not at the one mining used');
  const count = scope => f.journal.db.prepare('SELECT count FROM rates WHERE scope=?').get(scope).count;
  assert.equal(count(f.journal.scope), 1); assert.equal(count(f.journal.scope + '/links'), 2);
});

test('future blocks fail as not_a_bitmap; transient snapshot refusals retry', async t => {
  const f = await fixture(t), job = f.create([String(BigInt(f.clock.counted) + 1n), '1']);
  f.failures.set('1', { code: 'trac_snapshot_changed', status: 400, once: true });
  await f.worker.step(); assert.equal(f.worker.jobs.get(job.id).counts.failed, 0);
  f.due(); await f.worker.step(); f.due(); await f.worker.step();
  assert.equal(f.worker.jobs.detail(job.id).items[1].reason, 'not_a_bitmap');
});

test('gateway Retry-After delays every job and survives a worker restart', async t => {
  const f = await fixture(t, { pollMs: 60000 }); f.create(['1', '2', '3']); f.create(['4', '5']);
  f.busy({ status: 503, code: 'link_capacity' }); await f.worker.step();
  for (let n = 0; n < 4; n++) await f.worker.step();
  assert.equal(f.linkCalls.length, 1);
  await f.worker.close(); const resumed = new BulkLinkWorker(f.agent, { settings: unpaced }); cleanup(t, () => resumed.close());
  await resumed.step(); assert.equal(f.linkCalls.length, 1);
  f.busy(null); f.due(); await resumed.step(); assert.equal(f.linkRecords.size, 1);
});

test('a full local block allowance delays new quotes but still polls sent links', async t => {
  const f = await fixture(t, { pollMs: 60000, settings: { linkPacing: { perTip: 1 } } }); f.create(['1', '2', '3']);
  await f.worker.step(); await f.worker.step(); const before = f.linkCalls.length;
  await f.worker.step(); assert.equal(f.linkCalls.length, before);
  const [id, record] = [...f.linkRecords][0]; record.state = 'accepted';
  f.journal.db.prepare('UPDATE link_job_items SET retry_at=0 WHERE request_id=?').run(id);
  await f.worker.step(); assert.equal(f.worker.jobs.active().filter(i => i.state === 'in_progress').length, 0);
  assert.equal(f.linkCalls.at(-1), '/link-status/' + id);
});

test('local send delay uses configured pacing instead of the slower status polling interval', async t => {
  const f = await fixture(t, { pollMs: 5000, settings: { linkPacing: { intervalMs: 1000 } } }); let now = 10000;
  f.journal.now = () => now; f.create(['1', '2']);
  await f.worker.step(); await f.worker.step(); assert.equal(f.worker.jobs.delayUntil('send'), 11000);
  now = 11000; await f.worker.step(); assert.equal(f.linkRecords.size, 2);
});
