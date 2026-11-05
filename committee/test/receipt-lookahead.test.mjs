import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptFences } from '../signer/receipt-fences.mjs';
import { receiptAdmissionSettings } from '../signer/receipt-settings.mjs';
import { Journal } from '../signer/journal.mjs';
import * as r from '../../rules/src/index.js';
import { ed25519 } from '@noble/curves/ed25519';

async function fixture(t, admission) {
  const root = await mkdtemp(join(tmpdir(), 'receipt-lookahead-'));
  const secret = r.hashBytes('disposable receipt gateway'), gateway = r.bytesToHex(ed25519.getPublicKey(secret));
  const document = r.settingsRevision({ network: 'receipt-test', effectiveBatch: '1', effectiveBitcoinWindow: '0',
    values: { ...r.SETTINGS_PROFILE, puzzleBits: 0, receiptSegmentEntries: 2 } });
  const checkpoint = r.initialClaimSnapshot({ bitcoinAnchor: { height: '100' } }, '100');
  const accepted = { ready: true, settings: document, settingsHash: r.hashObject(document), last: { n: '0' }, claimsRoot: r.claimStateRoot(checkpoint) };
  let journal, fences;
  const reads = { rulesContext: async () => accepted, tip: async () => ({ tip: '100' }), authority: async () => ({ epoch: '0' }) };
  async function reopen() {
    await journal?.close(); journal = await new Journal(join(root, 'receipts.log'), 'disposable', document.network, 'witness').load();
    fences = new ReceiptFences({ journal, reads, network: document.network, gateway, signer: 'witness', secret, admission });
  }
  await reopen();
  t.after(async () => { await journal.close(); await rm(root, { recursive: true }); });
  const receipt = (sequence, batch = '2') => r.signReceiptV2({ v: 2, a: gateway, network: document.network,
    settingsHash: r.hashObject(document), b: '100', t: 'discovery-commit-v2', p: { commitment: r.hash(sequence) } },
  { tip: '100', hash: r.hash('100'), sequence, batch }, secret);
  return { accepted, checkpoint, document, receipt, reads, reopen, get fences() { return fences; }, get journal() { return journal; } };
}

test('a later receipt survives a reserved predecessor and restart without allowing either batch to omit it', async t => {
  const f = await fixture(t), first = f.receipt('1', '1'), later = f.receipt('2');
  await f.fences.admit(first, f.checkpoint);
  await f.journal.reserve(['batch/0/1'], r.hash('batch'), r.hash('session'), { n: '1', epoch: '0', deadline: '106' });
  const vote = await f.fences.admit(later, f.checkpoint);
  await f.reopen(); assert.deepEqual(await f.fences.admit(later, f.checkpoint), vote);
  const files = receipts => [{ receipts, receiptRoot: {} }];
  assert.doesNotThrow(() => f.fences.checkBatch({ n: '1' }, files([first])));
  assert.throws(() => f.fences.checkBatch({ n: '1' }, files([])), /receipt_batch_omission/);
  assert.throws(() => f.fences.checkBatch({ n: '2' }, files([])), /receipt_batch_omission/);
  assert.doesNotThrow(() => f.fences.checkBatch({ n: '2' }, files([later])));
  assert.throws(() => f.fences.checkBatch({ n: '1' }, files([first, f.receipt('3', '1')])), /receipt_batch_order/);
  assert.throws(() => f.fences.checkCutoffBatches('1'), /receipt_future_pending/);
  assert.doesNotThrow(() => f.fences.checkCutoffBatches('2'));
});

test('lookahead rejects excessive distance, capacity, reversed sequence order and reserved target slots', async t => {
  const f = await fixture(t);
  await assert.rejects(f.fences.admit(f.receipt('1', '3'), f.checkpoint), /receipt_admission_predecessor/);
  await assert.rejects(f.fences.admit(f.receipt('3', '1'), f.checkpoint), /receipt_admission_capacity/);
  await assert.rejects(f.fences.admit(f.receipt('5'), f.checkpoint), /receipt_admission_capacity/);
  await f.fences.admit(f.receipt('2'), f.checkpoint);
  await assert.rejects(f.fences.admit(f.receipt('3', '1'), f.checkpoint), /receipt_admission_capacity/);
  await assert.rejects(f.fences.admit(f.receipt('2', '1'), f.checkpoint), /receipt_admission_conflict/);
  await f.fences.admit(f.receipt('3'), f.checkpoint);
  await assert.rejects(f.fences.admit(f.receipt('4'), f.checkpoint), /receipt_admission_capacity/);
  await f.journal.reserve(['batch/0/1'], r.hash('batch'), r.hash('session'), { n: '1', epoch: '0', deadline: '106' });
  await assert.rejects(f.fences.admit(f.receipt('1', '1'), f.checkpoint), /receipt_batch_reserved/);
});

test('later admission requires an unchanged policy and authenticated checkpoint', async t => {
  const f = await fixture(t), receipt = f.receipt('1');
  await assert.rejects(f.fences.admit(receipt), /receipt_admission_checkpoint/);
  f.accepted.scheduledSettings = r.settingsRevision({ network: f.document.network, effectiveBatch: '10', effectiveBitcoinWindow: '110',
    values: f.document.values, previous: f.document });
  await assert.rejects(f.fences.admit(receipt, f.checkpoint), /receipt_policy_boundary/);
  delete f.accepted.scheduledSettings;
  await f.journal.reserve(['batch/0/2'], r.hash('batch'), r.hash('session'), { n: '2', epoch: '0', deadline: '106' });
  await assert.rejects(f.fences.admit(receipt, f.checkpoint), /receipt_batch_reserved/);
});

test('a higher sequence cannot be inserted into a predecessor after later admission', async t => {
  const f = await fixture(t);
  await f.fences.admit(f.receipt('1'), f.checkpoint);
  await assert.rejects(f.fences.admit(f.receipt('2', '1'), f.checkpoint), /receipt_admission_order/);
});

test('operators can disable future admission and invalid settings fail closed', async t => {
  const f = await fixture(t, { futureBatches: 0 });
  await assert.rejects(f.fences.admit(f.receipt('1'), f.checkpoint), /receipt_admission_predecessor/);
  await f.fences.admit(f.receipt('1', '1'), f.checkpoint);
  for (const futureBatches of [-1, 2, 0.5, '1']) assert.throws(() => receiptAdmissionSettings({ futureBatches }), /receipt_admission_setting/);
});

test('future admission reuses matching reads and refreshes a stale accepted checkpoint once', async t => {
  const warm = await fixture(t); let fresh = 0;
  warm.reads.rulesContext.fresh = async () => { fresh++; return warm.accepted; };
  await warm.fences.admit(warm.receipt('1'), warm.checkpoint); assert.equal(fresh, 0);
  const stale = await fixture(t), checkpoint = structuredClone(stale.checkpoint); checkpoint.hot.namedSequence = '1';
  const accepted = { ...stale.accepted, last: { n: '1' }, claimsRoot: r.claimStateRoot(checkpoint) };
  stale.reads.rulesContext.fresh = async () => { fresh++; return accepted; };
  // Snapshot confirmation uses the refreshed source value as well.
  const cached = stale.reads.rulesContext;
  stale.reads.rulesContext = Object.assign(async () => fresh ? accepted : cached(), { fresh: cached.fresh });
  await stale.fences.admit(stale.receipt('2'), checkpoint); assert.equal(fresh, 1);
});
