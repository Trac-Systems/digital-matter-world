import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalReads } from '../signer/reads.mjs';

test('signer asset context forwards the accepted mint identity with its original payout snapshot', async () => {
  const args = ['p2:1', '42', 'tap', { deploymentId: 'original-deployment' }, 'ab'.repeat(32)];
  const reads = createLocalReads({ records: { assetContext: (...actual) => {
    assert.deepEqual(actual, args); return { admitted: actual[4] };
  } } });
  assert.deepEqual(await reads.assetContext(...args), { admitted: args[4] });
});
