import test from 'node:test';
import { admissionWhileSigning } from './admission-signing-fixture.mjs';
import assert from 'node:assert/strict';
import { v2StackFixture } from './v2-stack-fixture.mjs';
import { signBytes } from '../../kit/lib/signing.mjs';
import { accountActionDigest } from '../../contract/root-accounts.js';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { AccountAvailability } from '../src/account-availability.mjs';
import { heightKey } from '../src/util.mjs';
import * as r from '../../rules/src/index.js';
import { NamedAdmission } from '../src/named-admission.mjs';

for (const pipelineDepth of [1, 2]) test(`back-to-back reserved batches admit later receipts verified by unchanged kits at pipeline depth ${pipelineDepth}`,
  { timeout: 180000 }, t => admissionWhileSigning(t, { pipelineDepth }));

test('a later transfer records a stale revision after its predecessor spends, and a fresh authorization still executes',
  { timeout: 180000 }, t => v2StackFixture(t, { finderWindow: 2, settingsValues: { ...r.PUBLIC_MINT_SETTINGS,
    publicMintActivationHeight: '1010', publicMintLegacyFinderWindow: 2 }, scenario: async s => {
    s.pipeline.pipelineDepth = 1;
    const [A, B, C] = s.players.map(p => p.agent);
    await A.claim({ event: { window: s.tip, hash: s.history.hashAt(s.tip) }, plots: [{ block: 1, patterns: [0] }, { block: 11, patterns: [0] }],
      history: s.history, patterns: [{ ...s.legacyRecord, number: 0 }] });
    await s.drain(); await s.advance(1012); await s.runtime.intake.seal(); await s.drain();
    const balance = owner => {
      const record = s.contract.db.get('ar/' + owner); if (!record) return '0';
      const key = accountKey('balance', 'p0');
      return readAccountLeaf(record.root, new AccountAvailability(s.store).prove(record.root, [key]), key)?.available ?? '0';
    };
    assert.equal(balance(A.owner), '3');
    const packet = (to, nonce) => {
      const action = { type: 'transfer', owner: A.owner, to, asset: 'p0', amount: '1',
        revision: s.contract.db.get('ar/' + A.owner).revision, nonce: r.hash(nonce), until: String(s.tip + 100) };
      action.sig = signBytes(A.wallet, accountActionDigest(s.network, action));
      const move = { v: 2, ruleset: 'dmw-v2', network: s.network, settingsRevision: s.document.revision, settingsHash: r.hashObject(s.document),
        a: A.owner, t: 'transfer-v2', b: String(s.tip), h: s.history.hashAt(s.tip), p: { actions: [action] }, w: '0' };
      move.sig = signBytes(A.wallet, r.moveDigestV2(move)); return move;
    };
    const first = packet(B.owner, 'first'), later = packet(C.owner, 'later');
    const firstReceipt = await A.service.submit(first, { hashAt: s.history.hashAt });
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const signature = s.committee.signature;
    s.committee.signature = async (...args) => { const result = await signature(...args); entered(); await gate; return result; };
    const running = s.pipeline.tick(); let laterReceipt;
    try { await started; laterReceipt = await A.service.submit(later, { hashAt: s.history.hashAt }); }
    finally { release(); await running; }
    assert.equal(laterReceipt.batch, r.nextUint(firstReceipt.batch));
    s.committee.signature = signature;
    await s.pipeline.tick(); await s.runtime.refresh();
    assert.equal(balance(A.owner), '2'); assert.equal(balance(B.owner), '1'); assert.equal(balance(C.owner), '0');
    const fresh = packet(C.owner, 'later'), freshReceipt = await A.service.submit(fresh, { hashAt: s.history.hashAt });
    assert.equal(freshReceipt.batch, laterReceipt.batch);
    let refused = 0;
    s.committee.signature = async (...args) => {
      const failures = await s.rejectPublicClaimEvidence(args[1], context => {
        for (const input of context.inputs) if (input.accountRevisions) input.accountRevisions[0][1] = '999';
      }, /account_revision_read/);
      refused += failures.length; return signature(...args);
    };
    await s.drain(); assert.equal(refused, 5);
    assert.equal(balance(A.owner), '1'); assert.equal(balance(B.owner), '1'); assert.equal(balance(C.owner), '1');
    const publication = s.store.get('batches', heightKey(laterReceipt.batch)).publications[0];
    for (const [move, receipt, outcome] of [[later, laterReceipt, 'account_revision_changed'], [fresh, freshReceipt, 'accepted']]) {
      const inclusion = await A.service.inclusion(move, { publication, receipt, hashAt: s.history.hashAt });
      assert.equal(inclusion.reportedOutcome, outcome); assert.equal(inclusion.verified, true);
      assert.deepEqual(await A.service.submit(move, { hashAt: s.history.hashAt }), receipt);
    }
  } }));

test('later receipts survive gateway admission restart and replacement of an unreserved predecessor proposal',
  { timeout: 180000 }, t => v2StackFixture(t, { observationsPerBatch: 4, scenario: async s => {
    const A = s.players[0].agent;
    const move = tag => {
      const m = { v: 2, ruleset: 'dmw-v2', network: s.network, settingsRevision: s.document.revision, settingsHash: r.hashObject(s.document),
        a: A.owner, t: 'discovery-commit-v2', b: String(s.tip), h: s.history.hashAt(s.tip), p: { commitment: r.hash(tag) }, w: '0' };
      m.sig = signBytes(A.wallet, r.moveDigestV2(m)); return m;
    };
    await A.service.submit(move('activation'), { hashAt: s.history.hashAt }); await s.drain();
    const parent = move('parent'), parentReceipt = await A.service.submit(parent, { hashAt: s.history.hashAt });
    const original = await s.pipeline.build();
    const later = move('later'), receipt = await A.service.submit(later, { hashAt: s.history.hashAt });
    assert.equal(receipt.batch, r.nextUint(parentReceipt.batch));
    const old = s.runtime.intake.namedAdmission;
    s.runtime.intake.namedAdmission = new NamedAdmission({ ...old });
    assert.deepEqual(await A.service.submit(later, { hashAt: s.history.hashAt }), receipt);
    await s.observeNext();
    const retired = await s.pipeline.reconcileDraft(await s.pipeline.loadDraft());
    assert.equal(retired.draft, null);
    const replacement = await s.pipeline.build();
    assert.equal(String(replacement.proposal.batch.n), parentReceipt.batch);
    assert.notEqual(replacement.proposal.batch.root, original.proposal.batch.root);
    assert.ok(replacement.items.flatMap(i => i.input.entries).every(e => e.receipt.batch === parentReceipt.batch));
    await s.drain();
    for (const [m, rcp] of [[parent, parentReceipt], [later, receipt]]) {
      const accepted = s.store.get('namedAccepted', r.moveIdV2(m)); assert.equal(String(accepted.batch), rcp.batch);
      const row = s.store.get('batches', heightKey(rcp.batch));
      let verified = false;
      for (const publication of row.publications) {
        const audit = await A.service.audit(publication, { hashAt: s.history.hashAt });
        if (audit.file.receipts.some(r => r.move === rcp.move)) { assert.ok(audit.witnessed); verified = true; }
      }
      assert.ok(verified);
    }
  } }));
