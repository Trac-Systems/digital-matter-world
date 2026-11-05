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

test('every refusal tells the agent whether it is normal busy, normal competition or needs attention', async () => {
  const { errorKind, ERROR_KINDS } = await import('../lib/errors.mjs');
  for (const [status, code] of [[503, 'service_busy'], [503, 'read_not_ready'], [429, 'next_batch_work_capacity'], [409, 'taken_snapshot_stale'],
    [undefined, 'transport_error'], [undefined, '23'], [502, 'http_status'], [429, 'sender_rate']]) assert.equal(errorKind(status, code), 'retry', code);
  for (const code of ['public_minted', 'claimed_first', 'someone_paid_first', 'already_minted']) assert.equal(errorKind(400, code), 'moved_on', code);
  for (const [status, code] of [[409, 'upgrade_required'], [400, 'invalid_move'], [400, 'insufficient_balance']]) assert.equal(errorKind(status, code), 'attention', code);
  const busy = serviceError({ service: 'gateway', origin: 'http://fixture.invalid', route: '/moves', method: 'POST', status: 503, code: 'service_busy', submission: true });
  assert.equal(busy.kind, 'retry'); assert.ok(busy.message.endsWith(ERROR_KINDS.retry));
  assert.match(explainError(Error('Header window is closed')), /Normal in a competitive game/);
  assert.equal(explainError(Error('Invalid catalog page')), 'Invalid catalog page');
});

