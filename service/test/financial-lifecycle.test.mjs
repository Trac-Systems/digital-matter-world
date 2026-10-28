import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { Store } from '../src/store.mjs';
import { AccountExecution } from '../src/account-batch.mjs';
import { buildFinancialExecution, FinancialExecution } from '../src/financial-execution.mjs';
import { FinancialLinkReconciler } from '../src/financial-lifecycle.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { accountActionDigest, applyRootAccounts } from '../../contract/root-accounts.js';
import { applyPaymentPage, paymentCreditDigest, EMPTY_ALLOCATION_ROOT } from '../../contract/payment-pages.js';
import { custodyId, lifecycleDigest, recoveryEnd, recoveryPageHash } from '../../contract/financial-lifecycle.js';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { AccountAvailability } from '../src/account-availability.mjs';
import { rules as r } from '../src/rules.mjs';
import { alice, bob, nonce } from '../../contract/tests/helpers/harness.mjs';
import { temp, network } from './helpers.mjs';
import { publicFinancialOperations } from '../src/public-financial.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { Feeds } from '../src/feeds.mjs';
import { PublicSummaries } from '../src/public-summaries.mjs';
import { financialFeeKey } from '../src/financial-fee-identity.mjs';
import { heightKey } from '../src/util.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';

async function fixture(t, { project = false } = {}) {
  const path = await temp('g3c-lifecycle-'); let store = await Store.open(path);
  t.after(() => store.close());
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '10', values: { ...r.SETTINGS_PROFILE, paymentPage: 2 } });
  const sources = new Map(), records = new Map(), height = 10;
  let sequence = 0;
  if (project) await store.put('meta', 'ruleState', { batchVersion: 2, counted: '100' });
  const seed = new AccountExecution({ store, document, height });
  await seed.accounts([{ type: 'credit', owner: alice.address, asset: 'p2:0', amount: '100' }]);
  await store.transact(seed.result().writes);
  for (const w of seed.result().writes.filter(w => w.space === 'accountRecords')) records.set(w.id, w.value);
  const reads = { financialRecord: async key => records.get(key) ?? null,
    financialEvidence: async transition => { const e = sources.get(r.hashObject(transition)); if (e instanceof Error) throw e; assert.ok(e, 'fixture source missing'); return structuredClone(e); } };
  const executor = () => new FinancialExecution({ store, reads, document });
  const source = (transition, evidence) => { sources.set(r.hashObject(transition), evidence); return transition; };
  const lifecycle = (action, evidence) => source({ type: 'lifecycle', id: action.id, action }, { requestId: action.id, ...evidence });
  const execute = async (transitions, atHeight = height) => {
    const result = await buildFinancialExecution({ store, transitions, reads, document, height: atHeight });
    await verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads, document, network, height: atHeight });
    const changed = new Map(), adapter = { get: async key => changed.has(key) ? changed.get(key) : records.get(key), put: (key, value) => changed.set(key, value) };
    for (const op of result.operations) await (op.op === 'ar' ? applyRootAccounts : applyPaymentPage)(adapter, op, { network, height: atHeight, settings: { paymentPage: 2 } });
    for (const w of result.writes.filter(w => w.space === 'accountRecords')) assert.deepEqual(w.value, changed.get(w.id));
    for (const [key, value] of changed) records.set(key, structuredClone(value));
    const n = String(++sequence), file = { observation: n, height: String(atHeight), tip: String(atHeight), financialOperations: result.inputs };
    const draft = { items: [{ output: { file } }], proposal: { batch: { n } } };
    const local = executor().acceptedOperations(draft), writes = [...result.writes, ...local,
      ...(project ? [{ space: 'feedEvents', id: heightKey(n), value: { observation: n, batch: n, height: String(atHeight), tip: String(atHeight) } }] : [])];
    await store.transact([...writes, ...(project ? publicFinancialOperations(store, draft, writes) : [])]); return result;
  };
  const record = key => store.get('accountRecords', key);
  const inject = async (key, value) => { records.set(key, value); await store.put('accountRecords', key, value); };
  const sign = (action, who = alice) => ({ ...action, sig: Buffer.from(ed25519.sign(lifecycleDigest(network, action), who.secret)).toString('hex') });
  const feeItems = [{ role: 'firstMaker', to: 'fixture-custodian', ticker: 'tap', tt: 'a', dta: 'fixture-fee', amount: '5' }];
  const fees = [{ key: project ? financialFeeKey(feeItems[0]) : nonce(500), amount: '5' }];
  const link = id => {
    const e = { requestId: id, owner: alice.address, block: String(BigInt('0x' + id) % 10n), until: 20, state: 'reservable', fees, bitmapOwner: alice.address, link: null,
      ...(project ? { rail: 'tap', feeItems } : {}) };
    return lifecycle(sign({ type: 'link-reserve', id, owner: alice.address, block: e.block, until: e.until, terms: r.hashObject(e) }), e);
  };
  const bound = (id, fields) => ({ requestId: id, owner: record('fp/' + id).owner, terms: record('fp/' + id).terms, ...fields });
  const fund = (id, receipt = nonce(700), amount = '5', extra = {}) => {
    const items = [{ key: receipt, fee: fees[0].key, total: amount, amount }];
    return source({ type: 'fund', id, items }, bound(id, { state: 'settled', confirmations: 1, verifiedHeight: 11, items, ...extra }));
  };
  const mint = (id, capacity) => {
    const e = { owner: alice.address, asset: 'p2:0', amount: '7', fees, ...(capacity ? { capacity } : {}), ...(project ? { rail: 'tap', feeItems } : {}) };
    const action = { type: 'reserve', id, owner: alice.address, asset: e.asset, amount: e.amount, terms: r.hashObject(e),
      revision: record('ar/' + alice.address).revision, nonce: r.hashObject(['reserve', id]), until: 100 };
    action.sig = Buffer.from(ed25519.sign(accountActionDigest(network, action), alice.secret)).toString('hex');
    return source({ type: 'reserve', id, action, fees }, e);
  };
  const consume = id => source({ type: 'consume', id, permitHash: nonce(900) }, bound(id, { state: 'authorized', permitHash: nonce(900), fundingRoot: record('fp/' + id).root }));
  const credit = id => source({ type: 'refund', id, reason: 'credit' }, bound(id, { state: 'credit', expiry: 1 }));
  const balance = () => { const root = record('ar/' + alice.address).root, key = accountKey('balance', 'p2:0'); return readAccountLeaf(root, new AccountAvailability(store).prove(root, [key]), key); };
  return { get store() { return store; }, reads, document, sources, records, record, source, lifecycle, execute, sign, link, fund, fees, mint, consume, credit, bound, balance, inject, executor,
    reopen: async () => { await store.close(); store = await Store.open(path); } };
}

