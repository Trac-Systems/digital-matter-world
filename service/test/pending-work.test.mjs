import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { rules as r, initialState } from '../src/rules.mjs';
import { preparePendingWork, verifyPendingWork, legacyGatewayRows } from '../src/pending-work.mjs';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
import { installGatewayActivation } from '../src/v2-runtime.mjs';
import { Intake } from '../src/intake.mjs';
import { bindingFixture } from './bindings-fixture.mjs';
import { FeeQuotes, createFeePolicy, changeBaseFee } from '../src/fees.mjs';
import { harness, deployment } from '../../contract/tests/helpers/harness.mjs';
import { temp, network, secret, gateway, agent, fixtureHistory, receiptSigners, attestRoot } from './helpers.mjs';

async function fixture(t, { settled = false, overlap = false } = {}) {
  const store = await Store.open(await temp('pm1-pending-')); t.after(() => store.close());
  const history = fixtureHistory(210), alice = agent(310), bob = agent(311);
  const document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '10', values: { ...r.SETTINGS_PROFILE,
    puzzleBits: 0, claimsPerWindow: 1, settlementPageRows: 1, settlementPagesPerObservation: 1 } });
  const pattern = { number: 0, name: 'dmwlegacy', pat: '[0-9]', fld: 4, dt: 'n', rarity: 10, total: 10, tier: 5,
    discoverer: alice.address, historyHeight: 9, historyHash: history.hashAt(9) };
  const round = { window: 10, windowHash: history.hashAt(10), claimableHeight: 10,
    slots: [5, 6, 10].flatMap(h => r.legacyRules.slotsFor(history.get(h), [pattern])),
    claims: [5, 6].flatMap(block => [alice, bob].map(a => ({ agent: a.address, window: 10, block, patterns: [0] }))),
    headerSenders: [{ block: 10, agent: alice.address }], seedHash: null, closed: false };
  if (settled) {
    const result = r.legacyRules.settleClaims({ ...round, counted: 12, decidingHash: history.hashAt(12) });
    round.seedHash = history.hashAt(12); round.closed = true; round.credited = 1;
    round.settlement = { claims: result.claims, rejected: 0, winners: result.winners.map(({ claimers, ...w }) => ({ ...w, tickets: claimers.length })) };
    const w = result.winners[0];
    await store.put('finds', w.id, { ...w, finder: w.winner, findHeight: 12, window: 10 });
  }
  const proposal = { name: 'dmwcarried', pat: '[123]', fld: 4, dt: 'n' }, salt = r.hash('pm1-original-salt');
  const commitment = r.legacyRules.discoveryCommitment(proposal, salt, alice.address);
  const rounds = [round];
  if (overlap) rounds.push({ window: 11, windowHash: history.hashAt(11), claimableHeight: 11,
    slots: round.slots.filter(s => s.block !== 10), claims: round.claims.map(c => ({ ...c, window: 11 })), headerSenders: [], seedHash: null, closed: false });
  await store.put('meta', 'ruleState', { ...initialState(11, history.hashAt(10), 9), rounds, discoveryCommits: [{ agent: alice.address, commitment, tip: 8 }] });
  await store.put('meta', 'patterns', [pattern]);
  const legacy = harness({ ...deployment, network }); await legacy.advance(9); assert.equal(await legacy.batch([]), null); await legacy.advance(1);
  const anchor = { height: '10', hash: history.hashAt(10) };
  const pending = preparePendingWork({ store, network, document, anchor, lastTo: 9 });
  const imported = prepareTerminalImport({ records: legacy.db, height: 10, network, pendingWork: pending });
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2', previousBatchRoot: legacy.db.get('bt/1'),
    bitcoinAnchor: anchor, settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(pending.named), accountsRoot: imported.financialRoot,
    receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const manifestHash = r.hashObject(manifest), contract = harness({ ...deployment, network, v2: { manifest, manifestHash, document, importRoot: imported.importRoot, importRows: imported.importRows } });
  for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
  return { store, history, document, alice, bob, round, pending, imported, manifest, manifestHash, contract, proposal, salt, commitment };
}

