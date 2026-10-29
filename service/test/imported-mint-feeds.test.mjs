import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Feeds } from '../src/feeds.mjs';
import { claimedPage, claimedPatternPage } from '../src/claimed-feeds.mjs';
import { projectionReady, projectionRevision } from '../src/projection-state.mjs';
import * as r from '../../rules/src/index.js';

for (const ledger of ['p0', 'p2:0']) test(`accepted ${ledger} mint resumes public projection after restart without duplicating its ledger record`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rh2-mint-feed-'));
  let store = await Store.open(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const files = new Files(join(directory, 'static')), asset = 'p2:0', block = '1', key = r.uintKeyV2(block);
  const pattern = { number: '0', key: r.hash('pattern'), ...(ledger === 'p0' ? { legacy: { asset: ledger } } : {}) };
  await store.transact([
    { space: 'meta', id: 'ruleState', value: { batchVersion: 2 } },
    { space: 'patternsByAsset', id: asset, value: pattern },
    { space: 'claimed2/' + asset, id: key, value: { height: block, pattern: '0', count: '1', hash: r.hash('block'), found: false, minted: false } }
  ]);
  const before = projectionRevision(store, 'mintedAsset/' + asset), mint = { id: r.hash('request'), inscription: r.hash('inscription') + 'i0' };
  await store.transact([
    { space: 'minted', id: ledger + '/' + block, value: mint },
    { space: 'feedBlockChanges', id: 'mint/request', value: { block, asset: ledger } }
  ]);
  assert.notEqual(projectionRevision(store, 'mintedAsset/' + asset), before);
  assert.throws(() => projectionReady(store, 'claimed2/' + asset), /public_projection_pending/);
  await store.close(); store = await Store.open(directory);
  await new Feeds({ store, files, history: {}, reads: {} }).events();
  projectionReady(store, 'claimed2/' + asset, 'world', 'block/1');
  assert.equal(store.count('feedBlockChanges'), 0);
  const page = claimedPage(store, asset, new URLSearchParams('minted=true'));
  assert.equal(page.rows.length, 1); assert.equal(page.rows[0].minted, true); assert.deepEqual(page.rows[0].mint, mint);
  assert.equal(claimedPage(store, asset, new URLSearchParams('minted=false')).rows.length, 0);
  const ref = await claimedPatternPage({ store, files, pattern, asset, page: '0' });
  const manifest = JSON.parse(await readFile(files.path(ref.path.slice(1))));
  assert.equal(Buffer.from(manifest.minted, 'hex')[0] & 2, 2, 'published bitset includes the imported mint');
  assert.equal(store.db.prepare('SELECT mints FROM publicBlocksV2 WHERE height=?').get(block).mints, 1);
  assert.equal(store.count('minted'), 1, 'catalog alias is not a second mint');
});