test('link entitlement precedes payment, survives restart/holder change, completes once and releases admission', async t => {
  const f = await fixture(t), id = nonce(1), reservation = f.link(id);
  await f.execute([reservation]);
  const rival = f.link(nonce(2)), e = { ...f.sources.get(r.hashObject(rival)), block: reservation.action.block };
  rival.action = f.sign({ ...rival.action, block: e.block, terms: r.hashObject(e) });
  f.source(rival, e);
  await assert.rejects(f.execute([rival]), /link_reserved/);
  assert.equal(f.record('fp/' + rival.id), null, 'failed reservation publishes no funding');
  await f.reopen(); await f.execute([f.fund(id)]);
  const complete = f.lifecycle({ type: 'link-complete', id }, f.bound(id, { state: 'complete', block: reservation.action.block, fundingRoot: f.record('fp/' + id).root }));
  await f.execute([complete], 30); // Delayed, already paid entitlement remains usable.
  assert.equal(f.record('fl/' + id).state, 'complete');
  assert.equal(f.record('fl/slot/' + reservation.action.block), null);
  assert.equal(f.store.count('activeFinancialLinks'), 0);
  assert.equal(f.store.count('activeFinancialLinksByOwner/' + alice.address), 0);
  assert.equal(f.store.get('linkStatus', id).state, 'accepted');
  await assert.rejects(f.execute([complete]), /financial_link_binding/);
  assert.ok(f.record('k/link/' + BigInt(reservation.action.block).toString(36)));
});

test('partial paid link exits to exact transferable credit; escrow refund issues none; late payment cannot fund', async t => {
  const f = await fixture(t), id = nonce(3), reservation = f.link(id);
  await f.execute([reservation]);
  await assert.rejects(f.execute([f.fund(id, nonce(701), '2', { verifiedHeight: 21 })]), /financial_link_payment_late/);
  await f.execute([f.fund(id, nonce(701), '2')]);
  const exit = f.lifecycle({ type: 'link-exit', id }, f.bound(id, { state: 'credit', block: reservation.action.block }));
  await assert.rejects(f.execute([exit], 20), /financial_link_live/);
  await f.execute([exit], 21);
  assert.equal(f.record('fc/' + id).fees[0].amount, '2');
  assert.equal(f.record('fl/' + id).state, 'credited');
  await assert.rejects(f.execute([exit], 21), /financial_link_binding/);
  const next = nonce(4), r2 = f.link(next); await f.execute([r2]);
  await f.execute([f.lifecycle({ type: 'link-exit', id: next }, f.bound(next, { state: 'ethereum_refund', block: r2.action.block,
    confirmations: 1, rail: 'ethereum', status: 3, domain: nonce(8), payer: 'fixture-payer' }))]);
  assert.equal(f.record('fl/' + next).state, 'refunded'); assert.equal(f.record('fc/' + next), null);
});

