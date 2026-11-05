import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import { rules as r, initialState } from '../src/rules.mjs';
import { NamedAdmission } from '../src/named-admission.mjs';
import { SegmentedIntake } from '../src/segmented-intake.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Files } from '../src/files.mjs';
import { Store } from '../src/store.mjs';
import { WorkerStatus } from '../src/worker-status.mjs';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
import { harness, deployment } from '../../contract/tests/helpers/harness.mjs';
import { ReceiptFences } from '../../committee/signer/receipt-fences.mjs';
import { Journal } from '../../committee/signer/journal.mjs';
import { rebuildBatch } from '../../committee/signer/adapter.mjs';
import { temp, network, secret, gateway, fixtureHistory, agent, receiptSigners } from './helpers.mjs';

async function setup(t) {
  const directory = await temp('receipt-self-heal-'), history = fixtureHistory(30);
  const legacy = harness({ ...deployment, network }); await legacy.advance(9); await legacy.batch([]); await legacy.advance(1);
  const imported = prepareTerminalImport({ records: legacy.db, height: 10 });
  const document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '10', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0 } });
  const settingsHistory = new r.SettingsHistory(); settingsHistory.append(document, r.hashObject(document));
  const named = r.emptyNamedDiscovery(), manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2',
    previousBatchRoot: legacy.db.get('bt/1'), bitcoinAnchor: { height: '10', hash: history.hashAt(10) }, settingsHash: r.hashObject(document),
    catalogRoot: r.namedStateRoot(named), accountsRoot: imported.financialRoot, receiptSegmentStart: '0',
    schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const settings = r.activatedBatchSettings({ manifest, manifestHash: r.hashObject(manifest), document, receiptSigners });
  const resources = r.resourceRevision({ operator: 'fixture', values: r.RESOURCE_PROFILE });
  let store = await Store.open(directory), pipeline, intake, admission, tip = '10', batch = '2', unavailable = true, journals = [], signers = [];
  const calls = [], files = new Files(join(directory, 'static')), last = { n: '1', to: '9' };
  const checkpoint = r.initialClaimSnapshot(manifest, 9);
  const state = { ...initialState(10, history.hashAt(10), 9), ...checkpoint.hot, batchVersion: 2,
    claimSnapshot: checkpoint, claimRoot: r.claimStateRoot(checkpoint), catalogRoot: manifest.catalogRoot, accountRoot: manifest.accountsRoot };
  await store.transact([...imported.availability, ...imported.accountRecords, { space: 'meta', id: 'ruleState', value: state }]);
  const reads = { batchLast: async () => last, committeeEpoch: async () => '0', counted: async () => tip,
    batchRoot: async n => n === '1' ? manifest.previousBatchRoot : null, tip: async () => ({ tip }), authority: async () => ({ epoch: '0' }),
    rulesContext: async () => ({ ready: true, last, settings: document, settingsHash: r.hashObject(document), claimsRoot: state.claimRoot }) };
  const committee = {
    async acknowledgeReceipt(receipt, snapshot) {
      calls.push('ack/' + receipt.sequence);
      if (unavailable) throw Object.assign(Error('receipt_fence_quorum_unavailable'), { status: 503 });
      return Promise.all(signers.map(s => s.admit(receipt, snapshot)));
    },
    async attestRoot(seal) {
      calls.push('attest/' + seal.segment);
      const { receipts } = store.get('receiptObservations', r.receiptSegmentKey(seal));
      const votes = signers.map((s, i) => {
        s.checkSegment(seal, receipts);
        const late = receipts.length && r.compareUint(tip, r.addUint(seal.tip, '2')) >= 0;
        return r.attestReceiptRoot(seal, late && s.admittedAll(receipts) ? seal.tip : tip, receiptSigners[i].id, agent(800 + i).secret);
      });
      assert.ok(r.verifyRootAttestations(seal, votes, receiptSigners)); return votes;
    },
    async signature() { return null; }
  };
  async function open() {
    journals = await Promise.all(receiptSigners.map(w => new Journal(join(directory, w.id + '.log'), 'disposable', network, w.id).load()));
    signers = receiptSigners.map((w, i) => new ReceiptFences({ journal: journals[i], reads, members: receiptSigners,
      network, gateway, signer: w.id, secret: agent(800 + i).secret }));
    const context = () => ({ ready: true, ruleset: 'dmw-v2', settings: document, settingsHistory, batch, tip, counted: tip, future: batch === '3',
      state: named, acceptedRoot: manifest.catalogRoot, observation: intake.head.id, segmented: true, sealed: intake.rotating });
    intake = new SegmentedIntake({ store, network, secret, hashAt: history.hashAt, settings });
    admission = new NamedAdmission({ store, secret, context, resources, hashAt: history.hashAt, history, committee });
    intake.namedAdmission = admission;
    pipeline = new Pipeline({ store, files, history, intake, reads, committee, settings });
  }
  await open(); await intake.observe({ tip, counted: tip, confirmed: tip, hash: history.hashAt(tip) });
  t.after(async () => { await pipeline.close(); await Promise.all(journals.map(j => j.close())); await store.close(); });
  const packet = n => {
    const move = { v: 2, ruleset: 'dmw-v2', network, settingsRevision: document.revision, settingsHash: r.hashObject(document),
      a: gateway, t: 'discovery-commit-v2', b: tip, h: history.hashAt(tip), p: { commitment: r.hash('pending-' + n) }, w: '0' };
    return r.stableJSON({ ...move, sig: r.bytesToHex(ed25519.sign(r.moveDigestV2(move), secret)) });
  };
  return { packet, calls, committee, history, settings, last, reads,
    get store() { return store; }, get admission() { return admission; }, get intake() { return intake; }, get pipeline() { return pipeline; },
    get signers() { return signers; }, available(value = true) { unavailable = !value; }, advance(value) { tip = value; }, reserve(value) { batch = value; },
    async reopen() { await pipeline.close(); await Promise.all(journals.map(j => j.close())); await store.close(); store = await Store.open(directory); await open(); }
  };
}

