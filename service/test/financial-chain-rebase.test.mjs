import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { Store } from '../src/store.mjs';
import { AccountExecution } from '../src/account-batch.mjs';
import { buildFinancialExecution, FinancialExecution } from '../src/financial-execution.mjs';
import { installFinancialChain } from '../src/financial-chain.mjs';
import { createFinancialRebaseVerifier } from '../src/financial-chain-provenance.mjs';
import { financialChainSettings, moneyFreeFinancialInput } from '../src/financial-chain-policy.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { reserveNonceDigest, applyRootAccounts } from '../../contract/root-accounts.js';
import { applyPaymentPage } from '../../contract/payment-pages.js';
import { plotKey } from '../../contract/financial-capacity.js';
import { capacityPlotKey } from '../../rules/src/per-ticker-supply-activation.js';
import { rules as r } from '../src/rules.mjs';
import { alice } from '../../contract/tests/helpers/harness.mjs';
import { temp, network } from './helpers.mjs';

async function fixture(t) {
  const store = await Store.open(await temp('financial-rebase-')); t.after(() => store.close());
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '10', values: { ...r.SETTINGS_PROFILE } });
  const generation = r.hash('generation'), common = { bitcoin: { height: '10', hash: r.hash('common') }, ethereum: null };
  const old = { bitcoin: { height: '11', hash: r.hash('losing') }, ethereum: null };
  const canonicalOverrides = new Map(), reveals = new Map();
  const canonical = h => canonicalOverrides.get(h) ?? (h === '10' ? common.bitcoin.hash : r.hash('winning/' + h));
  let forked = false, stamp = { tip: '11', tipHash: old.bitcoin.hash, counted: '11', last: { n: '0' } };
  const sources = new Map(), batches = new Map(), records = new Map();
  const seed = new AccountExecution({ store, document, height: '10' });
  await seed.accounts([{ type: 'credit', owner: alice.address, asset: 'p2:0', amount: '100' }]);
  await store.transact([...seed.result().writes, { space: 'accountRecords', id: 'fp/chain', value: common },
    { space: 'accountRecords', id: 'fd/asset/p2:0', value: generation },
    { space: 'accountRecords', id: 'fd/' + generation, value: { asset: 'p2:0', deployment: 'fixture-deployment', maximum: '100', limit: '0', reserved: '0', minted: '0' } }]);
  for (const row of store.list('accountRecords', { limit: 100 })) records.set(row.id, row.value);
  const source = (transition, evidence) => { sources.set(r.hashObject(transition), evidence); return transition; };
  const makeReads = (enabled = true, settings, auditCalls = [], deploymentCalls = []) => {
    const bitcoinHash = async h => h === '11' && !forked ? old.bitcoin.hash : canonical(h);
    const audits = async n => { auditCalls.push(String(n)); const batch = batches.get(String(n)); assert.ok(batch); assert.equal(r.merkleRoot(batch.files.map(r.encodeBinary)), batch.root); return structuredClone(batch.files); };
    const reads = { financialRecord: async key => structuredClone(records.get(key) ?? null),
      financialEvidence: async transition => { const evidence = sources.get(r.hashObject(transition)); assert.ok(evidence); return structuredClone(evidence); } };
    const deploymentIncluded = async (id, at) => {
      deploymentCalls.push(id); assert.deepEqual(at, stamp);
      const value = reveals.get(id); if (value instanceof Error) throw value;
      return structuredClone(value ?? null);
    };
    return installFinancialChain(reads, { bitcoinHash, canonicalBitcoinHash: bitcoinHash, settings,
      bitcoinHeader: async hash => hash === old.bitcoin.hash ? { ...old.bitcoin, parent: common.bitcoin.hash } : null,
      ...(enabled ? { rebaseSafe: createFinancialRebaseVerifier({ store, audits, bitcoinHash, canonicalBitcoinHash: bitcoinHash, deploymentIncluded, settings }) } : {}) });
  };
  const accept = async (result, financial, fields = {}) => {
    const file = { ...fields, ops: result.operations, financialOperations: result.inputs }, n = String(BigInt(stamp.last.n) + 1n);
    await verifyFinancialExecution({ files: [file], reads: makeReads(), document, network, height: stamp.counted, at: stamp });
    const changed = new Map(), adapter = { get: async key => changed.has(key) ? changed.get(key) : records.get(key) ?? null, put: (key, value) => changed.set(key, value) };
    for (const op of result.operations) await (op.op === 'ar' ? applyRootAccounts : applyPaymentPage)(adapter, op, { network, height: stamp.counted });
    for (const w of result.writes.filter(w => w.space === 'accountRecords')) { assert.deepEqual(changed.get(w.id), w.value); records.set(w.id, w.value); }
    const provenance = result.inputs.flatMap((input, index) => (input.recordCommitments ?? []).map(([id]) =>
      ({ space: 'financialRecordProvenance', id, value: { n, file: 0, index } })));
    const draft = { proposal: { batch: { n } }, items: [{ output: { file, accountWrites: result.writes } }] };
    await store.transact([...result.writes, ...provenance, ...(financial ? financial.acceptedOperations(draft) : [])]);
    batches.set(n, { files: [file], root: r.merkleRoot([r.encodeBinary(file)]) });
    stamp = { ...stamp, last: { n } }; return file;
  };
  const reserve = (n, target) => {
    const asset = target?.action?.asset ?? 'p2:0', external = target?.action?.deployment ?? 'fixture-deployment';
    const id = r.hash('reservation/' + n), evidence = { owner: alice.address, asset, amount: '7', fees: [{ key: r.hash('fee'), amount: '5' }],
      capacity: { deployment: external, asset, amount: '7', block: String(n), remaining: '100', limit: '0' },
      generationCapacity: { deployment: target?.id ?? generation, plot: String(n) } };
    const action = { type: 'reserve-n', id, owner: alice.address, asset: evidence.asset, amount: evidence.amount,
      terms: r.hashObject(evidence), nonce: r.hash('nonce/' + n), until: String(BigInt(stamp.counted) + 9n) };
    action.sig = Buffer.from(ed25519.sign(reserveNonceDigest(network, action), alice.secret)).toString('hex');
    return source({ type: 'reserve', id, action, fees: evidence.fees }, evidence);
  };
  const build = (transitions, reads = makeReads(), fields = {}) => buildFinancialExecution({ ...fields, store, transitions, reads, document, height: stamp.counted, at: stamp });
  const deployment = (type = 'deployment-open', n = 1) => {
    const inscription = r.hash('deployment-reveal/' + n) + 'i0', id = r.hash('deployment-generation/' + n);
    const body = { asset: type === 'deployment-add' ? 'p2:0' : 'p2:' + n, deployment: inscription,
      ...(type === 'deployment-add' ? { official: generation } : { generation: '0', previous: null }), maximum: '100', limit: '0' };
    reveals.set(inscription, { height: '11', blockHash: canonical('11'), confirmations: '2', tx: { txid: inscription.slice(0, 64) } });
    return source({ type: 'lifecycle', id, action: { type, id, ...body } },
      { requestId: id, state: 'deployed', confirmations: 1, deployment: body, minted: '0', outstanding: '0', remaining: '100' });
  };
  const refund = id => source({ type: 'refund', id, reason: 'credit' }, { requestId: id, owner: alice.address,
    terms: records.get('fp/' + id).terms, state: 'credit', expiry: '11' });
  const fork = () => { forked = true; stamp = { ...stamp, tip: '12', tipHash: canonical('12'), counted: BigInt(stamp.counted) > 12n ? stamp.counted : '12' }; };
  const gap = (count, files = [{ ops: [{ op: 'ar', v: 2, actions: [{ type: 'credits', owner: alice.address, assets: [['p2:0', '1']] },
    { type: 'craft', owner: alice.address, asset: 'c1', inputs: [['p2:0', '1']] }] }] }]) => {
    for (let i = 0; i < count; i++) {
      const n = String(BigInt(stamp.last.n) + 1n);
      batches.set(n, { files: structuredClone(files), root: r.merkleRoot(files.map(r.encodeBinary)) });
      stamp = { ...stamp, last: { n } };
    }
  };
  return { store, records, document, source, reserve, build, accept, makeReads, fork, refund, old, common, batches, gap,
    deployment, reveals, canonical, canonicalOverrides,
    get at() { return stamp; }, setStamp: fields => { stamp = { ...stamp, ...fields }; }, setLast: n => { stamp = { ...stamp, last: { n } }; } };
}