test('credit spending and transfers verify owner/revision, conserve backing and release terminal claims', async t => {
  const f = await fixture(t), id = nonce(5); await f.execute([f.mint(id)]); await f.execute([f.fund(id)]); await f.execute([f.credit(id)]);
  const creditOp = (operation, who = alice) => {
    operation.sig = Buffer.from(ed25519.sign(paymentCreditDigest(network, operation), who.secret)).toString('hex');
    return f.lifecycle({ type: operation.type === 'use' ? 'credit-use' : 'credit-transfer', id: operation.id, operation }, { state: 'authorized', operation: r.hashObject(operation) });
  };
  const transfer = creditOp({ op: 'fp', v: 2, type: 'transfer', id, credit: id, to: bob.address, revision: '0', until: 20 });
  await f.execute([transfer]); await assert.rejects(f.execute([transfer]), /credit_signature/);
  await f.execute([creditOp({ op: 'fp', v: 2, type: 'transfer', id, credit: id, to: alice.address, revision: '1', until: 20 }, bob)]);
  const next = nonce(6); await f.execute([f.mint(next)]);
  const spend = creditOp({ op: 'fp', v: 2, type: 'use', id: next, credit: id, revision: '2', until: 20, items: [{ fee: f.fees[0].key, amount: '5' }] });
  await f.execute([spend]); await assert.rejects(f.execute([spend]), /credit_signature/);
  assert.equal(f.record('fc/' + id).fees[0].amount, '0'); assert.equal(f.record('fp/' + next).paid[0], '5');
  await f.store.put('mints', next, { id: next, creditIds: [id, nonce(99)] });
  await f.store.put('creditClaims', id, next); await f.store.put('creditClaims', nonce(99), 'another-request');
  await f.execute([f.credit(next)]);
  assert.equal(f.store.get('creditClaims', id), null); assert.equal(f.store.get('creditClaims', nonce(99)), 'another-request');
  assert.equal(f.record('fc/' + next).fees[0].amount, '5'); assert.deepEqual(f.balance(), { available: '100', held: '0' });
});

test('custody accrues only consumed backing, pays once to owner authorization, renews only after proved revocation', async t => {
  const f = await fixture(t), request = nonce(7); await f.execute([f.mint(request)]); await f.execute([f.fund(request)]);
  const id = custodyId(request, f.fees[0].key), liability = { request, fee: f.fees[0].key, owner: bob.address, rail: 'tap', custodian: 'fixture-custodian', amount: '5' };
  const accrue = () => f.lifecycle({ type: 'custody-accrue', id, ...liability }, { state: 'custodied', liability, confirmations: 1,
    terms: f.record('fp/' + request).terms, fundingRoot: f.record('fp/' + request).consumedRoot ?? nonce(0) });
  await assert.rejects(f.execute([accrue()]), /financial_custody_evidence/);
  await f.execute([f.consume(request)]); await f.execute([accrue()]); await assert.rejects(f.execute([accrue()]), /custody_funding/);
  const claim = (revision, who) => f.lifecycle(f.sign({ type: 'custody-claim', id, revision, destination: 'fixture-beneficiary', until: 20 }, who),
    { state: 'destination_verified', owner: bob.address, rail: 'tap', revision, destination: 'fixture-beneficiary' });
  await assert.rejects(f.execute([claim('0', alice)]), /lifecycle_signature/);
  await f.execute([claim('0', bob)]);
  const payment = (state, extra = {}) => { const row = f.record('bc/' + id); return { state, claim: row.claim, amount: row.amount, rail: row.rail, custodian: row.custodian, destination: row.destination, ...extra }; };
  const oldClaim = f.record('bc/' + id).claim;
  await assert.rejects(f.execute([f.lifecycle({ type: 'custody-reopen', id, claim: oldClaim }, payment('expired'))]), /financial_payout_not_revoked/);
  await f.execute([f.lifecycle({ type: 'custody-reopen', id, claim: oldClaim }, payment('revoked_unpaid', { confirmations: 1, revocation: nonce(90) }))]);
  await assert.rejects(f.execute([claim('0', bob)]), /custody_revision/);
  await f.execute([claim('2', bob)]);
  const settle = f.lifecycle({ type: 'custody-settle', id, claim: f.record('bc/' + id).claim, receipt: nonce(91) }, payment('paid', { confirmations: 1, receipt: nonce(91) }));
  await f.execute([settle]); assert.equal(f.record('bc/' + id).state, 'settled'); assert.equal(f.record('bc/' + id).amount, '5');
  await assert.rejects(f.execute([settle]), /custody_claim/);
});

