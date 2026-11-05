import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceStore } from '../evidence.mjs';
import * as r from '../../../rules/src/index.js';

function fixture(settings = {}) {
  const reader = new EvidenceStore({ config: { settings }, now: () => 0 });
  reader.payload = { id: 'test', observedAt: 0, expiresAt: 30000 };
  let calls = 0;
  const rows = Array.from({ length: 32 }, (_, n) => {
    const prefix = r.hash(String(n)), key = String(n), value = { n };
    const row = { prefix, key, value, commitment: r.hashObject(['dmw-named-leaf-v2', prefix, key, value]) };
    return [r.hashObject(['dmw-stored-index-v2', row]), row];
  });
  reader.exchange = async request => { calls++; return { nodes: [rows.find(([id]) => id === request.id), ...rows.filter(([id]) => id !== request.id)].slice(0, reader.settings.pageRows) }; };
  return { reader, rows, calls: () => calls };
}
test('a cached source page crosses the worker bridge without requiring exact hints', async () => {
  const { reader, rows, calls } = fixture();
  const first = await reader.replayNodes('claimNodes', rows[0][0], [], 128);
  assert.equal(first.length, rows.length); assert.deepEqual(first[0], rows[0]); assert.equal(calls(), 1);
  const second = await reader.replayNodes('claimNodes', rows[10][0], [], 7);
  assert.equal(second.length, 7); assert.deepEqual(second[0], rows[10]); assert.equal(calls(), 1);
  assert.equal((await reader.replayNodes('claimNodes', rows[1][0], [], 1)).length, 1);
  assert.ok(Buffer.byteLength(r.stableJSON(first)) <= reader.settings.chunkBytes);
  reader.now = () => 30000;
  await assert.rejects(reader.replayNodes('claimNodes', rows[0][0], [], 128), /evidence_missing_or_stale/);
});
test('page metadata is bounded by actual retained rows and malformed pages never enter it', async () => {
  const { reader, rows } = fixture({ pageRows: 4, prefetchCacheEntries: 8, nodeCacheEntries: 8 });
  for (const [id] of rows) {
    await reader.replayNodes('claimNodes', id, [], 4);
    assert.ok(reader.nodePageRows <= 8); assert.ok(reader.nodePageFor.size <= 8); assert.ok(reader.nodePages.size <= 8);
  }
  const before = reader.nodePageRows;
  reader.exchange = async request => ({ nodes: [[request.id, { value: 'forged' }]] });
  await assert.rejects(reader.replayNodes('claimNodes', r.hash('missing'), [], 4), /evidence_index_node_hash/);
  assert.equal(reader.nodePageRows, before);
});

test('replay pages reuse immutable rows while ordinary node readers receive independent copies', async () => {
  const { reader, rows, calls } = fixture();
  const first = await reader.replayNodes('claimNodes', rows[0][0], [], 128);
  const second = await reader.replayNodes('claimNodes', rows[0][0], [], 128);
  assert.equal(calls(), 1);
  for (let i = 0; i < first.length; i++) {
    assert.equal(first[i][1], second[i][1]);
    assert.ok(Object.isFrozen(first[i][1]) && Object.isFrozen(first[i][1].value));
  }
  const copy = await reader.claimNode(rows[0][0]);
  copy.value.n = -1;
  assert.deepEqual(await reader.claimNode(rows[0][0]), rows[0][1]);
  assert.deepEqual(await reader.replayNodes('claimNodes', rows[0][0], [], 128), first);
});

