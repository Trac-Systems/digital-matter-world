import test from 'node:test';
import assert from 'node:assert/strict';
import MatterContract from '../contract.js';
import { MAX_BATCH_HORIZON } from '../settings.js';
import { batchDigest, bytesToHex } from '../signing.js';
import { harness, alice, bob, signedBatch, signedRequest, nonce, deployment, invariants } from './helpers/harness.mjs';
import { chain } from './helpers/chain.mjs';

const credit = { op: 'mk', to: alice.address, asset: 'a', amount: '1' };
const digest = batch => bytesToHex(batchDigest(deployment.network, batch));

test('batch deadline is mandatory, a nonnegative safe integer and signature-bound', async () => {
  const h = harness(), batch = signedBatch({ n: 1, from: 1, to: 1, deadline: 1, hx: chain(1), ops: [credit] });
  const { deadline, ...missing } = batch;
  assert.equal(await h.run('bt', missing), 'batch');
  for (const deadline of [-1, null, '1', true]) assert.equal(await h.run('bt', { ...batch, deadline }), 'batch');
  for (const deadline of [-0, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.equal(await h.run('bt', { ...batch, deadline }), 'encoding');
  }
  for (const deadline of [0, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await h.run('bt', signedBatch({ ...batch, deadline })), 'batch_deadline');
  }
  assert.equal(await h.run('bt', { ...batch, deadline: 2 }), 'batch_signature');
  assert.equal(h.db.size, 0, 'invalid deadlines leave headers, sequence and credits untouched');
  assert.equal(await h.run('bt', batch), null);
});

for (const message of [false, true]) for (const late of [false, true]) {
  test(`${message ? 'message' : 'transaction'} batch at deadline${late ? '+1' : ''}`, async () => {
    const h = harness(); await h.advance(1 + Number(late));
    const batch = signedBatch({ n: 1, from: 1, to: 1, deadline: 1, ops: [credit] });
    const before = structuredClone(h.db);
    assert.equal(await h.run('bt', batch, alice.address, message), late ? 'batch_deadline' : null);
    if (late) assert.deepEqual(h.db, before);
    else {
      assert.equal(await h.state().balance(1, 'a'), '1'); assert.deepEqual(await h.state().batchLast(), { n: 1, to: 1 });
      await h.advance(1);
      const expired = structuredClone(h.db);
      assert.equal(await h.run('bt', batch, alice.address, message), 'batch_sequence', 'applied batch cannot replay after its deadline');
      assert.deepEqual(h.db, expired);
    }
    invariants(h.db, 0, h.supply);
  });
}

test('batch horizon is a fixed inclusive 36 blocks from application, independent of coverage', async () => {
  assert.equal(MAX_BATCH_HORIZON, 36);
  const h = harness(); await h.advance(100); // Counted 100, coverage can still begin at 1.
  const base = { n: 1, from: 1, to: 1, ops: [credit] }, before = structuredClone(h.db);
  assert.equal(await h.run('ad_set', { key: 'batch_horizon', value: 144 }), 'admin_proposal');
  assert.equal(await h.run('bt', signedBatch({ ...base, deadline: 137 })), 'batch_deadline');
  assert.deepEqual(h.db, before);
  assert.equal(await h.run('bt', signedBatch({ ...base, deadline: 136 })), null);
  assert.equal(await h.state().balance(1, 'a'), '1');
});

for (const message of [false, true]) test(`combined ${message ? 'message' : 'transaction'} checks both deadline bounds after headers atomically`, async () => {
  const h = harness(); await h.advance(1);
  const parent = await h.state().beacon().raw((await h.state().head()).tip.hash);
  const base = { n: 1, from: 1, to: 1, hx: chain(1, parent), ops: [credit] }, before = structuredClone(h.db);
  for (const deadline of [1, 39]) {
    assert.equal(await h.run('bt', signedBatch({ ...base, deadline }), alice.address, message), 'batch_deadline');
    assert.deepEqual(h.db, before, 'rejected header progress cannot expire another signature');
    assert.equal((await h.state().head()).counted, 1);
  }
  // 37 blocks ahead before hx, exactly 36 after hx: the post-header height governs.
  assert.equal(await h.run('bt', signedBatch({ ...base, deadline: 38 }), alice.address, message), null);
  assert.equal((await h.state().head()).counted, 2);
  assert.equal(await h.state().balance(1, 'a'), '1');
});

for (const failure of ['request_expired', 'balance']) test(`a ${failure} batch expires permanently and its slot accepts a new digest`, async () => {
  const h = harness(); await h.mint(['a']); await h.advance(1);
  const request = signedRequest('xc', { owner: alice.address, in: [['a', '100']], out: [['b', '1']], nonce: nonce(1), until: failure === 'request_expired' ? 2 : 10000 });
  const old = signedBatch({ n: 2, from: 2, to: 2, deadline: 4, ops: [request] });
  assert.equal(await h.state().transaction('bt', old, alice.address), null, 'preflight succeeds without reserving balances');
  if (failure === 'balance') assert.equal(await h.run('tf', { to: bob.address, assets: [['a', '100']] }), null);
  else await h.advance(1);
  const before = structuredClone(h.db);
  assert.equal(await h.run('bt', old), failure); assert.deepEqual(h.db, before);
  await h.advance(4 - (await h.state().head()).counted);
  assert.equal(await h.run('bt', old), failure, 'deadline itself has not retired the digest');
  await h.advance(1);
  if (failure === 'balance') assert.equal(await h.run('tf', { to: alice.address, assets: [['a', '100']] }, bob.address), null);
  const expired = structuredClone(h.db);
  for (let retry = 0; retry < 2; retry++) {
    assert.equal(await h.run('bt', old, alice.address, retry === 1), 'batch_deadline');
    assert.deepEqual(h.db, expired);
  }
  assert.equal(h.db.has('rq/n/1/' + nonce(1)), false, 'refused request nonce stays unused');
  assert.deepEqual(await h.state().batchLast(), { n: 1, to: 1 });
  const replacement = signedBatch({ ...old, deadline: 41, ops: failure === 'balance' ? [request] : [] });
  assert.notEqual(digest(replacement), digest(old));
  assert.equal(await h.run('bt', replacement), null, 'same epoch, sequence and coverage remain usable');
  const applied = structuredClone(h.db);
  assert.equal(await h.run('bt', old), 'batch_sequence', 'consumed sequence takes precedence on replay');
  assert.equal(await h.run('bt', replacement), 'batch_sequence');
  assert.deepEqual(h.db, applied);
  assert.equal(await h.state().balance(1, 'a'), failure === 'balance' ? '0' : '100');
  assert.equal(await h.state().balance(1, 'b'), failure === 'balance' ? '1' : '0');
  invariants(h.db, 0, h.supply);
});

test('real contract adapter discards deadline-refused combined headers on both routes', async () => {
  for (const message of [false, true]) {
    const db = new Map(), contract = new MatterContract({}, { dmw: deployment });
    const storage = { get: async k => db.has(k) ? { value: db.get(k) } : null,
      put: async (k, v) => db.set(k, structuredClone(v)), del: async k => db.delete(k) };
    const batch = signedBatch({ n: 1, from: 1, to: 1, deadline: 0, hx: chain(1), ops: [credit] });
    const wrap = value => message
      ? { type: 'msg', value: { dispatch: { type: 'msg', address: alice.address, msg: JSON.stringify({ network: deployment.network, op: 'bt', value }) } } }
      : { type: 'tx', key: nonce(10), value: { ipk: alice.address, wp: bob.address, dispatch: { type: 'bt', value } } };
    assert.equal((await contract.execute(wrap(batch), storage)).message, 'batch_deadline');
    assert.equal(db.size, 0);
    assert.equal(await contract.execute(wrap(signedBatch({ ...batch, deadline: 1 })), storage), null);
    assert.equal(db.get('b/cnt'), 1); assert.equal(db.get('v/1/a'), '1');
  }
});