test('reserved and issued capacity cannot overpromise; exhaustion renews identity without freeing minted plots', async t => {
  const f = await fixture(t), deployment = nonce(10);
  const open = (id, previous, generation) => {
    const d = { asset: 'p2:0', deployment: 'fixture-inscription-' + id, generation, previous, maximum: '7', limit: '7' };
    return f.lifecycle({ type: 'deployment-open', id, ...d }, { state: 'deployed', confirmations: 1, deployment: d, minted: '0', outstanding: '0', remaining: d.maximum });
  };
  await f.execute([open(deployment, null, '0')]);
  await assert.rejects(f.execute([f.mint(nonce(17))]), /financial_capacity_required/);
  const request = nonce(11); await f.execute([f.mint(request, { deployment, plot: '42' })]);
  const before = f.balance();
  await assert.rejects(f.execute([f.mint(nonce(12), { deployment, plot: '43' })]), /capacity_exhausted/);
  assert.deepEqual(f.balance(), before);
  await assert.rejects(f.execute([open(nonce(13), deployment, '1')]), /deployment_unexhausted/);
  await f.execute([f.fund(request)]); await f.execute([f.consume(request)]);
  assert.equal(f.record('dc/' + request).state, 'issued'); assert.equal(f.record('fd/' + deployment).reserved, '7');
  await assert.rejects(f.execute([f.credit(request)]), /financial_obligation/);
  const finish = f.lifecycle({ type: 'capacity-finish', id: request, permitHash: nonce(900) }, { state: 'minted', confirmations: 1,
    permitHash: nonce(900), deployment, asset: 'p2:0', amount: '7', plot: '42', receipt: nonce(14) });
  await f.execute([finish]); await assert.rejects(f.execute([finish]), /capacity_terminal/);
  await f.execute([open(nonce(13), deployment, '1')]);
  await assert.rejects(f.execute([f.mint(nonce(15), { deployment: nonce(13), plot: '42' })]), /capacity_plot/);
  const next = nonce(16); await f.execute([f.mint(next, { deployment: nonce(13), plot: '43' })]); await f.execute([f.credit(next)]);
  assert.equal(f.record('dc/' + next).state, 'released'); assert.equal(f.record('fd/' + nonce(13)).reserved, '0');
  assert.equal(f.record('dc/plot/p2:0/43'), null); assert.equal(f.record('dc/plot/p2:0/42'), request);
});

test('reorg reconciliation authenticates every page, preserves liabilities, fences spending and renews stale approvals', async t => {
  const f = await fixture(t), request = nonce(20); await f.execute([f.mint(request)]); await f.execute([f.fund(request)]); await f.execute([f.credit(request)]);
  const id = nonce(21), previous = nonce(22), tip = nonce(23);
  await f.inject('br/' + id + '/meta', { state: 'building', previous: { hash: previous } });
  await f.inject('bt/last', { n: 4 });
  const item = { key: 'fc/' + request, before: r.hashObject(f.record('fc/' + request)), outcome: 'quarantine' };
  const accountItem = { key: 'ar/' + alice.address, before: r.hashObject(f.record('ar/' + alice.address)), outcome: 'quarantine' };
  const items = [item, accountItem], manifest = recoveryPageHash(items, recoveryEnd);
  const begin = f.lifecycle({ type: 'recovery-begin', id, previous, tip, manifest, count: '2' }, { state: 'reconciliation_manifest', previous, tip, manifest, count: '2', snapshot: nonce(24) });
  await f.execute([begin]); await f.reopen();
  await assert.rejects(f.execute([f.mint(nonce(25))]), /financial_recovery_active/);
  const approve = batch => f.lifecycle({ type: 'recovery-approve', id, batch }, { state: 'reconciled', previous, tip, manifest, batch });
  await assert.rejects(f.execute([approve(4)]), /financial_recovery_incomplete/);
  const bad = [{ ...item, outcome: 'retain' }];
  await assert.rejects(f.execute([f.lifecycle({ type: 'recovery-page', id, sequence: '0', items: bad, next: recoveryEnd },
    { state: 'reconciled', sequence: '0', items: bad, next: recoveryEnd })]), /financial_recovery_page/);
  const page = f.lifecycle({ type: 'recovery-page', id, sequence: '0', items, next: recoveryEnd }, { state: 'reconciled', sequence: '0', items, next: recoveryEnd });
  await f.execute([page]); await assert.rejects(f.execute([page]), /financial_recovery_page/);
  await f.execute([approve(4)]);
  assert.equal(f.record('recoveryApproved/' + id).lastBatch, 5);
  await f.inject('bt/last', { n: 8 });
  await f.execute([f.lifecycle({ type: 'recovery-refresh', id, batch: 8 }, { state: 'reconciled', previous, tip, manifest, batch: 8 })]);
  assert.equal(f.record('recoveryApproved/' + id).lastBatch, 9);
  const reconciliation = f.record('fr/' + id).root;
  const finish = f.lifecycle({ type: 'recovery-finish', id }, { state: 'adopted', reconciliation });
  await assert.rejects(f.execute([finish]), /financial_recovery_unadopted/);
  await f.inject('b/recovery', { id, previous: { hash: previous }, tip: { hash: tip }, reconciliation });
  await f.execute([finish]);
  assert.deepEqual(f.record('fc/' + request).fees, f.fees, 'reorg never erases the liability');
  await assert.rejects(f.execute([f.mint(nonce(26))]), /financial_quarantined/);
  const operation = { op: 'fp', v: 2, type: 'transfer', id: request, credit: request, to: bob.address, revision: '0', until: 20 };
  operation.sig = Buffer.from(ed25519.sign(paymentCreditDigest(network, operation), alice.secret)).toString('hex');
  const transfer = f.lifecycle({ type: 'credit-transfer', id: request, operation }, { state: 'authorized', operation: r.hashObject(operation) });
  await assert.rejects(f.execute([transfer]), /financial_quarantined/);
  await f.execute([f.lifecycle({ type: 'recovery-release', id, key: item.key, before: item.before }, { state: 'canonical_again', key: item.key, before: item.before, confirmations: 1 })]);
  await f.execute([transfer]); assert.equal(f.record('fc/' + request).owner, bob.address);
  await f.execute([f.lifecycle({ type: 'recovery-release', id, key: accountItem.key, before: accountItem.before },
    { state: 'canonical_again', key: accountItem.key, before: accountItem.before, confirmations: 1 })]);
  await f.execute([f.mint(nonce(26))]);
});

