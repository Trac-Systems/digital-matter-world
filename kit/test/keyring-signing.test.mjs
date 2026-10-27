import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { init, unlock, publicAddress, publicKey, wipeWallet } from '../lib/keyring.mjs';
import { signMove, signOwnerRequest, signPaymentIntent } from '../lib/signing.mjs';
import { checkMove, verifyRequest, digest, pendingId } from '../../rules/src/index.js';
import { requestDigest } from '../../contract/signing.js';
import { cleanup, temp, testWallet, history } from './helpers.mjs';

test('encrypted keyring recovers the same Trac identity without plaintext recovery words', async t => {
  const dir = await temp(t), password = 'disposable local password';
  const result = await init({ directory: dir, password }), wallet = await unlock({ directory: dir, password });
  try {
    assert.equal(result.address, publicAddress(wallet)); assert.equal(result.address, wallet.address);
    const bytes = await readFile(join(dir, 'keystore.json'), 'utf8');
    assert.equal(bytes.includes(wallet.mnemonic), false); assert.equal(bytes.includes(password), false);
    const request = { owner: publicKey(wallet), in: [['p0', '2']], out: [['c1', '1']], nonce: '11'.repeat(32), until: 20 };
    const sig = signOwnerRequest(wallet, 'xc', 'kit-test', request, 10);
    assert.equal(verifyRequest('xc', 'kit-test', request, sig, 10), true);
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), wallet.publicKey]), format: 'der', type: 'spki' });
    assert.equal(verify(null, requestDigest('kit-test', 'xc', request), key, Buffer.from(sig, 'hex')), true);
  } finally { wipeWallet(wallet); }
  await assert.rejects(unlock({ directory: dir, password: 'a wrong test password' }), /Wrong password/);
  await assert.rejects(init({ directory: dir, password }), /EEXIST/);
  await chmod(join(dir, 'keystore.json'), 0o644); await assert.rejects(unlock({ directory: dir, password }), /private/);
});
test('keyring rejects symlinks and authenticated-header tampering', async t => {
  const dir = await temp(t), password = 'disposable local password'; await init({ directory: dir, password });
  const path = join(dir, 'keystore.json'), data = JSON.parse(await readFile(path));
  data.address = 'aa'.repeat(32); await writeFile(path, JSON.stringify(data));
  await assert.rejects(unlock({ directory: dir, password }), /Wrong password/);
  const link = dir + '-link'; await symlink(dir, link); cleanup(t, async () => { const { unlink } = await import('node:fs/promises'); await unlink(link); });
  await assert.rejects(unlock({ directory: link, password }), /symlink/);
});
test('puzzle and signatures bind network, anchor, selections and the owner request', async () => {
  const wallet = testWallet(), hist = history(), network = 'kit-test', tip = hist.get(20);
  const move = await signMove(wallet, { network, type: 'header', payload: { height: 20, raw: hist.raw(20) }, tip }, { puzzleBits: 12 });
  const context = { network, tip: 20, hashAt: hist.hashAt, puzzleBits: 12 };
  assert.equal(checkMove(move, context), null);
  assert.notEqual(checkMove({ ...move, network: 'other' }, context), null);
  assert.notEqual(checkMove({ ...move, p: { ...move.p, height: 21 } }, context), null);
  const request = { owner: publicKey(wallet), asset: 'p0', amount: '1', receive: '02'.repeat(32), block: 20, nonce: '03'.repeat(32), until: 20, expires: 432 };
  const sig = signOwnerRequest(wallet, 'rq', network, request, 15);
  assert.equal(verifyRequest('rq', network, request, sig, 15), true);
  assert.equal(verifyRequest('rq', network, { ...request, amount: '2' }, sig, 15), false);
  assert.throws(() => signOwnerRequest(wallet, 'rq', network, { ...request, owner: 'ff'.repeat(32) }, 15), /Foreign/);
  assert.throws(() => signOwnerRequest(wallet, 'rq', network, request, 21), /stale/);
  const auth = signPaymentIntent(wallet, network, { request, receiver: 'local-receiver', payer: 'local-payer', kind: 'tap' });
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), wallet.publicKey]), format: 'der', type: 'spki' });
  assert.equal(verify(null, digest('dmw-payment-intent-v1', network, { requestId: pendingId(network, request), receiver: 'local-receiver', payer: 'local-payer', kind: 'tap', feeQuote: null }), key, Buffer.from(auth, 'hex')), true);
});
test('puzzle cancellation and invalid work bounds never yield a signature', async () => {
  const wallet = testWallet(), hist = history(), args = { network: 'kit-test', type: 'header', payload: { height: 1, raw: hist.raw(1) }, tip: hist.get(1) };
  await assert.rejects(signMove(wallet, args, { signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(signMove(wallet, args, { puzzleBits: 32 }), /limits/);
  await assert.rejects(signMove(wallet, args, { puzzleBits: 24, maxAttempts: 1 }), /attempt limit/);
});

test('mint signing binds absolute expiry and Ethereum payer namespaces', async () => {
  const { mintExpiry, escrowPaymentId, paymentPayer } = await import('../lib/signing.mjs');
  const wallet = testWallet(), network = 'kit-test';
  const request = { owner: publicKey(wallet), asset: 'c1', amount: '1', receive: '02'.repeat(32), nonce: '03'.repeat(32), until: 112, expires: mintExpiry(100, 432) };
  const sig = signOwnerRequest(wallet, 'rq', network, request, 100);
  assert.equal(request.expires, 532);
  assert.equal(verifyRequest('rq', network, { ...request, expires: 533 }, sig, 100), false);
  for (const duration of [undefined, null, 5, 2017, '432', 1.5]) assert.throws(() => mintExpiry(100, duration));
  assert.throws(() => mintExpiry(Number.MAX_SAFE_INTEGER, 432), /request_expiry/);
  for (const expires of [105, 2117]) assert.throws(() => signOwnerRequest(wallet, 'rq', network, { ...request, expires }, 100), /request_expiry/);
  for (const expires of [106, 2116]) assert.equal(verifyRequest('rq', network, { ...request, expires }, signOwnerRequest(wallet, 'rq', network, { ...request, expires }, 100), 100), true);
  const payer = '0x' + 'AB'.repeat(20), other = '0x' + 'cd'.repeat(20), contract = '0x' + '12'.repeat(20), requestId = pendingId(network, request);
  const identity = { chainId: '31337', contract, payer, requestId };
  assert.equal(paymentPayer('ethereum', payer), payer.toLowerCase());
  assert.equal(escrowPaymentId(identity), `31337:${contract}:${payer.toLowerCase()}:${requestId}`);
  assert.notEqual(escrowPaymentId(identity), escrowPaymentId({ ...identity, payer: other }));
  assert.notEqual(escrowPaymentId(identity), escrowPaymentId({ ...identity, contract: other }));
  assert.notEqual(escrowPaymentId(identity), escrowPaymentId({ ...identity, chainId: '31338' }));
  assert.throws(() => escrowPaymentId({ ...identity, payer: 'local-payer' }), /Ethereum payer/);
  const terms = { request, receiver: 'local-receiver', payer, kind: 'ethereum' };
  const authorization = signPaymentIntent(wallet, network, terms);
  assert.equal(authorization, signPaymentIntent(wallet, network, { ...terms, payer: payer.toLowerCase() }));
  assert.notEqual(authorization, signPaymentIntent(wallet, network, { ...terms, payer: other }));
});