for (const tip of ['11', '12', '20']) test(`pipeline recovers sealed pending receipts at tip ${tip} without a client retry`, async t => {
  const f = await setup(t), text = f.packet(1), id = r.moveIdV2(JSON.parse(text));
  await assert.rejects(f.admission.accept(text), /receipt_fence_quorum_unavailable/);
  const original = f.store.get('namedDedupe', id).receipt, sealed = await f.intake.seal();
  assert.ok(f.signers.every(s => !s.admittedAll([original])));
  f.advance(tip);
  if (tip !== '11') await assert.rejects(f.committee.attestRoot(sealed.receiptRoot), /receipt_attestation_late/);
  await f.reopen(); f.available(); f.calls.length = 0;
  await f.pipeline.tick();
  assert.deepEqual(f.calls, ['ack/1', 'attest/0']);
  assert.equal(f.store.get('namedDedupe', id).witnessPending, undefined);
  assert.deepEqual(f.store.get('namedDedupe', id).receipt, original);
  assert.ok(f.signers.every(s => s.admittedAll([original])));
  const draft = await f.pipeline.loadDraft();
  assert.deepEqual(draft.items[0].input.receiptRoot, sealed.receiptRoot);
  assert.deepEqual(draft.items[0].input.entries[0].receipt, original);
  const rebuilt = rebuildBatch(network, draft.proposal, { authority: { epoch: '0' }, counted: draft.execution, gateway,
    state: draft.startState, patterns: draft.startPatterns, inputs: draft.items.map(i => i.input), history: f.history, hashAt: f.history.hashAt,
    settings: draft.settings, limits: draft.limits, last: f.last, activation: f.settings.activation, previousRoot: draft.previousRoot });
  assert.equal(rebuilt.batch.root, draft.proposal.batch.root);
  await f.pipeline.tick(); assert.deepEqual(f.calls, ['ack/1', 'attest/0']);
  assert.deepEqual(await f.admission.accept(text), original);
  assert.equal(f.store.get('meta', 'namedReceiptSequence'), '1');
});

