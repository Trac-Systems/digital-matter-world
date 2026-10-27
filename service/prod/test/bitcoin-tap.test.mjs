import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { BitcoinSource, BitcoinViews, verifyMerkle } from '../bitcoin.mjs';
import { TapReader } from '../tap.mjs';
import { HttpSource } from '../http.mjs';
import { GENESIS } from '../../../contract/beacon/bitcoin.js';
import { mockServer, temporary, json, body, genesis, genesisTx, genesisTxid } from './helpers.mjs';

test('verified header views seed offline, preserve old branches and bound catch-up work', async t => {
  const root = await temporary(t), file = join(root, 'headers.bin'); await writeFile(file, Buffer.from(genesis, 'hex'), { mode: 0o600 });
  const views = new BitcoinViews({ header: async () => genesis }, join(root, 'headers.sqlite'), { maxHeadersPerView: 2 }); t.after(() => views.close());
  await views.seed(file); const view = await views.view(0, GENESIS.hash); assert.equal(view.hashAt(0), GENESIS.hash); assert.equal(view.field(0, 10), '2083236893');
  assert.throws(() => views.insert(genesis.slice(0, -2) + '00', 1, views.get.get(GENESIS.hash)), /bitcoin_pow/);
  await assert.rejects(views.view(2, GENESIS.hash), /bitcoin_header_height/);
  const limited = new BitcoinViews({ header: async () => genesis }, ':memory:', { maxHeadersPerView: 0 }); t.after(() => limited.close()); await assert.rejects(limited.view(0, GENESIS.hash), /bitcoin_history_seed_required/);
});
test('TAP requires agreement on present and absent records and refuses split sources', async () => {
  let other = { result: { owner: 'a' } };
  const reader = new TapReader({ sources: [{ request: async () => ({ result: { owner: 'a' } }) }, { request: async () => other }], agreement: 2 });
  assert.deepEqual(await reader.tap('getLock/fixture'), { owner: 'a' }); other = { result: null }; await assert.rejects(reader.tap('getLock/fixture'), /tap_source_disagreement/);
  other = null; reader.sources[1].request = async () => { throw Error('timeout'); }; await assert.rejects(reader.tap('getLock/fixture'), /tap_quorum_unavailable/);
});
test('TAP snapshots detect same-height reorgs and refuse historical ownership', async () => {
  let hash = GENESIS.hash;
  const source = { request: async path => path.includes('getCurrentBlock') ? { result: 10 } : hash };
  const reader = new TapReader({ sources: [source, source], agreement: 2, bitcoin: { blockHash: async () => hash } });
  await assert.rejects(reader.at({ tip: 9, tipHash: hash }, async () => true), /tap_historical_snapshot_unavailable/);
  await assert.rejects(reader.at({ tip: 10, tipHash: hash }, async () => { hash = '11'.repeat(32); return true; }), /tap_snapshot_changed/);
});
test('TAP list calls use ord-tap max pagination and a fixed total budget', async () => {
  const paths = []; const source = { request: async path => { paths.push(path); return { result: [1, 2] }; } };
  const reader = new TapReader({ sources: [source], agreement: 1 });
  await assert.rejects(reader.all('getPrivilegeAuthList', { pageSize: 2, maxRows: 4 }), /tap_list_limit/);
  assert.ok(paths[1].endsWith('?offset=2&max=2')); await reader.holders('tap', { offset: 10, limit: 5 }); assert.ok(paths.at(-1).endsWith('?offset=10&max=5'));
});