test('one-block rebase emits a normal checkpoint and identical gateway/signer inputs and effects', async t => {
  const f = await fixture(t), reservation = f.reserve(1);
  const accepted = await f.build([reservation]); await f.accept(accepted);
  assert.ok(accepted.inputs.every(moneyFreeFinancialInput));
  f.fork();
  const transitions = [f.refund(reservation.id)], gateway = await f.build(transitions), independent = await f.build(transitions, f.makeReads());
  assert.equal(r.stableJSON(gateway.inputs), r.stableJSON(independent.inputs));
  assert.equal(r.stableJSON(gateway.operations), r.stableJSON(independent.operations));
  const checkpoint = gateway.operations.find(op => op.type === 'checkpoint');
  assert.equal(checkpoint.previous, r.hashObject(f.old));
  assert.deepEqual(checkpoint.anchor, { bitcoin: { height: '12', hash: f.at.tipHash }, ethereum: null });
  await f.accept(gateway);
  assert.equal(f.records.get(plotKey('p2:0', '1')), null);
  assert.equal(f.records.get(capacityPlotKey('p2:0', '1')), null);
});

test('a payment page after the first unchanged checkpoint prevents rebase', async t => {
  const f = await fixture(t), reservation = f.reserve(1), id = reservation.id, terms = reservation.action.terms;
  const items = [{ key: r.hash('receipt'), fee: r.hash('fee'), amount: '1', total: '1' }];
  const payment = f.source({ type: 'fund', id, items }, { requestId: id, owner: alice.address, terms, items, state: 'settled', confirmations: 1 });
  await f.accept(await f.build([reservation, payment]));
  assert.equal(f.store.get('financialRecordProvenance', 'fp/chain').index, 0);
  f.fork();
  await assert.rejects(f.build([f.refund(id)]), /financial_chain_recovery_required/);
});

