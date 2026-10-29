import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ed25519 } from '../../rules/node_modules/@noble/curves/ed25519.js';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import * as r from '../../rules/src/index.js';
import { harness, deployment, committeeSecret, signedBatch } from '../../contract/tests/helpers/harness.mjs';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
import { installGatewayActivation, createV2Runtime } from '../src/v2-runtime.mjs';
import { initialState } from '../src/rules.mjs';
import { Store } from '../src/store.mjs';
import { Files } from '../src/files.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { Outbox } from '../src/transport.mjs';
import { Policy } from '../../committee/signer/policy.mjs';
import { rebuildBatch } from '../../committee/signer/adapter.mjs';
import { ReceiptFences } from '../../committee/signer/receipt-fences.mjs';
import { Journal } from '../../committee/signer/journal.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';
import { ServiceClient } from '../../kit/lib/service-client.mjs';
import { TracClient } from '../../kit/lib/trac.mjs';
import { Agent } from '../../kit/lib/agent.mjs';
import { verifyRenewedAudit } from '../../kit/lib/receipt-renewal.mjs';
import { serve } from '../src/http.mjs';
import { heightKey } from '../src/util.mjs';
import { chain } from '../../contract/tests/helpers/chain.mjs';
import { temp, secret, gateway, fixtureHistory, agent } from './helpers.mjs';

