import test from 'node:test';
import assert from 'node:assert/strict';
import * as original from '../../rules/src/trac-address.js';
import { publicIdentities, encodeTracAddress, configurePublicIdentities } from '../src/public-identities.mjs';
import { BoundedLRU } from '../src/public-read-settings.mjs';

test('cached presentation preserves rule bytes, mutable inputs, and exclusions', () => {
  configurePublicIdentities({ identityCacheEntries: 2 });
  const owner = 'a'.repeat(64), value = { owner, route: '/agents/' + owner, n: 2n,
    owners: [owner], split: { owner }, feeQuote: { owner }, packet: { a: owner, network: 'test', t: 'x' } };
  assert.deepEqual(publicIdentities(value), original.publicIdentities(value));
  value.owner = 'b'.repeat(64);
  assert.deepEqual(publicIdentities(value), original.publicIdentities(value));
  for (const key of ['a', 'b', 'c', 'a']) assert.equal(encodeTracAddress(key.repeat(64)), original.encodeTracAddress(key.repeat(64)));
  assert.equal(encodeTracAddress(Buffer.alloc(32, 7)), original.encodeTracAddress(Buffer.alloc(32, 7)));
  assert.throws(() => encodeTracAddress('invalid'));
  configurePublicIdentities();
});
test('LRU evicts least recently used values and can be disabled', () => {
  const cache = new BoundedLRU(2); cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
  assert.equal(cache.get('b'), undefined); assert.equal(cache.get('a'), 1);
  const disabled = new BoundedLRU(0); disabled.set('x', 1); assert.equal(disabled.get('x'), undefined);
});

test('binding verification cache rejects altered certificates and trust contexts', async t => {
  const { Store } = await import('../src/store.mjs');
  const { bindingFixture } = await import('./bindings-fixture.mjs');
  const { agent, temp } = await import('./helpers.mjs');
  const { rm } = await import('node:fs/promises');
  const directory = await temp('binding-cache-'), store = await Store.open(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const { bindings, bind } = bindingFixture(store), record = await bind(agent(), 'tap');
  assert.deepEqual(bindings.proof(record.id), record);
  assert.deepEqual(bindings.proof(record.id), record);
  assert.equal(bindings.verifiedBindings.entries.size, 1);
  const damaged = structuredClone(record); damaged.attestations[0].sig = '0'.repeat(128);
  assert.throws(() => bindings.verify(damaged));
  assert.equal(bindings.verifiedBindings.entries.size, 1);
  bindings.members = [];
  assert.throws(() => bindings.proof(record.id));
});
