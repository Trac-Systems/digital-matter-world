import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
// A fixed deployment list is compiled into both consensus engines. Replace
// only that module in this isolated test process, never via batch input.
const manifest = { network: 'compound-merge-test', ready: true, rows: [] };
mock.module('../../rules/src/compound-merge-manifest.js', { namedExports: { COMPOUND_IDENTITY_V4_MERGES: manifest } });
const r = await import('../../rules/src/index.js');
const { mergeFixture } = await import('../../rules/test/fixtures/compound-merge-v4.js');
const { ed25519 } = await import('../../rules/node_modules/@noble/curves/ed25519.js');
const { verifyCreditOperations, accountOperationsRoot } = await import('../../rules/src/account-batch.js');
const { verifyFinancialExecution } = await import('../../committee/signer/financial-execution.mjs');
const { checkBatchV2 } = await import('../../contract/batch-v2.js');
const { buildCreditAccounts } = await import('../src/account-batch.mjs');
const { accountKey, readAccountLeaf } = await import('../../contract/account-tree.js');
const { AccountAvailability } = await import('../src/account-availability.mjs');
const { attest, receiptSigners } = await import('../../rules/test/witness-fixture.mjs');
const height = r.COMPOUND_IDENTITY_V4_HEIGHT, before = String(BigInt(height) - 1n);
const f = mergeFixture(); manifest.rows.push(...f.manifest.rows);
const secret = r.hashBytes('compound merge craft holder'), crafter = r.bytesToHex(ed25519.getPublicKey(secret));

function memory() {
  const data = new Map(), store = { get: (space, id) => data.get(space + '/' + id) };
  const commit = writes => { for (const w of writes) data.set(w.space + '/' + w.id, w.value); };
  const leaf = (owner, asset) => {
    const head = store.get('accountRecords', 'ar/' + owner), key = accountKey('balance', asset);
    return readAccountLeaf(head.root, new AccountAvailability(store).prove(head.root, [key]), key);
  };
  return { data, store, commit, leaf };
}
test('service proofs convert 11 units, subsequent mixed legacy/v2 crafts add to that identity, and supply/public balances agree', async () => {
  const m = memory();
  m.commit((await buildCreditAccounts({ store: m.store, document: f.settings, height: before, credits: [
    { op: 'ac', to: f.owner, assets: f.manifest.rows.map(row => [row.oldId, row.amount]) },
    { op: 'ac', to: crafter, assets: [['p0', '5'], ['p2:0', '5'], ['p2:1', '10']] }
  ] })).writes);
  const migrated = r.mergeCompoundCatalogV4(f.state, { network: f.network, height });
  const accounts = await buildCreditAccounts({ store: m.store, document: f.settings, height, credits: [], compoundMerge: migrated.merge });
  assert.equal(verifyCreditOperations([], accounts.operations, [], [], migrated.merge), accounts.operations);
  assert.throws(() => verifyCreditOperations([], accounts.operations), /account_credit_derivation/);
  await verifyFinancialExecution({ files: [{ ops: accounts.operations, compoundMerge: migrated.merge }],
    reads: { financialRecord: async key => m.store.get('accountRecords', key), financialEvidence: async () => { throw Error('unexpected evidence scan'); } },
    document: f.settings, network: f.network, height });
  m.commit(accounts.writes);
  assert.deepEqual(m.leaf(f.owner, f.id), { available: '11', held: '0' });
  for (const row of f.manifest.rows) assert.equal(m.leaf(f.owner, row.oldId), null);
  let named = migrated.state;
  for (const [i, inputs] of [[['p0', '1'], ['p2:1', '1']], [['p2:0', '1'], ['p2:1', '1']], [['p0', '1'], ['p2:0', '1'], ['p2:1', '2']]].entries()) {
    const snapshot = { height: String(BigInt(height) + BigInt(i)), hash: r.hash('snapshot/' + i) };
    const preview = r.previewCraftV2(named, { recipe: 'fusion', inputs, snapshot, settings: f.settings });
    const action = { type: 'craft', owner: crafter, revision: m.store.get('accountRecords', 'ar/' + crafter).revision,
      nonce: r.hash('craft/' + i), until: String(BigInt(height) + 10n), in: inputs, out: [[preview.record.id, preview.amount]], compound: preview.record.commitment };
    action.sig = r.bytesToHex(ed25519.sign(r.craftActionDigest(f.network, action), secret));
    const result = r.executeCraftV2(named, { move: { a: crafter, p: { recipe: 'fusion', snapshot, action } }, settings: f.settings,
      counted: snapshot.height, provenance: null, hashAt: () => snapshot.hash });
    named = result.state;
    m.commit((await buildCreditAccounts({ store: m.store, document: f.settings, height: snapshot.height, credits: [], crafts: [result.craft] })).writes);
    assert.equal(result.craft.id, f.id); assert.equal(result.craft.firstMaker, f.owner);
    assert.deepEqual(result.craft.record.properties, f.records[0].properties);
  }
  assert.deepEqual(m.leaf(crafter, f.id), { available: '4', held: '0' });
  assert.deepEqual(m.leaf(crafter, 'p0'), { available: '3', held: '0' });
  assert.deepEqual(m.leaf(crafter, 'p2:0'), { available: '3', held: '0' });
  assert.equal(m.store.get('publicSupply', f.id).outstanding, '15');
  assert.equal(m.store.get('publicBalances', crafter + '/' + f.id).amount, '4');
});

