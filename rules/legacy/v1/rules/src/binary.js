import { publicIdentities } from './trac-address.js';
import { assert, integer, utf8, hexToBytes, bytesToHex, stableJSON } from './core.js';
// Canonical, self-contained binary JSON. Strings are interned in encounter order;
// lowercase even-length hex is stored as bytes. No runtime compression is needed.
export function encodeBinary(value) {
  const out = [68, 77, 87, 2], strings = new Map();
  const uint = n => { assert(integer(n), 'binary_integer'); do { const b = n % 128; n = Math.floor(n / 128); out.push(b | (n ? 128 : 0)); } while (n); };
  function str(s) {
    if (strings.has(s)) { out.push(7); uint(strings.get(s)); return; }
    strings.set(s, strings.size);
    const packed = s.length >= 8 && s.length % 2 === 0 && /^[0-9a-f]+$/.test(s), bytes = packed ? hexToBytes(s) : utf8(s);
    out.push(packed ? 6 : 5); uint(bytes.length); for (const b of bytes) out.push(b);
  }
  function visit(v, depth) {
    assert(depth <= 16, 'binary_depth');
    if (v === null) out.push(0);
    else if (v === false || v === true) out.push(v ? 2 : 1);
    else if (typeof v === 'number') { assert(Number.isSafeInteger(v) && !Object.is(v, -0), 'binary_number'); out.push(v < 0 ? 4 : 3); uint(Math.abs(v)); }
    else if (typeof v === 'string') str(v);
    else if (Array.isArray(v)) { assert(Object.keys(v).length === v.length, 'binary_array'); out.push(8); uint(v.length); for (const x of v) visit(x, depth + 1); }
    else {
      assert(v && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null), 'binary_object');
      const keys = Object.keys(v).sort(); out.push(9); uint(keys.length); for (const k of keys) { str(k); visit(v[k], depth + 1); }
    }
  }
  visit(value, 0); return Uint8Array.from(out);
}
export function decodeBinary(bytes, maxBytes = 1500000) {
  assert(bytes instanceof Uint8Array && bytes.length <= maxBytes, 'binary_size');
  let pos = 0; const strings = [], decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const byte = () => { assert(pos < bytes.length, 'binary_truncated'); return bytes[pos++]; };
  for (const b of [68, 77, 87, 2]) assert(byte() === b, 'binary_version');
  function uint() { let n = 0, scale = 1, b; do { b = byte(); n += (b & 127) * scale; scale *= 128; assert(Number.isSafeInteger(n) && scale <= 2 ** 56, 'binary_integer'); } while (b & 128); return n; }
  function visit(depth) {
    assert(depth <= 16, 'binary_depth'); const tag = byte();
    if (tag < 3) return [null, false, true][tag];
    if (tag === 3 || tag === 4) { const n = uint(); assert(tag !== 4 || n > 0, 'binary_negative_zero'); return tag === 4 ? -n : n; }
    if (tag === 5 || tag === 6) {
      const n = uint(); assert(pos + n <= bytes.length, 'binary_truncated');
      const slice = bytes.subarray(pos, pos += n), s = tag === 6 ? bytesToHex(slice) : decoder.decode(slice); strings.push(s); return s;
    }
    if (tag === 7) { const n = uint(); assert(n < strings.length, 'binary_reference'); return strings[n]; }
    assert(tag === 8 || tag === 9, 'binary_tag'); const n = uint(); assert(n <= bytes.length, 'binary_count');
    if (tag === 8) return Array.from({ length: n }, () => visit(depth + 1));
    const out = {}; let previous;
    for (let i = 0; i < n; i++) {
      const key = visit(depth + 1); assert(typeof key === 'string' && (previous === undefined || key > previous), 'binary_key');
      Object.defineProperty(out, key, { value: visit(depth + 1), enumerable: true, writable: true, configurable: true }); previous = key;
    }
    return out;
  }
  const value = visit(0); assert(pos === bytes.length, 'binary_trailing');
  const canonical = encodeBinary(value); assert(canonical.length === bytes.length && canonical.every((b, i) => b === bytes[i]), 'binary_canonical'); return value;
}
export function viewerSummary(file) {
  return publicIdentities({ v: file.v, height: file.height, hash: file.hash, tip: file.tip, tipHash: file.tipHash,
    receipts: { count: file.receipts.length, root: file.receiptRoot.root },
    moves: file.moves.length, rejected: file.moves.filter(m => m.reason !== 'accepted').length,
    settlements: file.settlements.map(s => ({ ...s, ...(Array.isArray(s.claims) ? { claims: s.claims.length } : {}) })), discoveries: file.discoveries.map(d => d.record), crafts: file.crafts,
    root: file.auditHash ?? null });
}
export const summaryBytes = file => utf8(stableJSON(viewerSummary(file)));
