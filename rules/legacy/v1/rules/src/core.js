import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
export { bytesToHex, hexToBytes };
export function unicode(s) {
  assert(typeof s === 'string', 'unicode_string');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const d = s.charCodeAt(++i); assert(d >= 0xdc00 && d <= 0xdfff, 'unicode_surrogate'); }
    else assert(c < 0xdc00 || c > 0xdfff, 'unicode_surrogate');
  }
  return s;
}
export const utf8 = s => new TextEncoder().encode(unicode(s));
export function assert(ok, reason) { if (!ok) throw new Error(reason); }
export const integer = (n, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= max;
export const hex = (s, size) => typeof s === 'string' && s.length === size * 2 && /^[0-9a-f]+$/.test(s);
export const exactKeys = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
import { canonicalJSON } from '../../contract/signing.js';
export function stableJSON(value) {
  const visit = v => { if (typeof v === 'string') unicode(v); else if (v && typeof v === 'object') for (const k of Object.keys(v)) { unicode(k); visit(v[k]); } };
  visit(value); return canonicalJSON(value);
}
export function parseCanonical(text, maxBytes = 16384) {
  assert(typeof text === 'string' && utf8(text).length <= maxBytes, 'json_size');
  const value = JSON.parse(text);
  assert(stableJSON(value) === text, 'json_canonical');
  return value;
}
export const hashBytes = value => sha256(typeof value === 'string' ? utf8(value) : value);
export const hash = value => bytesToHex(hashBytes(value));
export const hashObject = value => hash(stableJSON(value));
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
