import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import * as r from '../../rules/src/index.js';
import { accountOperationsRoot } from '../../rules/src/account-batch.js';
import { Store } from '../src/store.mjs';
import { History } from '../src/history.mjs';
import { Replay } from '../src/replay.mjs';
import { runtimeResources } from '../src/r3-settings.mjs';
import { closureTimeouts } from '../../rules/src/closure-timeouts.js';
import { heightKey } from '../src/util.mjs';
import { Files } from '../src/files.mjs';
import { harness, deployment, signedBatch } from '../../contract/tests/helpers/harness.mjs';
import { mine, parseHeader } from '../../contract/tests/helpers/chain.mjs';
import { workFor, REGTEST_PARAMS } from '../../contract/beacon/bitcoin.js';
import { receiptSigners, attest } from '../../rules/test/witness-fixture.mjs';
import { rebuildBatch } from '../../committee/signer/adapter.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';

for (const boundary of ['9007199254740992', '9223372036854775808', '1' + '0'.repeat(79)]) {
  test(`decimal batch, beacon, replay and restart cross ${boundary}`, async t => {
    const base = String(BigInt(boundary) - 1n), next = r.nextUint(base), next2 = r.nextUint(next), network = deployment.network;
    const raw = mine('0'.repeat(64), 1000), first = r.parseHeader(raw, base);
    const secondRaw = mine(first.hash, 1600), second = r.parseHeader(secondRaw, next);
    const checkpoint = { height: base, hash: first.hash, bits: first.bits, time: first.time, chainwork: workFor(first.bits).toString() };
    const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: base, values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
    const named = r.emptyNamedDiscovery(), prior = r.hash('predecessor/' + base);
    const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '1', previousBatchRoot: prior,
      bitcoinAnchor: { height: base, hash: first.hash }, settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(named), accountsRoot: r.merkleRoot([]),
      receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
    const options = { ...deployment, beacon: { checkpoint, params: { ...REGTEST_PARAMS, interval: 1 } },
      v2: { manifest, manifestHash: r.hashObject(manifest), document, importRoot: r.hash('fixture'), importRows: 1 } };
    // A trusted checkpoint fixture places lifetime fields immediately before
    // each boundary without pretending to mine the preceding chain.
    const h = harness(options);
    h.db.set('v2/ready', r.hashObject(manifest)); h.db.set('v2/manifest', manifest); h.db.set('v2/settings', document);
    h.db.set('bt/last', { n: base, to: base }); h.db.set('bt/' + base, prior); h.db.set('bt/observation', base); h.db.set('s/epoch', base);
    h.db.set('v2/catalog', manifest.catalogRoot); h.db.set('v2/accounts', manifest.accountsRoot);
    assert.equal(await h.run('hd', { headers: [secondRaw] }), null);
    assert.equal((await h.state().head()).counted, next);
    const who = new Uint8Array(32).fill(9), gateway = r.bytesToHex(ed25519.getPublicKey(who));
    const body = { v: 2, ruleset: 'dmw-v2', network, settingsRevision: document.revision, settingsHash: r.hashObject(document),
      a: gateway, t: 'header-v2', b: next, h: second.hash, p: { height: next, raw: secondRaw }, w: '0' };
    const move = { ...body, sig: r.bytesToHex(ed25519.sign(r.moveDigestV2(body), who)) };
    const receipt = r.signReceiptV2(move, { tip: next, hash: second.hash, sequence: next, batch: next }, who);
    const seal = r.sealReceiptSegment([receipt], { network, tip: next, hash: second.hash, segment: next, previous: r.hash('segment'),
      ruleset: 'dmw-v2', settingsRevision: '0', settingsHash: r.hashObject(document) }, who);
    const settings = r.activatedBatchSettings({ manifest, manifestHash: r.hashObject(manifest), document, receiptSigners });
    const directory = await mkdtemp(join(tmpdir(), 'dmw-g4b-int-'));
    const resources = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE } });
    const startupDocument = { ...document, values: { ...document.values, closureWorkBudget: document.values.closureWorkBudget / 2 } };
    let store = await Store.open(directory); const replay = new Replay(runtimeResources(resources, startupDocument).replay);
    t.after(async () => { await replay.close(); await store.close(); });
    const persistence = new r.NamedStorage({ get: () => null, cacheSize: 16 }), saved = persistence.save(named);
    let state = { batchVersion: 2, counted: base, lastTip: base, highestTip: base, observation: base, namedSequence: base,
      namedSnapshot: saved.snapshot, catalogRoot: manifest.catalogRoot, accountRoot: manifest.accountsRoot,
      rounds: [], settlementRoundCursor: base,
      receiptSegments: { [`${next}/${second.hash}`]: { segment: base, hash: r.hash('segment') } } };
    const claimSnapshot = r.initialClaimSnapshot(manifest, base);
    for (const field of Object.keys(claimSnapshot.hot)) if (state[field] !== undefined) claimSnapshot.hot[field] = state[field];
    const claimStorage = new r.ClaimStorage({ get: () => null, cacheSize: 16 });
    let claimed = claimStorage.load({ ...claimSnapshot.hot, claimSnapshot, claimRoot: r.claimStateRoot(claimSnapshot) });
    claimed.receiptSegments = r.recordSet(claimed.receiptSegments, `${next}/${second.hash}`, state.receiptSegments[`${next}/${second.hash}`]);
    const claimSaved = claimStorage.save(claimed); state = { ...state, ...claimSaved.state };
    h.db.set('v2/claims', state.claimRoot);
    await store.transact([...claimSaved.writes, { space: 'meta', id: 'ruleState', value: state }, { space: 'meta', id: 'headerHeight', value: base },
      { space: 'headers', id: heightKey(base), value: { raw, hash: first.hash } },
      { space: 'headerObjects', id: first.hash, value: { height: base, raw, parent: first.prev } }]);
    let history = new History(store); await history.append(next, secondRaw);
    const input = { height: next, blockHash: second.hash, tip: next, tipHash: second.hash, network, gateway, settings, state, patterns: [],
      entries: [{ move, receipt }], receiptRoot: seal, rootAttestations: attest(seal), batchSequence: next, namedEvidence: { nodes: [] } };
    const deadlines = [], timer = globalThis.setTimeout;
    const clock = t.mock.method(globalThis, 'setTimeout', (work, ms, ...args) => { deadlines.push(ms); return timer(work, ms, ...args); });
    let output;
    try { output = await replay.run(input, history, { store, staged: new Map() }); } finally { clock.mock.restore(); }
    assert.deepEqual(deadlines, [closureTimeouts(document, resources).replayMs], 'replay uses the batch policy after its startup policy changes');
    input.claimEvidence = output.claimEvidence;
    const published = await new Files(join(directory, 'public')).publish(output, { id: heightKey(next) });
    assert.match(published.receipts.path, /^\/receipts\/v2\/[a-f0-9]{64}\.json$/);
    assert.equal(output.file.observation, next); assert.equal(output.state.rounds[0].headerCount, '1');
    assert.equal(output.file.moves[0].reason, 'accepted');
    const built = r.buildBatchV2({ network, epoch: base, sequence: next, lastTo: base, previousRoot: prior, files: [output.file], executionHeight: next,
      executionHash: second.hash, activation: settings.activation, settings, catalogRoot: output.state.catalogRoot, accountRoot: accountOperationsRoot(output.file.ops) });
    assert.equal(built.batch.n, next); assert.equal(built.batch.deadline, r.addUint(next, '6'));
    const context = { settings, counted: next, last: { n: base, to: base }, previousRoot: prior, activation: settings.activation,
      state, patterns: [], gateway, inputs: [input], history, hashAt: history.hashAt, authority: { epoch: base } };
    const proposal = { batch: built.batch, files: built.fileBytes.map(b => Buffer.from(b).toString('hex')) };
    assert.equal(rebuildBatch(network, proposal, context).digest, r.bytesToHex(built.signingDigest));
    assert.equal((await preflightBatch(built.batch, { counted: next, last: context.last }, { read: key => h.db.get(key), deployment: options })).ok, true);
    assert.equal(await h.run('bt', signedBatch(built.batch, options)), null);
    assert.deepEqual(await h.state().batchLast(), { n: next, to: next });
    assert.throws(() => signedBatch({ ...built.batch, n: Number(next) }, options), /json_value/);
    const malformed = signedBatch({ ...built.batch, n: 1 }, options);
    assert.equal(await h.run('bt', malformed), 'batch');
    const owner = r.hash('agent'); h.db.set('a/last', base);
    const transition = h.state(); assert.equal(await transition.agent(owner, true), next);
    for (const [key, value] of transition.writes) h.db.set(key, value);
    assert.equal(await h.state().address(next), owner);
    h.db.set('ad/p/key', { value: await h.state().committee(), at: next });
    assert.equal(await h.run('ad_apply', { id: 'key' }), null);
    assert.equal(await h.state().committeeEpoch(), next);
    // Materialized counts use decimal SQL arithmetic, including updates/deletes.
    await store.put('fixture-count', 'first', true);
    store.db.prepare('UPDATE record_counts_decimal SET n=? WHERE space=?').run(base, 'fixture-count');
    await store.put('fixture-count', 'second', true); assert.equal(store.countUint('fixture-count'), next);
    await store.put('meta', 'ruleState', output.state);
    await store.close(); store = await Store.open(directory); history = new History(store);
    assert.equal(store.countUint('fixture-count'), next); assert.equal(store.get('meta', 'ruleState').observation, next);
    assert.equal(history.length, next2); assert.equal(history.get(next).height, next);
    assert.equal(history.view(next, second.hash).get(base).hash, first.hash);
    await store.put('fixture-count', 'second'); assert.equal(store.countUint('fixture-count'), base);
  });
}

