import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../../rules/src/index.js';
import { mergeFixture } from '../../rules/test/fixtures/compound-merge-v4.js';
import { previewCraftNamed, craftNamed } from '../lib/craft-v2.mjs';
import { chooseCompound } from '../strategies/default.mjs';

function fixture(existing) {
  const f = mergeFixture(), state = existing ? r.mergeCompoundCatalogV4(f.state, { network: f.network, height: r.COMPOUND_IDENTITY_V4_HEIGHT, manifest: f.manifest }).state : f.state;
  const nodes = new Map(), storage = new r.NamedStorage({ get: id => nodes.get(id), cacheSize: 4 }), saved = storage.save(state);
  for (const row of saved.writes) nodes.set(row.id, row.value);
  const snapshot = { height: r.COMPOUND_IDENTITY_V4_HEIGHT, hash: r.hash('kit snapshot') };
  const agent = { actionId: () => {}, journal: { get: () => null }, dryRun: true,
    trac: { head: async () => ({ counted: snapshot.height }), hashAt: async () => snapshot.hash },
    service: { craftPreview: async p => r.craftPreviewProof({ snapshot: saved.snapshot, get: id => nodes.get(id), anchor: p.snapshot,
      recipe: p.recipe, inputs: p.inputs, settings: f.settings }) } };
  return { ...f, agent, context: { catalogRoot: r.namedStateRoot(state), settings: f.settings } };
}
test('kit verifies new versus existing identity, canonical legacy ratios and unchanged first-craft properties', async () => {
  const f = fixture(true);
  const legacy = await previewCraftNamed(f.agent, { recipe: 'fusion', inputs: [['p0', '1'], ['p2:1', '1']] }, f.context);
  const native = await previewCraftNamed(f.agent, { recipe: 'fusion', inputs: [['p2:1', '2'], ['p2:0', '2']] }, f.context);
  assert.equal(legacy.result.record.id, f.id); assert.equal(native.result.record.id, f.id);
  assert.equal(legacy.result.existing, true); assert.equal(native.result.amount, '2');
  assert.deepEqual(native.result.record.properties, f.records[0].properties);
  const fresh = fixture(false), result = await previewCraftNamed(fresh.agent, { recipe: 'fusion', inputs: [['p0', '1'], ['p2:1', '1']] }, fresh.context);
  assert.equal(result.result.existing, false); assert.equal(result.result.record.id, f.id);
  const dryRun = await craftNamed(f.agent, { actionId: 'dry', recipe: 'fusion', inputs: [['p0', '1'], ['p2:0', '1'], ['p2:1', '2']] }, f.context);
  assert.equal(dryRun.state, 'dry-run'); assert.equal(dryRun.signed, false); assert.equal(dryRun.existing, true); assert.equal(dryRun.amount, '2');
});
test('kit derives existence from authenticated state and rejects altered output properties', async () => {
  const f = fixture(true), read = f.agent.service.craftPreview;
  f.agent.service.craftPreview = async p => ({ ...await read(p), existing: false });
  assert.equal((await previewCraftNamed(f.agent, { recipe: 'fusion', inputs: [['p0', '1'], ['p2:1', '1']] }, f.context)).result.existing, true);
  f.agent.service.craftPreview = async p => { const proof = await read(p); proof.record = { ...proof.record, properties: { ...proof.record.properties, charge: 99 } }; return proof; };
  await assert.rejects(previewCraftNamed(f.agent, { recipe: 'fusion', inputs: [['p0', '1'], ['p2:1', '1']] }, f.context), /craft_preview_value/);
});
test('suggestions include legacy balances after activation and never mistake two ledger keys for two ingredients', () => {
  const patterns = [{ number: '0', asset: 'p2:0', key: r.hash('pattern0'), legacy: { asset: 'p0' } }, { number: '1', asset: 'p2:1', key: r.hash('pattern1') }];
  const balances = { p0: '99', 'p2:0': '5', 'p2:1': '3' };
  const after = chooseCompound({ patterns, balances, ruleset: 'dmw-v2', height: r.COMPOUND_IDENTITY_V4_HEIGHT });
  assert.deepEqual(after.inputs, [['p0', '1'], ['p2:1', '1']]);
  assert.equal(chooseCompound({ patterns, balances: { p0: '99', 'p2:0': '5' }, ruleset: 'dmw-v2', height: r.COMPOUND_IDENTITY_V4_HEIGHT }), null);
  const before = chooseCompound({ patterns, balances, ruleset: 'dmw-v2', height: String(BigInt(r.COMPOUND_IDENTITY_V4_HEIGHT) - 1n) });
  assert.deepEqual(before.inputs, [['p2:0', '1'], ['p2:1', '1']]);
  assert.equal(chooseCompound({ patterns: [{ number: 0 }, patterns[1]], balances,
    ruleset: 'dmw-v2', height: r.COMPOUND_IDENTITY_V4_HEIGHT }), null);
});

test('live-mode kit preparation signs a legacy-ledger craft and retries its saved authorization', async t => {
  const { Journal } = await import('../lib/journal.mjs');
  const { temp, testWallet } = await import('./helpers.mjs');
  const f = fixture(true), directory = await temp(t), journal = await Journal.open(directory, f.network, { intervalMs: 0, perTip: 10 });
  t.after(() => journal.close());
  const wallet = testWallet(), submitted = [], snapshot = { height: r.COMPOUND_IDENTITY_V4_HEIGHT, hash: r.hash('kit snapshot') };
  Object.assign(f.agent, { journal, wallet, network: f.network, owner: wallet.publicKey.toString('hex'), dryRun: false });
  f.agent.trac.head = async () => ({ counted: snapshot.height, tip: snapshot });
  f.agent.trac.accountRoot = async () => ({ revision: '1' });
  f.agent.service.submit = async move => { submitted.push(move); return { batch: '2', move: r.moveIdV2(move) }; };
  const input = { actionId: 'legacy-send', recipe: 'fusion', inputs: [['p0', '1'], ['p2:1', '1']] };
  const first = await craftNamed(f.agent, input, f.context);
  assert.equal(first.state, 'received'); assert.equal(first.compound.id, f.id);
  assert.deepEqual(submitted[0].p.action.in, input.inputs);
  assert.equal(r.checkMoveV2(submitted[0], { settings: f.settings, tip: snapshot.height, hashAt: () => snapshot.hash }), null);
  const again = await craftNamed(f.agent, input, f.context);
  assert.equal(again.replayed, true); assert.equal(submitted.length, 1);
});
