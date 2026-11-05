import test from 'node:test';
import assert from 'node:assert/strict';
import { hashObject, stableJSON, utf8, unicode } from '../src/core.js';
import { canonicalJSON } from '../../contract/signing.js';
import { NamedStorage } from '../src/named-storage.js';
import { IndexRowCache, immutableIndexRow, indexRowBytes, indexRowHash, indexRowCommitment } from '../src/index-row-cache.js';

const leaf = value => {
  const row = { prefix: 'ab', key: 'key', value };
  row.commitment = hashObject(['dmw-named-leaf-v2', row.prefix, row.key, row.value]);
  return row;
};
test('memoized rows are deeply immutable and preserve canonical bytes and authentication', () => {
  for (const value of [null, false, 0, { nested: ['é', { key: '😀' }] }]) {
    const row = immutableIndexRow(leaf(value));
    assert.equal(indexRowBytes(row), utf8(stableJSON(row)).length);
    assert.equal(indexRowHash(row), hashObject(['dmw-stored-index-v2', row]));
    assert.equal(indexRowCommitment(row), row.commitment);
    assert.ok(Object.isFrozen(row));
    if (value && typeof value === 'object') {
      assert.ok(Object.isFrozen(row.value.nested[1]));
      assert.throws(() => { row.value.nested[1].key = 'changed'; }, TypeError);
    }
    const storage = new NamedStorage({ get: () => row, cacheSize: 1 });
    assert.equal(storage.row(indexRowHash(row)), row);
    assert.throws(() => storage.row('0'.repeat(64)), /named_storage_integrity/);
  }
});
test('mutable adapters are reauthenticated after eviction and bad commitments remain errors', () => {
  const row = leaf({ n: 1 }), other = leaf({ n: 2 }), id = indexRowHash(row), otherId = indexRowHash(other);
  const storage = new NamedStorage({ get: key => key === id ? row : other, cacheSize: 1 });
  storage.row(id); storage.row(otherId); row.value.n = 3;
  assert.notEqual(indexRowHash(row), id);
  assert.throws(() => storage.row(id), /named_storage_integrity/);
  const malformed = immutableIndexRow({ ...other, commitment: '0'.repeat(64) });
  assert.throws(() => new NamedStorage({ get: () => malformed, cacheSize: 1 }).row(indexRowHash(malformed)), /named_storage_commitment/);
});
test('row cache bounds canonical bytes and count, refreshes recency and does not retain oversize rows', () => {
  const rows = [1, 2, 3].map(n => leaf({ n })), size = indexRowBytes(rows[0]);
  const cache = new IndexRowCache(2, size * 2);
  cache.set('a', rows[0]); cache.set('b', rows[1]); assert.equal(cache.get('a'), rows[0]);
  cache.set('c', rows[2]); assert.equal(cache.get('b'), undefined); assert.equal(cache.rows.size, 2); assert.equal(cache.bytes, size * 2);
  cache.set('a', leaf('x'.repeat(size * 3))); assert.equal(cache.get('a'), undefined); assert.equal(cache.rows.size, 1); assert.equal(cache.bytes, size);
  cache.set('missing', undefined); assert.equal(cache.rows.size, 1);
  for (const args of [[0, 1], [1, 0], [Infinity, 1], [1, 1.5]]) assert.throws(() => new IndexRowCache(...args), /index_row_cache_setting/);
});

test('cached nesting depths preserve canonical validation in every enclosing depth', () => {
  const rows = [{}, [], { empty: [], nested: { value: 'é' }, mixed: [null, { value: true }] }, Object.create(null)];
  let chain = { value: 0 };
  for (let n = 0; n < 18; n++) { rows.push(chain); chain = n % 2 ? [chain] : { child: chain }; }
  for (const value of rows) {
    const row = immutableIndexRow(value);
    for (const depth of [...Array(19).keys(), ...Array(19).keys()].reverse()) {
      let expected, error;
      try { expected = utf8(canonicalJSON(row, depth, unicode)).length; } catch (e) { error = e; }
      if (error) assert.throws(() => indexRowBytes(row, depth), { name: error.name, message: error.message });
      else assert.equal(indexRowBytes(row, depth), expected);
    }
  }
});
