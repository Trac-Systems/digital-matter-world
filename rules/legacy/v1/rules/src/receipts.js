import { ed25519 } from '@noble/curves/ed25519';
import { assert, integer, hex, bytesToHex, hexToBytes, digest, stableJSON, exactKeys } from './core.js';
import { moveId } from './moves.js';
import { merkleRoot, merkleProof, verifyMerkle } from './merkle.js';
export const claimWindow = (window, tip) => integer(window) && integer(tip) && tip >= window && tip < window + 2;
const unsigned = signed => { const { sig, ...body } = signed; return body; };
export function signReceipt(move, { tip, hash, sequence, highestTip = tip }, secret) {
  assert(integer(tip) && integer(highestTip) && highestTip >= tip && hex(hash, 32) && integer(sequence), 'receipt_fields');
  assert(move.t !== 'claim' || (claimWindow(move.p.window, tip) && claimWindow(move.p.window, highestTip)), 'claim_window');
  const body = { v: 1, network: move.network, gateway: bytesToHex(ed25519.getPublicKey(secret)), tip, hash, sequence, move: moveId(move) };
  return { ...body, sig: bytesToHex(ed25519.sign(digest('dmw-receipt-v1', body.network, body), secret)) };
}
export function verifyReceipt(receipt, move, { gateway, network, hashAt }) {
  try {
    assert(exactKeys(receipt, ['v', 'network', 'gateway', 'tip', 'hash', 'sequence', 'move', 'sig']), 'receipt_shape');
    assert(receipt.v === 1 && receipt.network === network && receipt.gateway === gateway && hex(gateway, 32) &&
      integer(receipt.tip) && integer(receipt.sequence) && hashAt(receipt.tip) === receipt.hash && receipt.move === moveId(move) && hex(receipt.sig, 64), 'receipt_context');
    return ed25519.verify(hexToBytes(receipt.sig), digest('dmw-receipt-v1', network, unsigned(receipt)), hexToBytes(gateway), { zip215: false });
  } catch { return false; }
}
function orderedReceipts(receipts) {
  const sorted = [...receipts].sort((a, b) => a.sequence - b.sequence);
  assert(new Set(sorted.map(r => r.sequence)).size === sorted.length, 'receipt_sequence'); return sorted;
}
export function sealReceipts(receipts, { network, tip, hash }, secret) {
  const sorted = orderedReceipts(receipts), gateway = bytesToHex(ed25519.getPublicKey(secret));
  assert(sorted.every(r => r.tip === tip && r.hash === hash && r.gateway === gateway && r.network === network), 'receipt_tip');
  const body = { v: 1, network, gateway, tip, hash, count: sorted.length, root: merkleRoot(sorted.map(r => stableJSON(r))) };
  return { ...body, sig: bytesToHex(ed25519.sign(digest('dmw-receipt-root-v1', network, body), secret)) };
}
export function verifyReceiptRoot(seal, receipts, { network, gateway, tip, hash }) {
  try {
    assert(exactKeys(seal, ['v', 'network', 'gateway', 'tip', 'hash', 'count', 'root', 'sig']), 'receipt_root_shape');
    assert(seal.v === 1 && seal.network === network && seal.gateway === gateway && seal.tip === tip && seal.hash === hash && seal.count === receipts.length && hex(seal.sig, 64), 'receipt_root_context');
    assert(seal.root === merkleRoot(orderedReceipts(receipts).map(r => stableJSON(r))), 'receipt_root');
    return ed25519.verify(hexToBytes(seal.sig), digest('dmw-receipt-root-v1', network, unsigned(seal)), hexToBytes(gateway), { zip215: false });
  } catch { return false; }
}
export function receiptProof(receipts, sequence) {
  const sorted = orderedReceipts(receipts), index = sorted.findIndex(r => r.sequence === sequence);
  return merkleProof(sorted.map(r => stableJSON(r)), index);
}
export const verifyReceiptProof = (receipt, proof, root) => verifyMerkle(stableJSON(receipt), proof, root);

export function attestReceiptRoot(seal, observedTip, signer, secret) {
  assert(integer(observedTip) && observedTip >= seal.tip && observedTip < seal.tip + 2, 'receipt_attestation_late');
  const body = { v: 1, network: seal.network, signer, tip: seal.tip, hash: seal.hash, root: seal.root, count: seal.count, observedTip };
  return { ...body, sig: bytesToHex(ed25519.sign(digest('dmw-receipt-witness-v1', seal.network, body), secret)) };
}
export function verifyRootAttestations(seal, attestations, members) {
  try {
    assert(Array.isArray(members) && members.length === 5 && new Set(members.map(m => m.id)).size === 5 && new Set(members.map(m => m.identity)).size === 5, 'receipt_members');
    assert(Array.isArray(attestations) && attestations.length >= 3 && attestations.length <= 5 && new Set(attestations.map(a => a.signer)).size === attestations.length, 'receipt_quorum');
    for (const a of attestations) {
      const member = members.find(m => m.id === a.signer);
      assert(exactKeys(a, ['v', 'network', 'signer', 'tip', 'hash', 'root', 'count', 'observedTip', 'sig']) && member && a.v === 1 && a.network === seal.network && a.tip === seal.tip &&
        a.hash === seal.hash && a.root === seal.root && a.count === seal.count && integer(a.observedTip) && a.observedTip >= seal.tip && a.observedTip < seal.tip + 2 && hex(a.sig, 64), 'receipt_attestation');
      assert(ed25519.verify(hexToBytes(a.sig), digest('dmw-receipt-witness-v1', seal.network, unsigned(a)), hexToBytes(member.identity), { zip215: false }), 'receipt_signature');
    }
    return true;
  } catch { return false; }
}
