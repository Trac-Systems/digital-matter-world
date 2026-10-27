import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, scryptSync, hkdfSync, timingSafeEqual } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { stableJSON as canonicalJSON } from '../../rules/src/core.js';
export { canonicalJSON };
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const hex = value => Buffer.from(value).toString('hex');
export const check = (condition, message) => { if (!condition) throw Error(message); };
export const isHex = (value, bytes = 32) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
export const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
export function encrypt(key, bytes, context) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { nonce: hex(nonce), data: hex(data), tag: hex(cipher.getAuthTag()) };
}
export function decrypt(key, box, context) {
  check(isHex(box?.nonce, 12) && isHex(box?.tag, 16) && typeof box.data === 'string' && /^(?:[0-9a-f]{2})*$/.test(box.data), 'ciphertext');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.nonce, 'hex'));
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(Buffer.from(box.tag, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(box.data, 'hex')), cipher.final()]);
}
export function seal(passphrase, bytes, context) {
  const salt = randomBytes(32), key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 });
  try { return { salt: hex(salt), ...encrypt(key, bytes, context) }; } finally { key.fill(0); }
}
export function unseal(passphrase, box, context) {
  check(isHex(box?.salt), 'salt');
  const key = scryptSync(passphrase, Buffer.from(box.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 << 20 });
  try { return decrypt(key, box, context); } finally { key.fill(0); }
}
function channelKey(secret, pub, context) {
  const shared = x25519.getSharedSecret(secret, pub);
  try { return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), context, 32)); } finally { shared.fill(0); }
}
export function boxShare(publicKey, share, context) {
  check(isHex(publicKey), 'encryption_key');
  const secret = randomBytes(32), ephemeral = hex(x25519.getPublicKey(secret));
  const key = channelKey(secret, Buffer.from(publicKey, 'hex'), context);
  try { return { ephemeral, ...encrypt(key, share, context) }; } finally { secret.fill(0); key.fill(0); }
}
export function openShare(secretKey, box, context) {
  check(isHex(box?.ephemeral), 'ephemeral');
  const key = channelKey(Buffer.from(secretKey, 'hex'), Buffer.from(box.ephemeral, 'hex'), context);
  try { return decrypt(key, box, context); } finally { key.fill(0); }
}
export const mac = (key, value) => createHmac('sha256', key).update(canonicalJSON(value)).digest('hex');
export const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