test('cached page sizes preserve exact UTF-8 boundaries and enforce depth and hash validation', async () => {
  const { reader, rows } = fixture();
  const key = 'unicode', prefix = r.hash(key), value = { text: 'é😀\n"\\'.repeat(30) };
  const row = { key, prefix, value, commitment: r.hashObject(['dmw-named-leaf-v2', prefix, key, value]) };
  const pair = [r.hashObject(['dmw-stored-index-v2', row]), row];
  rows[0] = pair;
  await reader.replayNodes('namedNodes', pair[0], [], 128);
  reader.settings.chunkBytes = Buffer.byteLength(r.stableJSON(rows.slice(0, 2)));
  const exact = await reader.replayNodes('namedNodes', pair[0], [], 128);
  assert.equal(exact.length, 2); assert.equal(Buffer.byteLength(r.stableJSON(exact)), reader.settings.chunkBytes);
  reader.settings.chunkBytes--;
  assert.equal((await reader.replayNodes('namedNodes', pair[0], [], 128)).length, 1);
  reader.exchange = async request => ({ nodes: [[request.id, { value: 'changed' }]] });
  await assert.rejects(reader.namedNode(r.hash('forged')), /evidence_index_node_hash/);
  let deep = 'leaf'; for (let n = 0; n < 15; n++) deep = { child: deep };
  const deepId = r.hashObject(['dmw-stored-index-v2', deep]);
  reader.settings.chunkBytes = 256000;
  reader.exchange = async () => ({ nodes: [[deepId, deep]] });
  await assert.rejects(reader.namedNode(deepId), /json_depth/);
});

test('worker-held neighbors are omitted until eviction without suppressing a demanded row or lease checks', async () => {
  const { reader, rows, calls } = fixture();
  reader.hintNodes('claimNodes', rows.map(([id]) => id));
  const held = new Set(rows.map(([id]) => 'claimNodes/' + id));
  const first = await reader.replayNodes('claimNodes', rows[0][0], [], 128, held);
  assert.deepEqual(first, [rows[0]]); assert.equal(calls(), 1);
  held.delete('claimNodes/' + rows[10][0]);
  assert.deepEqual(await reader.replayNodes('claimNodes', rows[0][0], [], 128, held), [rows[0], rows[10]]);
  assert.equal(calls(), 1);
  assert.equal((await reader.replayNodes('namedNodes', rows[0][0], [], 128, held)).length, rows.length, 'spaces do not alias');
  reader.now = () => 30000;
  await assert.rejects(reader.replayNodes('claimNodes', rows[0][0], [], 128, held), /evidence_missing_or_stale/);
});

test('held-row filtering scans only the next hint page even when later rows are cached', async () => {
  const { reader, rows } = fixture({ pageRows: 4 });
  for (const [id] of rows) await reader.claimNode(id);
  reader.hintNodes('claimNodes', rows.map(([id]) => id));
  const hint = reader.nodeHints.get('claimNodes/' + rows[0][0]); let visits = 0;
  hint.hints = new Proxy(hint.hints, { get(target, key) { if (/^[0-9]+$/.test(String(key))) visits++; return target[key]; } });
  const held = new Set(rows.slice(0, -1).map(([id]) => 'claimNodes/' + id));
  const page = await reader.replayNodes('claimNodes', rows[0][0], [], 128, held);
  assert.deepEqual(page[0], rows[0]); assert.ok(visits <= reader.settings.pageRows);
  assert.ok(page.slice(1).every(([id]) => !held.has('claimNodes/' + id)));
});

test('consumed worker neighbors enter the existing demand cache and survive source-page churn and refresh', async () => {
  const { reader, rows, calls } = fixture({ nodeCacheEntries: 8, prefetchCacheEntries: 8 });
  await reader.replayNodes('claimNodes', rows[0][0], [], 128);
  const consumed = 'claimNodes/' + rows[31][0];
  assert.equal(reader.prefetchCache.has(consumed), true); assert.equal(reader.nodeCache.has(consumed), false);
  await reader.replayNodes('claimNodes', rows[0][0], [], 128, undefined, [consumed, 'claimNodes/' + r.hash('absent')]);
  assert.equal(reader.nodeCache.has(consumed), true); assert.equal(reader.prefetchCache.has(consumed), false);
  for (const [id] of rows.slice(1, 4)) await reader.claimNode(id);
  assert.ok(reader.nodeCache.size <= 8 && reader.prefetchCache.size <= 8);
  reader.payload = { id: 'next', observedAt: 0, expiresAt: 30000 };
  const before = calls(); assert.deepEqual(await reader.claimNode(rows[31][0]), rows[31][1]); assert.equal(calls(), before);
  reader.now = () => 30000;
  await assert.rejects(reader.replayNodes('claimNodes', rows[0][0], [], 128, undefined, [consumed]), /evidence_missing_or_stale/);
});
