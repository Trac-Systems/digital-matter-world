import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { Store } from '../src/store.mjs';
import { AccountExecution } from '../src/account-batch.mjs';
import { buildFinancialExecution, FinancialExecution } from '../src/financial-execution.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { accountActionDigest, reserveNonceDigest } from '../../contract/root-accounts.js';
import { applyRootAccounts } from '../../contract/root-accounts.js';
import { applyPaymentPage, surplusCreditId, paymentCreditDigest } from '../../contract/payment-pages.js';
import { accountKey, readAccountLeaf } from '../../contract/account-tree.js';
import { AccountAvailability } from '../src/account-availability.mjs';
import { rules as r } from '../src/rules.mjs';
import { alice, bob, nonce } from '../../contract/tests/helpers/harness.mjs';
import { temp, network } from './helpers.mjs';

async function fixture(t) {
  const store = await Store.open(await temp('g3-financial-')); t.after(() => store.close());
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '10', values: { ...r.SETTINGS_PROFILE, paymentPage: 16 } });
  const seed = new AccountExecution({ store, document, height: 10 });
  await seed.accounts([{ type: 'credit', owner: alice.address, asset: 'p2:0', amount: '100' }]); await store.transact(seed.result().writes);
  const sources = new Map(), reads = { financialRecord: async key => store.get('accountRecords', key),
    financialEvidence: async transition => { const row = sources.get(r.hashObject(transition)); if (row instanceof Error) throw row; assert.ok(row, 'independent source fixture exists'); return structuredClone(row); } };
  const execute = async transitions => {
    const result = await buildFinancialExecution({ store, transitions, reads, document, height: 10 });
    await verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads, document, network, height: 10 });
    // Re-run exactly the same operations through the contract implementations.
    const changed = new Map(), adapter = { get: async key => changed.get(key) ?? reads.financialRecord(key), put: (key, value) => changed.set(key, value) };
    for (const op of result.operations) await (op.op === 'ar' ? applyRootAccounts : applyPaymentPage)(adapter, op, { network, height: 10, settings: { paymentPage: 16 } });
    for (const row of result.writes.filter(w => w.space === 'accountRecords')) assert.deepEqual(row.value, changed.get(row.id));
    await store.transact(result.writes);
    const projection = store.get('publicBalances', alice.address + '/p2:0');
    const record = store.get('accountRecords', 'ar/' + alice.address), key = accountKey('balance', 'p2:0');
    const leaf = readAccountLeaf(record.root, new AccountAvailability(store).prove(record.root, [key]), key);
    assert.deepEqual({ available: projection.amount, held: projection.held }, leaf);
    assert.deepEqual(store.get('publicBalanceHeads', alice.address), record);
    return result;
  };
  const source = (transition, evidence) => { sources.set(r.hashObject(transition), evidence); return transition; };
  const reserve = (n, fees = [{ key: nonce(500), amount: '65' }], parallel = false, amount = '7') => {
    const id = nonce(n), evidence = { owner: alice.address, asset: 'p2:0', amount, fees };
    const action = { type: 'reserve', owner: alice.address, asset: evidence.asset, amount: evidence.amount, id, terms: r.hashObject(evidence),
      revision: store.get('accountRecords', 'ar/' + alice.address).revision, nonce: nonce(n + 1000), until: 20 };
    if (parallel) { action.type = 'reserve-n'; delete action.revision; }
    action.sig = Buffer.from(ed25519.sign((parallel ? reserveNonceDigest : accountActionDigest)(network, action), alice.secret)).toString('hex');
    return source({ type: 'reserve', id, action, fees }, evidence);
  };
  const evidence = (id, fields) => ({ requestId: id, owner: alice.address, terms: store.get('accountRecords', 'fp/' + id).terms, ...fields });
  const balance = () => {
    const root = store.get('accountRecords', 'ar/' + alice.address).root, key = accountKey('balance', 'p2:0');
    return readAccountLeaf(root, new AccountAvailability(store).prove(root, [key]), key);
  };
  return { store, document, reads, execute, source, reserve, evidence, balance };
}