async function setup(t, { manualFence = true, receiptCount = 2, deferBoundaryRefresh = false, beforeBoundary,
  receiptProtocol = 1, documentValues = {}, successorValues = {}, separateReceipts = false, withFinancial = false, pipelineDepth = 1, deferRecovery = false } = {}) {
  const directory = await temp('receipt-renewal-'), network = deployment.network, originalHistory = fixtureHistory(40);
  const replacement = new Map();
  const history = { ...originalHistory, raw: h => replacement.get(String(h)) ?? originalHistory.raw(h),
    get: h => replacement.has(String(h)) ? r.parseHeader(replacement.get(String(h)), Number(h)) : originalHistory.get(h),
    hashAt: h => replacement.has(String(h)) ? r.parseHeader(replacement.get(String(h)), Number(h)).hash : originalHistory.hashAt(h),
    view: (tip, hash) => { assert.equal(originalHistory.hashAt(tip), hash); return originalHistory; } };
  const witnesses = Array.from({ length: 5 }, (_, i) => ({ ...agent(1200 + i), id: `renewal-${i}` }));
  const members = witnesses.map(w => ({ id: w.id, identity: w.address }));
  const old = harness(); await old.mint(['p0']);
  const imported = prepareTerminalImport({ records: old.db, height: 1, pageBytes: 10000 });
  const document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '1',
    values: { ...r.SETTINGS_PROFILE, puzzleBits: 0, adminDelayTips: 1, ...documentValues } });
  const named = r.emptyNamedDiscovery(), manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2',
    effectiveBatch: '2', previousBatchRoot: old.db.get('bt/1'), bitcoinAnchor: { height: '1', hash: history.hashAt(1) },
    settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(named), accountsRoot: imported.financialRoot,
    receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const pin = { manifest, manifestHash: r.hashObject(manifest), document, gateway, receiptSigners: members,
    ...(receiptProtocol ? { receiptProtocol } : {}),
    importRoot: imported.importRoot, importRows: imported.importRows };
  const contract = harness({ ...deployment, v2: pin }), contexts = new Map();
  for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
  let store = await Store.open(join(directory, 'gateway')), pipeline, runtime, journals = [], signers = [], policies = [];
  t.after(async () => { await pipeline?.close(); await Promise.all(journals.map(j => j.close())); await store.close(); });
  const files = new Files(join(store.directory, 'static'));
  await store.put('meta', 'ruleState', initialState(1, history.hashAt(1), 1));
  await installGatewayActivation({ store, ...pin, imported, named });
  const rulesContext = async () => ({ ruleset: 'dmw-v2', ready: true, manifest, manifestHash: pin.manifestHash,
    settings: contract.db.get('v2/settings'), settingsHash: r.hashObject(contract.db.get('v2/settings')),
    scheduledSettings: contract.db.get('v2/settings-next') ?? null, receiptRenewal: contract.db.get('v2/receipt-renewal') ?? null,
    receiptProtocol: contract.db.get('v2/receipt-protocol') ?? null,
    last: await contract.state().batchLast(), catalogRoot: contract.db.get('v2/catalog'),
    claimsRoot: contract.db.get('v2/claims'), accountsRoot: contract.db.get('v2/accounts') });
  const reads = { rulesContext, counted: async () => (await contract.state().head()).counted,
    tip: async () => ({ tip: (await contract.state().head()).tip.height }),
    authority: async () => ({ network, committee: deployment.committee, epoch: await contract.state().committeeEpoch() }),
    committeeEpoch: () => contract.state().committeeEpoch(), batchLast: () => contract.state().batchLast(),
    batchRoot: async n => contract.db.get('bt/' + n) ?? null, settings: () => contract.state().settings(),
    renewalSlice: async n => contract.db.get('v2/receipt-renewal-slice/' + n) ?? null,
    settingsByHash: async hash => contract.db.get('v2/settings/' + hash),
    receiptCutoffPage: async (hash, index) => store.get('receiptCutoffPages', r.receiptCutoffPageKey(hash, index)),
    receiptObservation: async (tip, hash, segment) => store.get('receiptObservations', `${tip}/${hash}/${segment}`),
    receiptCertificate: async (tip, hash, segment) => store.get('receiptCertificates', `${tip}/${hash}/${segment}`),
    batchContext: async n => {
      const context = structuredClone(contexts.get(n));
      if (!context) return { history, hashAt: history.hashAt };
      return { ...context, history, hashAt: history.hashAt,
        executionHash: await contract.state().beacon().hashAt(context.counted),
        views: context.inputs.map(i => { const view = history.view(i.tip, i.tipHash); return { history: view, hashAt: view.hashAt }; }) };
    },
    preflight: (batch, at) => preflightBatch(batch, at, { read: key => contract.db.get(key), deployment: contract.options }),
    publishContext: async (n, d) => contexts.set(n, { last: d.last, counted: d.execution, state: d.startState, patterns: d.startPatterns,
      gateway, settings: d.settings, limits: d.limits, headers: d.headers, activation: d.activation, previousRoot: d.previousRoot,
      inputs: d.items.map(i => i.input) }) };
  if (withFinancial) {
    reads.financialRecord = async () => null;
    reads.financialEvidence = async () => { throw Error('unexpected_financial_execution'); };
  }
  async function reopenSigners() {
    await Promise.all(journals.map(j => j.close()));
    journals = await Promise.all(witnesses.map(w => new Journal(join(directory, w.id + '.log'), 'disposable-renewal', network, w.id).load()));
    signers = witnesses.map((w, i) => new ReceiptFences({ members, journal: journals[i], reads, network, gateway, signer: w.id, secret: w.secret }));
    policies = signers.map(receiptFences => new Policy({ network, publicKey: deployment.committee, reads, receiptFences,
      replayBatch: async (...args) => rebuildBatch(...args) }));
  }
  await reopenSigners();
  let loseSignature = false;
  const committee = { healthy: async () => members,
    acknowledgeReceipt: (receipt, checkpoint) => Promise.all(signers.map(s => s.admit(receipt, checkpoint))),
    fenceReceipts: async (cutoff, evidence) => {
      const results = await Promise.allSettled(signers.map(async s => {
        let vote; do { vote = await s.cutoff(cutoff, evidence); } while (vote.pending); return vote;
      }));
      const failed = results.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
      return results.map(r => r.value);
    },
    attestRoot: async seal => {
      const prior = store.get('receiptCertificates', r.receiptSegmentKey(seal)); if (prior) return prior.attestations;
      const tip = (await reads.tip()).tip, attestations = witnesses.map(w => r.attestReceiptRoot(seal, tip, w.id, w.secret));
      await store.put('receiptCertificates', r.receiptSegmentKey(seal), { seal, attestations }); return attestations;
    },
    signature: async (key, proposal) => {
      const approvals = await Promise.all(policies.map(p => p.approve(proposal)));
      assert.equal(new Set(approvals.map(a => a.digest)).size, 1);
      for (let i = 0; i < 5; i++) await journals[i].reserve(approvals[i].slots, approvals[i].digest, r.hash(key), approvals[i].details);
      if (loseSignature) throw Error('uncertain_signature');
      return { signature: { compact: secp256k1.sign(approvals[0].digest, committeeSecret, { lowS: true, prehash: false }).toCompactHex() } };
    } };
  const config = { mode: 'regtest', network, assetRecoveryVersion: 2, committee: members.map(peer => ({ peer })),
    v2: { ...pin, resources: r.resourceRevision({ operator: 'renewal-fixture', values: r.RESOURCE_PROFILE }) } };
  const transport = { prepareMessage: async (op, value) => ({ op, value }),
    sendMessage: async ({ op, value }) => assert.equal(await contract.run(op, value), null),
    status: async job => ({ state: contract.db.get('bt/' + job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
  async function openRuntime() {
    runtime = await createV2Runtime({ config, store, secret, history, reads, committee, deferRecovery });
    pipeline = new Pipeline({ pipelineDepth, store, files, history, intake: runtime.intake, reads, committee, settings: runtime.settings,
      outbox: new Outbox({ store, transport, retryMs: 0 }) });
  }
  await openRuntime();
  const packet = (n, policy = runtime.settings.document) => {
    const tip = String(runtime.intake.head.tip), body = { v: 2, ruleset: 'dmw-v2', network, a: gateway,
      settingsRevision: policy.revision, settingsHash: r.hashObject(policy), t: 'discovery-commit-v2', b: tip, h: history.hashAt(tip),
      p: { commitment: r.hash('renewal-commit-' + n) }, w: '0' };
    return r.stableJSON({ ...body, sig: r.bytesToHex(ed25519.sign(r.moveDigestV2(body), secret)) });
  };
  await runtime.intake.observe({ tip: '1', counted: '1', confirmed: '1', hash: history.hashAt(1) });
  assert.equal(runtime.intake.namedAdmission.context().ready, true, 'initial admission ready');
  await runtime.intake.namedAdmission.accept(packet(0));
  do { await pipeline.tick(); await runtime.refresh(); } while (store.get('meta', 'draft'));
  assert.equal((await reads.batchLast()).n, '2');
  const successor = r.settingsRevision({ network, previous: document, effectiveBatch: manualFence ? '4' : '3', effectiveBitcoinWindow: '2',
    values: { ...document.values, commitLifetime: 10, revealBudget: 1, ...successorValues } });
  assert.equal(await contract.run('ad_settings', { document: successor }), null);
  const packets = [], receipts = [];
  const admit = async () => {
    for (let i = 0; i < receiptCount; i++) {
      const p = packet(i + 1); packets.push(p); receipts.push(await runtime.intake.namedAdmission.accept(p));
    }
    if (separateReceipts) {
      // Model a retained valid backlog with acknowledged receipts in separate
      // immutable segments. Preserve every signed byte and the original window;
      // the normal gateway closes new admission when its first segment seals.
      const space = 'intake/' + runtime.intake.head.id, rows = store.list(space);
      assert.equal(rows.length, 2);
      await store.transact([{ space, id: rows[1].id }]);
      for (let n = 0; n < 4; n++) await runtime.intake.seal({ financial: true });
      await store.put('intake/' + runtime.intake.head.id, rows[1].id, rows[1].value);
    }
  };
  if (!manualFence) await admit();
  await beforeBoundary?.({ pipeline, runtime, store, committee });
  await contract.advance(1); assert.equal(await contract.run('ad_apply', { id: 'settings' }), null);
  await runtime.intake.observe({ tip: '2', counted: '2', confirmed: '2', hash: history.hashAt(2) });
  if (!deferBoundaryRefresh) await runtime.refresh();
  if (manualFence) {
    assert.equal(runtime.intake.namedAdmission.context().ready, true, 'pre-cutoff admission ready');
    await admit();
  }
  const predecessor = { n: '2', root: await reads.batchRoot('2'), claims: contract.db.get('v2/claims'), catalog: contract.db.get('v2/catalog') };
  const fence = manualFence ? await runtime.intake.fence({ document, successor, predecessor }) : store.get('namedFences', r.hashObject(document));
  return { directory, document, successor, contract, reads, packets, receipts, members, history, network, packet,
    get fence() { return store.get('namedFences', r.hashObject(document)) ?? fence; },
    get store() { return store; }, get pipeline() { return pipeline; }, get runtime() { return runtime; },
    get journals() { return journals; }, get policies() { return policies; },
    loseSignature(v) { loseSignature = v; }, reopenSigners,
    replaceBranch(start, headers) { for (const [i, raw] of headers.entries()) replacement.set(String(start + i), raw); },
    async tick() { let result; do { result = await pipeline.tick(); await runtime.refresh(); } while (store.get('meta', 'draft')); return result; },
    async reopen() { await pipeline.close(); await store.close(); store = await Store.open(join(directory, 'gateway')); await reopenSigners(); await openRuntime(); }
  };
}

test('background receipt certification preserves the same renewal across restart without holding refresh', { timeout: 30000 }, async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { manualFence: false, deferRecovery: true, beforeBoundary: ({ committee }) => {
    const fence = committee.fenceReceipts.bind(committee);
    committee.fenceReceipts = async (...args) => { entered(); await blocked; return fence(...args); };
  } });
  assert.equal(f.runtime.intake.rulesContext().ready, false);
  const recovering = f.runtime.recoverReceipts();
  await Promise.race([started, recovering.then(() => { throw Error('receipt_recovery_not_started'); })]);
  try {
    const at = performance.now(); await f.runtime.refresh();
    assert.ok(performance.now() - at < 200);
    assert.equal(f.runtime.intake.namedAdmission.context().ready, false);
  } finally { release(); await recovering; }
  assert.equal(f.fence.phase, 'certified');
  await f.tick(); assert.equal((await f.reads.batchLast()).n, '3');
  await f.reopen(); await f.runtime.recoverReceipts(); await f.tick();
  assert.equal((await f.reads.batchLast()).n, '4');
  assert.equal((await f.reads.rulesContext()).receiptRenewal, null);
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
  for (let i = 0; i < f.packets.length; i++) assert.deepEqual(await f.runtime.intake.namedAdmission.accept(f.packets[i]), f.receipts[i]);
});

test('certified renewal advances once, executes original receipts/terms, and admits successor work after restart', async t => {
  const f = await setup(t), before = await f.reads.rulesContext();
  await f.tick(); const reserved = await f.reads.rulesContext();
  assert.equal(reserved.last.n, '3'); assert.equal(reserved.catalogRoot, before.catalogRoot); assert.equal(reserved.claimsRoot, before.claimsRoot);
  assert.equal(reserved.accountsRoot, before.accountsRoot); assert.equal(reserved.receiptRenewal.targetBatch, '4');
  await f.reopen();
  assert.deepEqual(await f.runtime.intake.namedAdmission.accept(f.packets[0]), f.receipts[0]);
  await assert.rejects(f.runtime.intake.namedAdmission.accept(f.packet(3)), /ruleset_not_ready/);
  await f.tick();
  assert.equal((await f.reads.batchLast()).n, '4'); assert.equal((await f.reads.rulesContext()).receiptRenewal, null);
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
  const snapshot = f.store.get('meta', 'ruleState').namedSnapshot;
  const named = new r.NamedStorage({ get: id => f.store.get('namedNodes', id), cacheSize: 32 }).load(snapshot);
  for (const packet of f.packets) {
    const move = JSON.parse(packet), commitment = r.namedGet(named.records, `commit/${gateway}/${move.p.commitment}`);
    assert.equal(commitment.settingsHash, r.hashObject(f.document));
    assert.equal(commitment.expires, '146');
  }
  await f.reopen();
  const receipt = await f.runtime.intake.namedAdmission.accept(f.packet(4)); assert.equal(receipt.settingsHash, r.hashObject(f.successor));
  await f.tick(); assert.equal((await f.reads.batchLast()).n, '5');
  const batch3 = f.store.get('batches', heightKey('3')).batch, batch4 = f.store.get('batches', heightKey('4'));
  assert.ok(batch4);
  const publication = batch4.publications.at(-1), bytes = await readFile(join(f.directory, 'gateway/static', publication.audit.path));
  const file = r.decodeBinary(bytes), allFiles = await Promise.all(batch4.publications.map(p => readFile(join(f.directory, 'gateway/static', p.audit.path))));
  const allReceipts = Array.from({ length: Number(f.fence.cutoff.segmentCount) }, (_, i) => f.store.get('receiptCutoffPages', r.receiptCutoffPageKey(r.hashObject(f.document), String(i))).segment).flatMap(s => s.receipts), receiptProofs = Object.fromEntries(allReceipts.map((receipt, i) =>
    [receipt.sequence, r.merkleProof(allReceipts.map(r.stableJSON), i)]));
  const renewal = { reservationBatch: batch3, executionBatch: batch4.batch, auditProof: r.merkleProof(allFiles, allFiles.length - 1),
    receiptProofs, batchRoot: f.reads.batchRoot, settingsByHash: f.reads.settingsByHash, renewalSlice: f.reads.renewalSlice };
  const client = new ServiceClient({ network: f.network, gateway, receiptSigners: f.members });
  client.publication = async () => bytes;
  const inclusion = await client.inclusion(JSON.parse(f.packets[0]), { publication, receipt: f.receipts[0], hashAt: f.history.hashAt, renewal });
  assert.equal(inclusion.contractCommitted, true); assert.equal(inclusion.reportedOutcome, 'accepted');
  assert.equal(file.receipts[0].batch, '3'); assert.equal(file.batchSequence, '4');
  await assert.rejects(client.audit(publication, { hashAt: f.history.hashAt }), /Independent renewal reads/);
  await assert.rejects(client.audit(publication, { hashAt: f.history.hashAt, renewal: { ...renewal, receiptProofs: {} } }), /Renewal receipt proof/);
  await assert.rejects(client.audit(publication, { hashAt: f.history.hashAt, renewal: { ...renewal, batchRoot: async () => r.hash('forged') } }), /Renewal acceptance/);
});

for (const phase of ['reserve', 'execute']) test(`uncertain ${phase} signature reserves renewal consumption across restarts`, async t => {
  const f = await setup(t); if (phase === 'execute') await f.tick();
  f.loseSignature(true); await assert.rejects(f.tick(), /uncertain_signature/);
  const draft = await f.pipeline.loadDraft(), id = r.hashObject(f.fence.cutoff), slot = `receipt-renewal/${id}/${phase}${phase === 'execute' ? '/0' : ''}`;
  await f.reopen();
  for (const journal of f.journals) {
    assert.ok(journal.slots.has(slot));
    await assert.rejects(journal.reserve([slot], r.hash('different'), r.hash('different-session'), {}), /slot_conflict/);
    await assert.rejects(journal.retireBatch(`batch/0/${draft.proposal.batch.n}`, f.reads), /batch_retirement_unproven/);
  }
  f.loseSignature(false); await f.tick();
  assert.equal(await f.reads.batchRoot(draft.proposal.batch.n), draft.proposal.batch.root);
});

test('contract and preflight reject forged quorum, cutoff root, wrong successor, and ordinary batches while reserved', async t => {
  const f = await setup(t), draft = await f.pipeline.build(), batch = draft.proposal.batch;
  for (const mutate of [b => { b.renewal.votes.pop(); b.renewal.votes.pop(); b.renewal.votes.pop(); },
    b => { b.renewal.cutoff.receipts = r.hash('forged'); }, b => { b.renewal.cutoff.successorHash = r.hash('wrong'); },
    b => { b.claims = r.hash('changed'); }, b => { b.root = r.hash('forged-root'); }]) {
    const bad = structuredClone(batch); mutate(bad);
    assert.notEqual(await f.contract.run('bt', signedBatch(bad, f.contract.options)), null);
    await assert.rejects(f.reads.preflight(bad, { counted: await f.reads.counted(), last: await f.reads.batchLast() }));
  }
  await f.tick(); const execution = await f.pipeline.build();
  const ordinary = structuredClone(execution.proposal.batch); delete ordinary.renewal;
  assert.notEqual(await f.contract.run('bt', signedBatch(ordinary, f.contract.options)), null);
  await assert.rejects(f.policies[0].approve({ ...execution.proposal, batch: ordinary }), /renewal_pending/);
});

for (const phase of ['reserve', 'execute']) for (const boundary of ['draft', 'signature', 'accepted', 'checkpoint'])
  test(`${phase} resumes exactly once after durable ${boundary}`, async t => {
    const f = await setup(t); if (phase === 'execute') await f.tick();
    const target = r.nextUint((await f.reads.batchLast()).n), draft = await f.pipeline.build();
    if (boundary === 'signature') {
      const save = f.pipeline.saveDraft.bind(f.pipeline);
      f.pipeline.saveDraft = async d => { await save(d); if (d.signature) throw Error('crash_after_signature'); };
      await assert.rejects(f.pipeline.tick(), /crash_after_signature/);
    } else if (boundary === 'accepted') {
      await f.pipeline.tick();
      assert.equal(await f.reads.batchRoot(target), draft.proposal.batch.root);
      assert.ok(f.store.get('meta', 'draft'), 'local acceptance is still pending');
    } else if (boundary === 'checkpoint') {
      const transact = f.store.transact.bind(f.store);
      f.store.transact = async ops => {
        const result = await transact(ops);
        if (ops.some(o => o.space === 'receiptRenewals' && o.value?.state === (phase === 'reserve' ? 'reserved' : 'consumed')))
          throw Error('crash_after_checkpoint');
        return result;
      };
      await assert.rejects(f.tick(), /crash_after_checkpoint/);
    }
    await f.reopen();
    if (boundary !== 'checkpoint') await f.tick();
    assert.equal((await f.reads.batchLast()).n, target);
    assert.equal(await f.reads.batchRoot(target), draft.proposal.batch.root);
    assert.equal(f.store.get('meta', 'draft'), null);
    assert.equal(f.store.get('receiptRenewals', r.hashObject(f.fence.cutoff)).state, phase === 'reserve' ? 'reserved' : 'consumed');
    if (phase === 'execute') {
      assert.equal(await f.contract.run('bt', signedBatch(draft.proposal.batch, f.contract.options)), 'renewal_consumed');
      for (const receipt of f.receipts) assert.equal(f.store.get('namedAccepted', receipt.move).batch, target);
    }
  });

test('only independently proven expiry releases both the batch and renewal signer reservations', async t => {
  const f = await setup(t); await f.tick(); f.loseSignature(true);
  await assert.rejects(f.tick(), /uncertain_signature/);
  const draft = await f.pipeline.loadDraft(), b = draft.proposal.batch, slot = `batch/${b.epoch}/${b.n}`, renewalSlot = `receipt-renewal/${b.renewal.id}/execute/0`;
  await f.contract.advance(f.document.values.batchDeadlineTips + 1);
  for (const journal of f.journals) {
    await journal.retireBatch(slot, f.reads);
    assert.equal(journal.slots.has(slot), false); assert.equal(journal.slots.has(renewalSlot), false);
  }
  await f.reopenSigners();
  for (const journal of f.journals) assert.equal(journal.slots.has(renewalSlot), false);
  assert.equal((await f.reads.rulesContext()).receiptRenewal.id, b.renewal.id, 'expiry does not consume or erase the accepted right');
});

for (const phase of ['reserve', 'execute']) test(`Bitcoin branch change refuses stale ${phase} without consuming receipts`, async t => {
  const f = await setup(t); if (phase === 'execute') await f.tick();
  const draft = await f.pipeline.build(), batch = draft.proposal.batch;
  const alternate = chain(2, f.history.get(1), 601, 91);
  assert.equal(await f.contract.run('hd', { headers: alternate }), null);
  assert.notEqual(await f.contract.state().beacon().hashAt('2'), f.history.hashAt(2));
  assert.equal(await f.contract.run('bt', signedBatch(batch, f.contract.options)), 'batch_execution_branch');
  await assert.rejects(f.reads.preflight(batch, { counted: await f.reads.counted(), last: await f.reads.batchLast() }), /preflight_activation/);
  await f.reopen();
  for (const packet of f.packets) assert.ok(f.store.get('namedDedupe', r.moveIdV2(JSON.parse(packet))));
  assert.equal((await f.reads.rulesContext()).receiptRenewal?.id ?? null, phase === 'execute' ? r.hashObject(f.fence.cutoff) : null);
});

test('eleven execution/proof reductions still refuse while complete outstanding-right renewal remains unavailable', async t => {
  const f = await setup(t);
  // An accepted successor is never changed in place. Start a later proposal
  // after completing the non-reducing receipt renewal.
  await f.tick(); await f.tick();
  for (const key of ['batchBytes', 'batchOps', 'batchAssets', 'auditChunkBytes', 'auditTotalBytes', 'summaryBytes',
    'proofBytes', 'accountLeaves', 'accountProofNodes', 'accountProofBytes', 'accountActions']) {
    const values = { ...f.successor.values, [key]: f.successor.values[key] - 1 };
    const candidate = r.settingsRevision({ network: f.network, previous: f.successor, effectiveBatch: '5', effectiveBitcoinWindow: '3', values });
    assert.equal(await f.contract.run('ad_settings', { document: candidate }), 'settings_capacity_drain_required', key);
  }
});

for (const receiptCount of [0, 2]) test(`authorized amendment automatically fences and completes with ${receiptCount} outstanding receipts`, async t => {
  const f = await setup(t, { manualFence: false, receiptCount });
  assert.equal(f.fence.phase, 'certified');
  assert.equal(f.fence.cutoff.lastSequence, String(receiptCount + 1));
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.document));
  await assert.rejects(f.runtime.intake.namedAdmission.accept(f.packet(9)), /receipt_admission_fenced/);
  await f.reopen(); await f.tick(); await f.reopen(); await f.tick();
  assert.equal(f.store.get('receiptRenewals', r.hashObject(f.fence.cutoff)).state, 'consumed');
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
  for (const receipt of f.receipts) {
    assert.equal(f.store.get('namedAccepted', receipt.move).batch, '4');
    assert.deepEqual(await f.runtime.intake.namedAdmission.accept(f.packets[f.receipts.indexOf(receipt)]), receipt);
  }
  const admitted = await f.runtime.intake.namedAdmission.accept(f.packet(10));
  assert.equal(admitted.settingsHash, r.hashObject(f.successor));
  await f.tick(); assert.equal((await f.reads.batchLast()).n, '5');
});