test('missing accepted gap files cannot be replaced by a local provenance hint', async t => {
  const f = await fixture(t), reservation = f.reserve(1);
  await f.accept(await f.build([reservation]));
  f.setLast('357'); f.fork();
  await assert.rejects(f.build([f.refund(reservation.id)]), /financial_chain_recovery_required/);
});

test('a deferred refund and lifecycle queue drains after rebase and releases every block reservation', async t => {
  const f = await fixture(t), reservations = [1, 2, 3, 4].map(f.reserve);
  await f.accept(await f.build(reservations)); f.fork();
  const financial = new FinancialExecution({ store: f.store, reads: f.makeReads(false), document: f.document, resources: { workPage: 32 } });
  for (const reservation of reservations) await financial.submit(f.refund(reservation.id));
  for (let n = 0; n < 32; n++) {
    const id = r.hash('deployment/' + n), deployment = { asset: 'p2:' + (n + 1), deployment: 'external/' + n, generation: '0', previous: null, maximum: '100', limit: '0' };
    const transition = f.source({ type: 'lifecycle', id, action: { type: 'deployment-open', id, ...deployment } },
      { requestId: id, state: 'deployed', confirmations: 1, deployment, minted: '0', outstanding: '0', remaining: '100' });
    await financial.submit(transition);
  }
  const deferred = await financial.build({ height: f.at.counted, at: f.at });
  assert.equal(deferred.inputs.length, 0);
  assert.ok(deferred.deferred.every(row => row.reason === 'financial_chain_recovery_required'));
  assert.equal(f.store.count('financialQueue'), 36);
  financial.reads = f.makeReads(); let batches = 0, processed = 0;
  while (financial.pending()) {
    assert.ok(batches++ < 3);
    const result = await financial.build({ height: f.at.counted, at: f.at });
    assert.ok(result.inputs.length); assert.deepEqual(result.deferred, []);
    processed += result.inputs.length; await f.accept(result, financial);
  }
  assert.equal(processed, 36); assert.equal(f.store.count('financialDeferred'), 0);
  assert.equal(batches, 2);
  for (let n = 1; n <= 4; n++) {
    assert.equal(f.records.get(plotKey('p2:0', String(n))), null);
    assert.equal(f.records.get(capacityPlotKey('p2:0', String(n))), null);
  }
});

