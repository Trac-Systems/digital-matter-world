import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayNodeCache, replayNodeCaches } from '../signer/replay-node-cache.mjs';
import { indexRowBytes } from '../../rules/src/index-row-cache.js';

test('bridge eviction tracking follows LRU, byte limits and movement between cache tiers', () => {
  const evicted = new Set(), row = { value: 'one' }, bytes = indexRowBytes(row);
  const demand = new ReplayNodeCache(2, bytes * 2, evicted), prefetch = new ReplayNodeCache(3, bytes * 2, evicted);
  demand.set('a', row); demand.set('b', row); demand.get('a'); demand.set('c', row);
  assert.deepEqual([...evicted], ['b']); assert.deepEqual([...demand.rows.keys()], ['a', 'c']);
  prefetch.set('d', row); prefetch.set('e', row); prefetch.set('f', row);
  assert.deepEqual([...evicted], ['b', 'd'], 'byte eviction is reported even below the entry bound');
  const moved = prefetch.get('e'); prefetch.delete('e'); demand.set('e', moved);
  assert.equal(evicted.has('e'), false); assert.equal(evicted.has('a'), true);
  assert.equal(demand.bytes, bytes * 2); assert.equal(prefetch.bytes, bytes);
  demand.set('oversized', { value: 'x'.repeat(100) });
  assert.equal(demand.has('oversized'), false); assert.equal(evicted.has('oversized'), true);
  assert.throws(() => prefetch.set('invalid', { invalid: undefined }), /json_value/);
  assert.equal(evicted.has('invalid'), true);
  demand.set('b', row); assert.equal(evicted.has('b'), false, 'retransmitted rows become held again');
});

test('demand priority preserves the total configured row and byte ceilings', () => {
  for (const [entries, bytes, totalEntries, totalBytes] of [
    [4096, 6000000, 20480, 30000000], [1, 100, 5, 500], [131072, 67108864, 196608, 134217728]
  ]) {
    const { nodes, prefetched } = replayNodeCaches(entries, bytes, new Set());
    assert.equal(nodes.entries + prefetched.entries, totalEntries);
    assert.equal(nodes.limit + prefetched.limit, totalBytes);
    assert.ok(nodes.entries >= entries && nodes.entries >= prefetched.entries);
    assert.ok(nodes.limit >= prefetched.limit);
  }
});