test('expired links release scarce local slots during source outages and reconciliation resumes after restart', async t => {
  const f = await fixture(t), id = nonce(30), r1 = f.link(id); await f.execute([r1]); await f.execute([f.fund(id, nonce(730), '2')]);
  const transition = { type: 'lifecycle', id, action: { type: 'link-exit', id } };
  f.source(transition, Error('source_unavailable'));
  let scheduler = new FinancialLinkReconciler({ store: f.store, financial: f.executor(), reads: f.reads, resources: { workPage: 1 } });
  await scheduler.tick(21);
  assert.equal(f.store.count('activeFinancialLinks'), 0); assert.equal(f.store.count('financialLinkRecovery'), 1);
  await f.reopen(); scheduler = new FinancialLinkReconciler({ store: f.store, financial: f.executor(), reads: f.reads, resources: { workPage: 1 } });
  f.source(transition, f.bound(id, { state: 'credit', block: r1.action.block }));
  await scheduler.tick(21); assert.equal(f.store.count('financialQueue'), 1);
  await f.execute([transition], 21); assert.equal(f.store.count('financialLinkRecovery'), 0); assert.equal(f.store.count('financialQueue'), 0);
});

test('lifecycle signer rejects source substitution and forged effects before publication', async t => {
  const f = await fixture(t), transition = f.link(nonce(40));
  const built = await buildFinancialExecution({ store: f.store, transitions: [transition], reads: f.reads, document: f.document, height: 10 });
  const files = [{ ops: built.operations, financialOperations: built.inputs }];
  await assert.rejects(verifyFinancialExecution({ files, reads: { ...f.reads, financialEvidence: async t => ({ ...await f.reads.financialEvidence(t), bitmapOwner: bob.address }) }, document: f.document, network, height: 10 }), /financial_evidence_read/);
  const altered = structuredClone(files); altered[0].ops[1].action.block = '999'; altered[0].financialOperations[0].operations = altered[0].ops;
  await assert.rejects(verifyFinancialExecution({ files: altered, reads: f.reads, document: f.document, network, height: 10 }), /financial_effects/);
  assert.equal(f.store.count('activeFinancialLinks'), 0);
});

