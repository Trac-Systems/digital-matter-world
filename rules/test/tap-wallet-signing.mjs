import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';

// Independent reproduction of bitcoinjs-message 2.2.0 sign(message, key,
// compressed), as called by TAP Wallet SingleWallet and inherited by HDWallet.
// No production hash/serialization helper is reused by this test signer.
export function signTapWalletMessage(message, key, compressed = true) {
  const body = Buffer.from(message, 'utf8'), size = body.length;
  let length;
  if (size < 253) length = Buffer.from([size]);
  else if (size <= 0xffff) { length = Buffer.alloc(3); length[0] = 253; length.writeUInt16LE(size, 1); }
  else { length = Buffer.alloc(5); length[0] = 254; length.writeUInt32LE(size, 1); }
  const sha256 = bytes => createHash('sha256').update(bytes).digest();
  const digest = sha256(sha256(Buffer.concat([Buffer.from('\x18Bitcoin Signed Message:\n'), length, body])));
  const sig = secp256k1.sign(digest, key, { lowS: true });
  return Buffer.concat([Buffer.from([27 + (compressed ? 4 : 0) + sig.recovery]), sig.toCompactRawBytes()]).toString('base64');
}
