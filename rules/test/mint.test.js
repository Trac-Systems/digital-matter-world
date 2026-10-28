import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hash, hexToBytes, mintRight, acceptMintRequest, finishMintRequest, mintTiming, pendingId, signRequest,
  compoundDeploy, compoundMintPermit, signMintPrivilege, compoundTicker } from '../src/index.js';
const secret = new Uint8Array(32).fill(1), owner = bytesToHex(ed25519.getPublicKey(secret)), other = '22'.repeat(32);
const find = { asset: 'p1', block: 100, count: 3, finder: owner, findHeight: 200 };
test('revisioned finds retain original decimal deadlines across settings amendments', () => {
  const recorded = { ...find, settingsHash: hash('original-settings'), finderUntil: '1208' };
  for (const finderWindow of [1, 10000]) {
    assert.deepEqual(mintRight({ find: recorded, owner: other, counted: 1207, finderWindow }), { allowed: false, role: 'finder', until: '1208' });
    assert.equal(mintRight({ find: recorded, owner: other, counted: 1208, finderWindow }).role, 'public');
  }
  const large = { ...recorded, block: '9223372036854775808', findHeight: '9223372036854775810', finderUntil: '9223372036854776818' };
  assert.equal(mintRight({ find: large, owner: other, counted: '9223372036854776817' }).allowed, false);
  assert.equal(mintRight({ find: large, owner: other, counted: large.finderUntil, link: { block: large.block, linkHeight: '9223372036854775809' }, currentHolder: other }).role, 'bitmap');
  assert.throws(() => mintRight({ find: { ...recorded, finderUntil: undefined }, owner, counted: 200 }));
  assert.throws(() => mintRight({ find: { ...recorded, finderUntil: '0208' }, owner, counted: 200 }));
});
test('finder week is exclusive; permanent pre-find links follow the live holder without a deadline', () => {
  const args = { find, owner: other, counted: 1207, link: { block: 100, linkHeight: 199 }, currentHolder: other };
  assert.equal(mintRight(args).allowed, false); assert.equal(mintRight({ ...args, owner }).allowed, true);
  assert.equal(mintRight({ ...args, counted: 1208 }).allowed, true);
  assert.equal(mintRight({ ...args, counted: 999999 }).allowed, true);
  assert.equal(mintRight({ ...args, counted: 1208, currentHolder: owner }).allowed, false);
  assert.equal(mintRight({ ...args, counted: 1208, currentHolder: null }).allowed, false);
  assert.equal(mintRight({ ...args, counted: 1208, link: { block: 100, linkHeight: 200 } }).role, 'public');
});
test('first accepted signed request holds a block, expiry releases it, stale completion cannot settle a replacement', () => {
  const network = 'local', request = { owner, asset: 'p1', block: 100, amount: '3', receive: hash('recipient'), nonce: hash('nonce'), until: 2000, expires: 632 };
  const args = { request, sig: signRequest('rq', network, request, secret), network, counted: 200, find, balance: '5' };
  const a = acceptMintRequest(args); assert.equal(a.id, pendingId(network, request)); assert.equal(a.pending.expiry, 632);
  const r2 = { ...request, nonce: hash('second'), expires: 1065 }, bargs = { ...args, state: a.state, request: r2, sig: signRequest('rq', network, r2, secret) };
  assert.throws(() => acceptMintRequest({ ...bargs, counted: 632 }), /pending/);
  const b = acceptMintRequest({ ...bargs, counted: 633 }); assert.notEqual(a.id, b.id);
  assert.throws(() => finishMintRequest(b.state, a.id, 633, { inscription: hash('ins') + 'i0' }), /pending/);
  b.state.pending[b.id].consumed = true;
  const done = finishMintRequest(b.state, b.id, 634, { inscription: hash('ins') + 'i0' });
  const r3 = { ...request, nonce: hash('third'), expires: 1067 };
  assert.throws(() => acceptMintRequest({ ...bargs, request: r3, sig: signRequest('rq', network, r3, secret), state: done.state, counted: 635 }), /minted/);
  assert.throws(() => acceptMintRequest({ ...args, request: { ...request, amount: '2' }, sig: signRequest('rq', network, { ...request, amount: '2' }, secret) }), /count/);
  assert.throws(() => acceptMintRequest({ ...args, sig: '00'.repeat(64) }), /signature/);
});
test('compound requests omit blocks; cancellation and permit windows use counted heights', () => {
  const network = 'local', request = { owner, asset: 'c1', amount: '7', receive: hash('address'), nonce: hash('compound'), until: 2000, expires: 532 };
  const a = acceptMintRequest({ request, sig: signRequest('rq', network, request, secret), network, counted: 100, compound: true, balance: '10' });
  assert.equal(a.pending.key,null);assert.equal(mintTiming(a.pending,316).maySignOrBroadcast,false);
  assert.throws(()=>finishMintRequest(a.state,a.id,532),/pending/);
  assert.equal(finishMintRequest(a.state,a.id,533).op.op,'rx');
  a.pending.consumed=true;assert.equal(mintTiming(a.pending,999999).maySignOrBroadcast,true);
  a.pending.paymentSeen=true;assert.equal(mintTiming(a.pending,999999).reservationExpires,null);

});
test('TAP deploy and mint bytes match ord-tap raw-string SHA256 and recoverable signatures', () => {
  const tick = compoundTicker('c123'), authority = hash('authority') + 'i0', deploy = compoundDeploy({ tick, authority });
  assert.deepEqual(deploy.payload, { p: 'tap', op: 'token-deploy', tick: 'dmwc123', max: '18446744073709551615', dec: '0', prv: authority });
  const params = { tick, quantity: '7', address: 'bcrt1qtestrecipient', salt: hash('salt') };
  for (const data of [undefined, '', 'request-digest']) {
    const permit = compoundMintPermit({ ...params, data });
    const expected = `tap-token-mint-${tick}-7-${params.address}-${data === undefined ? '' : data + '-'}${params.salt}`;
    assert.equal(new TextDecoder().decode(permit.signingBytes), expected);
    assert.equal(bytesToHex(permit.signingDigest), createHash('sha256').update(expected).digest('hex'));
    const signed = signMintPrivilege(permit, secret), prv = signed.payload.prv;
    const compact = hexToBytes(prv.sig.r.slice(2) + prv.sig.s.slice(2));
    const signature = secp256k1.Signature.fromCompact(compact).addRecoveryBit(prv.sig.v);
    assert.equal(bytesToHex(signature.recoverPublicKey(permit.signingDigest).toRawBytes()), bytesToHex(secp256k1.getPublicKey(secret)));
    assert.equal(secp256k1.verify(compact, permit.signingDigest, secp256k1.getPublicKey(secret), { prehash: false }), true);
    assert.equal(prv.address, params.address); assert.equal(prv.hash, bytesToHex(permit.signingDigest));
  }
  assert.throws(() => compoundMintPermit({ ...params, quantity: '18446744073709551616' }));
});
test('matching slots cannot mint without a find, even with units or a Bitmap link', async () => {
  const { mintCandidate } = await import('../src/index.js');
  const pattern = { number: 1, pat: '1', fld: 4, dt: 'n' }, history = { get: height => ({ height }) }, state = { finds: {} };
  assert.throws(() => mintCandidate({ pattern, block: 111, history, state }), /mint_no_find/);
  assert.throws(() => mintRight({ find: { block: 111, count: 3, finder: null, findHeight: null }, owner, counted: 200, link: { block: 111, linkHeight: 1 } }), /mint_find/);
});
test('expired request cleanup preserves a replacement hold and never makes its nonce reusable', () => {
  const network = 'local', request = { owner, asset: 'p1', block: 100, amount: '3', receive: hash('recipient'), nonce: hash('old'), until: 2000, expires: 632 };
  const args = { request, sig: signRequest('rq', network, request, secret), network, counted: 200, find, balance: '9'.repeat(100) };
  const a = acceptMintRequest(args), nextRequest = { ...request, nonce: hash('new'), expires: 1065 };
  const b = acceptMintRequest({ ...args, state: a.state, counted: 633, request: nextRequest, sig: signRequest('rq', network, nextRequest, secret) });
  const cleanup = finishMintRequest(b.state, a.id, 634); assert.equal(cleanup.state.holds['p1/100'].id, b.id);
  const reused = { ...request, expires: 1067 };
  assert.throws(() => acceptMintRequest({ ...args, request: reused, sig: signRequest('rq', network, reused, secret), state: cleanup.state, counted: 635 }), /replay/);
});
test('mint candidates recount a rewritten canonical header while retaining original attribution', async () => {
  const { mintCandidate, findId } = await import('../src/index.js');
  const pattern = { number: 1, pat: '1', fld: 10, dt: 'n' }, history = { get: height => ({ height, nonce: 1111 }) };
  const state = { finds: { [findId(100, 1)]: find } };
  const candidate = mintCandidate({ pattern, block: 100, history, state });
  assert.equal(candidate.count, 4); assert.equal(candidate.finder, owner); assert.equal(candidate.findHeight, 200); assert.equal(find.count, 3);
});
test('compound permit policy binds the signed recipient, live request digest, amount, deadline and remaining supply', async () => {
  const { compoundRequestPermit } = await import('../src/index.js');
  const network = 'local', address = 'bcrt1qrecipient', request = { owner, asset: 'c123', amount: '7', receive: hash(address), nonce: hash('policy'), until: 112, expires: 532 };
  const sig = signRequest('rq', network, request, secret), accepted = acceptMintRequest({ request, sig, network, counted: 100, compound: true, balance: '7' });
  accepted.pending.consumed=true;
  const args = { network, request, sig, pending: accepted.pending, counted: 316, address, remainingSupply: '7' };
  args.tick = 'dmwfallback123';
  const permit = compoundRequestPermit(args); assert.equal(permit.payload.tick, args.tick); assert.equal(permit.payload.amt, '7'); assert.equal(permit.payload.dta, accepted.id); assert.equal(permit.salt, accepted.id);
  assert.throws(() => compoundRequestPermit({ ...args, address: 'bcrt1qother' }), /receive/);
  assert.throws(() => compoundRequestPermit({ ...args, remainingSupply: '6' }), /remaining_supply/);
  assert.deepEqual(compoundRequestPermit({ ...args, counted: 999999 }),permit);
  assert.throws(()=>compoundRequestPermit({...args,pending:{...accepted.pending,consumed:false}}),/units_not_consumed/);
  assert.throws(() => compoundRequestPermit({ ...args, pending: { ...accepted.pending, id: hash('other') } }), /pending/);
  assert.throws(() => compoundRequestPermit({ ...args, sig: '00'.repeat(64) }), /signature/);
});