test('orphaned credits can regain backing through new settled pages without reusing the payment or erasing the liability', async t => {
  const f = await fixture(t), credit = nonce(50); await f.execute([f.mint(credit)]); await f.execute([f.fund(credit)]); await f.execute([f.credit(credit)]);
  const original = f.record('fc/' + credit), before = r.hashObject(original), recovery = nonce(51), id = nonce(52);
  await f.inject('fq/fc/' + credit, { recovery, before });
  const open = f.lifecycle({ type: 'credit-repair-open', id, credit, recovery, before }, { state: 'replacement_terms', credit, recovery, before, owner: alice.address, fees: original.fees });
  await f.execute([open]);
  const finish = () => f.lifecycle({ type: 'credit-repair-finish', id }, { state: 'replacement_backed', credit, before, fundingRoot: f.record('fp/' + id).root });
  await assert.rejects(f.execute([finish()]), /funding_incomplete/);
  await assert.rejects(f.execute([f.fund(id)]), /funding_reused/);
  await f.execute([f.fund(id, nonce(750))]); await f.execute([finish()]);
  assert.equal(f.record('fq/fc/' + credit), null); assert.deepEqual(f.record('fc/' + credit), original);
  assert.equal(f.record('fp/' + id).state, 'consumed'); assert.equal(f.record('fr/backing/' + id).state, 'complete');
  const liability = { request: id, fee: f.fees[0].key, owner: bob.address, rail: 'tap', custodian: 'fixture-custodian', amount: '5' };
  await assert.rejects(f.execute([f.lifecycle({ type: 'custody-accrue', id: custodyId(id, f.fees[0].key), ...liability },
    { state: 'custodied', liability, confirmations: 1, terms: f.record('fp/' + id).terms, fundingRoot: f.record('fp/' + id).consumedRoot })]), /custody_funding/);
  await assert.rejects(f.execute([finish()]), /funding_incomplete/);
  const thief = nonce(53); await f.execute([f.mint(thief)]);
  await assert.rejects(f.execute([f.fund(thief, nonce(750))]), /funding_reused/);
});

test('a fully paid link with lost entitlement is reconciled to credit and both alternative intents leave the queue', async t => {
  const f = await fixture(t), id = nonce(60), reservation = f.link(id); await f.execute([reservation]); await f.execute([f.fund(id)]);
  const complete = { type: 'lifecycle', id, action: { type: 'link-complete', id } };
  f.source(complete, Error('entitlement_invalidated')); await f.executor().submit(complete);
  const exit = f.lifecycle({ type: 'link-exit', id }, f.bound(id, { state: 'credit', failure: 'entitlement_invalidated', block: reservation.action.block }));
  await f.executor().linkReconciler.tick(21);
  assert.equal(f.store.count('financialQueue'), 2);
  await f.execute([exit], 21);
  assert.equal(f.store.count('financialQueue'), 0); assert.equal(f.store.count('activeFinancialLinks'), 0); assert.equal(f.store.count('financialLinkRecovery'), 0);
  assert.equal(f.record('fc/' + id).fees[0].amount, '5');
});

test('reservation and terminal reconciliation in one accepted batch leave no owner slot or credit claim', async t => {
  const f = await fixture(t), id = nonce(61), reservation = f.link(id), items = [{ key: nonce(761), fee: f.fees[0].key, amount: '5', total: '5' }];
  const bound = { requestId: id, owner: alice.address, terms: reservation.action.terms };
  const fund = f.source({ type: 'fund', id, items }, { ...bound, state: 'settled', confirmations: 1, verifiedHeight: 10, items });
  const fundingRoot = r.hashObject(['dmw-allocation-page-v2', id, EMPTY_ALLOCATION_ROOT, '0', items]);
  const complete = f.lifecycle({ type: 'link-complete', id }, { ...bound, state: 'complete', block: reservation.action.block, fundingRoot });
  await f.execute([reservation, fund, complete]);
  assert.equal(f.store.count('activeFinancialLinksByOwner/' + alice.address), 0); assert.equal(f.store.count('activeFinancialLinks'), 0);
  assert.equal(f.record('fl/' + id).state, 'complete');
});

test('duplicate reorg records cannot satisfy completeness or leave partial quarantines, and an abandoned candidate can be aborted', async t => {
  const f = await fixture(t), id = nonce(62), request = nonce(63), previous = nonce(64), tip = nonce(65);
  await f.execute([f.mint(request)]);
  await f.inject('br/' + id + '/meta', { state: 'building', previous: { hash: previous } });
  const item = { key: 'ao/' + request, before: r.hashObject(f.record('ao/' + request)), outcome: 'quarantine' };
  const items = [item, item], manifest = recoveryPageHash(items, recoveryEnd);
  await f.execute([f.lifecycle({ type: 'recovery-begin', id, previous, tip, manifest, count: '2' }, { state: 'reconciliation_manifest', previous, tip, manifest, count: '2', snapshot: nonce(66) })]);
  await assert.rejects(f.execute([f.lifecycle({ type: 'recovery-page', id, sequence: '0', items, next: recoveryEnd },
    { state: 'reconciled', sequence: '0', items, next: recoveryEnd })]), /financial_recovery_record/);
  assert.equal(f.record('fq/' + item.key), null); assert.equal(f.record('fr/' + id).processed, '0');
  await f.execute([f.lifecycle({ type: 'recovery-abort', id }, { state: 'candidate_abandoned', manifest })]);
  assert.equal(f.record('fr/active'), null); assert.equal(f.record('fr/' + id).state, 'aborted');
  await f.execute([f.credit(request)]); assert.deepEqual(f.balance(), { available: '100', held: '0' });
});

