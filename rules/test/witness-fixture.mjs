import { ed25519 } from '@noble/curves/ed25519';
import { attestReceiptRoot, bytesToHex } from '../src/index.js';
export const witnesses = Array.from({ length: 5 }, (_, i) => { const secret = new Uint8Array(32).fill(30 + i); return { id: `w${i}`, secret, identity: bytesToHex(ed25519.getPublicKey(secret)) }; });
export const receiptSigners = witnesses.map(({ id, identity }) => ({ id, identity }));
export const attest = seal => witnesses.slice(0, 3).map(w => attestReceiptRoot(seal, seal.tip, w.id, w.secret));
