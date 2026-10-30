import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import * as r from '../src/index.js';
import { accountActionDigest } from '../../contract/root-accounts.js';

const settings = r.settingsRevision({ network: 'craft-test', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
const snapshot = { height: '9999', hash: r.hash('snapshot') }, key = r.hashBytes('disposable-craft-test'), owner = r.bytesToHex(ed25519.getPublicKey(key));
function fixture() {
  const state = r.emptyNamedDiscovery();
  for (let i = 0; i < 2; i++) {
    const p = { key: r.hash('pattern' + i), number: String(i), catalogRevision: '1', knownMatchCount: '1000', anchor: snapshot, settingsHash: r.hashObject(settings), fld: 10 };
    state.records = r.namedSet(state.records, `pattern/${p.key}`, p); state.records = r.namedSet(state.records, `number/${i}`, p.key);
  }
  return state;
}
function signed(state, inputs = [['p2:0', '2'], ['p2:1', '2']], nonce = r.hash('nonce'), doc = settings) {
  const preview = r.previewCraftV2(state, { recipe: 'fusion', inputs, snapshot, settings: doc });
  const action = { type: 'craft', owner, revision: '0', nonce, until: 10001, in: inputs, out: [[preview.record.id, preview.amount]], compound: preview.record.commitment };
  assert.deepEqual(r.craftActionDigest(doc.network, action), accountActionDigest(doc.network, action));
  action.sig = r.bytesToHex(ed25519.sign(r.craftActionDigest(doc.network, action), key));
  const move = { v: 2, ruleset: 'dmw-v2', settingsHash: r.hashObject(doc), settingsRevision: doc.revision, network: doc.network, a: owner,
    t: 'craft-v2', b: snapshot.height, h: snapshot.hash, p: { recipe: 'fusion', snapshot: { ...snapshot }, action }, w: '0' };
  move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), key)); return { move, preview };
}
const execute = (state, move, doc = settings, extra = {}) => r.executeNamedMove(state, { move, settings: doc, tip: snapshot.height, counted: snapshot.height,
  receiptPosition: '1', hashAt: () => snapshot.hash, ...extra });

