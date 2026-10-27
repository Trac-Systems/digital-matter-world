import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { harness, alice, bob, carol, signedBatch, signedRequest, deployment, committee, nonce, invariants } from './helpers/harness.mjs';
import { chain, mine, checkpoint, parseHeader } from './helpers/chain.mjs';
import { bytesToHex, requestDigest } from '../signing.js';
import { targetFromBits } from '../beacon/bitcoin.js';

const replacement = bytesToHex(secp256k1.getPublicKey('02'.repeat(32)));
const balance = h => h.state().balance(1, 'a');
const mintRequest = (expires, serial = 1) => signedRequest('rq', {
  owner: alice.address, asset: 'a', amount: '100', receive: nonce(999), block: 42,
  nonce: nonce(serial), until: 10000, expires
});
const mintId = op => bytesToHex(requestDigest(deployment.network, 'rq', op.request));
async function rotate(h, key) {
  assert.equal(await h.run('ad_key', { key }), null);
  await h.advance(432);
  assert.equal(await h.run('ad_apply', { id: 'key' }, carol.address), null);
}

test('unused batch authority cannot revive after A to B to A key rotation', async () => {
  const h = harness(); await h.mint(['a']); await h.advance(1);
  const exchange = signedRequest('xc', { owner: alice.address, in: [['a', '100']], out: [['b', '1']], nonce: nonce(1), until: 10000 });
  const stale = signedBatch({ n: 2, from: 2, to: 2, ops: [exchange] });
  assert.equal(await h.state().committeeEpoch(), 0);
  await rotate(h, replacement); assert.equal(await h.state().committeeEpoch(), 1);
  assert.equal(await h.run('bt', stale), 'batch_epoch');
  await rotate(h, committee); assert.equal(await h.state().committeeEpoch(), 2);
  const before = structuredClone(h.db);
  assert.equal(await h.run('bt', stale, carol.address), 'batch_epoch');
  assert.equal(await h.run('bt', { ...stale, epoch: 2 }), 'batch_signature');
  assert.deepEqual(h.db, before); assert.equal(await balance(h), '100');
  assert.equal(h.db.get('s/epoch'), 2, 'epoch survives fresh transition instances');
  assert.equal(await h.run('bt', signedBatch({ ...stale, epoch: 2, deadline: (await h.state().head()).counted }), carol.address), null);
  assert.equal(await balance(h), '0'); assert.equal(await h.state().balance(1, 'b'), '1');
  invariants(h.db, 0, h.supply);
});

test('same-key reauthorization increments epoch only when applied and never resets at handover', async () => {
  const h = harness(); await h.mint(['a']); await h.advance(1);
  const stale = signedBatch({ n: 2, from: 2, to: 2, ops: [] });
  assert.equal(await h.run('ad_key', { key: committee }), null);
  assert.equal(await h.state().committeeEpoch(), 0);
  assert.equal(await h.run('ad_apply', { id: 'key' }), 'admin_delay');
  assert.equal(await h.state().committeeEpoch(), 0);
  await h.advance(432); assert.equal(await h.run('ad_apply', { id: 'key' }), null);
  assert.equal(await h.state().committeeEpoch(), 1);
  assert.equal(await h.run('bt', stale), 'batch_epoch');
  assert.equal(await h.run('bt', signedBatch({ ...stale, epoch: 1, deadline: (await h.state().head()).counted })), null);
  assert.equal(await h.run('ad_apply', { id: 'key' }), 'admin_unknown');
  await h.run('ad_admin', { address: bob.address }); await h.advance(432);
  assert.equal(await h.run('ad_accept', { id: 'admin' }, bob.address), null);
  assert.equal(await h.state().committeeEpoch(), 1);
});

test('epoch schema is mandatory and safe; mismatch rejects combined headers atomically', async () => {
  const h = harness(), value = signedBatch({ n: 1, from: 1, to: 1, hx: chain(6), ops: [] });
  const { epoch, ...missing } = value;
  for (const bad of [missing, { ...value, epoch: '0' }, { ...value, epoch: -1 }, { ...value, epoch: null }]) {
    assert.equal(await h.run('bt', bad), 'batch'); assert.equal(h.db.size, 0);
  }
  assert.equal(await h.run('bt', signedBatch({ ...value, epoch: 1 })), 'batch_epoch');
  assert.equal(h.db.size, 0);
  h.db.set('s/epoch', Number.MAX_SAFE_INTEGER);
  await h.run('ad_key', { key: replacement }); await h.advance(437);
  const before = structuredClone(h.db);
  assert.equal(await h.run('ad_apply', { id: 'key' }), 'committee_epoch_exhausted');
  assert.deepEqual(h.db, before); assert.equal(await h.state().committee(), committee);
});