test('v2 financial execution reserves, funds 65 fragments, consumes and preserves surplus', async t => {
  const f = await fixture(t), reserve = f.reserve(1), id = reserve.id;
  await f.execute([reserve]); assert.deepEqual(f.balance(), { available: '93', held: '7' });
  for (let i = 0; i < 65; i += 16) {
    const items = Array.from({ length: Math.min(16, 65 - i) }, (_, j) => ({ key: nonce(i + j + 100), fee: nonce(500), total: '1', amount: '1' }));
    await f.execute([f.source({ type: 'fund', id, items }, f.evidence(id, { items, state: 'settled', confirmations: 1 }))]);
  }
  const consume = f.source({ type: 'consume', id, permitHash: nonce(900) }, f.evidence(id, { state: 'authorized', permitHash: nonce(900), fundingRoot: f.store.get('accountRecords', 'fp/' + id).root }));
  await f.execute([consume]); assert.deepEqual(f.balance(), { available: '93', held: '0' });
  assert.equal(f.store.get('accountRecords', 'ao/' + id).permitHash, nonce(900));
  await assert.rejects(f.execute([consume]), /financial_obligation/);
  for (let i = 0; i < 2; i++) {
    const sequence = f.store.get('accountRecords', 'fp/' + id).sequence;
    const items = [{ key: nonce(950 + i), fee: nonce(500), total: '3', amount: '3' }];
    const transition = f.source({ type: 'surplus', id, items }, f.evidence(id, { items, state: 'settled', confirmations: 1 }));
    await f.execute([transition]);
    const credit = surplusCreditId(id, sequence);
    assert.equal(f.store.get('accountRecords', 'fc/' + credit).fees[0].amount, '3');
    const transfer = { op: 'fp', v: 2, type: 'transfer', id: credit, credit, revision: '0', to: bob.address, until: 20 };
    transfer.sig = Buffer.from(ed25519.sign(paymentCreditDigest(network, transfer), alice.secret)).toString('hex');
    const execution = new AccountExecution({ store: f.store, document: f.document, height: 10 });
    await execution.payment(transfer); await f.store.transact(execution.result().writes);
    assert.equal(f.store.get('accountRecords', 'fc/' + credit).owner, bob.address);
    await assert.rejects(f.execute([transition]), /funding_reused/);
  }
  const root = f.store.get('accountRecords', 'ar/supply').root, key = accountKey('supply', 'p2:0');
  assert.deepEqual(readAccountLeaf(root, new AccountAvailability(f.store).prove(root, [key]), key), { issued: '100', burned: '7' });
  assert.equal(f.store.get('publicSummaries', 'outstandingSupply').matter, '93');
  assert.equal(f.store.get('publicSupply', 'p2:0').burned, '7');
});

test('verified escrow refund releases reserved units once without also issuing fee credits', async t => {
  const f = await fixture(t), reserve = f.reserve(2); await f.execute([reserve]);
  const transition = f.source({ type: 'refund', id: reserve.id, reason: 'ethereum_refund' }, f.evidence(reserve.id,
    { state: 'ethereum_refund', rail: 'ethereum', status: 3, confirmations: 1, domain: { chainId: '31337', address: 'test escrow' }, payer: 'test payer' }));
  await f.execute([transition]); assert.deepEqual(f.balance(), { available: '100', held: '0' });
  assert.equal(f.store.get('accountRecords', 'fp/' + reserve.id).state, 'refunded');
  assert.equal(f.store.get('accountRecords', 'fc/' + reserve.id), null);
  await assert.rejects(f.execute([transition]), /financial_obligation/);
});

test('settled partial payment exits as a credit; a false external refund cannot erase allocations', async t => {
  const f = await fixture(t), reserve = f.reserve(3), id = reserve.id; await f.execute([reserve]);
  const items = [{ key: nonce(200), fee: nonce(500), total: '2', amount: '2' }];
  await f.execute([f.source({ type: 'fund', id, items }, f.evidence(id, { items, state: 'settled', confirmations: 1 }))]);
  const refund = f.source({ type: 'refund', id, reason: 'ethereum_refund' }, f.evidence(id,
    { state: 'ethereum_refund', rail: 'ethereum', status: 3, confirmations: 1, domain: {}, payer: 'payer' }));
  await assert.rejects(f.execute([refund]), /funding_refund/);
  assert.deepEqual(f.balance(), { available: '93', held: '7' });
  await f.execute([f.source({ type: 'refund', id, reason: 'credit' }, f.evidence(id, { state: 'credit', expiry: 9 }))]);
  assert.deepEqual(f.balance(), { available: '100', held: '0' });
  assert.equal(f.store.get('accountRecords', 'fc/' + id).fees[0].amount, '2');
  const sequence = f.store.get('accountRecords', 'fp/' + id).sequence, terminalRoot = f.store.get('accountRecords', 'fp/' + id).terminalRoot;
  const late = [{ key: nonce(202), fee: nonce(500), total: '3', amount: '3' }];
  await f.execute([f.source({ type: 'surplus', id, items: late }, f.evidence(id, { items: late, state: 'settled', confirmations: 1 }))]);
  assert.equal(f.store.get('accountRecords', 'fc/' + surplusCreditId(id, sequence)).fees[0].amount, '3');
  assert.equal(f.store.get('accountRecords', 'fp/' + id).terminalRoot, terminalRoot);
  assert.equal(f.store.get('accountRecords', 'fc/' + id).fees[0].amount, '2');
});

