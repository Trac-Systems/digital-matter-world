import { ed25519 } from '@noble/curves/ed25519';
import { assert, exactKeys, hex, digest, bytesToHex, hexToBytes } from './core.js';
import { uintV2, compareUint } from './integers-v2.js';
import { moveIdV2 } from './moves-v2.js';
import { renewedReceiptBatch } from './receipt-renewal.js';

const bodyOf = ({ sig, ...body }) => body;
const fields = ['v', 'network', 'gateway', 'move', 'agent', 'tip', 'hash', 'sequence', 'batch', 'settingsHash', 'sig'];
export function signReceiptV2(move, { tip, hash, sequence, batch }, secret) {
  uintV2(tip); uintV2(sequence); uintV2(batch); assert(hex(hash, 32) && compareUint(move.b, tip) <= 0, 'receipt_context');
  const body = { v: 2, network: move.network, gateway: bytesToHex(ed25519.getPublicKey(secret)), move: moveIdV2(move), agent: move.a,
    tip, hash, sequence, batch, settingsHash: move.settingsHash };
  return { ...body, sig: bytesToHex(ed25519.sign(digest('dmw-receipt-v2', body.network, body), secret)) };
}
export function verifyReceiptV2(receipt, move, { network, gateway, hashAt, batch, renewal }) {
  try {
    assert(verifyReceiptSignatureV2(receipt, { network, gateway }) && receipt.agent === move.a &&
      receipt.move === moveIdV2(move) && receipt.settingsHash === move.settingsHash, 'receipt_fields');
    assert((batch === undefined || batch === receipt.batch || renewedReceiptBatch(receipt, renewal, batch)) && hashAt(receipt.tip) === receipt.hash, 'receipt_context');
    return true;
  } catch { return false; }
}
// Admission witnesses certify durable receipt identity, not execution validity.
// Canonical branch and move execution are still independently checked at replay.
export function verifyReceiptSignatureV2(receipt, { network, gateway }) {
  try {
    assert(exactKeys(receipt, fields) && receipt.v === 2 && receipt.network === network && receipt.gateway === gateway &&
      ['gateway', 'agent', 'move', 'hash', 'settingsHash'].every(k => hex(receipt[k], 32)) && hex(receipt.sig, 64), 'receipt_fields');
    uintV2(receipt.sequence); uintV2(receipt.tip); uintV2(receipt.batch);
    return ed25519.verify(hexToBytes(receipt.sig), digest('dmw-receipt-v2', network, bodyOf(receipt)), hexToBytes(gateway), { zip215: false });
  } catch { return false; }
}
