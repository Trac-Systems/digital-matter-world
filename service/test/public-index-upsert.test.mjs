import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { publicReadIndex } from '../src/public-index.mjs';
import { temp } from './helpers.mjs';

test('public invalidation coalesces repeated store upserts without poisoning the writer', async () => {
  const store = await Store.open(await temp('public-upsert-'));
  try {
    publicReadIndex({ store });
    await store.put('meta', 'patterns', []);
    await store.put('meta', 'patterns', [{ number: 1 }]);
    await store.transact([{ space: 'headers', id: '1', value: { height: 1 } }, { space: 'headers', id: '1', value: { height: 1, changed: true } }]);
    assert.equal(store.failed, undefined);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM publicReadChanges').get().n, 2);
    assert.equal(store.get('headers', '1').changed, true);
  } finally { await store.close(); }
});
