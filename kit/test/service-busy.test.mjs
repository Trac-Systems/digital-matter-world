import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceClient } from '../lib/service-client.mjs';

const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('a busy gateway answer is retried with the identical body', async () => {
  const bodies = [];
  const answers = [reply(503, { error: 'request_pending' }, { 'retry-after': '0' }), reply(503, { error: 'service_busy' }, { 'retry-after': '0' }), reply(200, { ok: true })];
  const client = new ServiceClient({ fetchImpl: async (url, init) => { bodies.push(init.body); return answers.shift(); } });
  assert.deepEqual(await client.request('/mint/quote', { value: { asset: 'p2:1', block: '1' } }), { ok: true });
  assert.equal(bodies.length, 3); assert.equal(new Set(bodies).size, 1);
});

test('busy retries are bounded and other refusals are not retried', async () => {
  let calls = 0;
  const busy = new ServiceClient({ busyRetries: 2, fetchImpl: async () => { calls++; return reply(503, { error: 'request_pending' }, { 'retry-after': '0' }); } });
  await assert.rejects(busy.request('/status'), /request_pending/); assert.equal(calls, 3);
  calls = 0;
  const refused = new ServiceClient({ fetchImpl: async () => { calls++; return reply(503, { error: 'ruleset_not_ready' }, { 'retry-after': '0' }); } });
  await assert.rejects(refused.request('/status'), /ruleset_not_ready/); assert.equal(calls, 1);
});