test('mempool evidence, source replacement, injected credits and stale proofs fail independently', async t => {
  const f = await fixture(t), reserve = f.reserve(4), id = reserve.id; await f.execute([reserve]);
  const items = [{ key: nonce(201), fee: nonce(500), total: '1', amount: '1' }], transition = { type: 'fund', id, items };
  f.source(transition, f.evidence(id, { items, state: 'settled', confirmations: 0 }));
  await assert.rejects(f.execute([transition]), /financial_payment_unsettled/);
  f.source(transition, f.evidence(id, { items, state: 'settled', confirmations: 1 }));
  const result = await buildFinancialExecution({ store: f.store, transitions: [transition], reads: f.reads, document: f.document, height: 10 });
  const file = { ops: result.operations, financialOperations: result.inputs };
  const verify = files => verifyFinancialExecution({ files, reads: f.reads, document: f.document, network, height: 10 });
  const changed = structuredClone(file); changed.financialOperations[0].evidence.confirmations = 10;
  await assert.rejects(verify([changed]), /financial_evidence_read/);
  const injected = structuredClone(file); injected.financialOperations[0].operations.push({ op: 'ar', actions: [{ type: 'credit', owner: alice.address, asset: 'p2:0', amount: '999' }] });
  await assert.rejects(verify([injected]), /financial_effects|financial_operation_binding/);
  await f.execute([transition]); await assert.rejects(verify([file]), /funding_sequence|funding_revision|funding_reused/);
  await assert.rejects(verifyFinancialExecution({ files: [file], reads: {}, document: f.document, network, height: 10 }), /financial_source_adapter_required/);
});

test('deferred source failures preserve queued identities and allow another request to execute', async t => {
  const f = await fixture(t), a = f.reserve(5), b = f.reserve(6);
  f.source(a, Error('source_unavailable'));
  const queue = new FinancialExecution({ store: f.store, reads: f.reads, document: f.document, resources: { mintInputCapacity: 20, workPage: 16 } });
  const first = await queue.submit(a); await queue.submit(b); assert.deepEqual(await queue.submit(a), first);
  const built = await queue.build({ height: 10 }); assert.equal(built.inputs.length, 1); assert.equal(built.inputs[0].transition.id, b.id);
  assert.equal(f.store.count('financialQueue'), 2); assert.equal(f.store.count('financialDeferred'), 1);
  assert.equal(f.store.get('accountRecords', 'ao/' + b.id), null, 'unaccepted draft never publishes account state');
});

