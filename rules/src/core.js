import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '../../contract/signing.js';
export { bytesToHex, hexToBytes };
export function unicode(s) {
  assert(typeof s === 'string', 'unicode_string');
  if (!/[\ud800-\udfff]/.test(s)) return s;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const d = s.charCodeAt(++i); assert(d >= 0xdc00 && d <= 0xdfff, 'unicode_surrogate'); }
    else assert(c < 0xdc00 || c > 0xdfff, 'unicode_surrogate');
  }
  return s;
}
const encoder = new TextEncoder();
// Node's one-shot SHA-256 uses the platform implementation. The portable
// implementation remains available in browsers and runtimes without it.
const nativeHash = typeof process === 'object' && process.getBuiltinModule?.('node:crypto')?.hash;
export const utf8 = s => encoder.encode(unicode(s));
export function assert(ok, reason) { if (!ok) throw new Error(reason); }
export const integer = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= max;
export const hex = (s, size) => typeof s === 'string' && s.length === size * 2 && /^[0-9a-f]+$/.test(s);
export const exactKeys = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
import { canonicalJSON } from '../../contract/signing.js';
export function stableJSON(value) {
  // Validate keys and values during canonical encoding, without a second
  // recursive walk of every proof/record before serialization.
  return canonicalJSON(value, 0, unicode);
}
export function parseCanonical(text, maxBytes = 16384) {
  assert(typeof text === 'string' && utf8(text).length <= maxBytes, 'json_size');
  const value = JSON.parse(text);
  assert(stableJSON(value) === text, 'json_canonical');
  return value;
}
export const hashBytes = value => {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  if (!nativeHash || !(bytes instanceof Uint8Array)) return sha256(bytes);
  const result = nativeHash('sha256', bytes, 'buffer');
  return Uint8Array.from(result);
};
export const hash = value => nativeHash && (typeof value === 'string' || value instanceof Uint8Array)
  ? nativeHash('sha256', typeof value === 'string' ? unicode(value) : value, 'hex') : bytesToHex(hashBytes(value));
// stableJSON already checked every source string. Its JSON escapes and ASCII
// delimiters cannot introduce an unpaired surrogate requiring another scan.
// Callers supply text from a canonical encoder that already validated strings.
export const hashCanonicalText = text => nativeHash ? nativeHash('sha256', text, 'hex') : bytesToHex(sha256(encoder.encode(text)));
export const hashObject = value => hashCanonicalText(stableJSON(value));
export const digest = (domain, network, value) => hashBytes(`${domain}|${network}|${stableJSON(value)}`);
export function networkId(network) { assert(typeof network === 'string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(network), 'network'); return network; }
export function randomIndex(seed, domain, size) {
  assert(hex(seed, 32) && integer(size) && size > 0, 'random_input');
  const n = BigInt(size), range = 1n << 256n, limit = range - range % n;
  for (let counter = 0; ; counter++) {
    const v = BigInt(`0x${hash(stableJSON([domain, seed, counter]))}`);
    if (v < limit) return Number(v % n);
  }
}
export function findId(height, pattern) {
  assert(integer(height, 0xffffffff) && integer(pattern, 0xffffffff), 'find_id');
  return `f${((BigInt(height) << 32n) | BigInt(pattern)).toString(36)}`;
}
export function parseFindId(id) {
  assert(typeof id === 'string' && /^f[0-9a-z]{1,13}$/.test(id), 'find_id');
  let n = 0n;
  for (const c of id.slice(1)) n = n * 36n + BigInt(parseInt(c, 36));
  assert(n < 1n << 64n && `f${n.toString(36)}` === id, 'find_id');
  return { height: Number(n >> 32n), pattern: Number(n & 0xffffffffn) };
}
