import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, signedBatch } from './helpers/harness.mjs';

test('current contract has no rules-setting upgrade and refuses a v2 batch without writes', async () => {
  const h = harness(), before = structuredClone(h.db);
  assert.equal(await h.run('ad_set', { key: 'ruleset', value: 2 }), 'admin_proposal');
  const old = signedBatch({ n: 1, from: 1, to: 1, deadline: 1, ops: [] });
  assert.equal(await h.run('bt', { ...old, v: 2 }), 'batch');
  assert.equal(await h.run('bt', { ...old, ruleset: 'dmw-v2' }), 'batch');
  assert.deepEqual(h.db, before);
});
