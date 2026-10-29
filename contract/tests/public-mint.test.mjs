import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPublicScan, publicScanKey, publicRefundKey } from '../public-mint.js';
import { capacityKey, plotKey } from '../financial-capacity.js';
import { hashObject, hash } from '../../rules/src/core.js';
import { publicPlotId } from '../../rules/src/public-mint.js';

const asset = 'p2:7', block = '12', deployment = hash('deployment') + 'i0', generation = hash('generation');
function fixture() {
  const db = new Map([['fd/asset/' + asset, generation], ['fd/' + generation, { asset, deployment, minted: '0', reserved: '0', maximum: '20' }]]);
  return { db, store: { get: async k => db.get(k), put: (k, v) => db.set(k, v) },
    context: { height: '110', settings: { publicMintActivationHeight: '100', publicMintPageSize: 50, paymentPage: 16 } } };
}
function payment(n, height = '100', complete = true) {
  const id = hash('request' + n), tapAddress = 'wallet' + n, amount = '2';
  return { id, asset, block, tapAddress, reference: hash('payment' + n) + 'i0', height, transactionIndex: String(n), inscriptionIndex: '0', complete,
    fees: [{ amount: '10' }], paymentHash: hash('paid' + n), permitHash: hash('permit' + n),
    source: { publicMint: true, requestId: id, asset, amount, request: { asset, block, amount }, payer: tapAddress, receiver: tapAddress,
      deployment: { id: deployment }, generation, fees: [{ key: hash('fee'), amount: '10' }],
      capacity: { deployment, asset, block, amount, remaining: '20', limit: '0' } } };
}
function scan(f, payments, nextHeight = '101') {
  const id = publicPlotId(asset, block), old = f.db.get(publicScanKey(id));
  return { id, asset, block, previous: hashObject(old ?? null), start: '100',
    from: old?.next ?? { height: '100', transactionIndex: '0', inscriptionIndex: '0' },
    next: { height: nextHeight, transactionIndex: '0', inscriptionIndex: '0' }, blockHash: hash('block' + nextHeight), payments };
}
test('public settlement gates activation and rejects stale, reordered and skipped predecessors atomically', async () => {
  const f = fixture(), op = scan(f, [payment(1), payment(2)]), before = [...f.db];
  await assert.rejects(applyPublicScan(f.store, op, { ...f.context, height: '99' }), /public_mint_inactive/);
  await assert.rejects(applyPublicScan(f.store, op, { height: '9999', settings: { paymentPage: 16 } }), /public_mint_inactive/);
  await assert.rejects(applyPublicScan(f.store, { ...op, previous: hash('wrong') }, f.context), /public_scan_sequence/);
  await assert.rejects(applyPublicScan(f.store, { ...op, payments: op.payments.toReversed() }, f.context), /public_scan_payments/);
  await assert.rejects(applyPublicScan(f.store, { ...op, from: { ...op.from, transactionIndex: '1' } }, f.context), /public_scan_sequence/);
  assert.deepEqual([...f.db], before);
});
test('two complete payments issue exactly one permanent capacity and record the loser refund', async () => {
  const f = fixture(), a = payment(1), b = payment(2), op = scan(f, [a, b]);
  await applyPublicScan(f.store, op, f.context);
  assert.equal(f.db.get(publicScanKey(op.id)).winner.id, a.id);
  assert.equal(f.db.get('fp/' + a.id).state, 'consumed'); assert.equal(f.db.has('fp/' + b.id), false);
  assert.equal(f.db.get('dc/plot/' + asset + '/' + block), a.id);
  assert.deepEqual(f.db.get(plotKey(asset, block)), { id: a.id, state: 'reserved' });
  assert.equal(f.db.get(capacityKey(deployment)), '2'); assert.equal(f.db.get('fd/' + generation).reserved, '2');
  assert.equal(f.db.get(publicRefundKey(b)).reason, 'someone_paid_first');
  assert.equal([...f.db.keys()].some(k => k.startsWith('ao/') || k.startsWith('ar/')), false);
  const before = [...f.db]; await assert.rejects(applyPublicScan(f.store, op, f.context), /public_scan_sequence/);
  assert.deepEqual([...f.db], before);
});
test('later confirmed payments and repeated checkout payments refund without changing the winner', async () => {
  const f = fixture(), a = payment(1); await applyPublicScan(f.store, scan(f, [a]), f.context);
  const late = { ...payment(3, '101'), id: a.id }, other = payment(4, '101');
  await applyPublicScan(f.store, scan(f, [late, other], '102'), f.context);
  assert.equal(f.db.get(publicScanKey(publicPlotId(asset, block))).winner.reference, a.reference);
  assert.equal(f.db.get(publicRefundKey(late)).state, 'owed'); assert.equal(f.db.get(publicRefundKey(other)).state, 'owed');
  assert.equal(f.db.get(capacityKey(deployment)), '2');
});
test('partial payment refunds without taking the block from a later complete payment', async () => {
  const f = fixture(), partial = payment(1, '100', false), full = payment(2);
  await applyPublicScan(f.store, scan(f, [partial, full]), f.context);
  assert.equal(f.db.get(publicRefundKey(partial)).reason, 'public_payment_incomplete');
  assert.equal(f.db.get(publicScanKey(publicPlotId(asset, block))).winner.id, full.id);
});
test('capacity collision or late validation failure leaves every financial record untouched', async () => {
  const f = fixture(), a = payment(1), op = scan(f, [a]);
  f.db.set(plotKey(asset, block), { id: hash('existing'), state: 'reserved' });
  let before = [...f.db]; await assert.rejects(applyPublicScan(f.store, op, f.context), /financial_plot_reserved/);
  assert.deepEqual([...f.db], before);
  f.db.delete(plotKey(asset, block)); f.db.set('fd/' + generation, { ...f.db.get('fd/' + generation), maximum: '1' });
  before = [...f.db]; await assert.rejects(applyPublicScan(f.store, op, f.context), /financial_capacity/);
  assert.deepEqual([...f.db], before);
});

