import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import * as r from '../../rules/src/index.js';
import { witnesses, receiptSigners } from '../../rules/test/witness-fixture.mjs';
import { Store } from '../src/store.mjs';
import { NamedAdmission } from '../src/named-admission.mjs';
import { SegmentedIntake } from '../src/segmented-intake.mjs';
import { ReceiptFences } from '../../committee/signer/receipt-fences.mjs';
import { Journal } from '../../committee/signer/journal.mjs';
import { temp } from './helpers.mjs';

const secret = r.hashBytes('G4b3 disposable admission'), gateway = r.bytesToHex(ed25519.getPublicKey(secret)), network = 'g4b3-test';
async function setup(t) {
  const directory = await temp(), document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '0',
    values: { ...r.SETTINGS_PROFILE, puzzleBits: 0, adminDelayTips: 1 } });
  const successor = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '101', previous: document,
    values: { ...document.values, receiptSegmentEntries: 1 } });
  const resources = r.resourceRevision({ operator: 'fixture', values: { ...r.RESOURCE_PROFILE } });
  const history = new r.SettingsHistory(); history.append(document, r.hashObject(document));
  const checkpoint = r.initialClaimSnapshot({ bitcoinAnchor: { height: '100' } }, '100');
  const named = r.emptyNamedDiscovery(), storage = new r.NamedStorage({ get: () => null, cacheSize: 16 }), saved = storage.save(named);
  const state = { ...checkpoint.hot, batchVersion: 2, claimSnapshot: checkpoint, claimRoot: r.claimStateRoot(checkpoint),
    catalogRoot: r.namedStateRoot(named), namedSnapshot: saved.snapshot };
  let store = await Store.open(directory);
  await store.transact([...saved.writes, { space: 'meta', id: 'ruleState', value: state }]);
  const predecessor = { n: '0', root: r.hash('predecessor'), claims: state.claimRoot, catalog: state.catalogRoot };
  const accepted = { ready: true, settings: document, settingsHash: r.hashObject(document), last: { n: '0', to: '100' },
    scheduledSettings: successor,
    claimsRoot: state.claimRoot, catalogRoot: state.catalogRoot, manifest: { previousBatchRoot: predecessor.root } };
  const reads = { rulesContext: async () => accepted, tip: async () => ({ tip: '100' }), authority: async () => ({ epoch: '0' }),
    receiptCutoffPage: async (hash, index) => store.get('receiptCutoffPages', r.receiptCutoffPageKey(hash, index)),
    receiptCertificate: async (tip, hash, segment) => store.get('receiptCertificates', `${tip}/${hash}/${segment}`),
    receiptObservation: async (tip, hash, segment) => store.get('receiptObservations', `${tip}/${hash}/${segment}`) };
  let journals = [], signers = [];
  async function reopenSigners() {
    await Promise.all(journals.map(j => j.close()));
    journals = await Promise.all(witnesses.map(w => new Journal(join(directory, w.id + '.log'), 'disposable', network, w.id).load()));
    signers = witnesses.map((w, i) => new ReceiptFences({ members: receiptSigners, journal: journals[i], reads, network, gateway, signer: w.id, secret: w.secret }));
  }
  await reopenSigners();
  let lost = false;
  const committee = {
    async acknowledgeReceipt(receipt, checkpoint) {
      const votes = await Promise.all(signers.map(s => s.admit(receipt, checkpoint)));
      if (lost) throw Error('ambiguous_acknowledgment');
      assert.ok(r.verifyReceiptFenceVotes('admission', receipt, votes, receiptSigners)); return votes;
    },
    async attestRoot(seal) {
      const attestations = witnesses.map(w => r.attestReceiptRoot(seal, '100', w.id, w.secret));
      await store.put('receiptCertificates', r.receiptSegmentKey(seal), { seal, attestations }); return attestations;
    },
    async fenceReceipts(cutoff, evidence) {
      const votes = await Promise.all(signers.map(async s => { let vote; do { vote = await s.cutoff(cutoff, evidence); } while (vote.pending); return vote; }));
      if (lost) throw Error('ambiguous_cutoff');
      assert.ok(r.verifyReceiptFenceVotes('cutoff', cutoff, votes, receiptSigners)); return votes;
    }
  };
  let intake, admission;
  function reopenIntake() {
    const context = () => ({ ready: true, ruleset: 'dmw-v2', settings: document, settingsHistory: history,
      batch: '1', tip: '100', counted: '100', state: named, acceptedRoot: state.catalogRoot,
      observation: intake.head.id, segmented: true, sealed: intake.rotating });
    intake = new SegmentedIntake({ store, network, secret, hashAt: r.hash, settings: { document, batchVersion: 2, receiptSigners }, resources });
    admission = new NamedAdmission({ store, secret, context, resources, hashAt: r.hash, history: { get: height => ({ height, hash: r.hash(height) }) }, committee });
    intake.namedAdmission = admission;
  }
  reopenIntake(); await intake.observe({ tip: '100', counted: '100', hash: r.hash('100'), confirmed: '100', revision: '1' });
  const packet = n => {
    const body = { v: 2, ruleset: 'dmw-v2', network, settingsRevision: document.revision, settingsHash: r.hashObject(document), a: gateway,
      t: 'discovery-commit-v2', b: '100', h: r.hash('100'), p: { commitment: r.hash('commit ' + n) }, w: '0' };
    return r.stableJSON({ ...body, sig: r.bytesToHex(ed25519.sign(r.moveDigestV2(body), secret)) });
  };
  t.after(async () => { await Promise.all(journals.map(j => j.close())); await store.close(); });
  return { directory, document, successor, predecessor, packet, reads, accepted, state,
    get store() { return store; }, get signers() { return signers; }, get intake() { return intake; }, get admission() { return admission; },
    loseResponses(value) { lost = value; }, reopenSigners,
    async reopen() { await store.close(); store = await Store.open(directory); reopenIntake(); await reopenSigners(); },
    fence() { return intake.fence({ document, successor, predecessor }); }
  };
}