test('a settings increase cannot extend an already signed absolute mint expiry', async () => {
  const h = harness(); await h.mint(['a']);
  const original = mintRequest(433), stillLive = mintRequest(900, 2);
  assert.equal((await h.state().settings()).pending_blocks, 432);
  await h.run('ad_set', { key: 'pending_blocks', value: 2016 });
  await h.advance(432); await h.run('ad_apply', { id: 'set/pending_blocks' });
  const before = structuredClone(h.db);
  assert.equal(await h.batch([original]), 'request_expiry'); assert.deepEqual(h.db, before);
  assert.equal(await balance(h), '100');
  assert.equal(await h.batch([stillLive]), null);
  assert.equal((await h.state().mint(mintId(stillLive))).e, 900);
  await h.advance(467); assert.equal((await h.state().head()).counted, 900);
  assert.equal(await balance(h), '0'); assert.equal(await h.run('rx', { id: mintId(stillLive) }), 'mint_live');
  await h.advance(1); assert.equal(await balance(h), '100');
  assert.equal(await h.run('rx', { id: mintId(stillLive) }, carol.address), null);
  invariants(h.db, 0, h.supply);
});

for (const duration of [5, 6, 2016, 2017]) test('signed expiry duration boundary ' + duration, async () => {
  const h = harness(); await h.mint(['a']); await h.advance(1);
  // The mutable suggestion never replaces either hard bound.
  h.db.set('s/current', { pending_blocks: duration === 2016 ? 6 : 2016 });
  const signed = mintRequest(2 + duration), before = structuredClone(h.db);
  assert.equal(await h.batch([signed]), duration === 6 || duration === 2016 ? null : 'request_expiry');
  if (duration === 6 || duration === 2016) assert.equal((await h.state().mint(mintId(signed))).e, 2 + duration);
  else assert.deepEqual(h.db, before);
});

test('expiry is required, owner-signed, part of request identity and checked after combined headers', async () => {
  const h = harness(); await h.mint(['a']);
  const signed = mintRequest(7), changed = { ...signed.request, expires: 8 };
  assert.notEqual(mintId(signed), mintId({ request: changed }));
  const { expires, ...missing } = signed.request;
  const parent = await h.state().beacon().raw((await h.state().head()).tip.hash);
  const combined = ops => signedBatch({ n: 2, from: 2, to: 2, hx: chain(1, parent), ops });
  const before = structuredClone(h.db);
  assert.equal(await h.run('bt', combined([signedRequest('rq', missing)])), 'request');
  for (const expires of ['8', null, -1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await h.run('bt', combined([signedRequest('rq', { ...changed, expires })])), 'request_expiry');
  }
  assert.equal(await h.run('bt', combined([signed])), 'request_expiry', 'six blocks at signing becomes five at execution');
  assert.equal(await h.run('bt', combined([{ ...signed, request: changed }])), 'request_signature');
  assert.deepEqual(h.db, before);
  const good = signedRequest('rq', changed);
  assert.equal(await h.run('bt', combined([good])), null);
  assert.equal((await h.state().mint(mintId(good))).e, 8);
  assert.equal(h.db.get('e/1/a')[0][0], 8);
});

test('invalid proof, difficulty and time refuse without traversing a 2000-header fork', async () => {
  const h = harness(), main = await h.advance(2010), fork = chain(2000, checkpoint, 601, 713);
  for (let i = 0; i < fork.length; i += 20) assert.equal(await h.run('hd', { headers: fork.slice(i, i + 20) }), null);
  const tips = [parseHeader(main.at(-1)), parseHeader(fork.at(-1))];
  const invalid = parent => { const raw = Buffer.from(mine(parent.hash, parent.time + 1), 'hex'); raw.writeUInt32LE(0, 72); return raw.toString('hex'); };
  const overLimit = parent => { const raw = Buffer.from(mine(parent.hash, parent.time + 1), 'hex'); raw.writeUInt32LE(0x2100ffff, 72); return raw.toString('hex'); };
  const badHash = parent => {
    const raw = Buffer.from(mine(parent.hash, parent.time + 1), 'hex');
    for (let n = 0; ; n++) { raw.writeUInt32LE(n, 76); const hex = raw.toString('hex'); if (BigInt('0x' + parseHeader(hex).hash) > targetFromBits(parent.bits)) return hex; }
  };
  const results = {};
  for (const [kind, build, error] of [
    ['target', invalid, 'header_pow'], ['limit', overLimit, 'header_pow'], ['hash', badHash, 'header_pow'],
    ['bits', p => mine(p.hash, p.time + 1, 0x203fffff), 'header_bits'],
    ['time', p => mine(p.hash, 1000), 'header_time']
  ]) {
    const reads = [];
    for (const tip of tips) {
      const before = structuredClone(h.db), start = h.metrics.reads;
      assert.equal(await h.run('hd', { headers: [build(tip)] }), error);
      reads.push(h.metrics.reads - start); assert.deepEqual(h.db, before);
    }
    assert.equal(reads[1], reads[0], kind + ' refusal cost is independent of branch depth');
    assert.ok(reads[1] <= 6, 'only initialization, duplicate and direct-parent reads');
    results[kind] = { mainReads: reads[0], forkReads: reads[1] };
  }
  const valid = chain(1, tips[0]), bad = invalid(parseHeader(valid[0])), before = structuredClone(h.db);
  assert.equal(await h.run('hd', { headers: [...valid, bad] }), 'header_pow');
  assert.deepEqual(h.db, before, 'later invalid header rolls back an earlier valid header');
  console.log('HEADER_REFUSAL_READS ' + JSON.stringify(results));
});
