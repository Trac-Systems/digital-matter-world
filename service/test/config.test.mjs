import test from 'node:test';
import assert from 'node:assert/strict';
import { localURL, loadConfig } from '../src/config.mjs';
test('endpoint validation allows only explicit loopback HTTP without URL credentials', async () => {
  assert.equal(localURL('http://127.0.0.1:18443'), 'http://127.0.0.1:18443');
  for (const url of ['https://example.invalid', 'http://localhost', 'http://127.0.0.1@example.invalid', 'http://user:password@127.0.0.1', 'file:///tmp/x']) assert.throws(() => localURL(url));
  await assert.rejects(loadConfig('relative.json'), /absolute_config/);
});