test('canonical prior produces unchanged financial input and operation bytes', async t => {
  const f = await fixture(t), result = await f.build([f.reserve(1)]);
  assert.equal(r.hashObject([result.inputs, result.operations]), 'bea00e46c6885fd8ea9a7a07170d4185f376993bf2d05ee54fcb56ad3abdee51');
  await f.accept(result);
});

test('all money evidence and unknown operations keep an otherwise harmless input fenced', async t => {
  const f = await fixture(t), built = await f.build([f.reserve(1)]), original = built.inputs[0];
  assert.equal(moneyFreeFinancialInput(original), true);
  for (const field of ['payment', 'payments', 'receipt', 'receipts', 'refund', 'escrow', 'surplus', 'ethereumAnchor', 'custody']) {
    const input = structuredClone(original); input.evidence[field] = { proof: r.hash(field) };
    assert.equal(moneyFreeFinancialInput(input), false, field);
  }
  for (const type of ['page', 'surplus', 'public-payment', 'bulk-fund', 'refund', 'consume']) {
    const input = structuredClone(original); input.operations.push({ op: 'fp', type, id: input.transition.id });
    assert.equal(moneyFreeFinancialInput(input), false, type);
  }
});

test('a later money-free reservation at the unchanged anchor is covered by the gap proof', async t => {
  const f = await fixture(t);
  await f.accept(await f.build([f.reserve(1)]));
  // Another accepted reservation at the same anchor has no new fp/chain
  // commitment, but every input in both authenticated batches is inspected.
  const second = await f.build([f.reserve(2)]); await f.accept(second);
  f.fork();
  await f.accept(await f.build([f.refund(second.inputs[0].transition.id)]));
});

test('reader policy validates a shared default and disabling shallow rebases', () => {
  assert.deepEqual(financialChainSettings(), { shallowReorgLimit: 6, rebaseBatchLimit: 1024 });
  assert.deepEqual(financialChainSettings({ shallowReorgLimit: 0 }), { shallowReorgLimit: 0, rebaseBatchLimit: 1024 });
  for (const settings of [{ shallowReorgLimit: -1 }, { shallowReorgLimit: '6' }, { shallowReorgLimit: 1.5 }, { typo: 6 },
    { rebaseBatchLimit: -1 }, { rebaseBatchLimit: '1024' }, { rebaseBatchLimit: Infinity }])
    assert.throws(() => financialChainSettings(settings), /financial_chain_settings/);
});

test('a bounded gap of game credits and crafts rebases identically and each reader verifies it once', async t => {
  const f = await fixture(t), reservation = f.reserve(1);
  await f.accept(await f.build([reservation])); f.gap(366); f.fork();
  const gatewayCalls = [], signerCalls = [];
  const gatewayReads = f.makeReads(true, undefined, gatewayCalls), signerReads = f.makeReads(true, undefined, signerCalls);
  await Promise.all(Array.from({ length: 8 }, () => gatewayReads.financialChainAnchor({ at: f.at, prior: f.old })));
  const transitions = [f.refund(reservation.id)];
  const gateway = await f.build(transitions, gatewayReads), signer = await f.build(transitions, signerReads);
  assert.equal(r.stableJSON(gateway.inputs), r.stableJSON(signer.inputs));
  assert.equal(r.stableJSON(gateway.operations), r.stableJSON(signer.operations));
  await verifyFinancialExecution({ files: [{ ops: gateway.operations, financialOperations: gateway.inputs }],
    reads: signerReads, document: f.document, network, height: f.at.counted, at: f.at });
  assert.equal(gatewayCalls.length, 367); assert.equal(signerCalls.length, 367);
  assert.equal(new Set(gatewayCalls).size, gatewayCalls.length);
  assert.deepEqual(gatewayCalls, signerCalls);
  f.gap(1);
  await gatewayReads.financialChainAnchor({ at: f.at, prior: f.old });
  assert.equal(gatewayCalls.length, 368); assert.equal(gatewayCalls.at(-1), '368');
});

