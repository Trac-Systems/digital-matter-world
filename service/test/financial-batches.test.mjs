import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { secp256k1 } from '../../contract/node_modules/@noble/curves/secp256k1.js';
import { rules as r, initialState } from '../src/rules.mjs';
import { SegmentedIntake } from '../src/segmented-intake.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { FinancialExecution } from '../src/financial-execution.mjs';
import { Files } from '../src/files.mjs';
import { Store } from '../src/store.mjs';
import { Outbox } from '../src/transport.mjs';
import { prepareTerminalImport } from '../src/terminal-import.mjs';
import { installGatewayActivation } from '../src/v2-runtime.mjs';
import { Policy } from '../../committee/signer/policy.mjs';
import { rebuildBatch } from '../../committee/signer/adapter.mjs';
import { preflightBatch } from '../../committee/signer/preflight.mjs';
import { accountActionDigest } from '../../contract/root-accounts.js';
import { lifecycleDigest } from '../../contract/financial-lifecycle.js';
import { batchDigest } from '../../contract/signing.js';
import { harness, deployment, committeeSecret, alice, nonce } from '../../contract/tests/helpers/harness.mjs';
import { temp, network, secret, fixtureHistory, attestRoot, receiptSigners } from './helpers.mjs';

for (const observationsPerBatch of [1, 3]) test(`financial intents pass policy, notary and restart with ${observationsPerBatch} observations per batch`, async () => {
  const path = await temp('g3-batches-'), history = fixtureHistory(30), files = new Files(join(path, 'static'));
  const legacy = harness({ ...deployment, network }); await legacy.advance(9);
  assert.equal(await legacy.batch([{ op: 'mk', to: alice.address, asset: 'p0', amount: '100' }]), null); await legacy.advance(1);
  const imported = prepareTerminalImport({ records: legacy.db, height: 10 });
  const document = r.settingsRevision({ network, effectiveBatch: '2', effectiveBitcoinWindow: '10', values: { ...r.SETTINGS_PROFILE, puzzleBits: 0, observationsPerBatch,
    // The whole-batch closure allowance must still admit a cold step in every observation.
    closureByteBudget: r.SETTINGS_PROFILE.closureByteBudget * observationsPerBatch } });
  const manifest = { version: 1, network, fromRuleset: 'dmw-v1', toRuleset: 'dmw-v2', effectiveBatch: '2', previousBatchRoot: legacy.db.get('bt/1'),
    bitcoinAnchor: { height: '10', hash: history.hashAt(10) }, settingsHash: r.hashObject(document), catalogRoot: r.namedStateRoot(r.emptyNamedDiscovery()), accountsRoot: imported.financialRoot,
    receiptSegmentStart: '0', schemas: { batch: 2, file: 5, integer: 2, receipt: 2 }, minimumKitVersion: '0.2.0', route: 'terminal-import' };
  const manifestHash = r.hashObject(manifest), settings = r.activatedBatchSettings({ manifest, manifestHash, document, receiptSigners });
  const contract = harness({ ...deployment, network, v2: { manifest, manifestHash, document, importRoot: imported.importRoot, importRows: imported.importRows } });
  for (const page of imported.pages) assert.equal(await contract.run('ad_import', page), null);
  let store = await Store.open(path), last = await contract.state().batchLast(), pipeline, intake, financial, approvals = 0;
  const source = new Map(), certificates = new Map(), roots = new Map();
  await store.put('meta', 'ruleState', initialState(10, history.hashAt(10), 9));
  await installGatewayActivation({ store, manifest, manifestHash, document, imported, named: r.emptyNamedDiscovery() });
  const stamp = async () => { const head = await contract.state().head(); return { counted: '10', revision: head.revision, tip: '10', tipHash: history.hashAt(10), last }; };
  const create = () => {
    intake = new SegmentedIntake({ store, network, secret, hashAt: history.hashAt, settings });
    const reads = { batchLast: async () => last, committeeEpoch: async () => 0, counted: async () => '10', batchRoot: async n => contract.db.get('bt/' + n) ?? null,
      financialRecord: async key => contract.db.get(key) ?? null,
      financialEvidence: async transition => { const row = source.get(r.hashObject(transition)); assert.ok(row, 'independent source fixture'); return structuredClone(row); } };
    financial = new FinancialExecution({ store, reads, document, resources: { workPage: observationsPerBatch, mintInputCapacity: 100 } });
    const policyReads = { ...reads, authority: async () => ({ network, committee: deployment.committee, epoch: 0 }), batchStamp: stamp,
      rulesContext: async () => ({ ready: true, ruleset: 'dmw-v2', manifest, manifestHash, settings: document, settingsHash: r.hashObject(document), last,
        catalogRoot: contract.db.get('v2/catalog'), accountsRoot: contract.db.get('v2/accounts'), claimsRoot: contract.db.get('v2/claims') }),
      batchContext: async () => { const draft = await pipeline.loadDraft(); return { authority: { epoch: 0 }, counted: '10', gateway: intake.gateway,
        state: draft.startState, patterns: draft.startPatterns, inputs: draft.items.map(i => i.input), history, hashAt: history.hashAt,
        settings: draft.settings, limits: draft.limits, last, activation: settings.activation, previousRoot: draft.previousRoot }; },
      receiptCertificate: async (tip, hash, segment) => certificates.get(`${tip}/${hash}/${segment}`) ?? null,
      preflight: (batch, at) => preflightBatch(batch, at, { read: key => contract.db.get(key), deployment: contract.options }) };
    const policy = new Policy({ network, publicKey: deployment.committee, reads: policyReads, replayBatch: async (...args) => rebuildBatch(...args) });
    const committee = { attestRoot: async seal => {
      const attestations = await attestRoot(seal); certificates.set(`${seal.tip}/${seal.hash}/${seal.segment}`, { seal, attestations }); return attestations;
    }, signature: async (_, proposal) => {
      if (proposal.batch.ops.some(o => o.op === 'fp')) {
        const adversary = new Policy({ network, publicKey: deployment.committee, replayBatch: async (...args) => rebuildBatch(...args),
          reads: { ...policyReads, financialEvidence: async transition => ({ ...await reads.financialEvidence(transition), forged: true }) } });
        await assert.rejects(adversary.approve(proposal), /financial_evidence_read/);
      }
      const approved = await policy.approve(proposal); approvals++;
      return { signature: { compact: secp256k1.sign(approved.digest, committeeSecret, { lowS: true, prehash: false }).toCompactHex() } };
    } };
    const transport = { prepareMessage: async (op, value) => ({ op, value }), sendMessage: async m => {
      assert.equal(await contract.run(m.op, m.value), null, 'real notary accepts'); last = await contract.state().batchLast(); roots.set(last.n, m.value.root);
    }, status: async job => ({ state: roots.get(job.value.n) === job.value.root ? 'accepted' : 'pending' }) };
    pipeline = new Pipeline({ store, files, history, intake, reads, committee, financial,
      outbox: new Outbox({ store, transport, fallbackMs: 100000, retryMs: 0 }), settings });
  };
  const submit = async (transition, evidence) => {
    source.set(r.hashObject(transition), evidence); await financial.submit(transition);
    for (let i = 0; i < 3 && store.count('financialQueue'); i++) await pipeline.tick();
    assert.equal(store.count('financialQueue'), 0);
    for (const row of store.list('accountRecords', { limit: 100 })) assert.deepEqual(row.value, contract.db.get(row.id), row.id);
  };
  create();
  try {
    await intake.observe({ tip: '10', hash: history.hashAt(10), counted: '10', confirmed: 10 });
    const id = nonce(1), fees = [{ key: nonce(2), amount: '2' }], evidence = { owner: alice.address, asset: 'p0', amount: '3', fees };
    const action = { type: 'reserve', owner: alice.address, asset: 'p0', amount: '3', id, terms: r.hashObject(evidence), revision: '0', nonce: nonce(3), until: '20' };
    action.sig = Buffer.from(ed25519.sign(accountActionDigest(network, action), alice.secret)).toString('hex');
    const reservation = { type: 'reserve', id, action, fees };
    await submit(reservation, evidence); assert.equal(last.to, '10');
    const reserveBatch = last.n;
    await pipeline.close(); await store.close(); store = await Store.open(path); create();
    assert.equal((await financial.submit(reservation)).state, 'accepted');
    await intake.observe({ tip: '10', hash: history.hashAt(10), counted: '10', confirmed: 10 });
    const items = [{ key: nonce(4), fee: nonce(2), amount: '2', total: '2' }];
    if (observationsPerBatch === 1) {
      const transition = { type: 'fund', id, items }, evidence = { requestId: id, owner: alice.address, terms: action.terms, items, state: 'settled', confirmations: 1 };
      source.set(r.hashObject(transition), evidence); await financial.submit(transition);
      const ready = financial.ready.bind(financial);
      financial.ready = async args => { const result = await ready(args); source.delete(r.hashObject(transition)); return result; };
      await pipeline.tick();
      for (let i = 0; i < 2 && store.count('observations'); i++) await pipeline.tick();
      financial.ready = ready;
      assert.equal(store.count('financialQueue'), 1, 'source loss preserves exact intent');
      assert.equal(store.count('observations'), 0, 'witnessed empty segment cannot strand later work');
      assert.equal(store.list('batches', { limit: 10 }).at(-1).value.batch.ops.length, 2);
      await pipeline.tick(); assert.equal(last.n, r.addUint(reserveBatch, '1'), 'no repeated empty batches');
      await submit(transition, evidence);
    } else {
      financial.resources.workPage = 1;
      for (const n of [4, 6]) {
        const page = [{ key: nonce(n), fee: nonce(2), amount: '1', total: '1' }], transition = { type: 'fund', id, items: page };
        source.set(r.hashObject(transition), { requestId: id, owner: alice.address, terms: action.terms, items: page, state: 'settled', confirmations: 1 });
        await financial.submit(transition); await intake.seal({ financial: true });
      }
      for (let i = 0; i < 3 && store.count('financialQueue'); i++) await pipeline.tick();
      assert.equal(store.count('financialQueue'), 0);
      assert.equal(contract.db.get('fp/' + id).sequence, '2');
      assert.equal(last.n, r.addUint(reserveBatch, '1'), 'two sequential usage proofs share one batch');
    }
    await submit({ type: 'consume', id, permitHash: nonce(5) }, { requestId: id, owner: alice.address, terms: action.terms,
      state: 'authorized', permitHash: nonce(5), fundingRoot: contract.db.get('fp/' + id).root });
    assert.equal(last.n, r.addUint(reserveBatch, observationsPerBatch === 1 ? '3' : '2')); assert.equal(last.to, '10'); assert.equal(contract.db.get('ao/' + id).state, 'consumed');
    assert.equal(approvals, observationsPerBatch === 1 ? 4 : 3); assert.equal(store.count('financialAccepted'), observationsPerBatch === 1 ? 3 : 4);
    const link = nonce(20), linkEvidence = { requestId: link, state: 'reservable', owner: alice.address, bitmapOwner: alice.address,
      block: '2', until: '20', fees, link: null };
    const linkAction = { type: 'link-reserve', id: link, owner: alice.address, block: '2', until: '20', terms: r.hashObject(linkEvidence) };
    linkAction.sig = Buffer.from(ed25519.sign(lifecycleDigest(network, linkAction), alice.secret)).toString('hex');
    await submit({ type: 'lifecycle', id: link, action: linkAction }, linkEvidence);
    const linkItems = [{ key: nonce(21), fee: fees[0].key, amount: '2', total: '2' }];
    await submit({ type: 'fund', id: link, items: linkItems }, { requestId: link, owner: alice.address, terms: linkAction.terms,
      state: 'settled', confirmations: 1, verifiedHeight: '10', items: linkItems });
    const completion = { type: 'lifecycle', id: link, action: { type: 'link-complete', id: link } };
    source.set(r.hashObject(completion), { requestId: link, owner: alice.address, terms: linkAction.terms,
      block: '2', state: 'complete', fundingRoot: contract.db.get('fp/' + link).root });
    // The reconciler schedules the paid job without another client submission.
    for (let i = 0; i < 4 && store.count('activeFinancialLinks'); i++) await pipeline.tick();
    assert.equal(contract.db.get('fl/' + link).state, 'complete');
    assert.equal(store.count('activeFinancialLinks'), 0);
    assert.equal(approvals, observationsPerBatch === 1 ? 7 : 6); assert.equal(store.count('financialAccepted'), observationsPerBatch === 1 ? 6 : 7);
    const accepted = store.list('batches', { limit: 10 }).at(-1).value.batch;
    assert.equal(Buffer.from(batchDigest(network, accepted)).toString('hex').length, 64);
  } finally { await pipeline.close(); await store.close(); }
});
