import test from 'node:test';
import assert from 'node:assert/strict';
import { rules } from '../src/rules.mjs';
import { bulkFixture } from './helpers/bulk-sender.mjs';

test('a fractional fee estimate still yields signable bulk terms', async () => {
  const f = await bulkFixture(2, { feeRate: 2.125 });
  assert.equal(f.quote.fits, true);
  assert.equal(f.terms.mintFunding.feeRate, 3);
  assert.ok(f.terms.mintFunding.feeRateCeiling >= f.terms.mintFunding.feeRate);
  assert.match(rules.hashObject(f.terms), /^[0-9a-f]{64}$/);
});
