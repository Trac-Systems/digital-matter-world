import test from 'node:test';
import assert from 'node:assert/strict';
import { errorMeanings, explainError, isMoveRefusal, serviceError } from '../lib/errors.mjs';

test('a public mint refusal is explained and is definite only for the gateway refusal status', () => {
  assert.match(explainError(Error('public_minted')), /already taken by a public TAP Wallet mint/);
  const error = serviceError({ service: 'gateway', origin: 'http://fixture.invalid', route: '/moves', method: 'POST', status: 400, code: 'public_minted' });
  assert.equal(error.code, 'public_minted');
  assert.match(error.message, /Choose another unclaimed block/);
  assert.equal(isMoveRefusal(400, 'public_minted'), true);
  assert.equal(isMoveRefusal(503, 'public_minted'), false);
});

test('old gateway refusal evidence remains recognizable without obsolete deadline advice', () => {
  assert.equal(isMoveRefusal(400, 'claim_deadline'), true);
  assert.equal(isMoveRefusal(503, 'claim_deadline'), false);
  assert.equal(errorMeanings.claim_deadline, undefined);
  assert.equal(errorMeanings.claim_window_open, undefined);
  assert.doesNotMatch(serviceError({ service: 'gateway', origin: 'http://fixture.invalid', route: '/moves', status: 400, code: 'claim_deadline' }).message, /claim week|closed|only be minted/);
  assert.equal(errorMeanings.claimed_first, 'An agent claimed this block before your payment was confirmed. Your payment is refunded.');
});
