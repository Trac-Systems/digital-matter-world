import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { StateTransition } from '../../state.js';
import { MAX_BATCH_HORIZON } from '../../settings.js';
import { batchDigest, requestDigest, bytesToHex, sha256, utf8ToBytes } from '../../signing.js';
import { beaconOptions, chain, parseHeader } from './chain.mjs';

export const committeeSecret = '01'.repeat(32);
export const committee = bytesToHex(secp256k1.getPublicKey(committeeSecret));
export const person = n => {
  const secret = sha256(utf8ToBytes('dmw-disposable-test-' + n));
  return { secret, address: bytesToHex(ed25519.getPublicKey(secret)) };
};
export const alice = person(1), bob = person(2), carol = person(3);
export const deployment = { network: 'dmw-regtest-test-v1', admin: alice.address, committee, beacon: beaconOptions };
export function signedBatch(value, options = deployment, secret = committeeSecret) {
  const batch = { v: 1, epoch: 0, deadline: value.to + MAX_BATCH_HORIZON, root: 'ab'.repeat(32), ...value };
  batch.sig = secp256k1.sign(batchDigest(options.network, batch), secret, { lowS: true, prehash: false }).toCompactHex();
  return batch;
}
export function signedRequest(op, request, owner = alice, network = deployment.network) {
  return { op, request, sig: bytesToHex(ed25519.sign(requestDigest(network, op, request), owner.secret)) };
}
export const nonce = n => n.toString(16).padStart(64, '0');
export function harness(options = deployment) {
  const db = new Map(); const supply = new Map(); const metrics = { puts: 0, deletes: 0, bytes: 0, reads: 0 };
  const state = () => new StateTransition(async key => { metrics.reads++; return db.get(key) ?? null; }, options);
  const run = async (type, value, sender = alice.address, message = false) => {
    const s = state();
    const error = message ? await s.message(JSON.stringify({ network: options.network, op: type, value }), sender) : await s.transaction(type, value, sender);
    if (error) { assert.equal(s.writes.size, 0, 'refusal has an empty write set'); return error; }
    if (type === 'bt') {
      const pending = new Map([...db].filter(([k]) => k.startsWith('m/')));
      const add = (asset, quantity) => supply.set(asset, (supply.get(asset) ?? 0n) + quantity);
      for (const op of value.ops) {
        if (op.op === 'mk') add(op.asset, BigInt(op.amount));
        if (op.op === 'ac') for (const [asset, quantity] of op.assets) add(asset, BigInt(quantity));
        if (op.op === 'xc') {
          for (const [asset, q] of op.request.in) add(asset, -BigInt(q));
          for (const [asset, q] of op.request.out) add(asset, BigInt(q));
        }
        if (op.op === 'rq') pending.set('m/' + bytesToHex(requestDigest(options.network, 'rq', op.request)), op.request);
        if (op.op === 'mc') { const m = pending.get('m/' + op.id); if (m && m.s !== 1) { add(m.asset, -BigInt(m.amount)); pending.set('m/' + op.id, { ...m, s: 1 }); } }
        if (op.op === 'rx') pending.delete('m/' + op.id);
      }
    }
    for (const [key, value] of s.writes) {
      metrics.bytes += Buffer.byteLength(key) + (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)));
      if (value === undefined) { metrics.deletes++; db.delete(key); }
      else { metrics.puts++; db.set(key, structuredClone(value)); }
    }
    return null;
  };
  const advance = async (count, step = 600) => {
    const head = await state().head();
    const parent = await state().beacon().raw(head.tip.hash) ?? options.beacon.checkpoint;
    const hx = chain(count, parent, step);
    for (let i = 0; i < hx.length; i += 20) assert.equal(await run('hd', { headers: hx.slice(i, i + 20) }), null);
    return hx;
  };
  const batch = async (ops, extra = {}) => {
    const last = await state().batchLast(), h = (await state().head()).counted;
    return run('bt', signedBatch({ epoch: await state().committeeEpoch(), n: last.n + 1, from: last.to + 1, to: h, deadline: h + MAX_BATCH_HORIZON, ops, ...extra }, options));
  };
  const tickBatch = async ops => { await advance(1); return batch(ops); };
  const mint = async (list = ['a', 'b', 'c'], owner = alice.address) => {
    await advance(1);
    assert.equal(await batch(list.map(asset => ({ op: 'mk', to: owner, asset, amount: '100' }))), null);
  };
  return { db, state, run, advance, batch, tickBatch, mint, metrics, options, supply };
}
export function invariants(db, previous = 0, supply = null) {
  const counted = db.get('b/cnt') ?? 0, total = new Map(), live = new Map();
  assert.ok(counted >= previous, 'counted height monotone');
  const add = (asset, q) => { assert.match(q, /^[1-9][0-9]*$/); total.set(asset, (total.get(asset) ?? 0n) + BigInt(q)); };
  const owner = n => assert.ok(Number.isSafeInteger(n) && n > 0 && db.has(`an/${n}`));
  for (const [key, value] of db) {
    assert.ok(!key.startsWith('i/'), 'no per-item state');
    if (key.startsWith('v/')) { const [, n, asset] = key.split('/'); owner(Number(n)); add(asset, value); }
    if (key.startsWith('e/')) {
      const [, n, asset] = key.split('/'); owner(Number(n)); let last = -1;
      for (const [expiry, q] of value) { assert.ok(expiry > last); last = expiry; add(asset, q); }
      assert.ok(value.length <= 2018, 'bounded expiry aggregation');
    }
    if (/^l\/[0-9a-f]{64}$/.test(key)) {
      owner(value.o); owner(value.to); assert.ok(value.assets.length <= 16);
      assert.equal(new Set(value.assets.map(x => x[0])).size, value.assets.length);
      for (const [asset, q] of value.assets) add(asset, q);
    }
    if (key.startsWith('m/') && value.s === 0 && (value.h || counted <= value.e)) {
      owner(value.o); const k = `${value.o}/${value.asset}/${value.h ? Number.MAX_SAFE_INTEGER : value.e}`;
      live.set(k, (live.get(k) ?? 0n) + BigInt(value.amount));
    }
  }
  for (const [k, q] of live) {
    const [n, asset, e] = k.split('/');
    assert.equal(BigInt(db.get(`e/${n}/${asset}`).find(r => r[0] === Number(e))[1]), q, 'live mint escrow equals pending requests');
  }
  if (supply) for (const asset of new Set([...supply.keys(), ...total.keys()])) assert.equal(total.get(asset) ?? 0n, supply.get(asset) ?? 0n, 'asset conservation: ' + asset);
  return counted;
}
export { parseHeader };
