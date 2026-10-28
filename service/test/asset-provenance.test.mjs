import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { acceptedAssetProvenance } from '../src/asset-provenance.mjs';

test('ordinary provenance reads authenticate named definitions and claim paths against independent accepted roots', async () => {
  const key = r.hash('pattern'), owner = r.hash('owner'), asset = 'p2:9007199254740993', block = '9223372036854775809';
  const pattern = { key, number: asset.slice(3), pat: '[0-9]', fld: 4, dt: 'n', tier: 1, discoverer: owner };
  const named = r.emptyNamedDiscovery();
  named.records = r.namedSet(r.namedSet(named.records, 'number/' + pattern.number, key), 'pattern/' + key, pattern);
  const saved = new r.NamedStorage({ get: () => undefined, cacheSize: 8 }).save(named);
  const snapshot = r.initialClaimSnapshot({ bitcoinAnchor: { height: block } }, block);
  const claims = new r.ClaimStorage({ get: () => undefined, cacheSize: 8 });
  const hot = claims.load({ ...snapshot.hot, claimSnapshot: snapshot, claimRoot: r.claimStateRoot(snapshot) });
  const find = { asset, block, finder: owner, count: '3' };
  hot.finds = r.recordSet(hot.finds, r.findIdV2(block, pattern.number), find);
  const claim = claims.save(hot), rows = new Map([...saved.writes, ...claim.writes].map(w => [w.space + '/' + w.id, w.value]));
  const checkpoint = { named: saved.snapshot, claims: claim.state.claimSnapshot };
  const context = { ready: true, catalogRoot: r.namedStateRoot(named), claimsRoot: claim.state.claimRoot,
    settings: r.settingsRevision({ network: 'test', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } }) };
  let transform = value => value, calls = 0;
  const store = { get: async (space, id) => { calls++; return transform(structuredClone(space === 'assetCheckpoint' ? checkpoint : rows.get(space + '/' + id)), space); } };
  const reads = { rulesContext: async () => context };
  const result = await acceptedAssetProvenance({ store, reads, asset, block });
  assert.deepEqual(result.find, find); assert.deepEqual(result.pattern, pattern); assert.ok(calls < 10);
  assert.equal((await acceptedAssetProvenance({ store, reads, asset, block: '0' })).find, null);
  for (const space of ['namedNodes', 'claimNodes']) {
    transform = (row, s) => s === space ? null : row;
    await assert.rejects(acceptedAssetProvenance({ store, reads, asset, block }), /asset_provenance_node/);
    transform = (row, s) => { if (s === space) row.prefix += 'f'; return row; };
    await assert.rejects(acceptedAssetProvenance({ store, reads, asset, block }), /asset_provenance_node/);
  }
  transform = (row, space) => { if (space === 'assetCheckpoint') row.claims.hot.counted = '0'; return row; };
  await assert.rejects(acceptedAssetProvenance({ store, reads, asset, block }), /asset_provenance_root/);
  transform = value => value;
  context.catalogRoot = r.hash('unaccepted replacement');
  await assert.rejects(acceptedAssetProvenance({ store, reads, asset, block }), /asset_provenance_root/);
});
