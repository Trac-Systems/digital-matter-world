import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { tokenMintPermit, sha256, testKey } from '../protocol.mjs';
import { paymentLock, paymentMessage, TAP_BURN, tapBurnAddress } from '../payments.mjs';

test('ordinary mint signatures bind the raw amount, receiver and optional data without a block', () => {
  const key = testKey(), pubkey = secp256k1.getPublicKey(key);
  for (const dta of [undefined, '', 'request']) {
    const mint = tokenMintPermit({ tick: 'compound', amt: '9007199254740993', address: 'receiver', dta, salt: 'salt' }, key);
    const message = 'tap-token-mint-compound-9007199254740993-receiver-' + (dta === undefined ? '' : dta + '-') + 'salt';
    assert.equal(mint.prv.hash, sha256(message));
    const signature = new secp256k1.Signature(BigInt(mint.prv.sig.r), BigInt(mint.prv.sig.s));
    assert(secp256k1.verify(signature, mint.prv.hash, pubkey));
    for (const [from, to] of [['9007199254740993', '9007199254740992'], ['receiver', 'other'], ['compound', 'different'], ['salt', 'changed']]) assert.equal(secp256k1.verify(signature, sha256(message.replace(from, to)), pubkey), false);
    assert.equal('blk' in mint, false); assert.equal('dep' in mint, false);
  }
  assert.throws(() => tokenMintPermit({ amt: 9007199254740992 }, key), /exact decimal string/);
});

const input = { priceAtoms: 100n * 10n ** 18n, payer: 'payer', finder: 'finder', landowner: 'landowner', treasury: 'treasury', hash: 'ab'.repeat(32), expiry: 1000 };
test('payment split preserves atomic precision and uses the native burn route', () => {
  const lock = paymentLock(input);
  assert.equal(lock.amt, '35');
  assert.deepEqual(lock.al, [{ tt: 'a', to: 'finder', amt: '30', rl: 'of' }, { tt: 'a', to: 'landowner', amt: '15', rl: 'sr' }, { tt: 'b', to: TAP_BURN, amt: '20', rl: 'bn' }]);
  const noLand = paymentLock({ ...input, landowner: null, priceAtoms: 100n });
  assert.equal(noLand.amt, '0.000000000000000035');
  assert.deepEqual(noLand.al.map(a => a.amt), ['0.00000000000000003', '0.000000000000000035']);
  const integer = paymentLock({ ...input, decimals: 0, priceAtoms: 9007199254741000n });
  assert.equal(integer.amt, '3152519739159350');
  assert.deepEqual(paymentMessage('auth', lock, 'request'), { auth: 'auth', items: [], data: 'request', actions: [lock] });
});

test('payment builder rejects ambiguous rounding and colliding payment roles', () => {
  for (const priceAtoms of [0n, -100n, 101n, 100]) assert.throws(() => paymentLock({ ...input, priceAtoms }), /Price/);
  assert.throws(() => paymentLock({ ...input, finder: input.treasury }), /distinct/);
  assert.throws(() => paymentLock({ ...input, landowner: TAP_BURN }), /distinct/);
  assert.throws(() => paymentLock({ ...input, expiry: 1.5 }), /height/);
  assert.throws(() => paymentLock({ ...input, hash: 'bad' }), /SHA256/);
});

test('local regtest locks use the shared burn destination and reject colliding roles', () => {
  const burn = tapBurnAddress('regtest');
  assert.equal(paymentLock({ ...input, bitcoinNetwork: 'regtest' }).al.at(-1).to, burn);
  assert.throws(() => paymentLock({ ...input, bitcoinNetwork: 'regtest', landowner: burn }), /distinct/);
});
