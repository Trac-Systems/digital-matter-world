import test from 'node:test';
import assert from 'node:assert/strict';
import { symbol } from '../console/js/words.js';

test('symbol displays the server assignment unchanged, including longer symbols', () => {
  assert.equal(symbol({ name: 'dmwmudstone', symbol: 'Md' }), 'Md');
  assert.equal(symbol({ name: 'dmwmuddite', symbol: 'Mud' }), 'Mud');
  assert.equal(symbol({ name: 'dmwrenamed', symbol: 'Mu' }), 'Mu');
  assert.equal(symbol({ name: 'dmwmuffinite', symbol: '' }), '', 'only an absent field uses the legacy fallback');
});

test('older records and string callers retain the original display rule', () => {
  for (const [name, expected] of [['dmwmuffinite', 'Mu'], ['dmwmudstone', 'Mu'], ['Muffinite', 'Mu'], ['a', 'A'], ['', '–']]) {
    assert.equal(symbol(name), expected);
    assert.equal(symbol({ name }), expected);
  }
  assert.equal(symbol(null), '–');
  assert.equal(symbol({ name: 'dmwmudstone', symbol: undefined }), 'Mu');
});
