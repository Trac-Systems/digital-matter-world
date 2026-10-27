import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, alice, bob, signedRequest, signedBatch, nonce } from './helpers/harness.mjs';
import { FUNCTIONS } from '../state.js';

test('every function rejects malformed JSON values without changes or exceptions', async () => {
  const h = harness(); await h.mint(); const original = structuredClone(h.db);
  for (const type of FUNCTIONS) for (const value of [null, true, false, 0, '', [], {}, { unexpected: true }]) {
    assert.equal(typeof await h.run(type, value), 'string', type); assert.deepEqual(h.db, original, type);
  }
});
test('every batch operation refuses malformed payloads atomically', async () => {
  const h = harness(); await h.mint(); await h.advance(1);
  for (const op of ['mk', 'xc', 'rq', 'mp', 'mc', 'rl', 'rx', 'kv']) {
    const original = structuredClone(h.db);
    for (const entry of [{ op }, { op, unexpected: true }, { op, id: 1 }, { op, owner: alice.address, ids: [] }]) {
      assert.equal(typeof await h.batch([{ op: 'mk', to: alice.address, asset: 'z', amount: '1' }, entry]), 'string');
      assert.deepEqual(h.db, original);
    }
  }
});
test('asset budget counts both sides of exchanges atomically', async () => {
  const h = harness(); await h.mint(); await h.advance(1);
  h.db.set('s/current', { batch_assets: 2 });
  const request = { owner: alice.address, in: [['a','1']], out: [['b','1']], nonce: nonce(1), until: 100 };
  assert.equal(await h.batch([{op:'mk',to:alice.address,asset:'a',amount:'1'},signedRequest('xc',request)]), 'batch_assets');
  assert.equal(await h.batch([signedRequest('xc',request)]), null);
});
test('refused mint signature and late operation do not consume nonce', async () => {
  const h = harness(); await h.mint(); await h.advance(1);
  const request = {owner:alice.address,asset:'a',amount:'1',receive:nonce(9),nonce:nonce(1),until:100,expires:434};
  const good = signedRequest('rq',request);
  assert.equal(await h.batch([{...good,sig:'00'.repeat(64)}]), 'request_signature');
  assert.equal(await h.batch([good,{op:'rl',id:nonce(0),inscription:nonce(0)+'i0'}]), 'mint_not_consumed');
  assert.equal(await h.batch([good]), null);
});
test('admin cannot invoke arbitrary action IDs, remove authority or supply invalid keys', async () => {
  const h = harness();
  for (const [type, value] of [['ad_key', { key: '00'.repeat(33) }], ['ad_admin', { address: null }], ['ad_admin', { address: '' }],
    ['ad_set', { key: 'lock_min', value: '1' }], ['ad_apply', { id: '../admin' }], ['ad_apply', { id: 'set/__proto__' }],
    ['ad_pause', { on: 1 }]]) assert.equal(typeof await h.run(type, value), 'string');
  assert.equal(await h.state().admin(), alice.address);
});
test('wire size is bytes; unknown protocol versions and extra fields refuse', async () => {
  const h = harness(); await h.advance(6);
  const b = signedBatch({ n: 1, from: 1, to: 1, ops: [] });
  for (const value of [{ ...b, v: 2 }, { ...b, extra: 1 }, { ...b, root: 'ab' }]) assert.equal(await h.run('bt', value), 'batch');
  assert.equal(await h.run('bt', { x: 'é'.repeat(70000) }), 'size');
  assert.equal(await h.state().message('{"network":"x","network":"y","op":"hd","value":{}}', alice.address), 'message');
});
