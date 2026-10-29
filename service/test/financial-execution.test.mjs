import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { Store } from '../src/store.mjs';
import { AccountExecution } from '../src/account-batch.mjs';
import { buildFinancialExecution, FinancialExecution } from '../src/financial-execution.mjs';
import { verifyFinancialExecution } from '../../committee/signer/financial-execution.mjs';
import { accountActionDigest } from '../../contract/root-accounts.js';
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
  const reserve = (n, fees = [{ key: nonce(500), amount: '65' }]) => {
    const id = nonce(n), evidence = { owner: alice.address, asset: 'p2:0', amount: '7', fees };
    const action = { type: 'reserve', owner: alice.address, asset: evidence.asset, amount: evidence.amount, id, terms: r.hashObject(evidence),
      revision: store.get('accountRecords', 'ar/' + alice.address).revision, nonce: nonce(n + 1000), until: 20 };
    action.sig = Buffer.from(ed25519.sign(accountActionDigest(network, action), alice.secret)).toString('hex');
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