for (const boundary of ['closing', 'sealed', 'evidence', 'certified']) test(`automatic amendment fencing resumes after durable ${boundary}`, async t => {
  const f = await setup(t, { manualFence: false, deferBoundaryRefresh: true });
  const transact = f.store.transact.bind(f.store); let failed = false;
  f.store.transact = async operations => {
    const result = await transact(operations), fence = operations.find(o => o.space === 'namedFences')?.value;
    const phase = fence?.phase === 'sealed' && fence.cutoff ? 'evidence' : fence?.phase;
    if (!failed && phase === boundary) { failed = true; throw Error('automatic_fence_crash'); }
    return result;
  };
  await assert.rejects(f.runtime.refresh(), /automatic_fence_crash/); assert.equal(failed, true);
  await f.reopen(); assert.equal(f.fence.phase, 'certified');
  await f.tick(); await f.tick();
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
  for (const receipt of f.receipts) assert.equal(f.store.get('namedAccepted', receipt.move).batch, '4');
});

test('automatic amendment waits for the exact uncertain predecessor draft before fixing its cutoff', async t => {
  let original;
  const f = await setup(t, { manualFence: false, beforeBoundary: async ({ pipeline, committee }) => {
    original = await pipeline.build();
    const batch = original.proposal.batch; await pipeline.reads.publishContext(batch.n, original);
    const signed = await committee.signature(`batch/${batch.epoch}/${batch.n}`, original.proposal);
    original.signature = signed.signature.compact; await pipeline.saveDraft(original);
  } });
  assert.equal(f.fence, null);
  assert.equal(f.store.get('meta', 'draft').proposal.batch.root, original.proposal.batch.root);
  await f.reopen(); assert.equal(f.fence, null);
  await f.tick();
  assert.equal(await f.reads.batchRoot('3'), original.proposal.batch.root);
  assert.equal(f.fence.cutoff.predecessor.n, '3');
  for (const receipt of f.receipts) assert.equal(f.store.get('namedAccepted', receipt.move).batch, '3');
  await f.tick(); await f.tick();
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
  assert.equal((await f.reads.batchLast()).n, '5');
});