test('the accepted gap cap is inclusive and checked before any archive reads', async t => {
  const f = await fixture(t), reservation = f.reserve(1);
  await f.accept(await f.build([reservation])); f.gap(2); f.fork();
  const calls = [], bounded = f.makeReads(true, { rebaseBatchLimit: 2 }, calls);
  await bounded.financialChainAnchor({ at: f.at, prior: f.old }); assert.equal(calls.length, 3);
  f.gap(1);
  await assert.rejects(bounded.financialChainAnchor({ at: f.at, prior: f.old }), /financial_chain_recovery_required/);
  assert.equal(calls.length, 3);
  const coldCalls = [], cold = f.makeReads(true, { rebaseBatchLimit: 2 }, coldCalls);
  await assert.rejects(cold.financialChainAnchor({ at: f.at, prior: f.old }), /financial_chain_recovery_required/);
  assert.deepEqual(coldCalls, []);
  f.setLast('1026');
  const defaultCalls = [], defaults = f.makeReads(true, undefined, defaultCalls);
  await assert.rejects(defaults.financialChainAnchor({ at: f.at, prior: f.old }), /financial_chain_recovery_required/);
  assert.deepEqual(defaultCalls, []);
});

test('a payment accepted in a later unchanged-anchor batch prevents rebase', async t => {
  const f = await fixture(t), reservation = f.reserve(1), id = reservation.id;
  await f.accept(await f.build([reservation])); f.gap(2);
  const items = [{ key: r.hash('gap-receipt'), fee: r.hash('fee'), amount: '1', total: '1' }];
  const payment = f.source({ type: 'fund', id, items }, { requestId: id, owner: alice.address, terms: reservation.action.terms,
    items, state: 'settled', confirmations: 1 });
  await f.accept(await f.build([payment])); f.fork();
  const calls = [], reads = f.makeReads(true, undefined, calls);
  await assert.rejects(f.build([f.refund(id)], reads), /financial_chain_recovery_required/);
  const checked = calls.length;
  await assert.rejects(f.build([f.refund(id)], reads), /financial_chain_recovery_required/);
  assert.equal(calls.length, checked, 'immutable unsafe evidence is not scanned again');
});

test('raw payment effects and financial account actions cannot hide in a game-only gap', async t => {
  for (const operation of [{ op: 'fp', v: 2, type: 'page', id: r.hash('hidden-payment') },
    ...['reserve-n', 'consume', 'release-many', 'refund', 'unknown'].map(type => ({ op: 'ar', v: 2, actions: [{ type }] }))]) {
    const f = await fixture(t), reservation = f.reserve(1);
    await f.accept(await f.build([reservation])); f.gap(1, [{ ops: [operation] }]); f.fork();
    await assert.rejects(f.build([f.refund(reservation.id)]), /financial_chain_recovery_required/);
  }
});

test('a cached safe gap still authenticates newly accepted batches and refuses an unsafe extension', async t => {
  const f = await fixture(t), reservation = f.reserve(1);
  await f.accept(await f.build([reservation])); f.gap(2); f.fork();
  const calls = [], reads = f.makeReads(true, undefined, calls);
  await reads.financialChainAnchor({ at: f.at, prior: f.old });
  f.gap(1, [{ ops: [{ op: 'ar', v: 2, actions: [{ type: 'consume' }] }] }]);
  await assert.rejects(reads.financialChainAnchor({ at: f.at, prior: f.old }), /financial_chain_recovery_required/);
  assert.deepEqual(calls, ['1', '2', '3', '4']);
});

test('unauthenticated archives never enter the cached accepted-gap proof', async t => {
  const f = await fixture(t), reservation = f.reserve(1);
  await f.accept(await f.build([reservation])); f.gap(2); f.fork();
  const batch = f.batches.get('2'), original = structuredClone(batch.files);
  batch.files[0].ops = [];
  const calls = [], reads = f.makeReads(true, undefined, calls);
  await assert.rejects(reads.financialChainAnchor({ at: f.at, prior: f.old }), /financial_chain_recovery_required/);
  batch.files = original;
  await reads.financialChainAnchor({ at: f.at, prior: f.old });
  assert.deepEqual(calls, ['1', '2', '2', '3']);
});

