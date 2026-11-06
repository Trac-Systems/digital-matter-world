import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotMemo } from '../src/snapshot-memo.mjs';

test('a snapshot read is reused for its key, read again after its time, and never keeps a failure', async () => {
  let clock = 0, reads = 0, fail = true;
  const memo = snapshotMemo({ ttlMs: 1000, limit: 2, now: () => clock });
  const read = () => { reads++; if (fail) throw Error('source_unavailable'); return 'verified'; };
  await assert.rejects(memo('a', read), /source_unavailable/);
  fail = false;
  assert.equal(await memo('a', read), 'verified', 'a failed read is not reused');
  assert.equal(await memo('a', read), 'verified'); assert.equal(reads, 2);
  assert.equal(await memo('b', read), 'verified'); assert.equal(reads, 3, 'another snapshot reads the source');
  clock = 1000; assert.equal(await memo('a', read), 'verified'); assert.equal(reads, 4, 'an old entry is read again');
  await memo('c', read); await memo('d', read); clock = 1001;
  await memo('a', read); assert.equal(reads, 7, 'the bound evicts the oldest entries');
});

test('concurrent reads of one snapshot share a single source read', async () => {
  let reads = 0, release;
  const memo = snapshotMemo(), gate = new Promise(resolve => release = resolve);
  const read = async () => { reads++; await gate; return 'verified'; };
  const both = Promise.all([memo('s', read), memo('s', read)]); release();
  assert.deepEqual(await both, ['verified', 'verified']); assert.equal(reads, 1);
});

test('missing and not-yet-indexed results are retried without evicting newer work', async () => {
  const memo = snapshotMemo(); let calls = 0;
  const read = () => ++calls < 3 ? null : 'indexed';
  assert.equal(await memo('id', read), null);
  assert.equal(await memo('id', read), null);
  assert.equal(await memo('id', read), 'indexed');
  assert.equal(await memo('id', read), 'indexed'); assert.equal(calls, 3);
  memo.clear(); await memo('id', read); assert.equal(calls, 4);
});

test('snapshot caches bound response bytes, including a single oversized read', async () => {
  let calls = 0; const memo = snapshotMemo({ maxBytes: 20 });
  const read = value => () => { calls++; return value; };
  await memo('a', read('12345678')); await memo('b', read('12345678'));
  await memo('a', read('12345678')); assert.equal(calls, 3);
  await memo('large', read('x'.repeat(100))); await memo('large', read('x'.repeat(100)));
  assert.equal(calls, 5);
});
