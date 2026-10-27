import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hash, stableJSON, solveMove, checkMove, parseMove, signRequest, verifyRequest, requestDigest,
  settleClaims, findId, compound, patternProperties, feeFor, splitFee, leadingZeroBits, validateRequest, assetPairs } from '../src/index.js';
const key = new Uint8Array(32).fill(1), address = bytesToHex(ed25519.getPublicKey(key)), other = '22'.repeat(32);
const body = { v: 1, network: 'local:test', a: address, t: 'claim', b: 100, h: hash('100'), p: { window: 100, plots: [{ block: 100, patterns: [0] }] } };
test('free moves verify signatures, puzzles, tip freshness and strict canonical JSON', () => {
  const move = solveMove(body, key, 5), view = { network: body.network, tip: 100, hashAt: n => hash(String(n)), puzzleBits: 5 };
  assert.equal(checkMove(move, view), null); assert.deepEqual(parseMove(stableJSON(move)), move);
  assert.notEqual(checkMove({ ...move, p: { ...move.p, plots: [{ block: 100, patterns: [1] }] } }, view), null);
  assert.equal(checkMove(move, { ...view, network: 'elsewhere' }), 'network');
  assert.equal(checkMove(move, { ...view, tip: 103 }), 'stale');
  assert.equal(checkMove({ ...move, sig: '0'.repeat(128) }, view), 'signature');
  assert.throws(() => solveMove(body, key, 32, 0), /exhausted/); assert.throws(() => parseMove(' ' + stableJSON(move)));
  assert.equal(leadingZeroBits('00f'), 8);
});
test('bundled plot claims and free payloads are bounded; obsolete moves are rejected', () => {
  const request = { owner: address, in: [['p1', '2']], out: [['c1', '1']], nonce: 'ab'.repeat(32), until: 200 };
  for (const [t, p] of [['header', { height: 101, raw: '0'.repeat(160) }],
    ['discovery-commit', { commitment: hash('commitment') }],
    ['discovery-reveal', { proposal: { name: 'dmwtest', pat: '0', fld: 10, dt: 'n' }, salt: hash('salt') }],
    ['craft', { recipe: 'fusion', request, sig: signRequest('xc', body.network, request, key) }]]) {
    const move = solveMove({ ...body, t, p }, key, 0); assert.deepEqual(parseMove(stableJSON(move)), move);
    assert.throws(() => parseMove(stableJSON({ ...move, p: { ...p, unexpected: 1 } })));
  }
  assert.throws(() => solveMove({ ...body, t: 'reserve', p: { id: 'a', round: 0 } }, key, 0), /move_type/);
  assert.throws(() => solveMove({ ...body, p: { window: 100, plots: Array(6).fill(body.p.plots[0]) } }, key, 0));
});
test('plain proposals are refused even with a valid signature; reveal definitions remain strict', () => {
  const proposal = { name: 'dmwtest', pat: '0', fld: 10, dt: 'n' };
  const move = { ...body, t: 'proposal', p: proposal, w: '0' };
  // Sign raw wire bytes to exercise rejection independently of the signing API.
  const digest = hash(`dmw-move-v1|${body.network}|${stableJSON(move)}`);
  move.sig = bytesToHex(ed25519.sign(Buffer.from(digest, 'hex'), key));
  assert.throws(() => solveMove(move, key, 0), /move_type/);
  assert.throws(() => parseMove(stableJSON(move)), /move_type/);
  assert.equal(checkMove(move, { network: body.network, tip: 100, hashAt: n => hash(String(n)), puzzleBits: 0 }), 'format');
  for (const p of [null, { ...proposal, extra: true }, { ...proposal, name: 'invalid' }, { ...proposal, pat: '.*' }]) {
    assert.throws(() => solveMove({ ...body, t: 'discovery-reveal', p: { proposal: p, salt: hash('salt') } }, key, 0));
  }
});
test('fungible owner requests use the contract serializer and exact bounded quantities', async () => {
  const contract = await import('../../contract/signing.js');
  const r = { owner: address, in: [['p1', '2']], out: [['c1', '1']], nonce: 'aa'.repeat(32), until: 101 };
  const sig = signRequest('xc', body.network, r, key);
  assert.equal(verifyRequest('xc', body.network, r, sig, 101), true); assert.equal(verifyRequest('xc', body.network, r, sig, 102), false);
  assert.equal(verifyRequest('xc', 'another', r, sig, 101), false); assert.throws(() => signRequest('xc', body.network, { ...r, nonce: '0' }, key));
  assert.deepEqual(requestDigest('xc', body.network, r), contract.requestDigest(body.network, 'xc', r));
  const rq = { owner: address, asset: 'p1', block: 123, amount: '2', receive: hash('address'), nonce: 'bb'.repeat(32), until: 101, expires: 532 };
  assert.deepEqual(requestDigest('rq', body.network, rq), contract.requestDigest(body.network, 'rq', rq));
  assert.throws(() => validateRequest('rq', { owner: address, id: 'p1', nonce: rq.nonce, until: 101 }));
  assert.equal(assetPairs([['a', '0']]), false); assert.equal(assetPairs([['a', '01']]), false);
  assert.equal(assetPairs([['a', (1n << 256n).toString()]]), true); assert.equal(assetPairs([['a', '9'.repeat(79)]]), false); assert.equal(assetPairs([['a', '1'], ['a', '2']]), false);
});
test('draws settle at H+2, award every valid slot, and ignore arrival order', () => {
  const slots = Array.from({ length: 20 }, (_, pattern) => ({ id: findId(10, pattern), block: 10, pattern, asset: `p${pattern.toString(36)}`, count: 4 }));
  const claims = slots.map((_, i) => ({ agent: bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(i + 1))), window: 100, block: 10, patterns: [i] }));
  const args = { window: 100, counted: 102, decidingHash: hash('seed'), slots, claims };
  const a = settleClaims(args); assert.equal(a.winners.length, 20); assert.deepEqual(a, settleClaims({ ...args, claims: [...claims].reverse() }));
  assert.deepEqual(settleClaims({ ...args, claims: [...claims, claims[0]] }), a);
  assert.throws(() => settleClaims({ ...args, counted: 101 }), /not_ready/);
  const over = [{ ...claims[0], patterns: [0, 1, 2, 3, 4] }], four = { claimsPerWindow: 4 };
  assert.equal(settleClaims({ ...args, claims: over, settings: four }).claims[0].reason, 'claim_budget');
  assert.equal(settleClaims({ ...args, claims: over, settings: four, headerSenders: [{ block: 100, agent: claims[0].agent }] }).claims[0].reason, 'claim_budget');
  const conflict = settleClaims({ ...args, claims: [...claims, { ...claims[0], patterns: [2] }] });
  assert.equal(conflict.claims.filter(c => c.agent === claims[0].agent).every(c => c.reason === 'conflicting_claims'), true);
});
test('compound types are independent of batch quantity and conserve mass with exact rarity', () => {
  const properties = patternProperties({ rarity: 10, historyHeight: 99, number: 1, fld: 4 });
  const inputs = [{ asset: 'p1', amount: '2', properties }, { asset: 'p2', amount: '2', properties }];
  const a = compound('fusion', inputs, 100), one = compound('fusion', inputs.map(i => ({ ...i, amount: '1' })), 100);
  assert.deepEqual(a, compound('fusion', [...inputs].reverse(), 100)); assert.equal(a.id, one.id); assert.equal(a.amount, '2');
  assert.equal(a.properties.mass, '2'); assert.deepEqual(a.properties.rarity, { numerator: '1', denominator: '100' });
  assert.equal(a.modeledMatches, 1); assert.equal(a.id.length, 24);
  assert.equal(compound('resonance', inputs, 100).properties.rarity.denominator, '200');
  assert.throws(() => compound('fusion', [inputs[0], inputs[0]], 100), /duplicate/);
  assert.throws(() => compound('resonance', [inputs[0], { ...inputs[1], properties: { ...properties, charge: 2 } }], 100), /charge/);
});
test('compound fees pay first maker 30, burn 35, treasury 35 with exact integer conservation', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(t => feeFor('find', '7', t)), ['7', '21', '70', '210', '700']);
  assert.equal(feeFor('compound', '7'), '70');
  const expected = { firstMaker: '30', finder: '0', landowner: '0', burn: '35', treasury: '35', discoverer: '0' };
  assert.deepEqual(splitFee('100', { kind: 'compound', linked: true, discovered: true }), expected);
  for (const kind of ['find', 'compound', 'link']) for (const total of ['0', '1', '99', '100', '1000000000000000001']) {
    const parts = splitFee(total, { kind, linked: true, discovered: true });
    assert.equal(Object.values(parts).reduce((n, v) => n + BigInt(v), 0n), BigInt(total));
  }
  assert.throws(() => feeFor('find', '1.5'));
});