test('active agent-first scans refund complete and partial payments without issuing capacity or a public plot', async () => {
  const f = fixture(); f.context.settings.claimsNeverCloseHeight = '110';
  const a = payment(1), b = payment(2, '100', false), op = { ...scan(f, [a, b]), claim: { pattern: '7', claimed: true, publicWinner: null } };
  await applyPublicScan(f.store, op, f.context);
  assert.equal(f.db.get(publicScanKey(op.id)).winner, null);
  for (const p of [a, b]) assert.equal(f.db.get(publicRefundKey(p)).reason, 'claimed_first');
  assert.equal(f.db.has('dc/plot/' + asset + '/' + block), false);
  assert.equal(f.db.has('fp/' + a.id), false); assert.equal(f.db.has(capacityKey(deployment)), false);
  assert.equal(f.db.get('fd/' + generation).reserved, '0');
});

test('active public winner is permanent and later scans must bind its accepted predecessor', async () => {
  const f = fixture(); f.context.settings.claimsNeverCloseHeight = '110';
  const a = payment(1), op = { ...scan(f, [a]), claim: { pattern: '7', claimed: false, publicWinner: null } };
  await applyPublicScan(f.store, op, f.context);
  assert.equal(f.db.get('fp/' + a.id).owner, null);
  const late = { ...scan(f, [payment(2, '101')], '102'), claim: { ...op.claim, publicWinner: a.id } };
  const before = [...f.db];
  await assert.rejects(applyPublicScan(f.store, { ...late, claim: op.claim }, f.context), /public_claim_predecessor/);
  assert.deepEqual([...f.db], before);
  await applyPublicScan(f.store, late, f.context);
  assert.equal(f.db.get(publicScanKey(op.id)).winner.id, a.id);
  assert.equal(f.db.get(publicRefundKey(payment(2, '101'))).reason, 'someone_paid_first');
});

test('claim decisions are mandatory and identity-bound only at the new activation height', async () => {
  const f = fixture(); f.context.settings.claimsNeverCloseHeight = '110';
  const op = scan(f, [payment(1)]), before = [...f.db];
  await assert.rejects(applyPublicScan(f.store, op, f.context), /public_claim_binding/);
  await assert.rejects(applyPublicScan(f.store, { ...op, claim: { pattern: '8', claimed: false, publicWinner: null } }, f.context), /public_claim_binding/);
  assert.deepEqual([...f.db], before);
  await applyPublicScan(f.store, op, { ...f.context, height: '109' });
  assert.equal(f.db.get(publicScanKey(op.id)).winner.id, payment(1).id);
});