test('craft-v2 pins exact metadata, proportional output, owner authorization and nonce without mutating parent catalog', () => {
  const state = fixture(), root = r.namedStateRoot(state), { move, preview } = signed(state);
  const result = execute(state, move);
  assert.equal(result.craft.amount, '2'); assert.equal(result.craft.record.id, preview.record.id);
  assert.equal(result.craft.record.properties.generation, '1'); assert.equal(result.craft.record.tier.value, 5);
  assert.equal(r.namedStateRoot(state), root);
  const again = signed(result.state, move.p.action.in, move.p.action.nonce).move;
  assert.throws(() => execute(result.state, again), /move_already_executed|account_replay/);
  const next = signed(result.state, [[preview.record.id, '1'], ['p2:1', '1']], r.hash('second'));
  assert.equal(execute(result.state, next.move).craft.record.properties.generation, '2');
});
test('signed wrong output, foreign owner, expired request, changed snapshot and altered parent proofs fail closed', () => {
  for (const change of [a => a.out[0][1] = '3', a => a.compound = r.hash('wrong')]) {
    const state = fixture(), { move } = signed(state), root = r.namedStateRoot(state); change(move.p.action);
    move.p.action.sig = r.bytesToHex(ed25519.sign(r.craftActionDigest(settings.network, move.p.action), key));
    move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), key));
    assert.throws(() => execute(state, move), /craft_output/); assert.equal(r.namedStateRoot(state), root);
  }
  for (const change of [m => m.p.action.owner = r.hash('foreign'), m => m.p.action.until = 2, m => m.p.snapshot.hash = r.hash('fork')]) {
    const { move } = signed(fixture()); change(move); move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), key));
    assert.throws(() => execute(fixture(), move), /craft_authorization|compound_snapshot/);
  }
  const rows = new Map(), storage = new r.NamedStorage({ get: id => rows.get(id), cacheSize: 3 }), state = fixture(), saved = storage.save(state);
  for (const w of saved.writes) rows.set(w.id, w.value);
  const args = { recipe: 'fusion', inputs: [['p2:0', '1'], ['p2:1', '1']], snapshot, settings };
  const proof = r.craftPreviewProof({ ...args, snapshot: saved.snapshot, get: id => rows.get(id), anchor: snapshot });
  assert.ok(r.verifyCraftPreview(proof, { ...args, root: r.namedStateRoot(state) }));
  const altered = structuredClone(proof); altered.record.properties.charge++;
  assert.throws(() => r.verifyCraftPreview(altered, { ...args, root: proof.root }), /craft_preview_value/);
  const omitted = structuredClone(proof); omitted.nodes = [];
  assert.throws(() => r.verifyCraftPreview(omitted, { ...args, root: proof.root }), /named_storage_integrity/);
});
test('craft uses the accepted input revision even when earlier receipts add occurrences in its batch', () => {
  const accepted = fixture(), { move, preview } = signed(accepted), key = r.namedGet(accepted.records, 'number/0');
  const changed = { ...accepted, records: r.namedSet(accepted.records, `pattern/${key}`, {
    ...r.namedGet(accepted.records, `pattern/${key}`), knownMatchCount: '1001', catalogRevision: '2'
  }) };
  assert.throws(() => execute(changed, move), /craft_output/);
  const result = execute(changed, move, settings, { craftCatalog: accepted });
  assert.equal(result.craft.id, preview.record.id);
  assert.equal(result.craft.record.inputs[0].properties.source.catalogRevision, '1');
  assert.equal(r.namedGet(result.state.records, `pattern/${key}`).knownMatchCount, '1001');
});
test('unresolved threshold equality continues with bounded limbs, cold restart and unchanged compound identity', () => {
  const doc = r.settingsRevision({ network: settings.network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...settings.values, compoundPrecisionBits: 1, compoundWorkBudget: 2 } });
  const { move } = signed(fixture(), [['p2:0', '1'], ['p2:1', '1']], r.hash('continuation'), doc);
  let { state, craft } = execute(fixture(), move, doc);
  assert.equal(craft.record.tier.value, null);
  const immutable = r.stableJSON(craft.record), rows = new Map(); let calls = 0;
  while (r.compoundTierProgress(state, craft.id).value === null) {
    const before = r.compoundTierProgress(state, craft.id), oldRoot = r.namedStateRoot(state);
    const result = r.advanceCompoundTier(state, { asset: craft.id, cursor: before.cursor, steps: 2, settings: doc });
    assert.ok(BigInt(result.progress.cursor) - BigInt(before.cursor) <= 2n); assert.equal(r.namedStateRoot(state), oldRoot);
    const storage = new r.NamedStorage({ get: id => rows.get(id), cacheSize: 2 }), saved = storage.save(result.state);
    for (const w of saved.writes) rows.set(w.id, w.value);
    state = new r.NamedStorage({ get: id => rows.get(id), cacheSize: 2 }).load(saved.snapshot);
    assert.throws(() => r.advanceCompoundTier(state, { asset: craft.id, cursor: before.cursor, steps: 1, settings: doc }), /compound_tier_cursor/);
    assert.ok(++calls < 200);
  }
  assert.ok(calls > 10); assert.equal(r.compoundTierProgress(state, craft.id).value, 5); // 1/10 * 1/10 * 10000 = 100 exactly.
  assert.equal(r.stableJSON(r.exactGet(state, 'assets', craft.id)), immutable);
  // Retrying the recipe after refinement retains its original identity/record.
  const retry = signed(state, [['p2:0', '1'], ['p2:1', '1']], r.hash('after'), doc);
  assert.equal(execute(state, retry.move, doc).craft.id, craft.id);
});