test('retiring an unprepared draft refreshes the amendment fence before rebuilding', async t => {
  let original;
  const f = await setup(t, { manualFence: false, beforeBoundary: async ({ pipeline }) => { original = await pipeline.build(); } });
  assert.equal(f.fence, null);
  await f.tick();
  assert.equal(f.store.count('supersededDrafts'), 1);
  assert.notEqual(await f.reads.batchRoot('3'), original.proposal.batch.root);
  assert.equal(f.fence.cutoff.predecessor.n, '2');
  assert.equal((await f.reads.rulesContext()).receiptRenewal.id, r.hashObject(f.fence.cutoff));
  await f.tick();
  for (const receipt of f.receipts) assert.equal(f.store.get('namedAccepted', receipt.move).batch, '4');
});

test('gateway publishes durable renewal proofs that the kit fetches and independently verifies', async t => {
  const f = await setup(t); let http = await serve({ intake: f.runtime.intake,
    files: new Files(join(f.directory, 'gateway/static')), web: { handle: async () => false } });
  t.after(() => http.close());
  let client = new ServiceClient({ origin: http.url, network: f.network, gateway, receiptSigners: f.members });
  const independent = { batchRoot: f.reads.batchRoot, settingsByHash: f.reads.settingsByHash, renewalSlice: f.reads.renewalSlice };
  const id = r.hashObject(f.fence.cutoff);
  await assert.rejects(client.renewalProof(id, '3', independent), /renewal_proof_unavailable/);
  await f.tick(); await f.tick(); await http.close(); await f.reopen();
  http = await serve({ intake: f.runtime.intake, files: new Files(join(f.directory, 'gateway/static')), web: { handle: async () => false } });
  client = new ServiceClient({ origin: http.url, network: f.network, gateway, receiptSigners: f.members });
  const accepted = f.store.get('batches', heightKey('4')), publication = accepted.publications.find(p => p.tip === '2');
  const result = await client.inclusion(JSON.parse(f.packets[0]), { publication, receipt: f.receipts[0], hashAt: f.history.hashAt, renewal: independent });
  assert.equal(result.contractCommitted, true); assert.equal(result.reportedOutcome, 'accepted');
  const calls = [], trac = new TracClient({ network: f.network, integerVersion: 2, api: {
    dmwHashAt: height => f.history.hashAt(height),
    dmwBatchRoot: n => { calls.push(['root', n]); return f.reads.batchRoot(n); },
    dmwSettingsByHash: hash => { calls.push(['settings', hash]); return f.reads.settingsByHash(hash); },
    dmwReceiptRenewalSlice: n => { calls.push(['slice', n]); return f.reads.renewalSlice(n); }
  } });
  const player = new Agent({ network: f.network, service: client, trac, wallet: { publicKey: Buffer.from(gateway, 'hex') },
    journal: { get: key => { assert.equal(key, 'claim/2'); return { body: JSON.parse(f.packets[0]), result: f.receipts[0] }; } } });
  const verified = await player.claimInclusion({ window: 2, publication });
  assert.equal(verified.contractCommitted, true); assert.equal(verified.reportedOutcome, 'accepted');
  assert.deepEqual(calls, [['root', '3'], ['root', '4'], ['root', '3'], ['settings', r.hashObject(f.document)], ['slice', '4']]);
  const proof = await client.renewalProof(id, publication.observation, independent);
  const bytes = await client.publication(publication.audit, { binary: true, limit: 1500000 }), forged = r.decodeBinary(bytes);
  forged.moves[0].reason = 'forged-outcome';
  await assert.rejects(verifyRenewedAudit(forged, bytes, proof, { network: f.network, gateway, members: f.members }), /Renewal audit bytes mismatch/);
  await assert.rejects(client.inclusion(JSON.parse(f.packets[0]), { publication, receipt: f.receipts[0], hashAt: f.history.hashAt,
    renewal: { ...independent, batchRoot: async () => r.hash('unaccepted') } }), /Renewal acceptance mismatch/);
});

