import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha256';
import { hash, hashBytes, hashObject, stableJSON, utf8, bytesToHex } from '../src/core.js';
import { indexBranchRoot, indexBranchRootOf } from '../src/index-commitment.js';
import { immutableIndexRow, indexRowBytes, indexRowHash } from '../src/index-row-cache.js';

const reference = value => bytesToHex(sha256(typeof value === 'string' ? utf8(value) : value));
test('platform SHA-256 preserves portable digests, byte types and invalid-input rejection', () => {
  const values = ['', 'abc', 'é/😀', 'x'.repeat(10000), ...[0, 1, 31, 55, 56, 63, 64, 65, 1024, 10000].map(size =>
    Uint8Array.from({ length: size }, (_, i) => (i * 71 + size) & 255))];
  for (const value of values) {
    assert.equal(hash(value), reference(value));
    assert.deepEqual(hashBytes(value), sha256(typeof value === 'string' ? utf8(value) : value));
    assert.equal(Object.getPrototypeOf(hashBytes(value)), Uint8Array.prototype);
    assert.equal(hashBytes(value).buffer.byteLength, 32); assert.equal(hashBytes(value).byteOffset, 0);
  }
  for (const value of [undefined, null, {}, 5, [1, 2], new Uint16Array(3), '\ud800', '\udfff']) {
    let expected;
    try { reference(value); } catch (error) { expected = error; }
    assert.ok(expected);
    assert.throws(() => hash(value), { name: expected.name, message: expected.message });
    assert.throws(() => hashBytes(value), { name: expected.name, message: expected.message });
  }
});
test('fixed branch encoding matches canonical commitments for every fanout and the fallback grammar', () => {
  for (let size = 0; size <= 16; size++) {
    const children = Array.from({ length: size }, (_, i) => [i.toString(16), hash('child/' + i)]);
    for (const prefix of ['', 'a', '0123456789abcdef', 'e'.repeat(64), 'é', 'quote"']) {
      assert.equal(indexBranchRoot(prefix, children), hashObject(['dmw-named-branch-v2', prefix, children]));
      assert.equal(indexBranchRootOf(prefix, Object.fromEntries(children), value => value), indexBranchRoot(prefix, children));
    }
  }
  for (const [prefix, children] of [[null, [['x', 42]]], ['aa', [['x', { value: 2 }]]], ['\ud800', []], ['a', [['x', '\udfff']]]]) {
    try {
      const expected = hashObject(['dmw-named-branch-v2', prefix, children]);
      assert.equal(indexBranchRoot(prefix, children), expected);
    } catch (error) { assert.throws(() => indexBranchRoot(prefix, children), { name: error.name, message: error.message }); }
  }
  const custom = [['a', 'é/😀']];
  Object.defineProperty(custom, 'toJSON', { value: () => 'different' });
  assert.equal(indexBranchRoot('prefix', custom), hashObject(['dmw-named-branch-v2', 'prefix', custom]));
  for (const children of [[['a', hash('a'), undefined]], new Array(1), [Object.assign(['a', hash('a')], { extra: true })]])
    assert.throws(() => indexBranchRoot('', children));
});
test('cached row text preserves canonical depth checks for nested hash and proof envelopes', () => {
  let value = 1;
  for (let i = 0; i < 16; i++) value = { value };
  const row = immutableIndexRow(value);
  assert.equal(indexRowBytes(row), utf8(stableJSON(row)).length);
  assert.throws(() => indexRowHash(row), /json_depth/);
  assert.throws(() => indexRowBytes(row, 1), /json_depth/);
  assert.equal(indexRowBytes(row), utf8(stableJSON(row)).length);
});

test('stored branch encoding preserves sorted keys, extra-field authentication and malformed-row errors', async () => {
  const { storedBranchHash } = await import('../src/index-commitment.js');
  const expected = row => hashObject(['dmw-stored-index-v2', row]);
  for (let size = 0; size <= 16; size++) {
    const row = { prefix: '', children: Object.fromEntries(Array.from({ length: size }, (_, i) => [(15 - i).toString(16),
      { storage: hash('storage/' + i), commitment: hash('commitment/' + i) }])), commitment: hash('root') };
    for (const value of [row, { ...row, extra: 'authenticated' }, { ...row, prefix: 'é' },
      { ...row, children: { ...row.children, z: { storage: hash('s'), commitment: hash('c'), extra: 1 } } }])
      assert.equal(storedBranchHash(value), expected(value));
    for (const value of [{ ...row, prefix: '\ud800' }, { ...row, commitment: undefined }])
      assert.throws(() => storedBranchHash(value));
    Object.defineProperty(row, 'toJSON', { value: () => 'different' });
    assert.equal(storedBranchHash(row), expected(row));
  }
  for (const row of ['plain', 1, null]) assert.equal(storedBranchHash(row), expected(row));
});