test('cutoff and concurrent admission serialize; receipts, immutable segments and exact retries survive restart', async t => {
  const f = await setup(t), packets = [f.packet(1), f.packet(2), f.packet(3)];
  const first = await f.admission.accept(packets[0]);
  const second = f.admission.accept(packets[1]), fencing = f.fence(), late = f.admission.accept(packets[2]);
  const lateCheck = assert.rejects(late, /receipt_admission_fenced/);
  const receipt2 = await second, fence = await fencing; await lateCheck;
  assert.equal(fence.cutoff.lastSequence, receipt2.sequence); assert.equal(fence.cutoff.acceptedSequence, '0');
  assert.equal(f.store.get('receiptCutoffPages', r.receiptCutoffPageKey(r.hashObject(f.document), '0')).segment.receipts.length, 2);
  assert.ok(r.verifyReceiptFenceVotes('cutoff', fence.cutoff, fence.votes, receiptSigners));
  await f.reopen(); assert.deepEqual(await f.fence(), fence);
  assert.deepEqual(await f.admission.accept(packets[0]), first);
  assert.deepEqual(await f.admission.accept(packets[1]), receipt2);
  await assert.rejects(f.admission.accept(packets[2]), /receipt_admission_fenced/);
  const lateReceipt = r.signReceiptV2(JSON.parse(packets[2]), { tip: '100', hash: r.hash('100'), sequence: '3', batch: '1' }, secret);
  for (const signer of f.signers) await assert.rejects(signer.admit(lateReceipt, f.state.claimSnapshot), /receipt_admission_fenced/);
});

test('ambiguous receipt and cutoff responses retain reservations across process reopen', async t => {
  const f = await setup(t), packet = f.packet(1);
  f.loseResponses(true); await assert.rejects(f.admission.accept(packet), /ambiguous_acknowledgment/);
  const original = f.store.get('namedDedupe', r.moveIdV2(JSON.parse(packet))).receipt;
  await f.reopen(); f.loseResponses(false);
  assert.deepEqual(await f.admission.accept(packet), original);
  f.loseResponses(true); await assert.rejects(f.fence(), /ambiguous_cutoff/);
  const sealed = f.store.get('namedFences', r.hashObject(f.document)); assert.equal(sealed.phase, 'sealed');
  await f.reopen(); f.loseResponses(false);
  const certified = await f.fence(); assert.equal(certified.phase, 'certified'); assert.deepEqual(certified.cutoff, sealed.cutoff);
  assert.equal(f.store.count('observations'), 1);
});

test('independent witnesses reject omitted tails, forged members, cutoff conflicts and missing checkpoint proofs', async t => {
  const f = await setup(t); await f.admission.accept(f.packet(1)); await f.admission.accept(f.packet(2));
  // Seal without fencing the witnesses so omission checks cannot be satisfied
  // merely by their already having endorsed a different cutoff hash.
  await f.intake.seal();
  const segment = f.store.list('receiptObservations')[0].value, checkpoint = f.state.claimSnapshot;
  const evidence = { document: f.document, successor: f.successor, checkpoint, segments: [segment], claimEvidence: { nodes: [] } };
  const build = e => r.receiptCutoff({ ...e, network, gateway, predecessor: f.predecessor });
  const omitted = structuredClone(evidence); omitted.segments[0].receipts.pop();
  omitted.segments[0].seal = r.sealReceiptSegment(omitted.segments[0].receipts, segment.seal, secret);
  const omission = build(omitted);
  for (const signer of f.signers) await assert.rejects(signer.cutoff(omission, omitted), /receipt_cutoff_omission/);
  const forged = structuredClone(evidence); forged.segments[0].receipts[0].move = r.hash('forged');
  assert.throws(() => build(forged), /receipt_cutoff_segment/);
  const missing = structuredClone(evidence); missing.checkpoint.maps.receiptSegments = { storage: r.hash('missing'), root: r.hash('root') };
  assert.throws(() => r.receiptCutoff({ ...missing, network, gateway, predecessor: { ...f.predecessor, claims: r.claimStateRoot(missing.checkpoint) } }), /claim_state_proof/);
  const cutoff = build(evidence); await Promise.all(f.signers.map(s => s.cutoff(cutoff, evidence))); await f.reopenSigners();
  for (const signer of f.signers) await assert.rejects(signer.cutoff({ ...cutoff, lastSequence: '3' }, evidence), /receipt_cutoff_conflict/);
});

