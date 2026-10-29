import test from 'node:test';
import assert from 'node:assert/strict';
import { walletError } from '../../playground/console/js/wallet-errors.js';

test('public opening messages retain decimal heights without numeric rounding', () => {
  for (const publicFrom of ['0', '551009', '9007199254742001']) {
    assert.equal(walletError('not_yet_public', { publicFrom }), `Opens at block ${publicFrom}.`);
    assert.equal(walletError(Object.assign(Error('not_yet_public'), { publicFrom })), `Opens at block ${publicFrom}.`);
  }
});

test('missing or malformed opening heights retain the existing public mint guidance', () => {
  const fallback = walletError('not_yet_public');
  assert.match(fallback, /This block is not public yet/);
  for (const publicFrom of [undefined, null, '', '01', '-1', '1.5', '1e6', '<b>10</b>', 1108]) {
    assert.equal(walletError('not_yet_public', { publicFrom }), fallback);
  }
  assert.equal(walletError('claimed', { publicFrom: '1108' }), walletError('claimed'));
});
