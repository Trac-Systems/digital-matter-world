import { ed25519 } from '@noble/curves/ed25519';
import { assert, integer, hex, hash, digest, networkId, bytesToHex, hexToBytes, stableJSON, exactKeys } from './core.js';
import { feeFor } from './fees.js';
import { linkPaymentSplit } from './financial-fees.js';
import { multiTickerActive } from './multi-ticker-activation.js';
import { tapPaymentAllocations } from './tap.js';

export function paymentDigest(network, request) {
  networkId(network);
  assert(exactKeys(request, ['owner', 'height', 'nonce', 'until']) && hex(request.owner, 32) && hex(request.nonce, 32) && integer(request.height) && integer(request.until), 'link_request');
  return digest('dmw-link-v1', network, request);
}
export const linkId = (network, request) => bytesToHex(paymentDigest(network, request));
export const signLink = (network, request, secret) => { assert(bytesToHex(ed25519.getPublicKey(secret)) === request.owner, 'link_signer'); return bytesToHex(ed25519.sign(paymentDigest(network, request), secret)); };
export function verifyLinkInput(input, network, counted, options = {}) {
  assert(exactKeys(input, ['request', 'sig', 'terms', 'payment']), 'link_input');
  const { request: r, sig, terms: t, payment: p } = input, id = bytesToHex(paymentDigest(network, r));
  assert(hex(sig, 64) && ed25519.verify(hexToBytes(sig), paymentDigest(network, r), hexToBytes(r.owner), { zip215: false }), 'link_signature');
  assert(p?.requestId === id && ['tap', 'ethereum'].includes(p.kind) && typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 160 &&
    typeof p.payer === 'string' && p.payer.length > 0 && integer(p.confirmations) && p.confirmations >= 1 && typeof p.consumed === 'boolean' &&
    integer(p.verifiedHeight) && p.verifiedHeight <= counted && p.verifiedHeight <= r.until && integer(p.eventIndex), 'link_payment');
  assert(t?.payer === p.payer && typeof t.treasury === 'string' && t.treasury.length > 0 && hex(t.hash, 32), 'link_terms');
  const executionHeight = options?.executionHeight ?? counted, document = options?.document;
  if (multiTickerActive(executionHeight)) assert(document?.network === network && t.settingsHash === hash(stableJSON(document)), 'link_settings');
  const total = feeFor('link', t.baseFee, 1, t.feeSettings), split = linkPaymentSplit(total, document, executionHeight);
  assert(p.total === total && BigInt(total) > 0n, 'link_price');
  if (p.kind === 'tap') {
    const allocations = tapPaymentAllocations(split, {}, 'link');
    assert(p.tick === 'tap' && p.lockKind === 'htlc' && p.conditionType === 'hashlock' && p.hash === t.hash && p.refund === p.payer &&
      p.claim === t.treasury && p.base === split.treasury && stableJSON(p.allocations) === stableJSON(allocations) &&
      integer(p.refundAfter), 'link_tap');
  } else {
    const address = s => typeof s === 'string' && /^0x[0-9a-f]{40}$/.test(s), uint = s => typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s);
    const zero = '0x' + '00'.repeat(20), expected = { treasury: split.treasury === '0' ? zero : t.treasury, treasuryAmount: split.treasury,
      finder: zero, finderAmount: '0', landowner: zero, landownerAmount: '0', discoverer: '0x' + '00'.repeat(20), discovererAmount: '0', burnAmount: split.burn };
    assert(address(p.payer) && address(p.contract) && address(p.token) && uint(p.chainId) && [1, 2, 3].includes(p.status) && p.consumed === (p.status !== 1) && uint(p.timestamp) && uint(p.expiry) &&
      stableJSON(p.split) === stableJSON(expected) &&
      p.chainId === t.chainId && p.contract === t.contract && p.token === t.token, 'link_ethereum');
  }
  {
    const settled = p.settlement;
    assert(p.consumed === true && (p.kind !== 'ethereum' || p.status === 2) && settled?.accepted === true && settled.refund === false && settled.paymentId === p.id && hex(settled.txid, 32) &&
      integer(settled.confirmations) && settled.confirmations >= 1, 'link_unpaid');
  }
  return { id, height: r.height, owner: r.owner, paidHeight: p.verifiedHeight, eventIndex: p.eventIndex,
    paymentKey: hash(stableJSON(p.kind === 'tap' ? ['tap', p.id] : ['ethereum', p.chainId, p.contract, p.payer, p.requestId])),
    input };
}
