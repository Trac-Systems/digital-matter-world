import { BUILD as configuredBuildRoot } from '../../local/common.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { Journal } from '../signer/journal.mjs';
import { preflightBatch } from '../signer/preflight.mjs';
import { fixture, batchFixture } from './fixture.mjs';
import * as rules from '../../rules/src/index.js';
import { harness, alice, bob, committee, deployment, signedBatch, signedRequest, nonce } from '../../contract/tests/helpers/harness.mjs';
import { chain } from '../../contract/tests/helpers/chain.mjs';
import { observationFixture } from '../../rules/test/observation-fixture.mjs';

const root = `${configuredBuildRoot}/target/committee`;
const digest = b => rules.bytesToHex(rules.batchDigest(deployment.network, b));
const details = batch => ({ epoch: batch.epoch, n: batch.n, deadline: batch.deadline, root: batch.root, batch });
const readsFor = h => ({ authority: async () => ({ epoch: await h.state().committeeEpoch() }), batchLast: () => h.state().batchLast(),
  batchRoot: async n => h.db.get('bt/' + n) ?? null, counted: async () => (await h.state().head()).counted });

for (const cause of ['request_expired', 'balance']) test(`signed batch recovers durably after ${cause}, only beyond its deadline`, async () => {
  const h = harness(); await h.mint(['a']); await h.advance(1);
  const op = cause === 'request_expired' ? signedRequest('rq', { owner: alice.address, asset: 'a', amount: '10', receive: nonce(999), nonce: nonce(1), until: 2, expires: 8 }) :
    signedRequest('xc', { owner: alice.address, in: [['a', '100']], out: [['b', '1']], nonce: nonce(1), until: 10000 });
  const batch = signedBatch({ n: 2, from: 2, to: 2, deadline: 8, ops: [op] }), slot = 'batch/0/2';
  assert.equal((await preflightBatch(batch, { counted: 2, last: { n: 1, to: 1 } }, { read: async key => h.db.get(key) ?? null, deployment })).ok, true);
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(root + '/deadline-'), path = directory + '/signed.log';
  let journal = await new Journal(path, 'disposable-test-key', deployment.network, 'test').load();
  try {
    await journal.reserve([slot], digest(batch), 'original', details(batch));
    await journal.append('signed', { session: 'original', digest: digest(batch), signature: batch.sig });
    if (cause === 'request_expired') await h.advance(1);
    else assert.equal(await h.run('tf', { to: bob.address, assets: [['a', '100']] }), null);
    assert.equal(await h.run('bt', batch), cause);
    const replacement = signedBatch({ n: 2, from: 2, to: 9, deadline: 15, ops: [] });
    await assert.rejects(journal.reserve([slot], digest(replacement), 'replacement', details(replacement)), /slot_conflict/);
    await assert.rejects(journal.retireBatch(slot, readsFor(h)), /retirement_unproven/);
    await journal.reserve([slot], digest(batch), 'retry', details(batch));
    await h.advance(8 - (await h.state().head()).counted);
    await assert.rejects(journal.retireBatch(slot, readsFor(h)), /retirement_unproven/);
    await h.advance(1);
    await journal.close(); journal = await new Journal(path, 'disposable-test-key', deployment.network, 'test').load();
    await journal.retireBatch(slot, readsFor(h));
    await journal.close(); journal = await new Journal(path, 'disposable-test-key', deployment.network, 'test').load();
    assert.equal(journal.slots.has(slot), false);
    assert.equal(journal.records.some(r => r.type === 'signed'), true);
    assert.equal(journal.records.find(r => r.type === 'retired-batch').proof.counted, 9);
    await journal.reserve([slot], digest(replacement), 'replacement', details(replacement));
    if (cause === 'balance') assert.equal(await h.run('tf', { to: alice.address, assets: [['a', '100']] }, bob.address), null);
    assert.equal(await h.run('bt', batch), 'batch_deadline');
    assert.equal(await h.run('bt', replacement), null);
    assert.deepEqual(await h.state().batchLast(), { n: 2, to: 9 });
    await assert.rejects(journal.retireBatch(slot, readsFor(h)), /retirement_unproven/);
  } finally { await journal.close(); }
});