test('an empty activation batch derives the conversion once; account attachment and replay are byte-identical', async () => {
  const nodes = new Map(), claims = new Map(), storage = new r.NamedStorage({ get: id => nodes.get(id), cacheSize: 4 }), saved = storage.save(f.state);
  for (const row of saved.writes) nodes.set(row.id, row.value);
  const checkpoint = r.initialClaimSnapshot({ bitcoinAnchor: { height } }, before);
  const state = { claimSnapshot: checkpoint, claimRoot: r.claimStateRoot(checkpoint), namedSnapshot: saved.snapshot, catalogRoot: r.namedStateRoot(f.state) };
  const gateway = r.bytesToHex(ed25519.getPublicKey(secret)), settings = r.batchSettings({ document: f.settings, receiptSigners });
  const hashAt = h => r.hash('block/' + h), history = { get: h => ({ height: h, hash: hashAt(h) }) };
  const receiptRoot = r.sealReceiptSegment([], { network: f.network, tip: height, hash: hashAt(height), segment: '0', previous: null, ...settings }, secret);
  const input = { state, settings, height, executionHeight: height, blockHash: hashAt(height), tip: height, tipHash: hashAt(height), network: f.network, gateway, history,
    hashAt, entries: [], receiptRoot, rootAttestations: attest(receiptRoot), batchSequence: '1', financialPlanning: true };
  const readers = { namedNodeGet: id => nodes.get(id), claimNodeGet: id => claims.get(id) };
  const first = r.processBlockV2(input, readers);
  assert.equal(first.file.compoundMerge.manifest, r.hashObject(manifest));
  assert.equal(first.file.compoundMerge.types.filter(t => !t.retired).length, 1);
  assert.deepEqual(r.processBlockV2(input, readers).auditBytes, first.auditBytes);
  for (const row of first.namedWrites) nodes.set(row.id, row.value);
  for (const row of first.claimWrites) claims.set(row.id, row.value);
  const nextSeal = r.sealReceiptSegment([], { network: f.network, tip: height, hash: hashAt(height), segment: '1', previous: r.receiptSegmentHash(receiptRoot), ...settings }, secret);
  const next = r.processBlockV2({ ...input, state: first.state, receiptRoot: nextSeal, rootAttestations: attest(nextSeal) }, readers);
  assert.equal(next.file.compoundMerge, undefined);
  assert.equal(next.state.catalogRoot, first.state.catalogRoot);
  const old = r.processBlockV2({ ...input, executionHeight: before }, readers);
  assert.equal(old.file.compoundMerge, undefined); assert.equal(old.state.catalogRoot, state.catalogRoot);

  // Conversion itself is progress even when the accepted observation clocks
  // have already caught up and there are no receipts, credits or other moves.
  const sameClock = r.initialClaimSnapshot({ bitcoinAnchor: { height: String(BigInt(height) + 1n) } }, height);
  const sameInput = { ...input, state: { ...state, claimSnapshot: sameClock, claimRoot: r.claimStateRoot(sameClock) } };
  const plan = r.processBlockV2(sameInput, readers), m = memory();
  m.commit((await buildCreditAccounts({ store: m.store, document: f.settings, height: before,
    credits: [{ op: 'ac', to: f.owner, assets: f.manifest.rows.map(row => [row.oldId, row.amount]) }] })).writes);
  const accounts = await buildCreditAccounts({ store: m.store, document: f.settings, height, credits: [], compoundMerge: plan.file.compoundMerge });
  const completed = r.processBlockV2({ ...sameInput, financialPlanning: false, accountOperations: accounts.operations }, readers);
  assert.equal(completed.file.height, completed.file.previousHeight); assert.equal(completed.file.tip, completed.file.previousTip);
  assert.equal(completed.file.moves.length, 0); assert.equal(completed.file.settlements.length, 0);
  const importManifest = { version: 1, network: f.network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '1',
    previousBatchRoot: r.hash('pre-import'), bitcoinAnchor: { height, hash: hashAt(height) }, settingsHash: r.hashObject(f.settings),
    catalogRoot: state.catalogRoot, accountsRoot: r.hash('pre-import accounts'), receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const activation = { sequence: '1', previousRoot: importManifest.previousBatchRoot, height, hash: hashAt(height), ruleset: 'dmw-v2',
    settingsHash: importManifest.settingsHash, manifest: importManifest, manifestHash: r.hashObject(importManifest) };
  const built = r.buildBatchV2({ network: f.network, epoch: '0', sequence: '1', lastTo: height, previousRoot: importManifest.previousBatchRoot,
    files: [completed.file], executionHeight: height, executionHash: hashAt(height), settings, activation,
    catalogRoot: completed.state.catalogRoot, accountRoot: completed.state.accountRoot });
  assert.equal(built.batch.ops[0].actions[0].type, 'compound-merge');
});


test('notary batch gate requires the complete conversion first, forbids replay and forbids rolling the gate back', async () => {
  const pin = { id: 'test deployment' }, prior = r.hash('previous'), claims = r.hash('claims');
  const db = new Map([['v2/manifest', pin], ['v2/settings', f.settings], ['v2/claims', claims], ['bt/1', prior]]);
  const state = { options: { network: f.network, v2: true, batchActivation: { sequence: '1', ruleset: 'dmw-v2', manifest: pin, manifestHash: r.hashObject(pin) } },
    get: async key => db.get(key), beacon: () => ({ hashAt: async h => r.hash(h) }) };
  const last = { n: '1', to: before };
  const base = { v: 2, n: '2', to: before, ruleset: 'dmw-v2', settingsHash: r.hashObject(f.settings), settingsRevision: f.settings.revision, previous: prior,
    previousClaims: claims, claims, execution: { height, hash: r.hash(height) }, observation: '1', receipts: r.hash('receipts'), finds: r.hash('finds'), catalog: r.hash('catalog') };
  const withOps = ops => ({ ...base, ops, accounts: accountOperationsRoot(ops) });
  const merge = { op: 'ar', v: 2, actions: [{ type: 'compound-merge', manifest: r.hashObject(manifest) }] }, kv = { op: 'kv', key: 'test' };
  assert.equal(await checkBatchV2(state, withOps([kv]), last), 'compound_merge_required');
  assert.equal(await checkBatchV2(state, withOps([kv, merge]), last), 'compound_merge_required');
  assert.equal(await checkBatchV2(state, withOps([merge, merge]), last), 'compound_merge_required');
  assert.equal(await checkBatchV2(state, withOps([merge]), last), null);
  db.set(r.COMPOUND_MERGE_ACCOUNT_MARKER, r.hashObject(manifest));
  assert.equal(await checkBatchV2(state, withOps([merge]), last), 'compound_merge_required');
  assert.equal(await checkBatchV2(state, withOps([kv]), last), null);
  assert.equal(await checkBatchV2(state, { ...withOps([kv]), execution: { height: before, hash: r.hash(before) } }, last), 'compound_identity_height');
});

test('gateway HTTP craft preview and independent kit verifier agree through the activation boundary', async t => {
  const { serve } = await import('../src/http.mjs');
  const { previewCraftNamed } = await import('../../kit/lib/craft-v2.mjs');
  const nodes = new Map(), persistence = new r.NamedStorage({ get: id => nodes.get(id), cacheSize: 4 }), saved = persistence.save(f.state);
  for (const row of saved.writes) nodes.set(row.id, row.value);
  let counted = height;
  const context = { settings: f.settings, catalogRoot: r.namedStateRoot(f.state) };
  const intake = { rulesContext: () => ({ ready: true, settings: f.settings, acceptedRoot: context.catalogRoot, counted }),
    store: { get: (space, id) => space === 'namedNodes' ? nodes.get(id) : { namedSnapshot: saved.snapshot } } };
  const server = await serve({ intake, web: { handle: async () => false } }); t.after(() => server.close());
  const agent = { trac: { head: async () => ({ counted }), hashAt: async h => r.hash(h) }, service: { craftPreview: async payload => {
    const response = await fetch(server.url + '/craft-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const proof = await response.json(); if (!response.ok) throw Error(proof.error); return proof;
  } } };
  const legacy = await previewCraftNamed(agent, { recipe: 'fusion', inputs: [['p0', '1'], ['p2:1', '1']] }, context);
  const native = await previewCraftNamed(agent, { recipe: 'fusion', inputs: [['p2:0', '2'], ['p2:1', '2']] }, context);
  assert.equal(legacy.result.record.id, f.id); assert.equal(legacy.result.existing, true);
  assert.equal(native.result.record.id, f.id); assert.equal(native.result.amount, '2');
  counted = before;
  await assert.rejects(previewCraftNamed(agent, { recipe: 'fusion', inputs: [['p0', '1'], ['p2:1', '1']] }, context), /compound_inputs/);
  const old = await previewCraftNamed(agent, { recipe: 'fusion', inputs: [['p2:0', '1'], ['p2:1', '1']] }, context);
  assert.equal(old.result.record.v, 3); assert.notEqual(old.result.record.id, f.id);
});

test('public catalog and balance projections retire old assets and survive restart with one visible compound', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { Store } = await import('../src/store.mjs'), { claimedEventsV2 } = await import('../src/claimed-v2.mjs'), { itemPage } = await import('../src/public-projections.mjs');
  const path = await mkdtemp(join(tmpdir(), 'compound-public-'));
  let store = await Store.open(path); t.after(async () => { await store.close(); await rm(path, { recursive: true, force: true }); });
  await store.put('meta', 'ruleState', { batchVersion: 2 });
  for (const record of f.records) await store.put('catalogTypes', record.id, { ...record, firstMaker: f.owner });
  assert.equal(itemPage(store, 'compounds', '', new URLSearchParams()).compounds.length, 2);
  const { merge } = r.mergeCompoundCatalogV4(f.state, { network: f.network, height });
  await store.transact([
    ...merge.types.map(value => ({ space: 'compoundTypes', id: value.id, value })),
    ...merge.types.map(value => ({ space: 'publicBalances', id: f.owner + '/' + value.id, value: { owner: f.owner, asset: value.id, amount: value.retired ? '0' : '11', held: '0' } })),
    { space: 'feedEvents', id: 'merge', value: { height, tip: height, types: merge.types } }
  ]);
  for (let i = 0; i < 20 && store.get('feedEvents', 'merge'); i++) await claimedEventsV2({ store, history: {}, settings: {} });
  assert.equal(store.get('feedEvents', 'merge'), null);
  const check = () => {
    const compounds = itemPage(store, 'compounds', '', new URLSearchParams()).compounds;
    assert.equal(compounds.length, 1); assert.equal(compounds[0].id, f.id); assert.equal(compounds[0].firstMaker, f.owner);
    const balances = itemPage(store, 'balances', f.owner, new URLSearchParams()).balances;
    assert.deepEqual(balances.map(b => [b.asset, b.amount]), [[f.id, '11']]);
    for (const old of f.records) assert.equal(store.get('compoundTypes', old.id).mergedInto, f.id);
  };
  check(); await store.close(); store = await Store.open(path); check();
});

test('first craft creates a record and a later 2:2 craft adds two units to the same account asset', async () => {
  const document = r.settingsRevision({ network: 'fresh-compound-test', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: f.settings.values });
  const m = memory(); let state = f.state, first;
  m.commit((await buildCreditAccounts({ store: m.store, document, height, credits: [{ op: 'ac', to: crafter, assets: [['p2:0', '3'], ['p2:1', '3']] }] })).writes);
  for (const scale of ['1', '2']) {
    const inputs = [['p2:0', scale], ['p2:1', scale]], snapshot = { height: String(BigInt(height) + BigInt(scale)), hash: r.hash(scale) };
    const preview = r.previewCraftV2(state, { recipe: 'fusion', inputs, snapshot, settings: document });
    assert.equal(preview.existing, scale === '2');
    const action = { type: 'craft', owner: crafter, revision: m.store.get('accountRecords', 'ar/' + crafter).revision, nonce: r.hash('fresh/' + scale),
      until: String(BigInt(height) + 10n), in: inputs, out: [[preview.record.id, preview.amount]], compound: preview.record.commitment };
    action.sig = r.bytesToHex(ed25519.sign(r.craftActionDigest(document.network, action), secret));
    const result = r.executeCraftV2(state, { move: { a: crafter, p: { recipe: 'fusion', snapshot, action } }, settings: document,
      counted: snapshot.height, provenance: null, hashAt: () => snapshot.hash });
    state = result.state; first ??= result.craft.record;
    assert.deepEqual(result.craft.record, first); assert.equal(result.craft.firstMaker, crafter);
    m.commit((await buildCreditAccounts({ store: m.store, document, height: snapshot.height, credits: [], crafts: [result.craft] })).writes);
  }
  assert.deepEqual(m.leaf(crafter, first.id), { available: '3', held: '0' });
  assert.equal(m.leaf(crafter, 'p2:0'), null); assert.equal(m.leaf(crafter, 'p2:1'), null);
  assert.equal(m.store.get('publicSupply', first.id).issued, '3');
});
