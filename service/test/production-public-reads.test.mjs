import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/http.mjs';
import { redactedError } from '../src/error-log.mjs';

test('masked HTTP diagnostics retain the cause and redact URLs, credentials and private keys', async t => {
  const secret = 'b'.repeat(64), error = new TypeError(`RPC failed https://user:pass@example.invalid/key?token=hidden api_key=hidden Bearer hidden privateKey=${secret}\nnext line`);
  const clean = JSON.stringify(redactedError(error));
  assert.match(clean, /RPC failed/); assert.ok(!clean.includes('hidden')); assert.ok(!clean.includes(secret)); assert.ok(!clean.includes('example.invalid'));
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const server = await serve({ files: { serve: async () => false }, publicAPI: { handles: () => true, read: async () => { throw error; } } });
  t.after(() => server.close());
  const response = await fetch(server.url + '/patterns');
  assert.deepEqual(await response.json(), { error: 'request_failed' });
  assert.equal(logs.length, 1); assert.ok(logs[0].includes(clean));
});
