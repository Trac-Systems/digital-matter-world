import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMintExit, confirmedPaymentSeen } from '../src/asset-exits.js';
import { signRequest, pendingId } from '../src/operations.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hash } from '../src/core.js';
test('v2 mempool observations never acquire a hold', () => {
  const payment = { kind: 'tap', receipts: [{ accepted: true, confirmations: 0, amount: '1' }] };
  assert.equal(confirmedPaymentSeen(payment), false); payment.receipts[0].confirmations = 1;
  assert.equal(confirmedPaymentSeen(payment), true);
  assert.equal(confirmedPaymentSeen({ kind: 'ethereum', depositFinal: true, receipts: [] }), true);
});
test('Ethereum refund requires the canonical domain, payer, request and terminal status', () => {
  const secret = new Uint8Array(32).fill(17), owner = bytesToHex(ed25519.getPublicKey(secret)), network = 'dmw-exits';
  const request = { owner, asset: 'p0', amount: '3', receive: hash('receiver'), nonce: hash('nonce'), until: 10, expires: 20 };
  const id = pendingId(network, request), sig = signRequest('rq', network, request, secret), payer = '0x' + '11'.repeat(20);
  const domain = { chainId: '1', address: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20) };
  const input = { v: 2, op: 'mx', reason: 'ethereum_refund', request, sig, evidence: {
    owner, reservation: { s: 0, h: true, asset: 'p0', amount: '3', receive: request.receive, e: 20 }, pending: { id, expiry: 20 },
    payment: { requestId: id, payer, kind: 'ethereum' }, domain,
    refund: { ...domain, requestId: id, payer, confirmations: 1, blockHash: '0x' + hash('block'), deposit: { status: 3, payer } },
  } };
  assert.equal(verifyMintExit(input, { network, counted: 21 }).id, id);
  for (const change of [{ confirmations: 0 }, { requestId: hash('other') }, { chainId: '2' }, { deposit: { status: 2, payer } }]) {
    const bad = structuredClone(input); Object.assign(bad.evidence.refund, change);
    assert.throws(() => verifyMintExit(bad, { network, counted: 21 }), /mint_refund_unproven/);
  }
  input.evidence.reservation.s = 1;
  assert.throws(() => verifyMintExit(input, { network, counted: 21 }), /mint_exit_binding/);
});
