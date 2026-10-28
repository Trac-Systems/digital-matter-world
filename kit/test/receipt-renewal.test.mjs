import test from 'node:test';
import assert from 'node:assert/strict';
import { TracClient } from '../lib/trac.mjs';

test('independent renewal readers preserve decimal batch identities beyond safe integers', () => {
  const calls = [], api = { dmwBatchRoot: n => calls.push(['root', n]), dmwReceiptRenewalSlice: n => calls.push(['slice', n]) };
  const trac = new TracClient({ network: 'renewal-reader', api });
  for (const n of [4, '4', '9007199254740993', '9'.repeat(80)]) { trac.batchRoot(n); trac.renewalSlice(n); }
  assert.deepEqual(calls, [4, '4', '9007199254740993', '9'.repeat(80)].flatMap(n => [['root', n], ['slice', String(n)]]));
  for (const n of [0, '0', '01', '-1', '1.0', '1e3', 1.5, Number.MAX_SAFE_INTEGER + 1, null, {}, []]) {
    assert.throws(() => trac.batchRoot(n), /Invalid batch/);
    assert.throws(() => trac.renewalSlice(n), /renewal slice unavailable/);
  }
  assert.equal(calls.length, 8);
  assert.throws(() => new TracClient({ api: {} }).renewalSlice('4'), /upgrade_required/);
});
