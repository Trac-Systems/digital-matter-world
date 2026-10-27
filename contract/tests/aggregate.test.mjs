import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, alice, bob, invariants } from './helpers/harness.mjs';

test('aggregate credits update one balance per agent/asset and a fixed finds commitment', async () => {
  const h = harness(); await h.advance(6);
  const root = 'ab'.repeat(32);
  assert.equal(await h.batch([{ op: 'ac', to: alice.address, assets: [['p0', '400'], ['p1', '25']] },
    { op: 'ac', to: bob.address, assets: [['p0', '900']] }, { op: 'kv', key: 'finds/batch/1', value: root }]), null);
  assert.equal(await h.state().balance(await h.state().agent(alice.address), 'p0'), '400');
  assert.equal(h.db.get('n/finds/batch/1'), root);
  assert.equal([...h.db.keys()].filter(k => k.startsWith('v/')).length, 3);
  assert.equal([...h.db.keys()].some(k => /^n\/(?:find\/|charter\/|open\/)/.test(k)), false);
  invariants(h.db, 0, h.supply);
});
test('malformed aggregate vectors and removed namespaces roll back all writes', async () => {
  const h = harness(); await h.advance(6);
  for (const assets of [[], [['p0', '0']], [['p0', '1'], ['p0', '2']], Array.from({ length: 17 }, (_, i) => ['p' + i, '1'])]) {
    const before = [...h.db]; assert.equal(await h.batch([{ op: 'ac', to: alice.address, assets }]), 'ac'); assert.deepEqual([...h.db], before);
  }
  for (const key of ['charter/1', 'open/cursor', 'open/mask']) assert.equal(await h.batch([{ op: 'kv', key, value: 'x' }]), 'kv_namespace');
});
