import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import { Store } from '../src/store.mjs';
import { agent, temp } from './helpers.mjs';
import { bindingFixture } from './bindings-fixture.mjs';
import { bindingMessage, bindingNonceKey, verifyBinding } from '../../rules/src/payout-bindings.mjs';
import { signTestPayout } from './payout-wallets.mjs';

test('v2 renews a partial binding quorum without reusing a stale attempt or exhausting legacy nonce space', async t => {
  const store = await Store.open(await temp()); t.after(() => store.close());
  let now = Date.now(); const f = bindingFixture(store, { now: () => now }), who = agent(91);
  await f.bind(who, 'tap', who.secret.toString('hex'), '99999999999999999999'); now++;
  const packet = f.packet(who, 'tap', who.secret.toString('hex'), '1');
  packet.request = { ...packet.request, v: 2, nonce: '100000000000000000000' };
  const message = bindingMessage(f.bindings.network, 'regtest', packet.request);
  packet.agentSignature = Buffer.from(ed25519.sign(Buffer.from(message), who.secret)).toString('hex');
  packet.walletSignature = signTestPayout(message, who.secret.toString('hex'), 'tap', 'regtest');
  const { walletSignature, ...body } = packet, pending = await f.bindings.request(body), all = f.committee.bindPayout;
  f.committee.bindPayout = async record => { await f.endorse(record, 0); await f.endorse(record, 1); throw Error('outage'); };
  await assert.rejects(f.bindings.complete({ id: pending.id, walletSignature }), /outage/);
  const blockedAt = now; now += 60001; f.committee.bindPayout = all;
  await f.bindings.tick();
  const accepted = f.bindings.current(who.address, 'tap');
  assert.equal(accepted.request.v, 2); assert.equal(accepted.attempt, '1'); assert.equal(accepted.blockedAt, blockedAt);
  assert.equal(accepted.acceptedAt, now); assert.equal(accepted.attestations.length, 5);
  assert.deepEqual(verifyBinding(accepted, f.bindings.options()), accepted);
  assert.equal(store.get('payoutTransitions', who.address + '/tap'), null);
  const tampered = structuredClone(accepted); tampered.blockedAt++;
  assert.throws(() => verifyBinding(tampered, f.bindings.options()), /binding_attestation/);
  assert.throws(() => bindingMessage(f.bindings.network, 'regtest', { ...packet.request, v: 3 }), /binding_request/);
});

test('arbitrary-size versioned binding nonces have canonical numeric history order', () => {
  const values = ['1', '9', '10', '99', '100', '9'.repeat(20), '1' + '0'.repeat(20), '9'.repeat(100), '1' + '0'.repeat(100)];
  assert.deepEqual([...values].reverse().sort((a, b) => bindingNonceKey({ v: 2, nonce: a }) < bindingNonceKey({ v: 2, nonce: b }) ? -1 : 1), values);
});
