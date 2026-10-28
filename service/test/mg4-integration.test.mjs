import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { BitcoinViews } from '../prod/bitcoin.mjs';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Feeds } from '../src/feeds.mjs';
import { LocalHeaders, localHeaderHandler } from '../src/local-headers.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { rules } from '../src/rules.mjs';
import { heightKey } from '../src/util.mjs';
import { temp } from './helpers.mjs';

for (const integerVersion of [1, 2]) test(`shared header seed checkpoint and reopen, integer schema ${integerVersion}`, async t => {
  const root = await temp(), filename = join(root, 'seed.bin'), db = join(root, 'headers.sqlite');
  const bytes = Buffer.from((await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  await writeFile(filename, bytes, { mode: 0o600 });
  let views = new BitcoinViews({}, db, { integerVersion, settings: { seedChunkRows: 8 } }); t.after(() => views.close());
  await views.seed(filename); assert.equal(views.seedWork.headers, 64);
  views.close(); views = new BitcoinViews({}, db, { integerVersion });
  await views.seed(filename); assert.equal(views.seedWork.bytes, 0); assert.equal(views.seedWork.headers, 0);
  const tip = rules.parseHeader(bytes.subarray(63 * 80).toString('hex')).hash;
  assert.equal((await views.view(integerVersion === 2 ? '63' : 63, tip)).hashAt(integerVersion === 2 ? '3' : 3), rules.parseHeader(bytes.subarray(3 * 80, 4 * 80).toString('hex')).hash);
  const changed = Buffer.from(bytes); changed[20 * 80 + 76] ^= 1; await writeFile(filename, changed);
  await assert.rejects(views.seed(filename), /bitcoin_pow/);
});

test('scoped projections and local public header routes retain decimal heights beyond SQL integers', async t => {
  const root = await temp(), store = await Store.open(root); t.after(() => store.close());
  const block = '9223372036854775808', next = rules.nextUint(block), asset = 'p2:9007199254740993';
  const raw = (await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim().slice(0, 160), hash = rules.parseHeader(raw).hash;
  await store.transact([{ space: 'meta', id: 'ruleState', value: { batchVersion: 2, counted: next } },
    { space: 'meta', id: 'headerHeight', value: next }, ...[block, next].map(height => ({ space: 'headers', id: heightKey(height), value: { hash, raw } })),
    { space: 'headerObjects', id: hash, value: { raw } },
    { space: 'feedEvents', id: 'large', value: { height: next, tip: next, occurrences: [block, next].map(block => ({ block, asset, pattern: asset.slice(3), count: '1', hash })) } }]);
  const files = new Files(join(root, 'static')), feeds = new Feeds({ store, files, history: { get() { throw Error('unexpected source read'); } }, reads: {}, settings: { feedEventRows: 1 } });
  while (store.hasRows('feedEvents')) await feeds.events();
  const api = createPublicAPI({ views: { store }, files });
  const first = await api.read(`/patterns/${asset}/claimed-blocks?limit=1`);
  assert.equal(first.rows[0].height, block);
  const second = await api.read(`/patterns/${asset}/claimed-blocks?` + new URLSearchParams({ limit: '1', cursor: first.nextCursor }));
  assert.equal(second.rows[0].height, next);
  const local = new LocalHeaders(join(root, 'index.sqlite')); t.after(() => local.close());
  const server = createServer(localHeaderHandler(local, { pageRows: 2 }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(origin + '/api/blocks/tip/height')).text(), next);
  assert.equal(await (await fetch(origin + '/api/block-height/' + block)).text(), hash);
  assert.deepEqual((await (await fetch(origin + '/api/blocks/' + next)).json()).map(row => row.height), [next, block]);
});


test('explicit decimal bootstrap has a separate checkpoint from the retained legacy layout', async t => {
  const root = await temp(), filename = join(root, 'seed.bin'), db = join(root, 'headers.sqlite');
  const bytes = Buffer.from((await readFile(new URL('../../kit/test/fixtures/mainnet-64.hex', import.meta.url), 'utf8')).trim(), 'hex');
  await writeFile(filename, bytes, { mode: 0o600 });
  let views = new BitcoinViews({}, db); t.after(() => views.close());
  await views.seed(filename); views.close();
  views = new BitcoinViews({}, db, { integerVersion: 2 }); await views.seed(filename);
  assert.equal(views.seedWork.headers, 64); assert.ok(views.seedWork.bytes > 0);
  views.close(); views = new BitcoinViews({}, db, { integerVersion: 2 }); await views.seed(filename);
  assert.equal(views.seedWork.bytes, 0);
  views.close(); views = new BitcoinViews({}, db); await views.seed(filename); assert.equal(views.seedWork.bytes, 0);
});