test('financial prefix binds derived claim credits and signed crafts before sequential reservations', async t => {
  const f = await fixture(t), compound = 'c2:' + r.hash('mg1-compound');
  const sign = action => ({ ...action, sig: Buffer.from(ed25519.sign(accountActionDigest(network, action), alice.secret)).toString('hex') });
  const craft = { action: sign({ type: 'craft', owner: alice.address, revision: '1', nonce: nonce(3000), until: 20,
    in: [['p2:0', '1'], ['p2:1', '1']], out: [[compound, '1']], compound: compound.slice(3) }) };
  const reservation = f.reserve(7), evidence = await f.reads.financialEvidence(reservation);
  // The prefix advances this same owner's account before the reservation.
  reservation.action = sign({ ...reservation.action, revision: '2' });
  f.source(reservation, evidence);
  const credits = [{ op: 'ac', to: alice.address, assets: [['p2:1', '3']] }];
  const before = f.store.get('accountRecords', 'ar/' + alice.address);
  const result = await buildFinancialExecution({ store: f.store, credits, crafts: [craft], transitions: [reservation],
    reads: f.reads, document: f.document, height: 10 });
  const file = { ops: result.operations, financialOperations: result.inputs, crafts: structuredClone([craft]),
    settlements: [{ winners: [{ winner: alice.address, asset: 'p2:1', count: '3' }] }] };
  const verify = value => verifyFinancialExecution({ files: [value], reads: f.reads, document: f.document, network, height: 10 });
  await verify(file);
  assert.deepEqual(f.store.get('accountRecords', 'ar/' + alice.address), before, 'building and verifying publish no state');
  for (const alter of [
    value => { value.crafts = []; },
    value => { value.ops[0].actions[1].out[0][1] = '99'; },
    value => { value.ops[0].actions[0].assets[0][1] = '999'; },
    value => { value.ops[0].actions.reverse(); },
    value => { value.ops[0].actions.push(sign({ type: 'transfer', owner: alice.address, revision: '1', nonce: nonce(3001),
      until: 20, to: bob.address, asset: 'p2:0', amount: '1' })); },
  ]) {
    const changed = structuredClone(file); alter(changed);
    await assert.rejects(verify(changed), /account_credit_derivation/);
  }
  await f.store.transact(result.writes);
  assert.deepEqual(f.balance(), { available: '92', held: '7' });
  assert.equal(f.store.get('accountRecords', 'ar/' + alice.address).revision, '3');
  assert.equal(f.store.get('accountRecords', 'ao/' + reservation.id).state, 'reserved');
});

test('a financial attempt deferred after execution leaves no public balance or supply writes', async t => {
  const f = await fixture(t), transition = f.reserve(50);
  const result = await buildFinancialExecution({ store: f.store, reads: f.reads, document: f.document, height: 10,
    transitions: [transition], defer: true, priorOperations: Array.from({ length: f.document.values.batchOps }, () => ({})) });
  assert.equal(result.inputs.length, 0); assert.equal(result.deferred[0].reason, 'financial_batch_bytes');
  assert.deepEqual(result.writes, []); assert.deepEqual(result.operations, []);
  assert.deepEqual(f.balance(), { available: '100', held: '0' });
});

test('financial verification derives transfers together with claim credits and crafts before a reservation', async t => {
  const f = await fixture(t), compound = 'c2:' + r.hash('transfer-financial-compound');
  const document = r.settingsRevision({ network, previous: f.document, effectiveBatch: '2', effectiveBitcoinWindow: '10',
    values: { ...f.document.values, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '10' } });
  const sign = action => ({ ...action, sig: Buffer.from(ed25519.sign(accountActionDigest(network, action), alice.secret)).toString('hex') });
  const craft = { action: sign({ type: 'craft', owner: alice.address, revision: '1', nonce: nonce(4100), until: '20',
    in: [['p2:0', '1'], ['p2:1', '1']], out: [[compound, '1']], compound: compound.slice(3) }) };
  const transfer = { action: sign({ type: 'transfer', owner: alice.address, to: bob.address, asset: 'p2:0', amount: '1',
    revision: '1', nonce: nonce(4101), until: '20' }) };
  const reservation = f.reserve(4102), evidence = await f.reads.financialEvidence(reservation);
  reservation.action = sign({ ...reservation.action, revision: '2', until: '20' }); f.source(reservation, evidence);
  const credits = [{ op: 'ac', to: alice.address, assets: [['p2:1', '3']] }];
  const result = await buildFinancialExecution({ store: f.store, credits, crafts: [craft], transfers: [transfer], transitions: [reservation],
    reads: f.reads, document, height: '10' });
  const file = { ops: result.operations, financialOperations: result.inputs, crafts: structuredClone([craft]), transfers: structuredClone([transfer]),
    settlements: [{ winners: [{ winner: alice.address, asset: 'p2:1', count: '3' }] }] };
  const verify = value => verifyFinancialExecution({ files: [value], reads: f.reads, document, network, height: '10' });
  await verify(file);
  for (const alter of [value => { delete value.transfers; }, value => { value.transfers[0].action.to = alice.address; },
    value => { value.ops[0].actions.reverse(); }, value => { value.ops[0].actions.push(transfer.action); }]) {
    const changed = structuredClone(file); alter(changed); await assert.rejects(verify(changed), /account_credit_derivation/);
  }
  await f.store.transact(result.writes);
  assert.deepEqual(f.balance(), { available: '91', held: '7' });
  assert.equal(f.store.get('publicBalances', bob.address + '/p2:0').amount, '1');
  assert.equal(f.store.get('accountRecords', 'ao/' + reservation.id).state, 'reserved');
});

