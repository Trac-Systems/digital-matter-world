import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export { bytesToHex, hexToBytes, utf8ToBytes, sha256 };
export const NETWORK = /^[a-zA-Z0-9._:-]{1,96}$/;

// Sorted UTF-16 keys, JSON string escaping, safe integers only. No coercion,
// Unicode normalization, floating point, sparse arrays, or implicit nulls.
export function canonicalJSON(value, depth = 0, validateString) {
  if (depth > 16) throw new TypeError('json_depth');
  if (value === null) return 'null';
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { if (validateString) validateString(value); return JSON.stringify(value); }
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError('json_array');
    return '[' + Array.from(value, x => canonicalJSON(x, depth + 1, validateString)).join(',') + ']';
  }
  if (value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(k => {
      if (validateString) validateString(k);
      return JSON.stringify(k) + ':' + canonicalJSON(value[k], depth + 1, validateString);
    }).join(',') + '}';
  }
  throw new TypeError('json_value');
}

export function signingDigest(domain, network, value) {
  if (!['dmw-batch-v1', 'dmw-batch-v2', 'dmw-xc-v1', 'dmw-rq-v1', 'dmw-lock-v1'].includes(domain) || typeof network !== 'string' || !NETWORK.test(network)) throw new TypeError('signing_domain');
  return sha256(utf8ToBytes(domain + '|' + network + '|' + canonicalJSON(value)));
}
export function batchDigest(network, batch) {
  const { sig, ...unsigned } = batch;
  if (![1, 2].includes(batch.v)) throw new TypeError('batch_version');
  return signingDigest('dmw-batch-v' + batch.v, network, unsigned);
}
export function requestDigest(network, type, request) {
  if (type !== 'xc' && type !== 'rq') throw new TypeError('request_type');
  return signingDigest('dmw-' + type + '-v1', network, request);
}
export const jsonBytes = value => utf8ToBytes(canonicalJSON(value)).length;