for (const phase of ['reserve', 'execute']) test(`renewal completes after a Bitcoin branch change and independently proven ${phase} expiry`, async t => {
  const f = await setup(t); if (phase === 'execute') await f.tick();
  f.loseSignature(true); await assert.rejects(f.tick(), /uncertain_signature/);
  const stale = await f.pipeline.loadDraft(), b = stale.proposal.batch, slot = `batch/${b.epoch}/${b.n}`;
  const alternate = chain(9, f.history.get(1), 601, 97);
  assert.equal(await f.contract.run('hd', { headers: alternate }), null);
  f.replaceBranch(2, alternate);
  for (let tip = 2; tip <= 10; tip++) await f.runtime.intake.observe({ tip: String(tip), counted: String(tip), confirmed: String(tip), hash: f.history.hashAt(tip) });
  assert.equal(await f.contract.run('bt', signedBatch(b, f.contract.options)), 'batch_deadline');
  for (const journal of f.journals) await journal.retireBatch(slot, f.reads);
  await f.reopen(); f.loseSignature(false); await f.tick();
  if (phase === 'reserve') await f.tick();
  assert.equal(f.store.get('receiptRenewals', r.hashObject(f.fence.cutoff)).state, 'consumed');
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
  assert.equal((await f.reads.batchLast()).n, '4');
  for (const receipt of f.receipts) assert.equal(f.store.get('namedAccepted', receipt.move).batch, '4');
  const executed = f.store.get('batches', heightKey('4')).batch;
  assert.equal(executed.execution.hash, await f.contract.state().beacon().hashAt(executed.execution.height));
});