test('signed expiry is absolute, bounded at admission and unaffected by pending duration suggestions', async () => {
  const { validateRequest, verifyRequest } = await import('../src/index.js');
  const network = 'local', request = { owner, asset: 'c1', amount: '1', receive: hash('expiry'), nonce: hash('expiry'), until: 1000, expires: 532 };
  const sig = signRequest('rq', network, request, secret);
  const args = { network, request, sig, counted: 100, compound: true, balance: '1' };
  for (const pendingBlocks of [6, 432, 2016]) {
    assert.equal(acceptMintRequest({ ...args, counted: 200, settings: { pendingBlocks } }).pending.expiry, 532);
  }
  const { expires, ...missingExpiry } = request;
  for (const r of [missingExpiry, ...[null, -1, '532', 1.5, Number.MAX_SAFE_INTEGER + 1].map(expires => ({ ...request, expires }))]) {
    assert.throws(() => validateRequest('rq', r), /request_real/);
  }
  for (const remaining of [5, 6, 2016, 2017]) {
    const r = { ...request, expires: 100 + remaining }, input = { ...args, request: r, sig: signRequest('rq', network, r, secret) };
    if (remaining === 6 || remaining === 2016) assert.equal(acceptMintRequest(input).pending.expiry, r.expires);
    else assert.throws(() => acceptMintRequest(input), /request_expiry/);
  }
  assert.equal(verifyRequest('rq', network, { ...request, expires: 533 }, sig, 100), false);
  assert.notEqual(pendingId(network, request), pendingId(network, { ...request, expires: 533 }));
  assert.throws(() => acceptMintRequest({ ...args, counted: 527 }), /request_expiry/);
  assert.equal(acceptMintRequest({ ...args, counted: 526 }).pending.expiry, 532);
});
