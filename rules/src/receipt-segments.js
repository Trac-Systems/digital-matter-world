import { ed25519 } from '@noble/curves/ed25519';
import { assert, hex, bytesToHex, hexToBytes, digest, stableJSON, exactKeys } from './core.js';
import { decimalV2, compareUint } from './integers-v2.js';
import { merkleRoot } from './merkle.js';

const uint = n => Number.isSafeInteger(n) && n >= 0 || typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n);
const same = (a, b) => uint(a) && uint(b) && decimalV2(a) === decimalV2(b);
const order = (a, b) => compareUint(decimalV2(a), decimalV2(b));
const inWindow = (tip, observed) => uint(observed) && order(observed, tip) >= 0 && BigInt(observed) < BigInt(tip) + 2n;
// An empty segment carries no receipts that a late witness could backdate, so it may be
// witnessed after its window (e.g. after gateway downtime). Non-empty segments stay strict.
const witnessed = (seal, observed) => inWindow(seal.tip, observed) || seal.count === 0 && uint(observed) && order(observed, seal.tip) >= 0;
const bodyOf = ({ sig, ...body }) => body;
const fields = ['v', 'network', 'gateway', 'tip', 'hash', 'segment', 'previous', 'ruleset', 'settingsRevision', 'first', 'last', 'count', 'root', 'sig'];
export const receiptSegmentKey = seal => `${seal.tip}/${seal.hash}${seal.v === 2 ? '/' + seal.segment : ''}`;
export const receiptSegmentHash = seal => bytesToHex(digest('dmw-receipt-segment-id-v2', seal.network, seal));
export function sealReceiptSegment(receipts, context, secret) {
  const sorted = [...receipts].sort((a, b) => order(a.sequence, b.sequence)), gateway = bytesToHex(ed25519.getPublicKey(secret));
  const { network, hash, previous, ruleset, settingsRevision, settingsHash } = context;
  const tip = settingsHash ? decimalV2(context.tip) : context.tip, segment = settingsHash ? decimalV2(context.segment) : context.segment;
  assert(uint(tip) && hex(hash, 32) && uint(segment) && (previous === null || hex(previous, 32)) && (BigInt(segment) === 0n) === (previous === null) && typeof ruleset === 'string' && (settingsHash ? uint(settingsRevision) && hex(settingsHash, 32) : hex(settingsRevision, 32)), 'receipt_segment_context');
  assert(sorted.every((r, i) => r.network === network && r.gateway === gateway && same(r.tip, tip) && r.hash === hash && (!i || order(r.sequence, sorted[i - 1].sequence) > 0)), 'receipt_segment_range');
  const body = { v: 2, network, gateway, tip, hash, segment, previous, ruleset, settingsRevision, ...(settingsHash ? { settingsHash } : {}),
    first: sorted[0]?.sequence ?? null, last: sorted.at(-1)?.sequence ?? null,
    count: sorted.length, root: merkleRoot(sorted.map(stableJSON)) };
  return { ...body, sig: bytesToHex(ed25519.sign(digest('dmw-receipt-segment-v2', network, body), secret)) };
}
export function verifyReceiptSegment(seal, receipts, { network, gateway, tip, hash }) {
  try {
    assert(exactKeys(seal, [...fields, ...(seal.settingsHash ? ['settingsHash'] : [])]) && seal.v === 2 && seal.network === network && seal.gateway === gateway && same(seal.tip, tip) && seal.hash === hash && hex(gateway, 32) && hex(seal.sig, 64), 'receipt_segment');
    assert(uint(seal.segment) && (BigInt(seal.segment) === 0n ? seal.previous === null : hex(seal.previous, 32)) && typeof seal.ruleset === 'string' && (seal.settingsHash ? uint(seal.settingsRevision) && hex(seal.settingsHash, 32) : hex(seal.settingsRevision, 32)), 'receipt_segment');
    const sorted = [...receipts].sort((a, b) => order(a.sequence, b.sequence));
    assert(seal.count === sorted.length && seal.first === (sorted[0]?.sequence ?? null) && seal.last === (sorted.at(-1)?.sequence ?? null) && sorted.every((r, i) => r.network === network && r.gateway === gateway && same(r.tip, tip) && r.hash === hash && (!i || order(r.sequence, sorted[i - 1].sequence) > 0)), 'receipt_segment_range');
    assert(seal.root === merkleRoot(sorted.map(stableJSON)), 'receipt_segment_root');
    return ed25519.verify(hexToBytes(seal.sig), digest('dmw-receipt-segment-v2', network, bodyOf(seal)), hexToBytes(gateway), { zip215: false });
  } catch { return false; }
}
export function attestReceiptSegment(seal, observedTip, signer, secret) {
  if (seal.settingsHash) observedTip = decimalV2(observedTip);
  assert(witnessed(seal, observedTip), 'receipt_attestation_late');
  const body = { v: 2, network: seal.network, signer, segmentHash: receiptSegmentHash(seal), observedTip };
  return { ...body, sig: bytesToHex(ed25519.sign(digest('dmw-receipt-segment-witness-v2', seal.network, body), secret)) };
}
export function verifySegmentAttestations(seal, attestations, members) {
  try {
    assert(members?.length === 5 && new Set(members.map(m => m.id)).size === 5 && new Set(members.map(m => m.identity)).size === 5, 'receipt_members');
    assert(attestations.length >= 3 && attestations.length <= 5 && new Set(attestations.map(a => a.signer)).size === attestations.length, 'receipt_quorum');
    return attestations.every(a => {
      const m = members.find(m => m.id === a.signer);
      return exactKeys(a, ['v', 'network', 'signer', 'segmentHash', 'observedTip', 'sig']) && a.v === 2 && a.network === seal.network && m && a.segmentHash === receiptSegmentHash(seal) && witnessed(seal, a.observedTip) && hex(a.sig, 64) && ed25519.verify(hexToBytes(a.sig), digest('dmw-receipt-segment-witness-v2', seal.network, bodyOf(a)), hexToBytes(m.identity), { zip215: false });
    });
  } catch { return false; }
}