test('reservation custody terms contain no settled money, while funded custody evidence remains refused', async t => {
  const f = await fixture(t), built = await f.build([f.reserve(1)]), input = structuredClone(built.inputs[0]);
  const role = 'finder', requestId = input.transition.id;
  input.evidence.custody = [{ id: r.hashObject(['dmw-beneficiary-credit-v2', requestId, role]), requestId, role,
    owner: alice.address, rail: 'tap', custodian: 'fixture-custodian', amount: '5' }];
  assert.equal(moneyFreeFinancialInput(input), true);
  input.evidence.custody[0].state = 'claimable';
  assert.equal(moneyFreeFinancialInput(input), false);
  delete input.evidence.custody[0].state;
  input.evidence.custody[0].paymentKey = r.hash('custody-payment');
  assert.equal(moneyFreeFinancialInput(input), false);
});

for (const type of ['deployment-open', 'deployment-add']) test(`${type} at the origin rebases only after an independently canonical reveal`, async t => {
  const f = await fixture(t);
  if (type === 'deployment-add') f.setStamp({ counted: '1000000' });
  const transition = f.deployment(type), origin = await f.build([transition]);
  assert.equal(moneyFreeFinancialInput(origin.inputs[0]), false, 'accepted confirmations are not current inclusion proof');
  assert.equal(moneyFreeFinancialInput(origin.inputs[0], transition.action.deployment), true);
  const paid = structuredClone(origin.inputs[0]); paid.evidence.receipt = r.hash('payment-receipt');
  assert.equal(moneyFreeFinancialInput(paid, transition.action.deployment), false);
  await f.accept(origin); f.fork();
  const gatewayCalls = [], signerCalls = [], archives = [];
  const gatewayReads = f.makeReads(true, undefined, archives, gatewayCalls), signerReads = f.makeReads(true, undefined, [], signerCalls);
  await Promise.all(Array.from({ length: 8 }, () => gatewayReads.financialChainAnchor({ at: f.at, prior: f.old })));
  const transitions = [f.reserve(1)], gateway = await f.build(transitions, gatewayReads), signer = await f.build(transitions, signerReads);
  assert.equal(r.stableJSON(gateway.inputs), r.stableJSON(signer.inputs));
  assert.equal(r.stableJSON(gateway.operations), r.stableJSON(signer.operations));
  await verifyFinancialExecution({ files: [{ ops: gateway.operations, financialOperations: gateway.inputs }],
    reads: signerReads, document: f.document, network, height: f.at.counted, at: f.at });
  assert.deepEqual(gatewayCalls, [transition.action.deployment]); assert.deepEqual(signerCalls, gatewayCalls);
  assert.deepEqual(archives, ['1']);
  await f.accept(gateway);
});

test('orphaned, unavailable, missing, unconfirmed and future deployment reveals stay refused', async t => {
  for (const failure of ['orphan', 'unavailable', 'missing', 'unconfirmed', 'future', 'wrong-transaction']) {
    const f = await fixture(t), transition = f.deployment(), id = transition.action.deployment;
    await f.accept(await f.build([transition])); f.fork();
    const inclusion = f.reveals.get(id);
    if (failure === 'orphan') inclusion.blockHash = f.old.bitcoin.hash;
    if (failure === 'unavailable') f.reveals.set(id, Error('source_unavailable'));
    if (failure === 'missing') f.reveals.delete(id);
    if (failure === 'unconfirmed') inclusion.confirmations = '0';
    if (failure === 'future') inclusion.height = '13';
    if (failure === 'wrong-transaction') inclusion.tx.txid = r.hash('unrelated-reveal');
    for (const reads of [f.makeReads(), f.makeReads()])
      await assert.rejects(reads.financialChainAnchor({ at: f.at, prior: f.old }), /financial_chain_recovery_required/, failure);
  }
});

test('a deployment in the accepted gap retries an unavailable source without rereading accepted files', async t => {
  const f = await fixture(t);
  await f.accept(await f.build([f.reserve(1)]));
  const transition = f.deployment(), id = transition.action.deployment;
  await f.accept(await f.build([transition])); f.fork();
  const inclusion = f.reveals.get(id); f.reveals.set(id, Error('source_unavailable'));
  const archives = [], deployments = [], reads = f.makeReads(true, undefined, archives, deployments);
  await assert.rejects(reads.financialChainAnchor({ at: f.at, prior: f.old }), /financial_chain_recovery_required/);
  f.reveals.set(id, inclusion);
  await reads.financialChainAnchor({ at: f.at, prior: f.old });
  await reads.financialChainAnchor({ at: f.at, prior: f.old });
  assert.deepEqual(archives, ['1', '2']); assert.deepEqual(deployments, [id, id]);
});

