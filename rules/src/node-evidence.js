import { assert, bytesToHex } from './core.js';

// Optional cache hints carry fixed-width hashes, never authority for a read.
// Packed base64 keeps the JSON flat and avoids one quoted string per hash.
// Older array encodings remain readable for retained contexts.
export function decodeNodeHints(value, code = 'node_evidence_hints', limit = Infinity) {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    assert(value.every(id => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)), code);
    return value.slice(0, limit);
  }
  assert(typeof value === 'string' && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), code);
  let raw;
  try { raw = atob(value); } catch { assert(false, code); }
  assert(raw.length % 32 === 0 && btoa(raw) === value, code);
  const bytes = Uint8Array.from(raw.slice(0, limit * 32), c => c.charCodeAt(0));
  return bytesToHex(bytes).match(/.{64}/g) ?? [];
}