test('witnesses refuse premature successor admission and enforce its receipt capacity independently', async t => {
  const f = await setup(t, { manualFence: false, documentValues: { receiptSegmentEntries: 2 } });
  const next = r.signReceiptV2(JSON.parse(f.packet(20, f.successor)), { tip: '2', hash: f.history.hashAt(2), sequence: '4', batch: '3' }, secret);
  for (const policy of f.policies) await assert.rejects(policy.receiptFences.admit(next, f.store.get('meta', 'ruleState').claimSnapshot), /receipt_policy_boundary/);
  await f.tick(); await f.tick();
  const first = await f.runtime.intake.namedAdmission.accept(f.packet(21));
  assert.equal(first.settingsHash, r.hashObject(f.successor));
  await f.runtime.intake.namedAdmission.accept(f.packet(22));
  const overflow = r.signReceiptV2(JSON.parse(f.packet(22)), { tip: '2', hash: f.history.hashAt(2),
    sequence: r.addUint(first.sequence, '2'), batch: first.batch }, secret);
  for (const policy of f.policies) await assert.rejects(policy.receiptFences.admit(overflow, f.store.get('meta', 'ruleState').claimSnapshot), /receipt_admission_capacity/);
  await assert.rejects(f.runtime.intake.namedAdmission.accept(f.packet(23)), /next_batch_work_capacity/);
  await f.tick();
  assert.equal((await f.runtime.intake.namedAdmission.accept(f.packet(23))).settingsHash, r.hashObject(f.successor));
  await f.tick();
});

test('older receipt deployments retain the segment-reduction refusal', async t => {
  const f = await setup(t, { receiptProtocol: null });
  await f.tick(); await f.tick();
  const candidate = r.settingsRevision({ network: f.network, previous: f.successor, effectiveBatch: '5', effectiveBitcoinWindow: '3',
    values: { ...f.successor.values, receiptSegmentEntries: 1 } });
  assert.equal(await f.contract.run('ad_settings', { document: candidate }), 'settings_capacity_drain_required');
});

test('an oversized immutable cutoff completes exact bounded slices across restarts', async t => {
  const f = await setup(t, { manualFence: false, deferBoundaryRefresh: true, documentValues: { observationBudget: 2 } });
  for (const { value } of f.store.list('observations')) await f.runtime.intake.namedAdmission.committee.attestRoot(value.receiptRoot);
  await f.contract.advance(1);
  await f.runtime.intake.observe({ tip: '3', counted: '3', confirmed: '3', hash: f.history.hashAt(3) });
  await f.runtime.refresh();
  assert.equal(f.fence.phase, 'certified');
  assert.equal(f.store.count('observations'), 3);
  assert.equal(await f.reads.batchRoot('3'), null);
  for (const receipt of f.receipts) assert.deepEqual(f.store.get('namedDedupe', receipt.move).receipt, receipt);
  await f.tick(); await f.reopen();
  await f.tick();
  assert.equal((await f.reads.rulesContext()).receiptRenewal.cursor.segment, '2');
  await f.reopen(); await f.tick();
  assert.equal((await f.reads.rulesContext()).receiptRenewal, null);
  assert.equal((await f.reads.batchLast()).n, '5');
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
});


async function manySlices(t, successorValues = {}, options = {}) {
  const f = await setup(t, { manualFence: false, deferBoundaryRefresh: true, documentValues: { observationBudget: 2 }, successorValues, ...options });
  // Every original seal is witnessed in its real window before the next tip.
  for (let tip = 3; tip <= 7; tip++) {
    for (const { value } of f.store.list('observations')) await f.runtime.intake.namedAdmission.committee.attestRoot(value.receiptRoot);
    await f.contract.advance(1);
    await f.runtime.intake.observe({ tip: String(tip), counted: String(tip), confirmed: String(tip), hash: f.history.hashAt(tip) });
  }
  return f;
}

