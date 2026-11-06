import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { PublicMints } from '../src/public-mints.mjs';
import { newStore } from './helpers.mjs';
import { rules } from '../src/rules.mjs';
import { FinancialExecution } from '../src/financial-execution.mjs';
import { publicScanKey } from '../../contract/public-mint.js';
import { KeyedWork } from '../src/keyed-work.mjs';

async function fixture(t, workPage = 2) {
  const store = await newStore();
  t.after(async () => { await store.close(); await rm(store.directory, { recursive: true, force: true }); });
  const parent = { store, resources: { workPage } }, mints = new PublicMints(parent);
  const add = async (id, expiry, block = '1') => {
    const row = { id, publicMint: true, request: { asset: 'p2:0', block }, expiry, paymentIds: [rules.hash(id) + 'i0'], state: 'scanning' };
    await store.transact([{ space: 'mints', id, value: row }, { space: 'publicMintRequests', id, value: true },
      { space: 'publicMintPlots', id: rules.publicPlotId('p2:0', block), value: { asset: 'p2:0', block } }]);
    return row;
  };
  return { store, parent, mints, add };
}
test('expired unpaid checkouts release admission capacity while retaining delayed-payment reconciliation', async t => {
  const f = await fixture(t), expired = await f.add('a', '10'), current = await f.add('b', '11', '2');
  await f.mints.releaseFinishedRequests('11');
  assert.equal(f.store.get('publicMintRequests', 'a'), null);
  assert.equal(f.store.get('publicMintRequests', 'b'), true, 'inclusive last payment block remains open');
  assert.deepEqual(f.store.get('mints', 'a'), expired); assert.deepEqual(f.store.get('mints', 'b'), current);
  assert.equal(f.store.count('publicMintPlots'), 2, 'late and unreported payments remain discoverable');
});
test('bounded checkout cleanup resumes after restart and releases losing checkouts without discarding refunds', async t => {
  const f = await fixture(t, 1);
  await f.add('a', '50'); const loser = await f.add('b', '50', '2'); await f.add('c', '10', '3');
  const refund = { id: 'b', reference: rules.hash('payment') + 'i0', reason: 'someone_paid_first', state: 'owed' };
  await f.store.put('publicMintRefundsByRequest/b', rules.hash('refund'), refund);
  await f.store.put('accountRecords', publicScanKey(rules.publicPlotId('p2:0', '2')), { winner: { id: 'winner' } });
  await f.mints.releaseFinishedRequests('11'); assert.equal(f.store.count('publicMintRequests'), 3);
  const resumed = new PublicMints(f.parent);
  await resumed.releaseFinishedRequests('11'); assert.equal(f.store.get('publicMintRequests', 'b'), null);
  await resumed.releaseFinishedRequests('11'); assert.equal(f.store.get('publicMintRequests', 'c'), null);
  await resumed.releaseFinishedRequests('11'); assert.equal(f.store.get('publicMintRequests', 'a'), true);
  assert.deepEqual(f.store.get('mints', 'b'), loser);
  assert.deepEqual(f.store.list('publicMintRefundsByRequest/b', { limit: 1 })[0].value, refund);
});

test('the permit lane signs accepted public winners page by page and skips issued permits', async t => {
  const f = await fixture(t, 2), signed = [];
  f.parent.document = { values: { publicMintActivationHeight: '100' } };
  f.parent.mintWork = new KeyedWork();
  f.parent.reads = { batchStamp: async () => ({ counted: '103' }) };
  f.parent.committee = { signature: async (key, proposal) => { signed.push(proposal.id);
    return { payload: { prv: { hash: rules.hash('permit/' + proposal.id), address: 'receiver-' + proposal.id } } }; } };
  for (const [id, block] of [['a', '1'], ['b', '2'], ['c', '3']]) {
    const row = await f.add(id, '120', block), plot = rules.publicPlotId('p2:0', block);
    await f.store.transact([{ space: 'mints', id, value: { ...row, receiver: 'receiver-' + id, ...(id === 'b' ? { permit: { issued: true }, state: 'permit_issued' } : {}) } },
      { space: 'publicMintPaidPlots', id: plot, value: { asset: 'p2:0', block, through: '102' } },
      { space: 'accountRecords', id: publicScanKey(plot), value: { winner: { id, permitHash: rules.hash('permit/' + id) } } }]);
  }
  await f.mints.issuePending(); await f.mints.issuePending();
  assert.deepEqual(signed.sort(), ['a', 'c']);
  for (const id of ['a', 'c']) assert.equal(f.store.get('mints', id).state, 'permit_issued');
  await f.mints.issuePending(); await f.mints.issuePending();
  assert.equal(signed.length, 2, 'issued permits are never signed again');
});

test('opaque registration retries are durable, bounded, and continue beyond the first request page', async t => {
  const f = await fixture(t, 1), submitted = [];
  f.parent.document = { values: { publicMintActivationHeight: '100', publicPaymentV2Height: '103', publicMintScanBlocks: 1 } };
  f.parent.financial = { submit: async transition => submitted.push(transition) };
  f.parent.reads = { batchStamp: async () => ({ counted: '103' }), financialRecord: async () => null, publicMintScan: async () => ({}) };
  await f.store.put('meta', 'ruleState', { counted: '103' });
  for (const id of ['a', 'b', 'c']) {
    const row = await f.add(id, '120');
    await f.store.put('mints', id, { ...row, paymentRegistration: { commitment: rules.hash(id) } });
  }
  for (let i = 0; i < 3; i++) await new PublicMints(f.parent).tick();
  assert.deepEqual(submitted.filter(t => t.type === 'public-payment').map(t => t.id), ['a', 'b', 'c'].map(rules.hash));
  assert.ok(submitted.filter(t => t.type === 'public-payment').every(t => t.action === 'register' && !t.intent && !t.asset && !t.block));
});