async function activateCurrentSnapshot(f) {
  const pending = preparePendingWork({ store: f.store, network, document: f.document, anchor: f.manifest.bitcoinAnchor, lastTo: 9 });
  const original = new Map(f.imported.pages.flatMap(p => p.records).filter(([key]) => !/^(ar|ao|al|fp)\//.test(key) && !key.startsWith('v2-')));
  const imported = prepareTerminalImport({ records: original, height: 10, network, pendingWork: pending });
  const manifest = { ...f.manifest, catalogRoot: r.namedStateRoot(pending.named), accountsRoot: imported.financialRoot }, manifestHash = r.hashObject(manifest);
  const contract = harness({ ...deployment, network, v2: { manifest, manifestHash, document: f.document, importRoot: imported.importRoot, importRows: imported.importRows } });
  for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
  await installGatewayActivation({ ...f, pending, imported, manifest, manifestHash, named: pending.named });
  return pending;
}

test('pending snapshot rederives identically for five signers, pins notary roots, and rejects changed gateway work', async t => {
  const f = await fixture(t), { store, pending, document, manifest } = f, before = legacyGatewayRows(store);
  for (let i = 0; i < 5; i++) assert.equal(verifyPendingWork({ store, pending, network, document, anchor: manifest.bitcoinAnchor, lastTo: 9 }).root, pending.root);
  await store.put('bindingIntents', 'retained', { request: { nonce: 8 }, signature: 'exact-original' });
  await assert.rejects(installGatewayActivation({ ...f, named: pending.named }), /pending_reconciliation_mismatch/);
  assert.equal(store.get('meta', 'v2Activation'), null);
  await store.transact([{ space: 'bindingIntents', id: 'retained' }]);
  await installGatewayActivation({ ...f, named: pending.named });
  assert.equal(store.get('meta', 'ruleState').claimRoot, f.contract.db.get('v2/claims'));
  assert.deepEqual(store.get('meta', 'ruleState').discoveryCommits, before.find(([space, id]) => space === 'meta' && id === 'ruleState')[2].discoveryCommits);
  assert.equal(store.get('meta', 'legacyPendingWork').root, pending.root);
});

for (const [settled, overlap] of [[false, false], [true, false], [false, true], [true, true]]) test(`legacy claims retain lottery, assets and cursor (partly delivered=${settled}, overlapping=${overlap})`, async t => {
  const f = await fixture(t, { settled, overlap }), { store, pending, history, document, manifest, manifestHash, round } = f;
  await installGatewayActivation({ ...f, named: pending.named });
  let state = store.get('meta', 'ruleState'); const nodes = new Map(pending.writes.map(w => [w.id, w.value])), winners = [];
  const settings = r.activatedBatchSettings({ manifest, manifestHash, document, receiptSigners });
  let previous = null, segment = 0;
  for (let step = 0; step < 20; step++) {
    const tip = String(Math.min(10 + step, overlap ? 13 : 12));
    if (step <= (overlap ? 3 : 2)) { previous = null; segment = 0; }
    const receiptRoot = r.sealReceiptSegment([], { network, tip, hash: history.hashAt(Number(tip)), segment: String(segment++), previous,
      ruleset: 'dmw-v2', settingsRevision: document.revision, settingsHash: r.hashObject(document) }, secret);
    previous = r.receiptSegmentHash(receiptRoot);
    const out = r.processBlockV2({ height: tip, tip, blockHash: history.hashAt(Number(tip)), tipHash: history.hashAt(Number(tip)), network, gateway, history,
      hashAt: history.hashAt, entries: [], receiptRoot, rootAttestations: await attestRoot(receiptRoot), state, patterns: [], settings,
      batchSequence: String(2 + step), namedEvidence: { nodes: [...nodes] }, claimEvidence: { nodes: [] } }, { claimNodeGet: id => nodes.get(id) });
    for (const write of [...out.claimWrites, ...out.namedWrites]) nodes.set(write.id, write.value);
    state = out.state; winners.push(...out.file.settlements.flatMap(s => s.winners));
    if (!state.rounds.some(e => e.legacy)) break;
  }
  const expected = r.legacyRules.settleClaims({ ...round, counted: 12, decidingHash: history.hashAt(12) }).winners.slice(settled ? 1 : 0);
  assert.equal(winners.length, expected.length);
  assert.deepEqual(winners.map(w => [w.legacyId, w.winner, w.asset, w.count]), expected.map(w => [w.id, w.winner, w.asset, w.count]));
  assert(winners.every(w => w.asset === 'p0'));
  assert(!state.rounds.some(e => e.legacy));
});

test('sealed commits keep exact eligibility/expiry; already accepted reveals can attach evidence after expiry', async t => {
  const f = await fixture(t), { document, history, alice, proposal, salt, commitment, pending } = f;
  const matches = [1, 2, 3].map(h => ({ height: String(h), hash: history.hashAt(h), count: '1' }));
  const opening = { agent: alice.address, commitmentId: commitment, proposal, salt, matches, witnessRoot: r.witnessRoot(matches),
    anchor: { height: '10', hash: history.hashAt(10) }, counted: '200', tip: '10', receiptPosition: '1', settings: document, history };
  const c = r.namedGet(pending.named.records, `commit/${alice.address}/${commitment}`);
  assert.equal(c.eligible, '10'); assert.equal(c.expires, '152'); assert.equal(c.format, 1);
  assert.throws(() => r.revealNamedDiscovery(pending.named, { ...opening, tip: '9' }), /discovery_reveal_window/);
  assert.equal(r.revealNamedDiscovery(pending.named, opening).record.discoverer, alice.address);
  assert.throws(() => r.revealNamedDiscovery(pending.named, { ...opening, tip: '153' }), /discovery_reveal_window/);
  const queued = r.importLegacyDiscoveries({ commitments: [], queued: [{ agent: alice.address, commitment, tip: 8, proposal, height: 10, snapshotHash: history.hashAt(10) }],
    settings: document, receiptPosition: '0', lifetime: 144, minDelay: 2 });
  assert.equal(r.revealNamedDiscovery(queued, { ...opening, tip: '200' }).record.discoverer, alice.address);
  assert.throws(() => r.revealNamedDiscovery(queued, { ...opening, tip: '200', proposal: { ...proposal, name: 'dmwreplacement' } }), /legacy_reveal_binding/);
});

test('an acknowledged unbatched legacy commitment crosses activation with its exact receipt and opens without recommitting', async t => {
  const f = await fixture(t), { store, history, document, alice } = f;
  const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  await intake.observe({ tip: 10, counted: 10, confirmed: 10, hash: history.hashAt(10) });
  const proposal = { name: 'dmwpendingreceipt', pat: '[234]', fld: 4, dt: 'n' }, salt = r.hash('retained pending receipt salt');
  const commitment = r.legacyRules.discoveryCommitment(proposal, salt, alice.address);
  const move = r.solveMove({ v: 1, network, a: alice.address, t: 'discovery-commit', b: 10, h: history.hashAt(10), p: { commitment } }, alice.secret, 0);
  const receipt = await intake.accept(r.stableJSON(move)), oldDedupe = store.get('dedupe', r.moveId(move));
  const readers = { history, hashAt: history.hashAt, gateway, legacySettings: { puzzleBits: 0, receiptSigners } };
  const pending = preparePendingWork({ store, network, document, anchor: f.manifest.bitcoinAnchor, lastTo: 9, ...readers });
  assert.equal(pending.commitment.receipts, 1);
  const imported = prepareTerminalImport({ records: new Map(f.imported.pages.flatMap(p => p.records).filter(([k]) => !/^(ar|ao|al|fp)\//.test(k) && !k.startsWith('v2-'))),
    height: 10, network, pendingWork: pending });
  const manifest = { ...f.manifest, catalogRoot: r.namedStateRoot(pending.named), accountsRoot: imported.financialRoot };
  await installGatewayActivation({ store, document, imported, named: pending.named, manifest, manifestHash: r.hashObject(manifest), ...readers });
  assert.deepEqual(store.get('dedupe', r.moveId(move)), oldDedupe);
  assert.deepEqual(store.get('legacyReceiptResults', r.moveId(move)).receipt, receipt);
  assert.equal(store.get('legacyReceiptResults', r.moveId(move)).outcome, 'carried');
  assert.equal(store.get('meta', 'head'), null);
  const matches = [2, 3, 4].map(h => ({ height: String(h), hash: history.hashAt(h), count: '1' }));
  const opened = r.revealNamedDiscovery(pending.named, { agent: alice.address, commitmentId: commitment, proposal, salt, matches,
    witnessRoot: r.witnessRoot(matches), anchor: { height: '10', hash: history.hashAt(10) }, counted: '12', tip: '12', receiptPosition: '1', settings: document, history });
  assert.equal(opened.record.name, proposal.name);
});

test('closed-window pending receipts require their original quorum certificate and missing receipts cannot disappear', async t => {
  const f = await fixture(t), { store, history, document, alice } = f;
  const intake = new Intake({ store, network, secret, hashAt: history.hashAt, puzzleBits: 0 });
  await intake.observe({ tip: 8, counted: 8, confirmed: 8, hash: history.hashAt(8) });
  const move = r.solveMove({ v: 1, network, a: alice.address, t: 'discovery-commit', b: 8, h: history.hashAt(8), p: { commitment: r.hash('old pending') } }, alice.secret, 0);
  await intake.accept(r.stableJSON(move)); const observation = await intake.seal();
  const args = { store, network, document, anchor: f.manifest.bitcoinAnchor, lastTo: 9, history, hashAt: history.hashAt, gateway, legacySettings: { puzzleBits: 0, receiptSigners } };
  assert.throws(() => preparePendingWork(args), /pending_receipt_certificate_required/);
  await store.put('receiptCertificates', '8/' + history.hashAt(8), { seal: observation.receiptRoot, attestations: await attestRoot(observation.receiptRoot) });
  assert.equal(preparePendingWork(args).commitment.receipts, 1);
  await store.transact([{ space: 'dedupe', id: r.moveId(move) }]);
  assert.throws(() => preparePendingWork(args), /pending_receipt_coverage/);
});

test('retained financial records cannot silently become stranded after activation', async t => {
  const f = await fixture(t);
  const args = { store: f.store, network, document: f.document, anchor: f.manifest.bitcoinAnchor, lastTo: 9 };
  for (const [space, value] of [['mints', { state: 'paid' }], ['mintCredits', { items: [{ amount: '1' }] }],
    ['activeLinks', true], ['linkObligations', { state: 'reconciliation_required' }]]) {
    await f.store.put(space, 'pending', value);
    assert.throws(() => preparePendingWork(args), /pending_financial_adapter_required/);
    assert.equal(f.store.get('meta', 'v2Activation'), null);
    assert.deepEqual(f.store.get(space, 'pending'), value);
    await f.store.transact([{ space, id: 'pending' }]);
  }
});

test('signed legacy sends remain untouched and require acceptance or retirement evidence before cutover', async t => {
  const f = await fixture(t), job = { id: 'old-batch', op: 'bt', value: { n: 2 }, message: { nonce: 'original', signature: 'retained' } };
  await f.store.put('outbox', job.id, job);
  await assert.rejects(installGatewayActivation({ ...f, named: f.pending.named }), /pending_signed_transport_reconciliation/);
  assert.equal(f.store.get('meta', 'v2Activation'), null);
  assert.deepEqual(f.store.get('outbox', job.id), job);
});

for (const rail of ['tap', 'ethereum']) test(`pending ${rail} payout binding resumes the original quorum attempt after activation`, async t => {
  const f = await fixture(t), bindings = bindingFixture(f.store, { network });
  const { walletSignature, ...body } = bindings.packet(f.alice, rail, f.alice.secret.toString('hex'), '1');
  const request = await bindings.bindings.request(body);
  bindings.committee.bindPayout = record => Promise.all([0, 1].map(i => bindings.endorse(record, i)));
  await assert.rejects(bindings.bindings.complete({ id: request.id, walletSignature }), /binding_quorum/);
  const attempt = f.store.get('payoutAttempts', request.id), pending = await activateCurrentSnapshot(f);
  assert(pending.commitment.retainedCount >= 3);
  assert.deepEqual(f.store.get('payoutRequests', request.id), body);
  assert.deepEqual(f.store.get('payoutAttempts', request.id), attempt);
  bindings.committee.bindPayout = record => Promise.all([0, 1, 2].map(i => bindings.endorse(record, i)));
  const accepted = await bindings.bindings.complete({ id: request.id, walletSignature });
  assert.equal(accepted.acceptedAt, attempt.acceptedAt);
  assert.equal(accepted.walletSignature, walletSignature);
  assert.equal(bindings.bindings.current(f.alice.address, rail).id, request.id);
  assert.equal(bindings.journals[0].records.length, 1);
});

test('original fee quote and accepted authorization retain their signed terms after activation and a price change', async t => {
  const f = await fixture(t); let now = 1000, registry = { feePolicy: createFeePolicy('100') };
  const issuer = new FeeQuotes({ network, secret, now: () => now, registry: async () => registry });
  const scope = 'mint/p0/tap', quote = await issuer.issue(scope, 10), id = r.hash('pm1-original-quote');
  const authorization = await issuer.accept(quote, scope, id, 20, 10);
  await f.store.put('meta', 'originalQuote', { quote, authorization });
  await activateCurrentSnapshot(f);
  registry = changeBaseFee(registry, '200', ++now); now += 1000000;
  const verifier = new FeeQuotes({ network, gateway, registry: async () => registry, settings: () => f.document, now: () => now });
  const saved = f.store.get('meta', 'originalQuote');
  assert.deepEqual(saved, { quote, authorization });
  assert.equal((await verifier.accepted(saved.authorization, scope, id, 20)).baseFee, '100');
  await assert.rejects(verifier.accepted({ ...saved.authorization, until: 21 }, scope, id, 21), /fee_quote_signature/);
});
