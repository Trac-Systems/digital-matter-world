import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Feeds } from '../src/feeds.mjs';
import { claimedPage, claimedPatternPage } from '../src/claimed-feeds.mjs';
import { temp, agent } from './helpers.mjs';
import { rules } from '../src/rules.mjs';
import { heightKey } from '../src/util.mjs';
import { createPublicAPI } from '../src/public-api.mjs';

test('dense found/minted pages use compact bitsets and bounded detail with no history search', async () => {
  const directory = await temp(), store = await Store.open(directory), files = new Files(join(directory, 'static')), who = agent().address;
  try {
    const ops = [];
    for (let block = 0; block < 256; block++) {
      ops.push({ space: 'claimed/p0', id: heightKey(block), value: { pattern: 0, count: 3, hash: rules.hash(String(block)), found: true, minted: true } },
        { space: 'finds', id: rules.findId(block, 0), value: { block, pattern: 0, finder: who, findHeight: 300, count: 3 } },
        { space: 'minted', id: `p0/${block}`, value: rules.hash(String(block)) + 'i0' }, { space: 'links', id: heightKey(block), value: { block, linkHeight: 100 } });
    }
    await store.transact(ops);
    const publication = await claimedPatternPage({ store, files, pattern: { number: 0 }, page: 0 });
    const manifest = JSON.parse(await readFile(files.path(publication.path.slice(1))));
    assert.equal(manifest.found, 'ff'.repeat(32)); assert.equal(manifest.minted, 'ff'.repeat(32)); assert.ok(manifest.details.length > 1);
    let count = 0; for (const detail of manifest.details) { assert.ok(detail.bytes <= 60000); count += JSON.parse(await readFile(files.path(detail.path.slice(1)))).rows.length; }
    assert.equal(count, 256);
    const small = await claimedPatternPage({ store, files, pattern: { number: 0 }, page: 0, settings: { publicPageBytes: 1024 } });
    const compact = JSON.parse(await readFile(files.path(small.path.slice(1)))); let visited = 0;
    const visit = async ref => { assert.ok(ref.bytes <= 1024); const value = JSON.parse(await readFile(files.path(ref.path.slice(1))));
      if (value.rows) visited += value.rows.length; else for (const child of value.children) await visit(child); };
    for (const ref of compact.details) await visit(ref); assert.equal(visited, 256);
    const first = claimedPage(store, 'p0', new URLSearchParams('limit=64&found=true')); assert.equal(first.rows.length, 64); assert.equal(first.knownMatchCount, 256);
    const api = createPublicAPI({ views: { store }, files, settings: { publicPageBytes: 1200, patternDetailRows: 128 } });
    let cursor = null, seen = [];
    do {
      const page = await api.read('/patterns/p0/claimed-blocks?' + new URLSearchParams({ limit: '128', found: 'true', ...(cursor ? { cursor } : {}) }));
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 1200); seen.push(...page.rows.map(r => r.height)); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, Array.from({ length: 256 }, (_, i) => i));
    await store.put('claimedRevision', 'p0', 1);
    assert.throws(() => claimedPage(store, 'p0', new URLSearchParams({ cursor: first.nextCursor, found: 'true' })), /cursor_stale/);
    const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT height FROM claimedBlocks WHERE asset=? AND found=? AND height>? ORDER BY height LIMIT ?').all('p0', 1, -1, 64);
    assert.match(JSON.stringify(plan), /SEARCH.*claimedBlocksFound/);
  } finally { await store.close(); }
});

test('v3 public catalog and agent pages seek persisted keys without legacy aggregate views', async () => {
  const store = await Store.open(await temp());
  try {
    await store.put('meta', 'ruleState', { batchVersion: 2 });
    const ops = [];
    for (let i = 0; i < 300; i++) ops.push({ space: 'catalogPatterns', id: 'p' + i.toString(36), value: { number: i, name: 'pattern' + i } },
      { space: 'catalogAgents', id: agent(i).address, value: { address: agent(i).address, findCount: i } });
    await store.transact(ops);
    const api = createPublicAPI({ views: { store, catalog: () => { throw Error('legacy_scan'); }, indexed: () => { throw Error('legacy_scan'); } }, files: {}, settings: { publicPageBytes: 1200 } });
    for (const [route, key] of [['/patterns', 'patterns'], ['/agents', 'agents']]) {
      let cursor = null, count = 0;
      do { const result = await api.read(route + '?' + new URLSearchParams({ limit: '31', ...(cursor ? { cursor } : {}) })); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1200); count += result[key].length; cursor = result.nextCursor; } while (cursor);
      assert.equal(count, 300);
    }
    assert.equal((await api.read('/patterns/p0/blocks')).deprecated, true);
  } finally { await store.close(); }
});
test('feed event chunks survive restart, deduplicate dirty pages and finish past the first page', async () => {
  const directory = await temp(), files = new Files(join(directory, 'static')); let store = await Store.open(directory);
  const history = { get: height => ({ hash: rules.hash(String(height)) }) }, finds = {};
  for (let i = 0; i < 500; i++) finds[rules.findId(i, 0)] = { block: i, pattern: 0, asset: 'p0', count: 1, finder: agent(i).address, findHeight: 502 };
  const options = { files, history, reads: {}, settings: { projectionVersion: 3, feedEventRows: 47 } };
  await store.put('feedEvents', 'event', { height: 502, tip: 502, finds, discoveries: [], types: {} });
  await new Feeds({ ...options, store }).events(); await new Feeds({ ...options, store }).events(); await store.close(); store = await Store.open(directory);
  try {
    const feeds = new Feeds({ ...options, store }); let ticks = 0;
    while (store.count('feedEvents')) { await feeds.events(); assert.ok(++ticks < 40); }
    assert.equal(store.count('claimed/p0'), 500); assert.equal(store.count('feedPages'), 2); assert.equal(store.get('feedEventComplete', 'event'), true);
    await feeds.events(); assert.equal(store.count('claimed/p0'), 500);
  } finally { await store.close(); }
});
