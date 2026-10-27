import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeader } from '../../../contract/beacon/bitcoin.js';
import { relayFixture } from './header-relay-fixture.mjs';

test('production relay queues validated linked chunks after the contract head and survives restart without duplicates', async t => {
  const f = await relayFixture(t, 52);
  await f.advanceContract(7); await f.relay.tick(f.outbox);
  const jobs = f.store.list('outbox').map(r => r.value);
  assert.deepEqual(jobs.map(j => j.value.headers.length), [20, 20, 5]);
  assert.deepEqual(jobs.map(j => j.height), [27, 47, 52]);
  assert.equal(parseHeader(jobs[0].value.headers[0]).prev, f.history.hashAt(7));
  for (let i = 1; i < jobs.length; i++) { assert.equal(jobs[i].after, jobs[i - 1].id); assert.equal(parseHeader(jobs[i].value.headers[0]).prev, jobs[i - 1].hash); }
  await f.relay.tick(f.outbox); assert.deepEqual(f.store.list('outbox').map(r => r.value), jobs);
  await f.reopen(); await f.relay.tick(f.outbox); assert.deepEqual(f.store.list('outbox').map(r => r.value), jobs);
  // Another writer may accept part of an already queued chunk.
  await f.advanceContract(12); await f.relay.tick(f.outbox); assert.equal(f.store.count('outbox'), 3);
  // The message journal is durable even if the cursor write was interrupted.
  await f.store.put('meta', 'headerRelay'); await f.reopen(); await f.relay.tick(f.outbox); assert.equal(f.store.count('outbox'), 3);
  const now = Date.now();
  for (let i = 0; i < 4; i++) await f.outbox.tick(now + i * 1000);
  assert.equal(f.store.count('outbox'), 0); assert.equal(f.store.count('sent'), 3); assert.equal(f.messages.length, 3);
  await f.reopen(); await f.relay.tick(f.outbox); assert.equal(f.store.count('outbox'), 0); assert.equal(f.messages.length, 3);
  assert.equal((await f.reads.trac('head')).tip.hash, (await f.reads.client.tip()).hash);
});

test('production relay respects shared outbox capacity and resumes as slots become free', async t => {
  const f = await relayFixture(t, 45, { maxJobs: 2 });
  await f.outbox.enqueue('player', 'bt', { n: 1 }, { blocked: 'fixture' });
  await f.relay.tick(f.outbox); assert.equal(f.store.count('outbox'), 2);
  assert.equal(f.store.list('outbox').filter(r => r.value.op === 'hd')[0].value.height, 20);
  await f.relay.tick(f.outbox); assert.equal(f.store.count('outbox'), 2);
  const now = Date.now(); await f.outbox.tick(now); await f.outbox.tick(now + 1000);
  await f.relay.tick(f.outbox); assert.equal(f.store.count('outbox'), 2);
  assert.equal(f.store.list('outbox').find(r => r.value.op === 'hd').value.height, 40);
});

test('production relay rejects unvalidated source headers before enqueuing', async t => {
  const f = await relayFixture(t, 3);
  f.reads.client.header = async () => '00'.repeat(80);
  await assert.rejects(f.relay.tick(f.outbox), /bitcoin_pow/);
  assert.equal(f.store.count('outbox'), 0);
});

test('production relay replaces orphan jobs and accepts multiple fork chunks before the fork becomes best', async t => {
  const f = await relayFixture(t, 65, { deferred: true });
  await f.advanceContract(45); await f.relay.tick(f.outbox);
  const orphan = f.store.list('outbox')[0].id;
  await f.fork(5, 55); await f.relay.tick(f.outbox);
  assert.equal(f.store.get('outbox', orphan), null);
  const jobs = f.store.list('outbox').map(r => r.value);
  assert.deepEqual(jobs.map(j => j.height), [25, 45, 60]);
  assert.equal(parseHeader(jobs[0].value.headers[0]).prev, f.history.hashAt(5));
  let now = Date.now();
  for (let i = 0; i < 3; i++) {
    await f.outbox.tick(now += 1000);
    assert.equal(f.deliveries.length, 1, 'only the next dependent chunk is in flight');
    await f.deliver(f.deliveries.shift());
    if (i < 2) assert.equal((await f.reads.trac('head')).tip.hash, f.history.hashAt(45), 'fork is accepted but not best yet');
    await f.reopen(); await f.relay.tick(f.outbox);
  }
  await f.outbox.tick(now + 1000); await f.relay.tick(f.outbox);
  assert.equal(f.store.count('outbox'), 0); assert.equal(f.messages.length, 3);
  assert.equal((await f.reads.trac('head')).tip.hash, (await f.reads.client.tip()).hash);
});

test('a stalled fork resumes from its accepted cursor when the source grows', async t => {
  const f = await relayFixture(t, 45);
  await f.advanceContract(45); await f.fork(5, 30); await f.relay.tick(f.outbox);
  const now = Date.now(); for (let i = 0; i < 3; i++) await f.outbox.tick(now + i * 1000);
  assert.equal((await f.reads.trac('head')).tip.height, 45);
  await f.reopen(); await f.relay.tick(f.outbox); assert.equal(f.store.count('outbox'), 0);
  await f.fork(35, 15, 2); await f.relay.tick(f.outbox);
  const [job] = f.store.list('outbox').map(r => r.value);
  assert.equal(job.value.headers.length, 15); assert.equal(job.height, 50);
  await f.outbox.tick(now + 3000); await f.outbox.tick(now + 4000);
  assert.equal((await f.reads.trac('head')).tip.hash, (await f.reads.client.tip()).hash);
});

test('1,700 validated headers catch up in 85 ordered free messages at one acceptance per poll', async t => {
  const start = performance.now(), f = await relayFixture(t, 1700, { deferred: true });
  await f.relay.tick(f.outbox); assert.equal(f.store.count('outbox'), 85);
  const now = Date.now();
  for (let second = 0; second < 85; second++) {
    await f.outbox.tick(now + second * 1000);
    assert.equal(f.deliveries.length, 1);
    await f.deliver(f.deliveries.shift());
  }
  await f.outbox.tick(now + 85000); await f.relay.tick(f.outbox);
  assert.equal(f.store.count('outbox'), 0); assert.equal(f.messages.length, 85);
  assert.equal((await f.reads.trac('head')).tip.height, 1700);
  t.diagnostic(`1700 headers / 85 messages / 85 simulated seconds; local validation, durable queue and contract execution: ${(performance.now() - start).toFixed(0)} ms`);
});