test('preflight uses post-header height but refused headers never prove retirement', async () => {
  const h = harness(); await h.advance(1);
  const head = await h.state().head(), parent = await h.state().beacon().raw(head.tip.hash), hx = chain(1, parent);
  const at = { counted: 1, last: { n: 0, to: 0 } }, read = async key => h.db.get(key) ?? null;
  const batch = signedBatch({ n: 1, from: 1, to: 1, deadline: 1, ops: [], hx });
  await assert.rejects(preflightBatch(batch, at, { read, deployment }), /preflight:batch_deadline/);
  assert.equal(await h.run('bt', batch), 'batch_deadline'); assert.equal((await h.state().head()).counted, 1);
  for (const deadline of [2, 38]) assert.equal((await preflightBatch({ ...batch, deadline }, at, { read, deployment })).counted, 2);
  for (const deadline of [undefined, -1, 39]) await assert.rejects(preflightBatch({ ...batch, deadline }, at, { read, deployment }), /preflight:batch_deadline/);
});

test('signing policy independently rejects missing, expired and distant deadlines', async () => {
  const f = fixture(), b = batchFixture(); f.data.counted = b.context.counted; f.reads.batchContext = async () => b.context;
  for (const deadline of [undefined, -1, '100', 94, 132]) await assert.rejects(f.policy.batch({ ...b.proposal, batch: { ...b.proposal.batch, deadline } }), /batch_deadline/);
  for (const deadline of [95, 131]) {
    const approved = await f.policy.batch({ ...b.proposal, batch: { ...b.proposal.batch, deadline } });
    assert.equal(approved.details.deadline, deadline); assert.equal(approved.details.batch.deadline, deadline);
  }
});

test('rules bind a deadline based on application height independently of historical coverage', () => {
  const f = observationFixture({ network: deployment.network, checkpoint: 6, counted: 0, table: [] }); f.add(6, 1);
  const args = { network: deployment.network, epoch: 0, sequence: 1, lastTo: 0, files: f.files, executionHeight: 100 };
  const first = rules.buildBatch(args); assert.equal(first.batch.deadline, 106);
  const next = rules.buildBatch({ ...args, deadline: 107 }); assert.notDeepEqual(first.signingDigest, next.signingDigest);
  for (const executionHeight of [undefined, -1, '100', Number.MAX_SAFE_INTEGER]) assert.throws(() => rules.buildBatch({ ...args, executionHeight }), /batch_deadline/);
  const size = rules.utf8(rules.stableJSON({ ...first.batch, sig: '0'.repeat(128) })).length;
  assert.throws(() => rules.buildBatch({ ...args, maxBytes: size - 1 }), /batch_bytes/);
});

test('epoch retirement independently checks authority and preserves the old journal', async () => {
  const h = harness(); await h.mint(['a']); await h.advance(1);
  const batch = signedBatch({ n: 2, from: 2, to: 2, deadline: 8, ops: [] });
  await mkdir(root, { recursive: true }); const path = await mkdtemp(root + '/epoch-') + '/signed.log';
  const j = await new Journal(path, 'test-key', deployment.network, 'test').load();
  try {
    await j.reserve(['batch/0/2'], digest(batch), 'old', details(batch));
    assert.equal(await h.run('ad_key', { key: committee }), null); await h.advance(432);
    assert.equal(await h.run('ad_apply', { id: 'key' }), null);
    const retired = await j.retireBatch('batch/0/2', readsFor(h)); assert.equal(retired.proof.epoch, 1);
    assert.equal(j.records[0].digest, digest(batch));
  } finally { await j.close(); }
});

test('rules and contract retain the sixteen-asset, seventy-eight-digit and default record boundaries', async () => {
  const h = harness(); await h.advance(6); const value = '9'.repeat(78), pairs = Array.from({ length: 16 }, (_, i) => ['p' + i.toString(36), value]);
  assert.equal(rules.assetPairs(pairs), true); assert.equal(rules.assetPairs([...pairs, ['q', '1']]), false);
  assert.equal(rules.amount(value), true); assert.equal(rules.amount(value + '0'), false);
  assert.equal(await h.batch(pairs.map(([asset, amount]) => ({ op: 'mk', to: alice.address, asset, amount }))), null);
  assert.equal(await h.run('tf', { to: bob.address, assets: pairs }), null);
  assert.equal(await h.state().balance(await h.state().agent(bob.address), 'p0'), value);
  await h.advance(1); const ops = Array.from({ length: 17 }, (_, i) => rules.notaryOp('boundary/' + i, 'v'));
  assert.equal(await h.batch(ops), 'batch_kv'); assert.equal(await h.batch(ops.slice(0, 16)), null);
});
