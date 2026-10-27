import test from 'node:test';
import assert from 'node:assert/strict';
import { runDevnet } from '../scripts/devnet.mjs';

test('local real MSB/indexer/writer: signed batch, TNK transfer, claim/refund and fallback routes', { timeout: 150000 }, async () => {
  const result = await runDevnet(); assert.equal(result.ok, true); assert.equal(result.counted, 27); assert.equal(result.paths.length, 8);
});