test('gateway publishes the saved preimage only after the independent reader validates a confirmed reveal', async t => {
  const f = await fixture(t), submitted = [], commitment = rules.hash('commitment'), reference = rules.hash('payment') + 'i0';
  f.parent.document = { values: { publicMintActivationHeight: '100', publicPaymentV2Height: '103', publicMintScanBlocks: 1 } };
  f.parent.financial = { submit: async transition => submitted.push(transition) };
  let confirmed = false, validations = 0;
  f.parent.reads = { batchStamp: async () => ({ counted: '104' }), financialRecord: async () => null,
    publicMintScan: async () => { throw Object.assign(Error('public_payment_unrevealed'), { commitment, reference }); },
    publicMintPayment: async transition => { validations++; assert.equal(transition.reference, reference); if (!confirmed) throw Error('public_payment_unconfirmed'); } };
  await f.store.put('meta', 'ruleState', { counted: '104' });
  const row = await f.add('a', '120'), intent = { asset: 'p2:0', block: '1', paymentSalt: rules.hash('salt') };
  await f.store.put('mints', 'a', { ...row, intent });
  await f.store.put('publicMintCommitments', commitment, 'a');
  await f.mints.queuePlot('p2:0', '1', '104');
  await new PublicMints(f.parent).tick(); assert.equal(submitted.length, 0);
  confirmed = true; await new PublicMints(f.parent).tick();
  assert.equal(validations, 2);
  const plot = rules.publicPlotId('p2:0', '1');
  assert.deepEqual(submitted, [{ type: 'public-payment', id: commitment, action: 'reveal', intent, reference },
    { type: 'public-scan', id: plot, asset: 'p2:0', block: '1', previous: rules.hashObject(null) }], 'the scan joins its reveal in the same batch');
});

test('a queued identical scan step is not read again by every mint tick', async t => {
  const f = await fixture(t); let scans = 0; const queued = new Map(), deferred = [];
  f.parent.document = { values: { publicMintActivationHeight: '100', publicPaymentV2Height: '103', publicMintScanBlocks: 4 } };
  f.parent.financial = { submit: async transition => { queued.set(rules.hashObject(['dmw-financial-transition-v2', transition]), transition); },
    existing: id => queued.has(id) ? { id, state: 'queued' } : null };
  f.parent.reads = { batchStamp: async () => ({ counted: '104' }), financialRecord: async () => null, publicMintScan: async () => { scans++; return {}; } };
  await f.store.put('meta', 'ruleState', { counted: '104' });
  await f.mints.queuePlot('p2:0', '1', '104');
  for (let i = 0; i < 3; i++) await new PublicMints(f.parent).tick();
  assert.equal(scans, 1); assert.equal(queued.size, 1);
  // A queued step that waits on an unrevealed payment is read again, so its reveal is queued.
  const [work] = queued.keys(); await f.store.put('financialDeferred', work, { reason: 'public_payment_unrevealed' });
  await new PublicMints(f.parent).tick(); assert.equal(scans, 2);
});

test('expired opaque registrations release queue capacity while uncertain drafts and paid reveals remain durable', async t => {
  const f = await fixture(t), commitment = rules.hash('registration');
  f.parent.financial = new FinancialExecution({ store: f.store, reads: {}, document: {}, resources: {} });
  const row = { ...await f.add('a', '120'), paymentRegistration: { commitment, validUntil: '120' } };
  await f.store.put('mints', 'a', row);
  const transition = { type: 'public-payment', id: commitment, action: 'register', registration: row.paymentRegistration };
  const work = rules.hashObject(['dmw-financial-transition-v2', transition]);
  await f.store.put('financialQueue', work, transition);
  assert.equal(await f.parent.financial.expire(work, { counted: '120' }), false);
  await f.store.put('meta', 'draft', { proposal: { batch: { ops: [{ op: 'fp', id: commitment }] } } });
  await f.mints.releaseFinishedRequests('121');
  assert.ok(f.store.get('financialQueue', work)); assert.ok(f.store.get('publicMintRequests', 'a'));
  await f.store.transact([{ space: 'meta', id: 'draft' }]);
  await f.mints.releaseFinishedRequests('121');
  assert.equal(f.store.get('financialQueue', work), null); assert.equal(f.store.get('publicMintRequests', 'a'), null);
  assert.deepEqual(f.store.get('mints', 'a'), row, 'the preimage is retained for recovery');
  const reveal = { type: 'public-payment', id: commitment, action: 'reveal', reference: rules.hash('paid') + 'i0', intent: {} };
  const revealWork = rules.hashObject(['dmw-financial-transition-v2', reveal]);
  await f.store.put('financialQueue', revealWork, reveal);
  assert.equal(await f.parent.financial.expire(revealWork, { counted: '9000' }), false);
  assert.deepEqual(f.store.get('financialQueue', revealWork), reveal);
});