for (const boundary of ['forward', 'reverse', 'witness']) test(`paged cutoff restarts after durable ${boundary} progress without a whole-backlog proof`, async t => {
  const f = await manySlices(t);
  if (boundary === 'witness') {
    const journal = f.journals[0], append = journal.append.bind(journal); let failed = false;
    journal.append = async (...args) => { const row = await append(...args);
      if (!failed && args[0] === 'receipt-cutoff-page') { failed = true; throw Error('page_crash'); } return row; };
  } else {
    const transact = f.store.transact.bind(f.store); let failed = false;
    f.store.transact = async operations => { const result = await transact(operations);
      const progress = operations.find(o => o.space === 'namedFences')?.value?.pages;
      if (!failed && progress?.phase === boundary && (boundary === 'reverse' || progress.index === '1')) { failed = true; throw Error('page_crash'); }
      return result; };
  }
  await assert.rejects(f.runtime.refresh(), /page_crash/);
  await f.reopen();
  assert.equal(f.fence.cutoff.v, 2); assert.equal(f.fence.cutoff.segmentCount, '7');
  assert.equal(f.fence.evidence.segments, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(f.fence.evidence)) < 10000);
  await f.tick();
  let batches = 0;
  do {
    await f.reopen(); await f.tick(); batches++;
    const state = await f.reads.rulesContext();
    if (state.receiptRenewal) {
      assert.equal(state.receiptRenewal.cursor.segment, String(batches * 2));
      assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.document));
      await assert.rejects(f.runtime.intake.namedAdmission.accept(f.packet(99)), /ruleset_not_ready/);
    }
  } while ((await f.reads.rulesContext()).receiptRenewal);
  assert.equal(batches, 4); assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
  assert.equal(f.store.get('receiptRenewals', r.hashObject(f.fence.cutoff)).cursor.segment, '7');
  for (const receipt of f.receipts) assert.equal(f.store.get('namedAccepted', receipt.move).batch, '4');
});

test('paged slice proofs survive HTTP publication and reject forged independent acceptance', async t => {
  const f = await manySlices(t); await f.runtime.refresh(); await f.tick();
  const http = await serve({ intake: f.runtime.intake, files: new Files(join(f.directory, 'gateway/static')), web: { handle: async () => false } });
  t.after(() => http.close());
  const client = new ServiceClient({ origin: http.url, network: f.network, gateway, receiptSigners: f.members });
  const trac = new TracClient({ network: f.network, api: { dmwBatchRoot: f.reads.batchRoot,
    dmwSettingsByHash: f.reads.settingsByHash, dmwReceiptRenewalSlice: f.reads.renewalSlice } });
  const independent = { batchRoot: n => trac.batchRoot(n), settingsByHash: h => trac.settingsByHash(h), renewalSlice: n => trac.renewalSlice(n) };
  do {
    await f.tick();
    const accepted = f.store.get('batches', heightKey((await f.reads.batchLast()).n));
    for (const publication of accepted.publications) {
      const proof = await client.renewalProof(r.hashObject(f.fence.cutoff), publication.observation, independent);
      const bytes = await readFile(join(f.directory, 'gateway/static', publication.audit.path)), file = r.decodeBinary(bytes);
      await verifyRenewedAudit(file, bytes, proof, { network: f.network, gateway, members: f.members });
      await assert.rejects(verifyRenewedAudit(file, bytes, { ...proof, renewalSlice: async () => null }, { network: f.network, gateway, members: f.members }), /Independent renewal slice mismatch/);
      const forged = structuredClone(proof.executionBatch); forged.renewal.slice.next = r.hash('forged-tail');
      await assert.rejects(verifyRenewedAudit(file, bytes, { ...proof, executionBatch: forged }, { network: f.network, gateway, members: f.members }), /Independent renewal slice mismatch/);
    }
  } while ((await f.reads.rulesContext()).receiptRenewal);
});

test('missing, swapped, forged and prematurely completed renewal slices fail contract, replay and signer checks', async t => {
  const f = await manySlices(t); await f.runtime.refresh(); await f.tick();
  const draft = await f.pipeline.build(); await f.reads.publishContext(draft.proposal.batch.n, draft);
  for (const mutate of [b => { b.renewal.slice.from = '1'; }, b => { b.renewal.slice.seals.reverse(); },
    b => { b.renewal.slice.seals.pop(); }, b => { b.renewal.slice.to = '7'; },
    b => { b.renewal.slice.next = r.RECEIPT_CUTOFF_END; }, b => { b.renewal.slice.sequence = '0'; },
    b => { b.renewal.slice.seals[0].root = r.hash('forged'); }]) {
    const bad = structuredClone(draft.proposal.batch); mutate(bad);
    assert.notEqual(await f.contract.run('bt', signedBatch(bad, f.contract.options)), null);
    await assert.rejects(f.reads.preflight(bad, { counted: await f.reads.counted(), last: await f.reads.batchLast() }));
    await assert.rejects(f.policies[0].approve({ ...draft.proposal, batch: bad }));
  }
  await f.tick(); const active = (await f.reads.rulesContext()).receiptRenewal;
  assert.equal(active.cursor.segment, '2');
  const next = await f.pipeline.build(), skipped = structuredClone(next.proposal.batch);
  skipped.renewal.slice = draft.proposal.batch.renewal.slice;
  assert.notEqual(await f.contract.run('bt', signedBatch(skipped, f.contract.options)), null);
  assert.deepEqual((await f.reads.rulesContext()).receiptRenewal, active);
});

test('uncertain middle slice retains its distinct signer reservations and resumes after a Bitcoin replacement', async t => {
  const f = await manySlices(t); await f.runtime.refresh(); await f.tick(); await f.tick();
  const cursor = structuredClone((await f.reads.rulesContext()).receiptRenewal.cursor);
  f.loseSignature(true); await assert.rejects(f.tick(), /uncertain_signature/);
  const draft = await f.pipeline.loadDraft(), batch = draft.proposal.batch, slot = `receipt-renewal/${batch.renewal.id}/execute/2`;
  await f.reopen();
  for (const journal of f.journals) {
    assert.ok(journal.slots.has(slot));
    await assert.rejects(journal.reserve([slot], r.hash('different'), r.hash('session'), {}), /slot_conflict/);
    await assert.rejects(journal.retireBatch(`batch/0/${batch.n}`, f.reads), /batch_retirement_unproven/);
  }
  const alternate = chain(15, f.history.get(1), 601, 101);
  assert.equal(await f.contract.run('hd', { headers: alternate }), null); f.replaceBranch(2, alternate);
  await f.runtime.intake.observe({ tip: '16', counted: '16', confirmed: '16', hash: f.history.hashAt(16) });
  assert.deepEqual((await f.reads.rulesContext()).receiptRenewal.cursor, cursor);
  for (const journal of f.journals) await journal.retireBatch(`batch/0/${batch.n}`, f.reads);
  await f.reopen(); f.loseSignature(false);
  do { await f.tick(); await f.reopen(); } while ((await f.reads.rulesContext()).receiptRenewal);
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
  for (const receipt of f.receipts) assert.equal(f.store.get('namedAccepted', receipt.move).batch, '4');
});


