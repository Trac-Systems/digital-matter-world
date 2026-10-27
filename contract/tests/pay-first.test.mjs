import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, alice, bob, signedRequest, nonce, deployment, invariants } from './helpers/harness.mjs';
import { bytesToHex, requestDigest } from '../signing.js';
const rq = (n, expires = 20, amount = '60') => signedRequest('rq', { owner:alice.address, asset:'a', amount, receive:nonce(9), nonce:nonce(n), until:10000, expires });
const id = r => bytesToHex(requestDigest(deployment.network, 'rq', r.request));
const consume = (r, key = nonce(20)) => ({op:'mc',id:id(r),permitHash:nonce(21),payments:[{key,amount:'100',total:'100'}]});

test('seen payment pins escrow beyond expiry; consumption is once and survives a very late mint', async () => {
  const h=harness(); await h.mint(['a']); const r=rq(1); await h.tickBatch([r]);
  assert.equal(await h.tickBatch([{op:'mp',id:id(r)}]),null);
  await h.advance(30);
  assert.equal(await h.state().balance(1,'a'),'40'); assert.equal((await h.state().mint(id(r))).s,0);
  assert.equal(await h.run('rx',{id:id(r)},bob.address),'mint_payment_seen');
  assert.equal(await h.batch([consume(r)]),null);
  assert.equal(await h.tickBatch([consume(r)]),null);
  assert.equal(h.db.get('pay/'+nonce(20)).used,'100');
  await h.advance(100);
  assert.equal(await h.state().balance(1,'a'),'40');
  assert.equal(await h.batch([{op:'rl',id:id(r),inscription:nonce(7)+'i0'}]),null);
  invariants(h.db,0,h.supply);
});
test('late payment re-reserves only available units and cannot reuse consumed fee items', async () => {
  const h=harness(); await h.mint(['a']); const r=rq(1); await h.tickBatch([r]); await h.advance(30);
  assert.equal(await h.state().balance(1,'a'),'100');
  assert.equal(await h.run('rx',{id:id(r)}),null);
  assert.equal((await h.state().mint(id(r))).s,2);
  assert.equal(await h.batch([{op:'mp',id:id(r)}]),null);
  assert.equal(await h.state().balance(1,'a'),'40');
  assert.equal(await h.tickBatch([consume(r)]),null);
  const second=rq(2,100,'40'); await h.tickBatch([second]); await h.tickBatch([{op:'mp',id:id(second)}]);
  assert.equal(await h.tickBatch([consume(second)]),'payment_reused');
  assert.equal((await h.state().mint(id(second))).s,0);
  assert.equal(await h.batch([consume(second,nonce(22))]),null);
  invariants(h.db,0,h.supply);
});
test('spent expired units cannot be re-reserved and no permit commitment is recorded', async () => {
  const h=harness(); await h.mint(['a']); const r=rq(1); await h.tickBatch([r]); await h.advance(30);
  assert.equal(await h.run('tf',{to:bob.address,assets:[['a','100']]}),null);
  const before=structuredClone(h.db);
  assert.equal(await h.batch([{op:'mp',id:id(r)}]),'balance'); assert.deepEqual(h.db,before);
  assert.equal(await h.batch([consume(r)]),'mint_payment_missing');
  invariants(h.db,0,h.supply);
});
