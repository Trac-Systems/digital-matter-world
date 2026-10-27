import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON, signingDigest, batchDigest, requestDigest, bytesToHex } from '../signing.js';
import { parseJSON } from '../json.js';
import { deployment } from './helpers/harness.mjs';

test('canonical JSON has stable nested key ordering and integer representation', () => {
  assert.equal(canonicalJSON({ z: [2, { b: 'é', a: null }], a: true }), '{"a":true,"z":[2,{"a":null,"b":"é"}]}');
  assert.equal(canonicalJSON(Object.assign(Object.create(null), { b: 2, a: 1 })), '{"a":1,"b":2}');
  for (const bad of [undefined, NaN, Infinity, -0, 0.1, 2 ** 53, 1n, new Date(), [undefined], Array(1), { x: undefined }]) assert.throws(() => canonicalJSON(bad));
  let nested = {}; for (let i = 0; i < 18; i++) nested = { nested }; assert.throws(() => canonicalJSON(nested));
});
test('JSON parser rejects duplicate and escape-equivalent keys, trailing input and excessive nesting', () => {
  for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{}null', '[1,]', '{"a":}', '1e999', '"\u0001"', '['.repeat(18) + ']'.repeat(18)]) assert.equal(parseJSON(input), undefined);
  assert.equal(parseJSON('12345', 4), undefined);
  assert.equal(parseJSON('{"__proto__":1}').__proto__, 1);
});
test('signatures bind network and operation domain; batch excludes only sig', () => {
  const request = { owner: 'ab'.repeat(32), asset: 'a', amount: '1', receive: 'ef'.repeat(32), expires: 100, nonce: '00'.repeat(32), until: 10 };
  const rq = bytesToHex(requestDigest(deployment.network, 'rq', request));
  assert.notEqual(rq, bytesToHex(requestDigest('foreign', 'rq', request)));
  assert.notEqual(rq, bytesToHex(requestDigest(deployment.network, 'xc', request)));
  assert.deepEqual(batchDigest(deployment.network, { v: 1, epoch: 0, sig: 'abc' }), batchDigest(deployment.network, { v: 1, epoch: 0, sig: 'def' }));
  assert.notDeepEqual(batchDigest(deployment.network, { v: 1, epoch: 0 }), batchDigest(deployment.network, { v: 1, epoch: 1 }));
  assert.notDeepEqual(batchDigest(deployment.network, { v: 1, epoch: 0, deadline: 36 }), batchDigest(deployment.network, { v: 1, epoch: 0, deadline: 37 }));
  assert.notEqual(rq, bytesToHex(requestDigest(deployment.network, 'rq', { ...request, expires: 101 })));
  assert.throws(() => signingDigest('unknown', deployment.network, {}));
  assert.throws(() => signingDigest('dmw-batch-v1', 'net|inject', {}));
  assert.throws(() => requestDigest(deployment.network, 'tf', {}));
});
