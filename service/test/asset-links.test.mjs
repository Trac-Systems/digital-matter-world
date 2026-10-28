import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Links } from '../src/links.mjs';
import { temp } from './helpers.mjs';
test('unavailable funded links free admission slots without erasing payment obligations', async t => {
  const store = await Store.open(await temp()); t.after(() => store.close());
  for (let i = 0; i < 300; i++) {
    const id = String(i).padStart(4, '0'), row = { id, request: { owner: 'owner-' + id, height: i, until: 10 }, paymentId: 'paid-' + id };
    await store.transact([{ space: 'linkIntents', id, value: row }, { space: 'linkRequests', id, value: row }, { space: 'activeLinks', id, value: true }]);
  }
  const links = new Links({ store, reads: { bitmap: async () => { throw Error('source_unavailable'); } } });
  for (let i = 0; i < 4; i++) assert.deepEqual(await links.inputs({ height: 11 }), []);
  assert.equal(store.count('activeLinks'), 0);
  assert.equal(store.count('linkRecovery'), 300);
  assert.equal(store.count('linkObligations'), 300);
  assert.equal(store.get('linkObligations', '0299').paymentId, 'paid-0299');
  assert.equal(store.get('linkStatus', '0299').state, 'recovery');
});
