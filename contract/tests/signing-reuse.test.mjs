import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToBytes as referenceHex, bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { canonicalJSON, hexToBytes, batchDigest } from '../signing.js';
import { accountBranch, accountKey, accountTree, verifyAccountProof } from '../account-tree.js';
import { stableJSON } from '../../rules/src/core.js';

// The pre-P5 encoder, intentionally independent of the optimized implementation.
function referenceJSON(value, depth = 0, validateString) {
  if (depth > 16) throw new TypeError('json_depth');
  if (value === null) return 'null';
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { if (validateString) validateString(value); return JSON.stringify(value); }
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError('json_array');
    return '[' + Array.from(value, x => referenceJSON(x, depth + 1, validateString)).join(',') + ']';
  }
  if (value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(k => {
      if (validateString) validateString(k);
      return JSON.stringify(k) + ':' + referenceJSON(value[k], depth + 1, validateString);
    }).join(',') + '}';
  }
  throw new TypeError('json_value');
}
const referenceBranch = (left, right) => {
  const bytes = new Uint8Array(65); bytes[0] = 2;
  bytes.set(referenceHex(left), 1); bytes.set(referenceHex(right), 33);
  return bytesToHex(sha256(bytes));
};
const digest = value => bytesToHex(sha256(utf8ToBytes(value)));
function referenceRoot(entries) {
  const empty = new Array(257); empty[256] = digest('dmw-account-empty-v2');
  for (let d = 255; d >= 0; d--) empty[d] = referenceBranch(empty[d + 1], empty[d + 1]);
  const walk = (rows, d) => {
    if (!rows.length) return empty[d];
    if (d === 256) return digest('dmw-account-leaf-v2|' + rows[0][0] + '|' + referenceJSON(rows[0][1]));
    const left = [], right = [];
    for (const row of rows) ((parseInt(row[0][Math.floor(d / 4)], 16) >> (3 - d % 4)) & 1 ? right : left).push(row);
    return referenceBranch(walk(left, d + 1), walk(right, d + 1));
  };
  return walk([...entries].filter(([, value]) => value !== null), 0);
}

test('lookup hex decoder preserves bytes, validation and independent mutable results', () => {
  const outcome = (fn, value) => { try { return { value: fn(value) }; } catch (e) { return { error: [e.name, e.message] }; } };
  for (let i = 0; i < 256; i++) {
    const value = i.toString(16).padStart(2, '0');
    assert.deepEqual(hexToBytes(value), referenceHex(value));
    assert.deepEqual(hexToBytes(value.toUpperCase()), referenceHex(value));
  }
  for (const value of ['', 'a', 'abc', '  ', '0x12', '0g', 'g0', '00ffzz', 'é0', '0é', '\u00800', '\ud8000', '0\uff10', null, undefined, 1, [], new String('00')]) {
    assert.deepEqual(outcome(hexToBytes, value), outcome(referenceHex, value));
  }
  const a = hexToBytes('deadbeef'); a.fill(0);
  assert.equal(bytesToHex(hexToBytes('deadbeef')), 'deadbeef');
});

test('canonical encoding preserves bytes, callbacks, mutation and depth checks', () => {
  const special = ['a', '"', '\\', '\n', '\u0000', 'é', '😀', '\ud800', '\udc00', '\u2028', 'x'.repeat(129)];
  for (let i = 0; i < 5000; i++) {
    const value = { z: [i, true, null, false, special[i % special.length]], [String(i)]: 'ab'.repeat(32) };
    const before = [], after = [];
    assert.equal(canonicalJSON(value, 0, x => after.push(x)), referenceJSON(value, 0, x => before.push(x)));
    assert.deepEqual(after, before);
    assert.equal(canonicalJSON(value), referenceJSON(value));
  }
  const inner = { x: 1 }, value = Object.freeze({ inner });
  canonicalJSON(value); inner.x = 2;
  assert.equal(canonicalJSON(value), referenceJSON(value));
  const iterable = [1, 2]; Object.defineProperty(iterable, Symbol.iterator, { value: function* () { yield 'custom'; } });
  assert.equal(canonicalJSON(iterable), referenceJSON(iterable));
  const nullObject = Object.assign(Object.create(null), { 2: 'two', 10: 'ten', a: null });
  assert.equal(canonicalJSON(nullObject), referenceJSON(nullObject));
  let n = 0; const getter = Object.freeze({ get x() { return ++n; } });
  assert.equal(canonicalJSON(getter), '{"x":1}'); assert.equal(canonicalJSON(getter), '{"x":2}');
  for (const value of [undefined, NaN, Infinity, -0, 1.5, 1n, new Date(), [, 1], { a: undefined }]) assert.throws(() => canonicalJSON(value));
  let nested = {}; for (let i = 0; i < 17; i++) nested = { nested };
  assert.throws(() => canonicalJSON(nested), /json_depth/);
  canonicalJSON('\ud800'); assert.throws(() => stableJSON('\ud800'), /unicode_surrogate/);
});

test('cold, warm and overwritten account paths match the uncached root and signed digest oracle', () => {
  const entries = new Map(Array.from({ length: 24 }, (_, i) => [accountKey('balance', String(i)), { amount: String(i), owner: 'ab'.repeat(32) }]));
  const tree = accountTree(entries), old = referenceRoot(entries);
  assert.equal(tree.root, old);
  const keys = [...entries.keys()].slice(0, 8), proof = tree.prove(keys);
  const replacements = new Map(keys.map((key, i) => [key, i % 2 ? { amount: String(i + 30), owner: 'cd'.repeat(32) } : null]));
  const next = referenceRoot(new Map([...entries, ...replacements]));
  const check = () => {
    assert.equal(accountTree(entries).root, old);
    assert.deepEqual(accountTree(entries).prove(keys), proof);
    assert.equal(verifyAccountProof(old, proof, replacements), next);
    assert.equal(verifyAccountProof(old, proof, new Map(keys.map(key => [key, entries.get(key)]))), old);
    const batch = { v: 2, n: '17', root: next, ops: [{ proof }], sig: 'ignored' }, { sig, ...unsigned } = batch;
    assert.equal(bytesToHex(batchDigest('test', batch)), digest('dmw-batch-v2|test|' + referenceJSON(unsigned)));
    batch.ops[0].proof = { empty: true };
    const { sig: changedSig, ...changed } = batch;
    assert.equal(bytesToHex(batchDigest('test', batch)), digest('dmw-batch-v2|test|' + referenceJSON(changed)));
  };
  check(); check();
  for (let i = 0; i < 33000; i++) {
    const left = i.toString(16).padStart(64, '0'), right = 'ab'.repeat(32);
    assert.equal(accountBranch(left, right), referenceBranch(left, right));
  }
  check();
  assert.equal(accountBranch('ab'.repeat(32).toUpperCase(), 'cd'.repeat(32)), referenceBranch('ab'.repeat(32).toUpperCase(), 'cd'.repeat(32)));
  assert.throws(() => accountBranch('zz'.repeat(32), 'cd'.repeat(32)));
});

test('account cache slot collisions compare both full child strings', () => {
  const a = '0000' + '11'.repeat(30), b = '0000' + '22'.repeat(30);
  const c = 'abcd' + '33'.repeat(30), d = 'abcd' + '44'.repeat(30);
  for (const [left, right] of [[a,c], [b,c], [a,d], [b,d], [a,c]]) {
    assert.equal(accountBranch(left, right), referenceBranch(left, right));
  }
});