test('an uncertain prepared batch prevents a gateway cutoff before any durable fence', async t => {
  const f = await setup(t); await f.admission.accept(f.packet(1));
  await f.store.put('meta', 'draft', { proposal: { batch: { n: '1' } } });
  await assert.rejects(f.fence(), /receipt_cutoff_draft_pending/);
  assert.equal(f.store.get('namedFences', r.hashObject(f.document)), null);
});

for (const boundary of ['closing', 'sealed', 'evidence', 'certified']) test(`cutoff reopens after a crash immediately after durable ${boundary}`, async t => {
  const f = await setup(t), packet = f.packet(1), receipt = await f.admission.accept(packet), transact = f.store.transact.bind(f.store);
  let crashed = false;
  f.store.transact = async operations => {
    const result = await transact(operations), fence = operations.find(o => o.space === 'namedFences')?.value;
    const phase = fence?.phase === 'sealed' && fence.cutoff ? 'evidence' : fence?.phase;
    if (!crashed && phase === boundary) { crashed = true; throw Error('injected_process_exit'); }
    return result;
  };
  await assert.rejects(f.fence(), /injected_process_exit/); assert.ok(crashed);
  await f.reopen(); const result = await f.fence(); assert.equal(result.phase, 'certified');
  assert.equal(result.cutoff.segmentCount, '1'); assert.equal(f.store.count('observations'), 1);
  assert.deepEqual(await f.admission.accept(packet), receipt);
});

test('receipt reservations prevent batch omissions and late admission after preparation, including restart', async t => {
  const f = await setup(t), receipt = await f.admission.accept(f.packet(1));
  await f.reopenSigners();
  const signer = f.signers[0], batch = { n: '1', settingsHash: r.hashObject(f.document) };
  assert.throws(() => signer.checkBatch(batch, [{ receipts: [], receiptRoot: {} }]), /receipt_batch_omission/);
  assert.doesNotThrow(() => signer.checkBatch(batch, [{ receipts: [receipt], receiptRoot: {} }]));
  await signer.journal.reserve(['batch/0/1'], r.hash('prepared'), r.hash('ceremony'), { n: '1', epoch: '0', deadline: '106' });
  await f.reopenSigners();
  const next = r.signReceiptV2(JSON.parse(f.packet(2)), { tip: '100', hash: r.hash('100'), sequence: '2', batch: '1' }, secret);
  await assert.rejects(f.signers[0].admit(next, f.state.claimSnapshot), /receipt_batch_reserved/);
  assert.deepEqual(await f.signers[0].admit(receipt, f.state.claimSnapshot), signer.receipts.get(receipt.sequence).vote);
});

test('live signing reservations survive ambiguous responses; only proven expiry permits fencing', async t => {
  const f = await setup(t); await f.admission.accept(f.packet(1));
  let counted = '100';
  Object.assign(f.reads, { counted: async () => counted, batchLast: async () => f.accepted.last, batchRoot: async () => null });
  for (const signer of f.signers) await signer.journal.reserve(['batch/0/1'], r.hash('prepared'), r.hash('ceremony'), { n: '1', epoch: '0', deadline: '106' });
  await f.reopenSigners(); await assert.rejects(f.fence(), /batch_retirement_unproven/);
  counted = '107'; await f.reopenSigners(); assert.equal((await f.fence()).phase, 'certified');
  for (const signer of f.signers) assert.equal(signer.journal.slots.has('batch/0/1'), false);
});

test('a sync failure leaves the signer unusable until its durable journal is reopened', async t => {
  const f = await setup(t), signer = f.signers[0], receipt = r.signReceiptV2(JSON.parse(f.packet(1)), { tip: '100', hash: r.hash('100'), sequence: '1', batch: '1' }, secret);
  const append = signer.journal.append.bind(signer.journal);
  signer.journal.append = async (...args) => { await append(...args); throw Error('ambiguous_fsync'); };
  await assert.rejects(signer.admit(receipt, f.state.claimSnapshot), /ambiguous_fsync/);
  await assert.rejects(signer.admit(receipt, f.state.claimSnapshot), /receipt_journal_uncertain/);
  await f.reopenSigners(); assert.ok(r.verifyReceiptFenceVotes('admission', receipt, [await f.signers[0].admit(receipt, f.state.claimSnapshot)], receiptSigners, 1));
});