for (const [key, value] of [['receiptSegmentEntries', 1], ['observationBudget', 1], ['batchKv', 2]])
  test(`${key} reduction drains a multi-batch acknowledged backlog under its original envelope, then admits successor work`, async t => {
  const f = await manySlices(t, { [key]: value }, { separateReceipts: true });
  await f.runtime.refresh(); assert.equal(f.fence.cutoff.v, 2);
  await f.tick();
  let slices = 0;
  do {
    await f.reopen(); await f.tick(); slices++;
    const batch = f.store.get('batches', heightKey((await f.reads.batchLast()).n)).batch;
    assert.equal(batch.settingsHash, r.hashObject(f.document));
    assert.ok(batch.renewal.slice.seals.length <= f.document.values.observationBudget);
    if ([1, 3].includes(slices)) assert.equal(batch.renewal.slice.seals.reduce((n, s) => n + s.count, 0), 1);
  } while ((await f.reads.rulesContext()).receiptRenewal);
  assert.equal(slices, 6);
  for (const receipt of f.receipts) {
    assert.equal(f.store.get('namedAccepted', receipt.move).batch, f.receipts.indexOf(receipt) ? '6' : '4');
    assert.deepEqual(await f.runtime.intake.namedAdmission.accept(f.packets[f.receipts.indexOf(receipt)]), receipt);
  }
  assert.equal(f.runtime.settings.document.values[key], value);
  const fresh = await f.runtime.intake.namedAdmission.accept(f.packet(101));
  assert.equal(fresh.settingsHash, r.hashObject(f.successor));
  if (key !== 'batchKv') await assert.rejects(f.runtime.intake.namedAdmission.accept(f.packet(102)), /next_batch_work_capacity/);
  await f.tick();
  if (key === 'batchKv') assert.equal(f.store.get('batches', heightKey((await f.reads.batchLast()).n)).batch.ops.filter(o => o.op === 'kv').length, 2);
  assert.equal((await f.runtime.intake.namedAdmission.accept(f.packet(102))).settingsHash, r.hashObject(f.successor));
  await f.tick();
});

test('the runtime fences fresh financial admission throughout renewal and preserves queued identities across restart', async t => {
  const transition = { type: 'lifecycle', id: r.hash('retained-financial-intent'), action: { type: 'retained' } };
  let queued;
  const f = await manySlices(t, { observationBudget: 1 }, { withFinancial: true, beforeBoundary: async ({ runtime }) => {
    assert.equal(await runtime.financial.admissionReady(), true);
    queued = await runtime.financial.submit(transition);
  } });
  await f.runtime.refresh();
  do {
    assert.equal(await f.runtime.financial.admissionReady(), false);
    assert.deepEqual(await f.runtime.financial.submit(transition), queued);
    await assert.rejects(f.runtime.financial.submit({ ...transition, id: r.hash('new-financial-intent') }), /financial_admission_fenced/);
    await assert.rejects(f.runtime.mints.quote({}), /financial_admission_fenced/);
    await f.tick(); await f.reopen();
  } while ((await f.reads.rulesContext()).receiptRenewal);
  assert.equal(await f.runtime.financial.admissionReady(), true);
  assert.deepEqual(await f.runtime.financial.submit(transition), queued);
  assert.equal(f.store.count('financialQueue'), 1);
});

for (const corruption of ['missing', 'index', 'tail', 'member', 'checkpoint', 'proof'])
  test(`certification refuses a ${corruption} cutoff page and resumes the same durable candidate after repair`, async t => {
    const f = await manySlices(t), read = f.reads.receiptCutoffPage;
    f.reads.receiptCutoffPage = async (...args) => {
      const page = structuredClone(await read(...args));
      if (args[1] !== '0') return page;
      if (corruption === 'missing') return null;
      if (corruption === 'index') page.index = '1';
      if (corruption === 'tail') page.next = r.hash('forged-tail');
      if (corruption === 'member') page.segment.receipts.pop();
      if (corruption === 'checkpoint') page.checkpoint.hot.namedSequence = '999';
      if (corruption === 'proof') page.claimEvidence.nodes = [];
      return page;
    };
    await assert.rejects(f.runtime.refresh(), /receipt_cutoff|claim_state_proof/);
    assert.equal(await f.reads.batchRoot('3'), null);
    const id = r.hashObject(f.fence.cutoff);
    f.reads.receiptCutoffPage = read; await f.reopen();
    assert.equal(r.hashObject(f.fence.cutoff), id); assert.equal(f.fence.phase, 'certified');
    await f.tick();
    do { await f.tick(); } while ((await f.reads.rulesContext()).receiptRenewal);
    assert.equal(f.store.get('receiptRenewals', id).state, 'consumed');
  });

for (const pipelineDepth of [1, 2]) test(`renewal splits at the combined closure budget and resumes every original segment after restart at depth ${pipelineDepth}`, async t => {
  const f = await manySlices(t, {}, { pipelineDepth, documentValues: { observationBudget: 2, closureWorkBudget: 1 } });
  await f.runtime.refresh(); await f.tick();
  let slices = 0, metered = 0, split = false;
  do {
    await f.reopen(); await f.tick(); slices++;
    assert.ok(slices <= 7, 'every execution consumes a certified segment');
    const accepted = f.store.get('batches', heightKey((await f.reads.batchLast()).n));
    const totals = { work: 0, reads: 0, bytes: 0 };
    for (const publication of accepted.publications) {
      const file = r.decodeBinary(await readFile(join(f.directory, 'gateway/static', publication.audit.path)));
      for (const progress of file.closureProgress ?? []) {
        metered++;
        for (const key of Object.keys(totals)) totals[key] += progress[key];
      }
    }
    assert.ok(totals.work <= f.document.values.closureWorkBudget);
    assert.ok(totals.reads <= f.document.values.closureReadBudget);
    assert.ok(totals.bytes <= f.document.values.closureByteBudget);
    if (totals.work && accepted.publications.length === 1) split = true;
  } while ((await f.reads.rulesContext()).receiptRenewal);
  assert.ok(split && metered > 1, 'the closure meter must force smaller renewal slices');
  assert.equal(f.store.get('receiptRenewals', r.hashObject(f.fence.cutoff)).cursor.segment, f.fence.cutoff.segmentCount);
  assert.equal(f.runtime.settings.settingsHash, r.hashObject(f.successor));
  for (const receipt of f.receipts) assert.deepEqual(await f.runtime.intake.namedAdmission.accept(f.packets[f.receipts.indexOf(receipt)]), receipt);
});