test('combined paid mint, link, credits and custody publish exact source-free pages across restart', async t => {
  const f = await fixture(t, { project: true }), deployment = nonce(400), request = nonce(401);
  const d = { asset: 'p2:0', deployment: 'fixture-external-deployment', generation: '0', previous: null, maximum: '100', limit: '7' };
  await f.execute([f.lifecycle({ type: 'deployment-open', id: deployment, ...d }, { state: 'deployed', confirmations: 1, deployment: d, minted: '0', outstanding: '0', remaining: '100' })]);
  await f.execute([f.mint(request, { deployment, plot: '42' })]);
  assert.equal(f.store.get('publicBalances', alice.address + '/p2:0').held, '7');
  await f.execute([f.fund(request, nonce(410), '5', { paymentFacts: [{ key: nonce(410), reference: nonce(420) + 'i0', height: '11' }] })]);
  await f.execute([f.consume(request)]);
  await f.execute([f.lifecycle({ type: 'capacity-finish', id: request, permitHash: nonce(900) }, { state: 'minted', confirmations: 1,
    permitHash: nonce(900), deployment, asset: 'p2:0', amount: '7', plot: '42', receipt: nonce(411), inscription: nonce(412) + 'i0' })]);
  const link = nonce(402), reservation = f.link(link); await f.execute([reservation]); await f.execute([f.fund(link, nonce(413))]);
  await f.execute([f.lifecycle({ type: 'link-complete', id: link }, f.bound(link, { state: 'complete', block: reservation.action.block, fundingRoot: f.record('fp/' + link).root }))]);
  const surplus = [{ key: nonce(414), fee: f.fees[0].key, total: '5', amount: '5' }];
  const seq = f.record('fp/' + request).sequence;
  await f.execute([f.source({ type: 'surplus', id: request, items: surplus }, f.bound(request, { state: 'settled', confirmations: 1, items: surplus }))]);
  const { surplusCreditId } = await import('../../contract/payment-pages.js');
  const credit = surplusCreditId(request, seq);
  const creditOp = (operation, who = alice) => {
    operation.sig = Buffer.from(ed25519.sign(paymentCreditDigest(network, operation), who.secret)).toString('hex');
    return f.lifecycle({ type: operation.type === 'use' ? 'credit-use' : 'credit-transfer', id: operation.id, operation },
      { state: 'authorized', operation: r.hashObject(operation), owner: who.address });
  };
  await f.execute([creditOp({ op: 'fp', v: 2, type: 'transfer', id: credit, credit, to: bob.address, revision: '0', until: 20 })]);
  assert.equal(f.store.get('publicResults/credits', credit).owner, bob.address);
  await f.execute([creditOp({ op: 'fp', v: 2, type: 'transfer', id: credit, credit, to: alice.address, revision: '1', until: 20 }, bob)]);
  const next = nonce(403); await f.execute([f.mint(next, { deployment, plot: '43' })]);
  await f.execute([creditOp({ op: 'fp', v: 2, type: 'use', id: next, credit, revision: '2', until: 20, items: [{ fee: f.fees[0].key, amount: '5' }] })]);
  await f.execute([f.credit(next)]);
  const custody = custodyId(request, f.fees[0].key), liability = { request, fee: f.fees[0].key, owner: bob.address, rail: 'tap', custodian: 'fixture-custodian', amount: '5' };
  await f.execute([f.lifecycle({ type: 'custody-accrue', id: custody, ...liability }, { state: 'custodied', liability, confirmations: 1,
    terms: f.record('fp/' + request).terms, fundingRoot: f.record('fp/' + request).consumedRoot })]);
  await f.execute([f.lifecycle(f.sign({ type: 'custody-claim', id: custody, revision: '0', destination: 'fixture-beneficiary', until: 20 }, bob),
    { state: 'destination_verified', owner: bob.address, rail: 'tap', revision: '0', destination: 'fixture-beneficiary' })]);
  const row = f.record('bc/' + custody);
  await f.execute([f.lifecycle({ type: 'custody-settle', id: custody, claim: row.claim, receipt: nonce(415) }, {
    state: 'paid', claim: row.claim, amount: row.amount, rail: row.rail, custodian: row.custodian, destination: row.destination, confirmations: 1, receipt: nonce(415) })]);
  const burnRequest = nonce(404), burnReservation = f.mint(burnRequest, { deployment, plot: '44' });
  const burnEvidence = structuredClone(f.sources.get(r.hashObject(burnReservation)));
  burnEvidence.feeItems[0].role = 'burn'; burnEvidence.feeItems[0].to = r.tapBurnAddress('regtest');
  burnEvidence.fees = [{ key: financialFeeKey(burnEvidence.feeItems[0]), amount: '5' }];
  burnReservation.action.terms = r.hashObject(burnEvidence); burnReservation.fees = burnEvidence.fees;
  burnReservation.action.sig = Buffer.from(ed25519.sign(accountActionDigest(network, burnReservation.action), alice.secret)).toString('hex');
  await f.execute([f.source(burnReservation, burnEvidence)]);
  // One receipt allocated in two accepted pages is counted once in the burn.
  for (const amount of ['2', '3']) {
    const items = [{ key: nonce(419), fee: burnEvidence.fees[0].key, total: '5', amount }];
    await f.execute([f.source({ type: 'fund', id: burnRequest, items }, f.bound(burnRequest, { state: 'settled', confirmations: 1, items }))]);
  }
  await f.execute([f.credit(burnRequest)]);
  await f.reopen();
  const feeds = new Feeds({ store: f.store, history: { get() { throw Error('history_scan'); } }, reads: {}, settings: { feedEventRows: 2 } });
  while (f.store.count('feedEvents') || f.store.count('feedBlockChanges')) await feeds.events();
  let sourceCalls = 0;
  const registry = { revision: 1, settings: { pageRows: 2 }, page(space, { after }) {
    return (space.endsWith('/tap') && !after ? [{ id: 'verified-treasury' }] : []);
  } };
  const summary = new PublicSummaries({ store: f.store, rows: 2, reads: { registry: async () => registry,
    publicTreasuryAccount: async (rail, address) => { sourceCalls++; return { rail, address, balance: '900719925474099312345', anchor: { hash: nonce(416), height: '10' } }; },
    publicExternalSupply: async () => { sourceCalls++; return { ethereum: '900719925474099312346', anchor: { hash: nonce(417), height: '11' } }; } } });
  await summary.tick(); await summary.tick();
  const callsBefore = sourceCalls;
  const api = createPublicAPI({ views: { store: f.store, reads: new Proxy({}, { get() { sourceCalls++; throw Error('page_source_call'); } }) } });
  const mintPage = await api.read('/results/mints?state=minted&limit=1'); assert.equal(mintPage.mints[0].inscription, nonce(412) + 'i0');
  assert.equal(mintPage.mints[0].block, '42');
  const paidReceipt = f.store.get('publicResults/payments', nonce(410));
  assert.equal(paidReceipt.block, '11'); assert.equal(paidReceipt.targetBlock, '42'); assert.equal(paidReceipt.reference, nonce(420) + 'i0');
  assert.equal((await api.read('/results/links')).links[0].block, reservation.action.block);
  assert.equal((await api.read('/results/linkRequests')).linkRequests[0].state, 'complete');
  assert.equal((await api.read('/results/credits?owner=' + encodeTracAddress(bob.address))).credits.length, 0);
  const credits = (await api.read('/results/credits?limit=1')).credits; assert.equal(credits.length, 1);
  assert.equal((await api.read('/results/custody')).custody[0].state, 'settled');
  assert.equal((await api.read('/results/owed')).owed.length, 0);
  assert.equal((await api.read('/results/paid')).paid[0].amount, '5');
  assert.equal((await api.read('/results/payouts')).payouts[0].owed, '0');
  const totals = await api.read('/results'); assert.equal(totals.burn.tap, '5', 'split allocation and credit reuse never burn a second time');
  assert.equal(totals.outstandingSupply.matter, '93'); assert.equal(totals.treasury.tap, '900719925474099312345');
  assert.equal(totals.outstandingSupply.ethereum, '900719925474099312346');
  const profile = await api.read('/agents/' + encodeTracAddress(alice.address)); assert.equal(profile.scores.mints, '1'); assert.equal(profile.scores.links, '1');
  let cursor, payments = 0;
  do { const page = await api.read('/results/payments?' + new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) })); payments += page.payments.length; cursor = page.next; } while (cursor);
  assert.equal(payments, 4);
  assert.equal(sourceCalls, callsBefore, 'every page reads only persisted projections');
  const before = await api.response('/results/credits');
  await f.store.put('accountRecords', 'fq/fc/' + credit, { recovery: nonce(418) });
  assert.notEqual(await api.response('/results/credits'), before);
  const blocked = await api.read('/results/credits'); assert.equal(blocked.credits.find(c => c.id === credit).current, false);
  const beforeLink = await api.response('/results/links');
  await f.store.put('accountRecords', 'fq/fl/' + link, { recovery: nonce(418) });
  assert.notEqual(await api.response('/results/links'), beforeLink);
  assert.equal((await api.read('/results/links')).links[0].current, false);
  t.diagnostic(JSON.stringify({ paidMints: 1, paidLinks: 1, paymentReceipts: payments, creditTransfers: 2, creditUses: 1, custodySettlements: 1, publicPageSourceCalls: sourceCalls - callsBefore }));
});