test('failed acknowledgement stays visible to the worker and retries on the next pipeline tick', async t => {
  const f = await setup(t), text = f.packet(1), id = r.moveIdV2(JSON.parse(text));
  await assert.rejects(f.admission.accept(text), /receipt_fence_quorum_unavailable/); await f.intake.seal();
  const status = new WorkerStatus(f.store); f.calls.length = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await status.run('pipeline', () => f.pipeline.tick());
    assert.equal(f.store.get('meta', 'workerStatus').code, 'receipt_fence_quorum_unavailable');
    assert.equal(f.pipeline.step[0], 'acknowledgeReceipts'); assert.equal(f.pipeline.running, false);
    assert.equal(f.store.get('namedDedupe', id).witnessPending, true);
    assert.equal(f.store.get('meta', 'draft'), null);
  }
  assert.deepEqual(f.calls, ['ack/1', 'ack/1']);
  f.available(); await status.run('pipeline', () => f.pipeline.tick());
  assert.equal(f.store.get('meta', 'workerStatus'), null);
  assert.deepEqual(f.calls, ['ack/1', 'ack/1', 'ack/1', 'attest/0']);
});

test('recovery serializes with exact retries and acknowledges only pending receipts in sequence', async t => {
  const f = await setup(t), packets = [f.packet(1), f.packet(2), f.packet(3)];
  for (const text of packets.slice(0, 2)) await assert.rejects(f.admission.accept(text), /receipt_fence_quorum_unavailable/);
  f.available(); await f.admission.accept(packets[2]); await f.intake.seal(); f.calls.length = 0;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const acknowledge = f.committee.acknowledgeReceipt;
  f.committee.acknowledgeReceipt = async (...args) => { entered(); await gate; return acknowledge(...args); };
  const build = f.pipeline.tick(); await started;
  const retry = f.admission.accept(packets[0]); release(); await Promise.all([build, retry]);
  assert.deepEqual(f.calls, ['ack/1', 'ack/2', 'attest/0']);
  assert.equal(f.store.get('meta', 'namedReceiptSequence'), '3');
});

test('a partially recovered observation resumes at its first remaining pending receipt', async t => {
  const f = await setup(t), packets = [f.packet(1), f.packet(2), f.packet(3)];
  for (const text of packets) await assert.rejects(f.admission.accept(text), /receipt_fence_quorum_unavailable/);
  await f.intake.seal(); f.available(); f.calls.length = 0;
  const acknowledge = f.committee.acknowledgeReceipt;
  f.committee.acknowledgeReceipt = async (...args) => {
    const result = await acknowledge(...args); f.available(false); return result;
  };
  await assert.rejects(f.pipeline.tick(), /receipt_fence_quorum_unavailable/);
  assert.deepEqual(f.calls, ['ack/1', 'ack/2']);
  await f.reopen(); f.committee.acknowledgeReceipt = acknowledge; f.available(); f.calls.length = 0;
  await f.pipeline.tick(); assert.deepEqual(f.calls, ['ack/2', 'ack/3', 'attest/0']);
});

test('successor preparation finishes pending acknowledgements before speculative replay', async t => {
  const f = await setup(t); f.available();
  await f.admission.accept(f.packet(1)); const predecessor = await f.pipeline.build();
  f.pipeline.pipelineDepth = 2; f.reserve('3'); f.available(false);
  await assert.rejects(f.admission.accept(f.packet(2)), /receipt_fence_quorum_unavailable/);
  await f.intake.seal(); f.available(); f.calls.length = 0;
  const build = await f.pipeline.prepareSuccessor(predecessor);
  assert.equal(typeof build, 'function'); assert.deepEqual(f.calls, ['ack/2', 'attest/1']);
  const successor = await build(); assert.equal(successor.proposal.batch.n, '3');
  assert.deepEqual(f.calls, ['ack/2', 'attest/1']);
});