test('a cached deployment inclusion must remain in each later canonical stamp', async t => {
  const f = await fixture(t), transition = f.deployment();
  await f.accept(await f.build([transition])); f.fork();
  const deployments = [], reads = f.makeReads(true, undefined, [], deployments);
  await reads.financialChainAnchor({ at: f.at, prior: f.old });
  f.setStamp({ tip: '13', tipHash: f.canonical('13'), counted: '13' });
  await reads.financialChainAnchor({ at: f.at, prior: f.old });
  assert.equal(deployments.length, 1);
  f.canonicalOverrides.set('11', r.hash('replacement-reveal-block'));
  f.canonicalOverrides.set('14', r.hash('replacement-tip'));
  f.setStamp({ tip: '14', tipHash: f.canonical('14'), counted: '14' });
  await assert.rejects(reads.financialChainAnchor({ at: f.at, prior: f.old }), /financial_chain_recovery_required/);
  assert.equal(deployments.length, 1);
});

test('deployment origin, reservation pages and a long game-only suffix share one authenticated rebase proof', async t => {
  const f = await fixture(t), transition = f.deployment();
  const origin = await f.accept(await f.build([transition]));
  assert.deepEqual(origin.ops.map(op => op.action?.type ?? op.type), ['deployment-open', 'checkpoint']);
  assert.equal(origin.ops.at(-1).previous, r.hashObject(f.common));
  const winners = Array.from({ length: 4 }, (_, i) => ({ winner: i ? r.hash('claim-winner/' + i) : alice.address,
    asset: transition.action.asset, count: i ? '1' : '100' }));
  const credits = winners.map(w => ({ op: 'ac', to: w.winner, assets: [[w.asset, w.count]] })), reservation = f.reserve(1, transition);
  const reserved = await f.accept(await f.build([reservation], undefined, { credits }), undefined, { settlements: [{ winners }] });
  assert.equal(reserved.ops[0].actions.filter(a => a.type === 'credits').length, 4);
  assert.deepEqual(reserved.ops.slice(1).map(op => op.op === 'ar' ? op.actions[0].type : op.action?.type ?? op.type),
    ['reserve-n', 'open', 'capacity-reserve', 'checkpoint']);
  f.gap(4);
  // A grouped reservation's tail has only its financial page and capacity
  // effects. The archive proof must inspect those even without an account op.
  const grouped = await f.build([f.reserve(2, transition), f.reserve(3, transition)]), tail = grouped.inputs[1];
  assert.deepEqual(tail.operations.map(op => op.action?.type ?? op.type), ['open', 'capacity-reserve', 'checkpoint']);
  f.gap(1, [{ ops: tail.operations, financialOperations: [tail] }]);
  f.gap(366); f.fork();
  assert.deepEqual(f.store.get('financialRecordProvenance', 'fp/chain'), { n: '1', file: 0, index: 0 });
  const archives = [], gatewayCalls = [], signerCalls = [];
  const gatewayReads = f.makeReads(true, undefined, archives, gatewayCalls), signerReads = f.makeReads(true, undefined, [], signerCalls);
  const transitions = [f.refund(reservation.id)], gateway = await f.build(transitions, gatewayReads), signer = await f.build(transitions, signerReads);
  assert.equal(r.stableJSON(gateway.inputs), r.stableJSON(signer.inputs));
  assert.equal(r.stableJSON(gateway.operations), r.stableJSON(signer.operations));
  await verifyFinancialExecution({ files: [{ ops: gateway.operations, financialOperations: gateway.inputs }],
    reads: signerReads, document: f.document, network, height: f.at.counted, at: f.at });
  await gatewayReads.financialChainAnchor({ at: f.at, prior: f.old });
  assert.equal(archives.length, 373); assert.equal(new Set(archives).size, 373);
  assert.deepEqual(gatewayCalls, [transition.action.deployment]); assert.deepEqual(signerCalls, gatewayCalls);
});