test('multi-limb continuation distinguishes the two sides of a threshold with exact carries', () => {
  const H = 10n ** 30n + 1n, largeSnapshot = { height: String(H - 1n), hash: r.hash('large snapshot') };
  const doc = r.settingsRevision({ network: settings.network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...settings.values, compoundPrecisionBits: 1, compoundWorkBudget: 2 } });
  for (const count of [10n ** 16n, 10n ** 16n + 1n, 10n ** 17n + 1n]) {
    let state = fixture();
    for (let i = 0; i < 2; i++) {
      const key = r.namedGet(state.records, `number/${i}`);
      state.records = r.namedSet(state.records, `pattern/${key}`, { ...r.namedGet(state.records, `pattern/${key}`), knownMatchCount: String(count) });
    }
    const preview = r.previewCraftV2(state, { recipe: 'fusion', inputs: [['p2:0', '1'], ['p2:1', '1']], snapshot: largeSnapshot, settings: doc });
    state = preview.state; let calls = 0;
    while (r.compoundTierProgress(state, preview.record.id).value === null) {
      state = r.advanceCompoundTier(state, { asset: preview.record.id, cursor: r.compoundTierProgress(state, preview.record.id).cursor, steps: 2, settings: doc }).state;
      assert.ok(++calls < 2000);
    }
    const index = doc.values.tierThresholds.findIndex(t => count * count <= BigInt(t) * H);
    assert.equal(r.compoundTierProgress(state, preview.record.id).value, index < 0 ? 1 : 5 - index);
  }
});

