import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../src/index.js';
import { mergeFixture } from './fixtures/compound-merge-v4.js';
import { buildCompoundMergeManifest } from '../scripts/compound-merge-manifest.mjs';
const height = r.COMPOUND_IDENTITY_V4_HEIGHT;
test('fixed conversion is gated, chooses oldest metadata and maker, retires sources, and runs once', () => {
  const f = mergeFixture(), args = { network: f.network, manifest: { ...f.manifest, rows: [...f.manifest.rows].reverse() }, height };
  const before = r.namedStateRoot(f.state);
  assert.equal(r.mergeCompoundCatalogV4(f.state, { ...args, height: String(BigInt(height) - 1n) }).state, f.state);
  const migrated = r.mergeCompoundCatalogV4(f.state, args);
  assert.equal(r.namedStateRoot(f.state), before);
  assert.deepEqual(r.exactGet(migrated.state, 'assets', f.id).properties, f.records[0].properties);
  assert.deepEqual(r.exactGet(migrated.state, 'assets', f.id).tier, f.records[0].tier);
  assert.equal(r.namedGet(migrated.state.records, `compound/maker/${f.id}`).owner, f.owner);
  assert.equal(r.compoundRecordCommitment(r.exactGet(migrated.state, 'assets', f.id)), f.id.slice(3));
  for (const old of f.records) assert.deepEqual(r.exactGet(migrated.state, 'assets', old.id), { ...old, retired: true, mergedInto: f.id });
  assert.equal(migrated.merge.types.filter(c => !c.retired).length, 1);
  assert.equal(r.mergeCompoundCatalogV4(migrated.state, args).merge, null);
  assert.equal(r.mergeCompoundCatalogV4(migrated.state, args).state, migrated.state);
  const result = r.previewCraftV2(migrated.state, { recipe: 'fusion', inputs: [['p0', '2'], ['p2:1', '2']], snapshot: { height, hash: r.hash('active') }, settings: f.settings });
  assert.equal(result.record.id, f.id); assert.equal(result.amount, '2'); assert.equal(result.existing, true);
  assert.deepEqual(result.record.properties, f.records[0].properties);
});
test('conversion refuses unprepared lists, forged identities, source commitments and duplicate holders atomically', () => {
  const f = mergeFixture(), before = r.namedStateRoot(f.state), args = { network: f.network, height };
  assert.throws(() => r.mergeCompoundCatalogV4(f.state, { ...args, manifest: { ...f.manifest, ready: false } }), /unprepared/);
  for (const change of [m => m.rows[0].newId = 'c2:' + r.hash('forged'), m => m.rows.push(m.rows[0]), m => m.rows[0].oldId = 'c2:' + r.hash('unknown')]) {
    const manifest = structuredClone(f.manifest); change(manifest);
    assert.throws(() => r.mergeCompoundCatalogV4(f.state, { ...args, manifest }), /compound_merge_/);
    assert.equal(r.namedStateRoot(f.state), before);
  }
});
test('GET manifest builder checks all holders, supply, normalized unit amounts and stable public pages', async () => {
  const f = mergeFixture(), address = r.encodeTracAddress(f.owner), other = r.encodeTracAddress(f.other);
  const data = new Map([
    ['/compounds', { compounds: f.records.map((c, i) => ({ ...c, firstMaker: i ? other : address })) }],
    ['/agents', { agents: [{ address }, { address: other }] }],
    [`/agents/${address}/balances`, { balances: f.manifest.rows.map(row => ({ asset: row.oldId, amount: row.amount, held: '0', current: true })) }],
    [`/agents/${other}/balances`, { balances: [] }]
  ]);
  const read = async path => {
    const url = new URL(path, 'https://fixture.invalid');
    if (url.pathname === '/results/supply') { const row = f.manifest.rows.find(r => r.oldId === url.searchParams.get('asset')); return { supply: [{ asset: row.oldId, issued: row.amount, burned: '0', current: true }] }; }
    return data.get(url.pathname);
  };
  assert.deepEqual(await buildCompoundMergeManifest({ read, network: f.network }), { ...f.manifest, rows: [...f.manifest.rows].sort((a, b) => a.oldId.localeCompare(b.oldId)) });
  data.get(`/agents/${address}/balances`).balances[0].amount = '2';
  await assert.rejects(buildCompoundMergeManifest({ read, network: f.network }), /compound_merge_missing_holder/);
  data.get(`/agents/${address}/balances`).balances[0].held = '1';
  await assert.rejects(buildCompoundMergeManifest({ read, network: f.network }), /compound_merge_balance_unavailable/);
});
