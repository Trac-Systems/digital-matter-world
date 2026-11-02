import test from 'node:test';
import assert from 'node:assert/strict';
import { serveDashboard } from '../lib/dashboard.mjs';
import { BulkLinkWorker } from '../lib/bulk-link.mjs';
import { linkFixture } from './fixtures/link-service.mjs';
import { cleanup } from './helpers.mjs';

async function eventually(check) {
  for (let n = 0; n < 200; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('local worker did not reach the expected state');
}
async function start(t, f, settings = {}) {
  const bulkLinks = new BulkLinkWorker(f.agent, { pollMs: 5, settings });
  const dashboard = await serveDashboard({ ...f.context, bulkLinks }); cleanup(t, () => dashboard.close());
  const token = new URL(dashboard.loginLink).hash.slice(1);
  const login = await fetch(dashboard.origin + '/login', { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (path, body, headers = {}) => fetch(dashboard.origin + path, { headers: { cookie, origin: dashboard.origin,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { dashboard, call };
}

test('bulk HTTP API returns promptly, authenticates, validates, deduplicates and pages exact shapes', async t => {
  const f = await linkFixture(t), { dashboard: d, call } = await start(t, f, { maxBlocks: 3, linkConcurrency: 1 });
  for (const path of ['/api/link-bulk', '/api/link-bulk/no-such-job']) assert.equal((await fetch(d.origin + path)).status, 401);
  assert.equal((await call('/api/link-bulk', { blocks: ['1'] }, { origin: 'https://elsewhere.invalid' })).status, 403);
  for (const blocks of [[], [1], ['01'], ['-1']]) {
    const response = await call('/api/link-bulk', { blocks }); assert.equal(response.status, 400); assert.equal((await response.json()).error, 'invalid_blocks');
  }
  let response = await call('/api/link-bulk', { blocks: ['1', '2', '3', '4'] });
  assert.equal(response.status, 400); assert.equal((await response.json()).error, 'too_many_blocks');
  // Block the fake transport: creating a job must not wait for a gateway reply.
  f.stall(signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  response = await call('/api/link-bulk', { blocks: ['2', '1', '1'] }); assert.equal(response.status, 200);
  const { job } = await response.json(); assert.equal(job.payer, f.binding.request.address); assert.equal(job.total, 2);
  assert.deepEqual(Object.keys(job).sort(), ['counts', 'createdAt', 'id', 'payer', 'state', 'total']);
  assert.equal(new Date(job.createdAt).toISOString(), job.createdAt);
  response = await call('/api/link-bulk', { blocks: ['1', '2'] }); assert.equal(response.status, 409);
  const duplicate = await response.json(); assert.equal(duplicate.error, 'link_job_running'); assert.equal(duplicate.job.id, job.id);
  const second = await (await call('/api/link-bulk', { blocks: ['3'] })).json();
  const list = await (await call('/api/link-bulk?offset=0&limit=1')).json(); assert.equal(list.jobs[0].id, second.job.id); assert.equal(list.next, 1);
  const detail = await (await call(`/api/link-bulk/${job.id}?limit=1`)).json(); assert.equal(detail.next, 1); assert.equal(detail.items[0].block, '1');
  assert.equal(typeof detail.items[0].updatedAt, 'string'); assert.equal('reason' in detail.items[0], false);
  assert.equal((await call('/api/link-bulk?offset=-1')).status, 400);
  assert.equal((await call('/api/link-bulk?limit=1&limit=2')).status, 400);
  assert.equal((await call('/api/link-bulk/no-such-job')).status, 404);
  assert.equal((await call('/api/link-bulk/candidates')).status, 404);
  await d.close();
});

test('dashboard startup automatically resumes unfinished jobs and sent items survive cancellation', async t => {
  const f = await linkFixture(t), first = await start(t, f, { linkConcurrency: 1 });
  const { job } = await (await first.call('/api/link-bulk', { blocks: ['1', '2', '3'] })).json();
  await eventually(() => f.linkRecords.size === 1 && first.dashboard.state.bulkLinks.jobs.get(job.id).counts.inProgress === 1);
  const id = first.dashboard.state.bulkLinks.jobs.detail(job.id).items[0].requestId;
  const cancelled = await (await first.call(`/api/link-bulk/${job.id}/cancel`, {})).json();
  assert.equal(cancelled.job.counts.cancelled, 2); assert.equal(cancelled.job.counts.inProgress, 1);
  await first.dashboard.close(); f.linkRecords.get(id).state = 'accepted';
  const second = await start(t, f);
  await eventually(() => second.dashboard.state.bulkLinks.jobs.get(job.id).state === 'cancelled');
  const detail = await (await second.call(`/api/link-bulk/${job.id}`)).json();
  assert.equal(detail.job.counts.linked, 1); assert.equal(detail.items[0].state, 'linked'); assert.equal(f.linkPackets.length, 2);
});

test('stopping rejects new bulk work and cancellation with 503', async t => {
  const f = await linkFixture(t), { dashboard, call } = await start(t, f);
  const { job } = await (await call('/api/link-bulk', { blocks: ['1'] })).json();
  dashboard.state.closed = true;
  assert.equal((await call('/api/link-bulk', { blocks: ['2'] })).status, 503);
  assert.equal((await call(`/api/link-bulk/${job.id}/cancel`, {})).status, 503);
});

test('shutdown can interrupt a link queued behind mining without later touching the journal', async t => {
  const f = await linkFixture(t); let release;
  const mining = f.agent.exclusive(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const worker = new BulkLinkWorker(f.agent, { pollMs: 1 }); cleanup(t, () => worker.close());
  worker.create({ blocks: ['1'] }); worker.start();
  await eventually(() => !!worker.sendingItem);
  await worker.close(); release(); await mining; await f.agent.tail;
  assert.equal(f.linkPackets.length, 0);
});