const activeHeight = r.COMPOUND_IDENTITY_V4_HEIGHT;
const beforeHeight = String(BigInt(activeHeight) - 1n);
function activeFixture() {
  const state = fixture(), k = r.namedGet(state.records, 'number/0');
  state.records = r.namedSet(state.records, `pattern/${k}`, { ...r.namedGet(state.records, `pattern/${k}`), legacy: { asset: 'p0' } });
  return state;
}
const previewAt = (state, inputs, height = activeHeight, extra = {}) => r.previewCraftV2(state, {
  recipe: 'fusion', inputs, snapshot, settings, executionHeight: height, ...extra
});
test('activation preserves the old record bytes and switches identity using execution height, not snapshot', () => {
  const state = activeFixture(), inputs = [['p2:0', '1'], ['p2:1', '1']];
  const old = previewAt(state, inputs, beforeHeight), legacy = previewAt(state, inputs, '9999');
  assert.deepEqual(old.record, legacy.record);
  assert.equal(old.record.commitment, r.hashObject({ v: 3, recipe: 'fusion', inputs: old.record.inputs, snapshot, settingsHash: r.hashObject(settings), properties: old.record.properties }));
  const upgraded = previewAt(state, inputs);
  assert.equal(upgraded.record.v, 4); assert.notEqual(upgraded.record.id, old.record.id);
  assert.deepEqual(upgraded.record.properties, old.record.properties); assert.deepEqual(upgraded.record.tier, old.record.tier);
  assert.throws(() => previewAt(state, [['p0', '1'], ['p2:1', '1']], beforeHeight), /compound_inputs/);
});
test('recipe and reduced canonical ratio alone define identity; later snapshots and policies reuse the first record', () => {
  const state = activeFixture(), first = previewAt(state, [['p2:0', '1'], ['p2:1', '1']]);
  const later = { height: '10000', hash: r.hash('later') };
  const two = previewAt(first.state, [['p2:1', '2'], ['p2:0', '2']], activeHeight, { snapshot: later });
  assert.equal(two.amount, '2'); assert.equal(two.existing, true); assert.deepEqual(two.record, first.record);
  const freshLater = previewAt(state, [['p2:0', '1'], ['p2:1', '1']], activeHeight, { snapshot: later });
  assert.equal(freshLater.record.id, first.record.id); assert.notDeepEqual(freshLater.record.properties, first.record.properties);
  assert.notEqual(previewAt(state, [['p2:0', '1'], ['p2:1', '2']]).record.id, first.record.id);
  assert.deepEqual(previewAt(state, [['p0', '1'], ['p2:1', '1']]).record, first.record);
  const mixed = previewAt(state, [['p0', '1'], ['p2:0', '1'], ['p2:1', '2']]);
  assert.equal(mixed.record.id, first.record.id); assert.equal(mixed.amount, '2');
  assert.throws(() => previewAt(state, [['p0', '1'], ['p2:0', '1']]), /compound_inputs/);
  assert.throws(() => previewAt(state, [['p1', '1'], ['p2:0', '1']]), /compound_input_identity/);
  const doc = r.settingsRevision({ network: settings.network, effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...settings.values, compoundPrecisionBits: 8 } });
  assert.deepEqual(previewAt(first.state, [['p0', '2'], ['p2:1', '2']], activeHeight, { settings: doc }).record, first.record);
});
test('activated signed crafts verify their canonical output and preserve first maker; old payload outcomes still replay', () => {
  let state = activeFixture();
  const make = (inputs, nonce) => {
    const preview = previewAt(state, inputs), action = { type: 'craft', owner, revision: '0', nonce: r.hash(nonce), until: String(BigInt(activeHeight) + 1n), in: inputs,
      out: [[preview.record.id, preview.amount]], compound: preview.record.commitment };
    action.sig = r.bytesToHex(ed25519.sign(r.craftActionDigest(settings.network, action), key));
    const move = { ...signed(state).move, p: { recipe: 'fusion', snapshot, action } };
    move.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(move), key)); return move;
  };
  const first = make([['p0', '1'], ['p2:1', '1']], 'active one');
  assert.throws(() => execute(state, first, settings, { executionHeight: beforeHeight }), /craft_inputs/);
  const one = execute(state, first, settings, { executionHeight: activeHeight }); state = one.state;
  const two = execute(state, make([['p2:0', '2'], ['p2:1', '2']], 'active two'), settings, { executionHeight: activeHeight });
  assert.equal(two.craft.id, one.craft.id); assert.equal(two.craft.amount, '2'); assert.equal(two.craft.firstMaker, owner);
  const bad = make([['p2:0', '1'], ['p2:1', '1']], 'bad'); bad.p.action.out[0][1] = '99';
  bad.p.action.sig = r.bytesToHex(ed25519.sign(r.craftActionDigest(settings.network, bad.p.action), key));
  bad.sig = r.bytesToHex(ed25519.sign(r.moveDigestV2(bad), key));
  assert.throws(() => execute(state, bad, settings, { executionHeight: activeHeight }), /craft_output/);
});
test('resonance remains charge-gated and deterministic across snapshots and proportional inputs', () => {
  const state = activeFixture(), p = { ...r.namedGet(state.records, `pattern/${r.namedGet(state.records, 'number/1')}`), number: '65521', key: r.hash('same charge') };
  state.records = r.namedSet(state.records, `number/${p.number}`, p.key); state.records = r.namedSet(state.records, `pattern/${p.key}`, p);
  const opts = { recipe: 'resonance' }, first = previewAt(state, [['p0', '1'], ['p2:65521', '1']], activeHeight, opts);
  const again = previewAt(first.state, [['p2:65521', '2'], ['p2:0', '2']], activeHeight, { ...opts, snapshot: { height: '10001', hash: r.hash('next') } });
  assert.deepEqual(again.record, first.record); assert.equal(again.amount, '2');
  assert.notEqual(first.record.id, previewAt(state, [['p0', '1'], ['p2:65521', '1']]).record.id);
  assert.throws(() => previewAt(state, [['p0', '1'], ['p2:1', '1']], activeHeight, opts), /resonance_charge/);
});

test('pre-activation signed craft replays the exact accepted record and state bytes from the base release', () => {
  // Captured by executing this fixture with e184e980ce4b854f1409e5ca6ed90eba454f8f75.
  const state = fixture(), result = execute(state, signed(state).move);
  assert.equal(result.craft.id, 'c2:809226043bb181494dd4b16ef9a43b764099fa13a11ab900b87dc4fc1be99946');
  assert.equal(r.hashObject(result.craft), 'd51e0220ae06ca5bc6d440bf6d66cd8f7eb519d2beda8bd52aef66a64712b959');
  assert.equal(r.namedStateRoot(result.state), '488f866b66b6dbaa74645ae590b34093a4e14223a5de7889a9c400c40f0fca7a');
});