for (const count of [2, 5]) test(`builder, independent signer and contract agree on ${count} merged nonce reservations`, async t => {
  const f = await fixture(t), requests = Array.from({ length: count + 1 }, (_, i) => f.reserve(6000 + i, undefined, true));
  const result = await f.execute(requests.slice(0, count));
  assert.equal(result.operations.filter(op => op.op === 'ar').length, 1);
  assert.equal(result.operations[0].accounts.length, 1);
  assert.equal(result.operations[0].accounts[0].proof.leaves.length, count + 1);
  assert.equal(result.inputs[0].reserveGroup, count);
  assert.equal(f.store.get('accountRecords', 'ar/' + alice.address).revision, '2');
  await f.execute(requests.slice(count));
  assert.deepEqual(f.balance(), { available: String(100 - (count + 1) * 7), held: String((count + 1) * 7) });
});

test('merged reservations defer excess actions to a later batch without resigning', async t => {
  const f = await fixture(t), transitions = Array.from({ length: 5 }, (_, i) => f.reserve(6100 + i, undefined, true));
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '10', values: { ...f.document.values, accountActions: 2 } });
  const first = await buildFinancialExecution({ ...f, document, transitions, height: 10, defer: true });
  assert.equal(first.inputs.length, 2); assert.equal(first.deferred.length, 3);
  assert.ok(first.deferred.every(d => d.reason === 'account_operation'));
  await verifyFinancialExecution({ files: [{ ops: first.operations, financialOperations: first.inputs }], reads: f.reads, document, network, height: 10 });
  await f.store.transact(first.writes);
  const second = await buildFinancialExecution({ ...f, document, transitions: transitions.slice(2), height: 10, defer: true });
  assert.equal(second.inputs.length, 2); assert.equal(second.deferred.length, 1);
  await verifyFinancialExecution({ files: [{ ops: second.operations, financialOperations: second.inputs }], reads: f.reads, document, network, height: 10 });
});

test('merged reserve verification rejects omitted actions, group substitution and changed commitments', async t => {
  const f = await fixture(t), transitions = [f.reserve(6200, undefined, true), f.reserve(6201, undefined, true)];
  const result = await buildFinancialExecution({ ...f, transitions, height: 10 });
  for (const mutate of [
    f => f.financialOperations[0].operations[0].actions.pop(),
    f => { f.financialOperations[0].reserveGroup = 1; },
    f => { f.financialOperations[0].reserveGroup = null; },
    f => { f.financialOperations[1].transition.action.owner = bob.address; },
    f => { f.financialOperations[0].recordCommitments.pop(); },
  ]) {
    const file = structuredClone({ ops: result.operations, financialOperations: result.inputs }); mutate(file);
    file.ops = file.financialOperations.flatMap(i => i.operations);
    await assert.rejects(verifyFinancialExecution({ files: [file], reads: f.reads, document: f.document, network, height: 10 }));
  }
});

test('concurrent admissions cap each owner, hold exact available units and release on accept or expiry', async t => {
  const f = await fixture(t), queue = new FinancialExecution({ ...f, resources: { pendingMintsPerAgent: 3 } });
  const requests = Array.from({ length: 4 }, (_, i) => f.reserve(6300 + i, undefined, true, '30'));
  const admitted = await Promise.all(requests.slice(0, 3).map(t => queue.admit(t, { counted: 10 })));
  assert.equal(f.store.get('financialAdmissionCount', alice.address), 3);
  assert.equal(f.store.get('financialAdmissionHeld', alice.address + '/p2:0'), '90');
  await assert.rejects(queue.admit(requests[3], { counted: 10 }), e => e.status === 409 && e.message === 'financial_owner_fair_share');
  assert.deepEqual(await queue.admit(requests[0], { counted: 10 }), admitted[0]);
  await queue.expire(admitted[0].id, { counted: 21 });
  assert.equal(f.store.get('financialAdmissionHeld', alice.address + '/p2:0'), '60');
  await assert.rejects(queue.admit(f.reserve(6310, undefined, true, '41'), { counted: 10 }), e => e.status === 409 && e.message === 'financial_balance_reserved');
  const result = await queue.build({ height: 10 });
  await f.store.transact([...result.writes, ...queue.acceptedOperations({ proposal: { batch: { n: '1' } }, items: [{ output: { file: { financialOperations: result.inputs } } }] })]);
  assert.equal(f.store.count('financialAdmissionCount'), 0);
  assert.equal(f.store.get('financialAdmissionHeld', alice.address + '/p2:0'), '0');
  assert.equal(f.store.count('financialAdmissionNonce'), 0);
  assert.equal(f.store.count('financialQueue'), 0);
  assert.deepEqual(f.balance(), { available: '40', held: '60' });
});

