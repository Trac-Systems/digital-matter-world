import { assertPublicIdentities } from '../../rules/test/public-identities.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Feeds } from '../src/feeds.mjs';
import { rules } from '../src/rules.mjs';
import { temp, fixtureHistory, patterns, agent } from './helpers.mjs';
test('feed backfill covers history, refreshes indexed mint status, ranks records and indexes agent assets', async () => {
  const directory = await temp(), store = await Store.open(directory), files = new Files(join(directory, 'static')), history = fixtureHistory(520), owner = agent().address;
  const feeds = new Feeds({ store, files, history, reads: { balance: async () => '23' } });
  const find = { block: 100, pattern: 0, asset: 'p0', count: 3, finder: owner, findHeight: 103, window: 100 }, id = rules.findId(100, 0);
  try {
    await feeds.markAgent(owner, []);
    await store.transact([{ space: 'meta', id: 'patterns', value: patterns }, { space: 'finds', id, value: find },
      { space: 'feedEvents', id: '0000000000000103', value: { height: 103, tip: 108, finds: { [id]: find }, types: {}, discoveries: [] } }]);
    for (let i = 0; i < 3; i++) await feeds.tick();
    const manifest = JSON.parse(await readFile(files.path('patterns/p0/index.json'), 'utf8')); assert.equal(manifest.pages, 3); assert.equal(manifest.availableThroughPage, 2);
    const rankings = JSON.parse(await readFile(files.path('records/index.json'), 'utf8')); assert.equal(rankings.allTime[0].id, id);
    assert.deepEqual(store.list('agentAssets/' + owner).map(r => r.id), ['p0']);
    await store.put('minted', 'p0/100', 'ab'.repeat(32) + 'i0'); await feeds.markBlock(100, 'p0'); await feeds.tick();
    const pointer = JSON.parse(await readFile(files.path('patterns/p0/0.json'), 'utf8')), page = JSON.parse(await readFile(files.path(pointer.path.slice(1)), 'utf8'));
    assert.equal(page.v, 2); assert.ok(page.rows.length <= 256);
    assert.equal(page.rows.find(r => r.block === 100).found, true);
    assert.equal(page.rows.find(r => r.block === 101).found, false);
    assert.ok(page.rows.every(row => !Object.hasOwn(row, 'opened')));
    assertPublicIdentities(page); assertPublicIdentities(rankings); assert.equal(page.rows.find(r => r.block === 100).finder, encodeTracAddress(owner));
    assert.equal(page.rows.find(r => r.block === 100).minted, 'ab'.repeat(32) + 'i0'); assert.equal(store.count('feedPages'), 0);
  } finally { await store.close(); }
});
