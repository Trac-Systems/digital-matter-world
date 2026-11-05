import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { recordPage } from '../src/claimed-public.mjs';
import { temp } from './helpers.mjs';

test('a catalog cursor survives batches that only update pattern statistics and expires when a pattern is added', async t => {
  const store = await Store.open(await temp()); t.after(() => store.close());
  store.db.exec('UPDATE projectionControl SET ready=1 WHERE id=1');
  await store.transact([0, 1, 2, 3].map(n => ({ space: 'catalogPatterns', id: 'p2:' + n, value: { number: String(n), knownMatchCount: '1' } })));
  const read = cursor => recordPage(store, 'catalogPatterns', new URLSearchParams({ limit: '2', sort: 'number', ...(cursor ? { cursor } : {}) }), { key: 'patterns' });
  const first = read();
  // A batch rewrites statistics only: the traversal continues on the same revision.
  await store.put('catalogPatterns', 'p2:0', { number: '0', knownMatchCount: '9' });
  const second = read(first.nextCursor);
  assert.equal(second.revision, first.revision);
  assert.deepEqual([...first.patterns, ...second.patterns].map(p => p.number), ['0', '1', '2', '3']);
  // A new pattern changes the row set: the old cursor is refused and the reader starts over.
  await store.put('catalogPatterns', 'p2:4', { number: '4', knownMatchCount: '1' });
  assert.throws(() => read(first.nextCursor), /page_cursor_stale/);
  assert.notEqual(read().revision, first.revision);
});

test('the public pattern list in number order keeps its cursor across statistics updates', async t => {
  const { createPublicAPI } = await import('../src/public-api.mjs');
  const store = await Store.open(await temp()); t.after(() => store.close());
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: '974100' });
  const row = (n, count = '1') => ({ space: 'catalogPatterns', id: 'p2:' + n, value: { number: String(n), name: 'dmwpattern' + n, knownMatchCount: count } });
  await store.transact([0, 1, 2, 3].map(n => row(n)));
  const api = createPublicAPI({ views: { store } }), read = cursor => api.read('/patterns?' + new URLSearchParams({ sort: 'number', limit: '2', ...(cursor ? { cursor } : {}) }));
  const first = await read();
  await store.transact([row(1, '77')]);
  const second = await read(first.nextCursor);
  assert.equal(second.revision, first.revision);
  assert.deepEqual([...first.patterns, ...second.patterns].map(p => String(p.number)), ['0', '1', '2', '3']);
  await store.transact([row(4)]);
  await assert.rejects(read(first.nextCursor), /page_cursor_stale/);
  // A list sorted by a statistic keeps the per-batch revision.
  const bySupply = await api.read('/patterns?sort=supply&limit=2');
  await store.transact([row(2, '88')]);
  await assert.rejects(api.read('/patterns?' + new URLSearchParams({ sort: 'supply', limit: '2', cursor: bySupply.nextCursor })), /page_cursor_stale/);
});