test('legacy admission lock and pending nonce holds exclude each other', async t => {
  const f = await fixture(t), queue = new FinancialExecution(f), old = f.reserve(6400), next = f.reserve(6401, undefined, true);
  const admitted = await queue.admit(old, { counted: 10 });
  await assert.rejects(queue.admit(next, { counted: 10 }), /financial_account_reserved/);
  await queue.expire(admitted.id, { counted: 21 });
  await queue.admit(next, { counted: 10 });
  await assert.rejects(queue.admit(old, { counted: 10 }), /financial_account_reserved/);
});

for (const limit of ['accountLeaves', 'accountProofBytes', 'batchBytes']) test(`nonce reserve packing respects ${limit} and carries unchanged signatures forward`, async t => {
  const f = await fixture(t), transitions = [f.reserve(6500, undefined, true), f.reserve(6501, undefined, true)];
  const single = await buildFinancialExecution({ ...f, transitions: transitions.slice(0, 1), height: 10 });
  const max = limit === 'accountLeaves' ? 2 : limit === 'accountProofBytes' ? Buffer.byteLength(r.stableJSON(single.operations[0])) :
    Buffer.byteLength(r.stableJSON(single.operations)) + f.document.values.batchEnvelopeReserveBytes;
  const document = r.settingsRevision({ network, effectiveBatch: '1', effectiveBitcoinWindow: '10', values: { ...f.document.values, [limit]: max } });
  const first = await buildFinancialExecution({ ...f, document, transitions, height: 10, defer: true });
  assert.equal(first.inputs.length, 1); assert.equal(first.deferred.length, 1);
  assert.deepEqual(first.inputs[0].transition, transitions[0]);
  await f.store.transact(first.writes);
  // Later batches can have larger proofs as nonce leaves accumulate; normal
  // configured limits admit the original second signed request unchanged.
  const later = await f.execute(transitions.slice(1));
  assert.deepEqual(later.inputs[0].transition, transitions[1]);
});

test('a merged balance underflow or duplicate nonce cannot leave partial effects', async t => {
  const f = await fixture(t), a = f.reserve(6600, undefined, true, '60'), b = f.reserve(6601, undefined, true, '41');
  await assert.rejects(f.execute([a, b]), /account_insufficient/);
  assert.deepEqual(f.balance(), { available: '100', held: '0' });
  const e = await f.reads.financialEvidence(b);
  b.action.nonce = a.action.nonce; b.action.amount = e.amount = '1'; b.action.terms = r.hashObject(e);
  b.action.sig = Buffer.from(ed25519.sign(reserveNonceDigest(network, b.action), alice.secret)).toString('hex'); f.source(b, e);
  await assert.rejects(f.execute([a, b]), /account_replay/);
  assert.deepEqual(f.balance(), { available: '100', held: '0' });
});

test('a failing group extension restores the last verified proof without re-reading unavailable sources', async t => {
  const f = await fixture(t), a = f.reserve(6700, undefined, true), b = f.reserve(6701, undefined, true);
  const evidence = f.reads.financialEvidence; let aReads = 0;
  f.reads.financialEvidence = async transition => {
    if (transition.id === b.id || ++aReads > 1) throw Error('source_unavailable');
    return evidence(transition);
  };
  const result = await buildFinancialExecution({ ...f, transitions: [a, b], height: 10, defer: true });
  assert.equal(result.inputs.length, 1); assert.equal(result.inputs[0].transition.id, a.id);
  assert.equal(result.deferred.length, 1); assert.equal(result.deferred[0].reason, 'source_unavailable');
  f.reads.financialEvidence = evidence;
  await verifyFinancialExecution({ files: [{ ops: result.operations, financialOperations: result.inputs }], reads: f.reads, document: f.document, network, height: 10 });
  await f.store.transact(result.writes);
  assert.deepEqual(f.balance(), { available: '93', held: '7' });
  assert.equal(f.store.get('accountRecords', 'ao/' + b.id), null);
});
