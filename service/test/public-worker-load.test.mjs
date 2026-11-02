import test from 'node:test';
import assert from 'node:assert/strict';
import { measurePublicReadLoad } from '../scripts/measure-public-workers.mjs';

test('200 concurrent public requests preserve bytes while measuring main-thread event-loop delay', { timeout: 30000 }, async t => {
  const measured = await measurePublicReadLoad({ requests: 200, rows: 400 });
  assert.equal(measured.identicalResponses, 200);
  assert.ok(measured.before.maxMs > 0 && measured.after.maxMs > 0);
  // Delay is reported, not a flaky speed threshold on shared CI hosts.
  t.diagnostic(JSON.stringify(measured));
});
