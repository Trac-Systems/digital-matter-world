import { setImmediate as yieldNow } from 'node:timers/promises';
import { validatePayload, validateMove, puzzleHash, leadingZeroBits, moveDigest, requestDigest, validateRequest, validateRequestExpiry, digest, pendingId, paymentDigest } from '../../rules/src/index.js';
import { check, integer } from './check.mjs';
import { publicKey } from './keyring.mjs';

export function signBytes(wallet, bytes) {
  const signature = wallet.sign(Buffer.from(bytes));
  return typeof signature === 'string' ? signature : Buffer.from(signature).toString('hex');
}
export async function signMove(wallet, { network, type, payload, tip }, { puzzleBits = 12, maxAttempts = 10000000, maxWorkMs = 90000, signal } = {}) {
  check(integer(puzzleBits) && puzzleBits <= 24 && integer(maxAttempts) && maxAttempts > 0 && integer(maxWorkMs) && maxWorkMs > 0 && maxWorkMs <= 110000, 'Invalid puzzle work limits');
  validatePayload(type, payload);
  const move = { v: 1, network, a: publicKey(wallet), t: type, b: tip.height, h: tip.hash, p: structuredClone(payload), w: '0', sig: '0'.repeat(128) };
  validateMove(move); const deadline = Date.now() + maxWorkMs;
  for (let n = 0; n < maxAttempts; n++) {
    if (n % 1024 === 0) { await yieldNow(); signal?.throwIfAborted(); check(Date.now() < deadline, 'Puzzle time limit reached'); }
    move.w = n.toString(16);
    if (leadingZeroBits(puzzleHash(move)) >= puzzleBits) { move.sig = signBytes(wallet, moveDigest(move)); return move; }
  }
  throw new Error('Puzzle attempt limit reached');
}
export function signOwnerRequest(wallet, type, network, request, counted) {
  validateRequest(type, request);
  check(request.owner === publicKey(wallet) && integer(counted) && request.until >= counted && request.until <= counted + 2016, 'Foreign or stale owner request');
  if (type === 'rq') validateRequestExpiry(request, counted);
  return signBytes(wallet, requestDigest(type, network, request));
}
export function mintExpiry(counted, pendingBlocks) {
  check(integer(pendingBlocks) && pendingBlocks >= 6 && pendingBlocks <= 2016, 'Invalid pending duration suggestion');
  return validateRequestExpiry({ expires: counted + pendingBlocks }, counted);
}
export function signPlotRequest(wallet, kind, network, request, counted) {
  check(request.owner === publicKey(wallet) && integer(counted) && request.until > counted && request.until <= counted + 2016, 'Foreign or stale plot request');
  return signBytes(wallet, paymentDigest(network, request));
}
export function paymentPayer(kind, payer) {
  check(['tap', 'ethereum'].includes(kind) && typeof payer === 'string' && payer.length > 0 && payer.length <= 128, 'Invalid payment payer');
  if (kind === 'ethereum') {
    check(/^0x[0-9a-fA-F]{40}$/.test(payer) && !/^0x0{40}$/.test(payer), 'Invalid Ethereum payer');
    return payer.toLowerCase();
  }
  return payer;
}
// The on-chain request ID stays unchanged; its payer namespace is part of the
// off-chain identity used to join a deposit, release or refund.
export function escrowPaymentId({ chainId, contract, payer, requestId }) {
  check(typeof chainId === 'string' && /^[1-9][0-9]*$/.test(chainId) && BigInt(chainId) < 1n << 256n && /^[0-9a-f]{64}$/.test(requestId), 'Invalid escrow identity');
  return `${chainId}:${paymentPayer('ethereum', contract)}:${paymentPayer('ethereum', payer)}:${requestId}`;
}
export function signPaymentIntent(wallet, network, { request, receiver, payer, kind, feeQuote }) {
  check(request.owner === publicKey(wallet) && ['tap', 'ethereum'].includes(kind) && typeof payer === 'string' && payer.length > 0 && payer.length <= 128, 'Invalid payment intent');
  payer = paymentPayer(kind, payer);
  return signBytes(wallet, digest('dmw-payment-intent-v1', network, { requestId: pendingId(network, request), receiver, payer, kind, feeQuote: feeQuote ?? null }));
}