test('an omitted acknowledged tail cannot obtain a different three-of-five cutoff quorum', async t => {
  const f = await setup(t), receipt = r.signReceiptV2(JSON.parse(f.packet(1)), { tip: '100', hash: r.hash('100'), sequence: '1', batch: '1' }, secret);
  const votes = await Promise.all(f.signers.slice(0, 3).map(s => s.admit(receipt, f.state.claimSnapshot)));
  assert.ok(r.verifyReceiptFenceVotes('admission', receipt, votes, receiptSigners)); await f.reopenSigners();
  const empty = { document: f.document, successor: f.successor, checkpoint: f.state.claimSnapshot, segments: [], claimEvidence: { nodes: [] } };
  const build = evidence => r.receiptCutoff({ ...evidence, network, gateway, predecessor: f.predecessor });
  const omitted = build(empty), replies = await Promise.allSettled(f.signers.map(s => s.cutoff(omitted, empty)));
  const minority = replies.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  assert.equal(minority.length, 2); assert.equal(r.verifyReceiptFenceVotes('cutoff', omitted, minority, receiptSigners), false);
  await f.reopenSigners();
  const seal = r.sealReceiptSegment([receipt], { network, tip: '100', hash: r.hash('100'), segment: '0', previous: null,
    ruleset: 'dmw-v2', settingsRevision: f.document.revision, settingsHash: r.hashObject(f.document) }, secret);
  const evidence = { ...empty, segments: [{ seal, receipts: [receipt] }] }, complete = build(evidence);
  await f.store.put('receiptObservations', r.receiptSegmentKey(seal), evidence.segments[0]);
  const restored = await Promise.allSettled(f.signers.map(s => s.cutoff(complete, evidence)));
  const majority = restored.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
  assert.equal(majority.length, 3); assert.ok(r.verifyReceiptFenceVotes('cutoff', complete, majority, receiptSigners));
});

test('admission requires the accepted checkpoint and refuses a consumed receipt sequence', async t => {
  const f = await setup(t), signer = f.signers[0];
  const receipt = r.signReceiptV2(JSON.parse(f.packet(1)), { tip: '100', hash: r.hash('100'), sequence: '1', batch: '1' }, secret);
  await assert.rejects(signer.admit(receipt), /receipt_admission_checkpoint/);
  const forged = structuredClone(f.state.claimSnapshot); forged.hot.namedSequence = '5';
  await assert.rejects(signer.admit(receipt, forged), /receipt_admission_checkpoint/);
  f.accepted.claimsRoot = r.claimStateRoot(forged);
  await assert.rejects(signer.admit(receipt, forged), /receipt_admission_checkpoint/);
  assert.equal(signer.receipts.size, 0);
});

test('accepted work recovers an uncertain acknowledgment without asking witnesses to acknowledge it again', async t => {
  const f = await setup(t), packet = f.packet(1), id = r.moveIdV2(JSON.parse(packet));
  f.loseResponses(true); await assert.rejects(f.admission.accept(packet), /ambiguous_acknowledgment/);
  const receipt = f.store.get('namedDedupe', id).receipt;
  await f.store.put('namedAccepted', id, { receipt: r.hashObject(receipt), batch: '1' });
  await f.reopen(); assert.deepEqual(await f.admission.accept(packet), receipt);
  await f.store.put('namedAccepted', id, { receipt: r.hash('forged'), batch: '1' });
  await assert.rejects(f.admission.accept(packet), /receipt_acceptance_conflict/);
});

test('an unauthorized successor cannot permanently fence the accepted admission policy', async t => {
  const f = await setup(t); await f.admission.accept(f.packet(1)); await f.intake.seal();
  const successor = r.settingsRevision({ network, previous: f.document, effectiveBatch: '2', effectiveBitcoinWindow: '101',
    values: { ...f.successor.values, commitLifetime: 17 } });
  const evidence = { document: f.document, successor, checkpoint: f.state.claimSnapshot,
    segments: f.store.list('receiptObservations').map(r => r.value), claimEvidence: { nodes: [] } };
  const cutoff = r.receiptCutoff({ ...evidence, network, gateway, predecessor: f.predecessor });
  for (const signer of f.signers) {
    await assert.rejects(signer.cutoff(cutoff, evidence), /receipt_cutoff_successor/);
    assert.equal(signer.fences.size, 0);
  }
  await f.reopen(); assert.equal((await f.fence()).phase, 'certified');
});
