import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceClient } from '../lib/service-client.mjs';

const fullCodes = ['next_batch_work_capacity', 'next_batch_byte_capacity', 'next_batch_account_capacity', 'closure_backlog_capacity'];
const full = (code = fullCodes[0], after = '2') => Response.json({ code }, { status: 429, headers: after === undefined ? {} : { 'retry-after': after } });
const value = { v: 2, t: 'discovery-commit-v2', p: { commitment: 'saved-commitment' }, s: 'saved-signature' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const refusal = (code, retryAfterMs) => error => {
  assert.equal(error.code, code); assert.equal(error.status, 429);
  assert.equal(error.refusedBeforeAcceptance, true); assert.equal(error.retryAfterMs, retryAfterMs);
  assert.doesNotMatch(error.message, /outcome may be unknown/); return true;
};

for (const code of fullCodes) test(`batch wait resends the identical body after ${code}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bodies = [], waits = [], packet = structuredClone(value);
  const client = new ServiceClient({ onBatchWait: event => { waits.push(event); packet.s = 'changed-after-send'; },
    fetchImpl: async (_url, init) => { bodies.push(init.body); return bodies.length === 1 ? full(code, '7') : Response.json({ ok: true }); } });
  const pending = client.request('/moves', { value: packet });
  await flush(); assert.equal(bodies.length, 1); assert.deepEqual(waits, [{ code, waitMs: 7000 }]);
  t.mock.timers.tick(6999); await flush(); assert.equal(bodies.length, 1);
  t.mock.timers.tick(1); assert.deepEqual(await pending, { ok: true });
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]).s, value.s);
});

test('batch waits clamp Retry-After to 2–30 seconds and exhaust the configured budget as a refusal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waits = [], hints = ['0', '60', '4']; let calls = 0;
  const client = new ServiceClient({ batchWaitMs: 32000, onBatchWait: ({ waitMs }) => waits.push(waitMs),
    fetchImpl: async () => full(fullCodes[0], hints[calls++]) });
  const pending = assert.rejects(client.request('/moves', { value }), refusal(fullCodes[0], 4000));
  await flush(); t.mock.timers.tick(2000); await flush();
  assert.equal(calls, 2); t.mock.timers.tick(30000); await pending;
  assert.equal(calls, 3); assert.deepEqual(waits, [2000, 30000]);
});

test('batch waiting defaults to five minutes per send and can be disabled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, waits = 0;
  const client = new ServiceClient({ onBatchWait: () => waits++, fetchImpl: async () => { calls++; return full(fullCodes[0], '30'); } });
  const pending = assert.rejects(client.request('/moves', { value }), refusal(fullCodes[0], 30000));
  for (let i = 0; i < 10; i++) { await flush(); t.mock.timers.tick(30000); }
  await pending; assert.equal(calls, 11); assert.equal(waits, 10);
  client.batchWaitMs = 0;
  await assert.rejects(client.request('/moves', { value }), refusal(fullCodes[0], 30000));
  assert.equal(calls, 12); assert.equal(waits, 10);
});

test('batch waits honor HTTP-date Retry-After and use two seconds when it is absent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-01-01T00:00:00Z') });
  const waits = []; let calls = 0;
  const client = new ServiceClient({ onBatchWait: ({ waitMs }) => waits.push(waitMs), fetchImpl: async () => {
    calls++;
    if (calls === 1) return full(fullCodes[0], 'Thu, 01 Jan 2026 00:00:08 GMT');
    if (calls === 2) return Response.json({ error: fullCodes[0] }, { status: 429 });
    return Response.json({ ok: true });
  } });
  const pending = client.request('/moves', { value });
  await flush(); t.mock.timers.tick(8000); await flush(); t.mock.timers.tick(2000);
  assert.deepEqual(await pending, { ok: true }); assert.deepEqual(waits, [8000, 2000]);
});

test('other rate limits, routes, statuses and disabled retries never start batch waiting', async () => {
  for (const [path, options, status, code] of [
    ...['sender_rate', 'reveal_capacity', 'compound_work_budget', 'trac_snapshot_changed'].map(code => ['/moves', { value }, 429, code]),
    ['/moves', {}, 429, fullCodes[0]], ['/mint/quote', { value }, 429, fullCodes[0]],
    ['/moves', { value }, 503, fullCodes[0]], ['/moves', { value, retry: false }, 429, fullCodes[0]]
  ]) {
    let calls = 0;
    const client = new ServiceClient({ onBatchWait: () => assert.fail('unexpected wait'), fetchImpl: async () => {
      calls++; return Response.json({ error: code }, { status, headers: { 'retry-after': '2' } });
    } });
    await assert.rejects(client.request(path, options), error => error.code === code && error.retryAfterMs === 2000);
    assert.equal(calls, 1);
  }
});

test('another refusal ends batch waiting, while a busy answer during the wait is retried as before', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  {
    let calls = 0;
    const client = new ServiceClient({ fetchImpl: async () => ++calls === 1 ? full() : Response.json({ code: 'sender_rate' }, { status: 429 }) });
    const pending = assert.rejects(client.request('/moves', { value }), error => error.code === 'sender_rate' && error.status === 429);
    await flush(); t.mock.timers.tick(2000); await pending; assert.equal(calls, 2);
  }
  for (const [status, code] of [[503, 'service_busy'], [400, 'trac_snapshot_changed']]) {
    let calls = 0;
    const client = new ServiceClient({ fetchImpl: async () => ++calls === 1 ? full() : calls === 2 ? Response.json({ code }, { status }) : Response.json({ ok: true }) });
    const pending = client.request('/moves', { value });
    await flush(); t.mock.timers.tick(2000); await flush(); t.mock.timers.tick(2000);
    assert.deepEqual(await pending, { ok: true }); assert.equal(calls, 3);
  }
});

test('aborting a batch wait immediately surfaces its original refusal without resending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); let calls = 0;
  const client = new ServiceClient({ fetchImpl: async () => { calls++; return full(fullCodes[0], '30'); } });
  const pending = assert.rejects(client.request('/moves', { value, signal: controller.signal }), refusal(fullCodes[0], 30000));
  await flush(); controller.abort(); await pending;
  t.mock.timers.tick(30000); await flush(); assert.equal(calls, 1);
});

test('network timeouts before or after a batch refusal stay unknown and are never retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const firstRefused of [false, true]) {
    let calls = 0;
    const client = new ServiceClient({ fetchImpl: async () => {
      if (++calls === 1 && firstRefused) return full();
      throw new DOMException('request timed out', 'TimeoutError');
    } });
    const pending = assert.rejects(client.request('/moves', { value }), error => {
      assert.equal(error.code, '23'); assert.equal(error.refusedBeforeAcceptance, undefined);
      assert.equal(error.retryAfterMs, undefined); assert.match(error.message, /outcome may be unknown/); return true;
    });
    await flush(); if (firstRefused) t.mock.timers.tick(2000);
    await pending; assert.equal(calls, firstRefused ? 2 : 1);
  }
});

test('aborting an in-flight resend leaves an unknown outcome', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); let calls = 0;
  const client = new ServiceClient({ fetchImpl: async (_url, { signal }) => {
    if (++calls === 1) return full();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const pending = assert.rejects(client.request('/moves', { value, signal: controller.signal }), error => {
    assert.equal(error.refusedBeforeAcceptance, undefined); assert.match(error.message, /outcome may be unknown/); return true;
  });
  await flush(); t.mock.timers.tick(2000); await flush(); controller.abort();
  await pending; assert.equal(calls, 2);
});