test('large claim IDs, page cursors and header pools remain exact', () => {
  const base = '1' + '0'.repeat(79), window = r.addUint(base, '10'), number = r.nextUint(base);
  const document = r.settingsRevision({ network: 'large-claims', effectiveBatch: '1', effectiveBitcoinWindow: '0', values: { ...r.SETTINGS_PROFILE } });
  const settings = r.batchSettings({ document }), pattern = { number, pat: '[0-9]', fld: 4, dt: 'n' }, owner = r.hash('owner');
  const state = {}, event = r.claimRound(window, r.hash(window), window, { nextNumber: r.nextUint(number) });
  r.enterClaims({ state, event, agent: owner, plots: [{ block: base, patterns: [number] }], patterns: new Map([[number, pattern]]),
    history: { get: h => ({ height: h }) }, settings });
  r.freezeClaimWindow({ state, event, decidingHash: r.hash('seed'), counted: r.addUint(window, '2'), settings });
  // A persisted continuation's absolute page is independent of JS array offsets.
  const page = r.recordGet(state.settlementPages, `${window}/1`);
  state.settlementPages = r.recordSet(state.settlementPages, `${window}/${base}`, page);
  event.cursor = base; event.pages = r.nextUint(base);
  const out = r.takeSettlementPage({ state, event, height: r.addUint(window, '2'), budget: new r.CreditBudget(settings) });
  assert.equal(out.page, base); assert.equal(event.cursor, r.nextUint(base)); assert.equal(out.winners[0].id, r.findIdV2(base, number));
  assert.equal(r.recordGet(state.finds, out.winners[0].id).findHeight, r.addUint(window, '2'));
});
