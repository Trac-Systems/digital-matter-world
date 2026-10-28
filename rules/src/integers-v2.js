import { assert } from './core.js';

// JSON uses canonical decimal strings. No implicit Number conversion or wrap.
// Packet/proof byte budgets bound work; the integer format has no lifetime cap.
export function uintV2(value) {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'integer_v2');
  return value;
}
export function compareUint(a, b) {
  uintV2(a); uintV2(b);
  return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length < b.length ? -1 : 1;
}
export const addUint = (a, b) => (BigInt(uintV2(a)) + BigInt(uintV2(b))).toString();
export const nextUint = a => addUint(a, '1');
export function uintKeyV2(value) {
  uintV2(value); const length = String(value.length);
  return 'z'.repeat(length.length) + '!' + length + '!' + value;
}
export function intV2(value) {
  assert(typeof value === 'string' && /^(0|-?[1-9][0-9]*)$/.test(value), 'signed_integer_v2');
  return value;
}
// Explicit bridge for adapters which have not yet upgraded their storage
// offsets. Never silently round a consensus identifier into a JS Number.
export function safeNumberV2(value) {
  uintV2(value); const result = Number(value);
  assert(Number.isSafeInteger(result) && String(result) === value, 'adapter_integer_capability');
  return result;
}
export function decimalV2(value) {
  if (typeof value === 'string') return uintV2(value);
  assert(Number.isSafeInteger(value) && value >= 0, 'integer_v2'); return String(value);
}
export const patternAssetV2 = number => `p2:${uintV2(number)}`;
export function assetIdV2(value) {
  if (typeof value !== 'string') return false;
  if (/^c2:[0-9a-f]{64}$/.test(value)) return true;
  if (/^p2:(0|[1-9][0-9]*)$/.test(value)) return true;
  try { parseFindIdV2(value); return true; } catch { return false; }
}
function sqrtV2(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2)), y = (x + n / x) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; } return x;
}
export function heightToPlotV2(height) {
  const n = BigInt(uintV2(height)); if (!n) return { x: '0', y: '0' };
  const r = (sqrtV2(n) + 1n) / 2n, side = 2n * r, d = (side + 1n) ** 2n - 1n - n;
  const [x, y] = d < side ? [r - d, -r] : d < 2n * side ? [-r, -r + d - side] : d < 3n * side ? [-r + d - 2n * side, r] : [r, r - (d - 3n * side)];
  return { x: String(x), y: String(y) };
}
export function plotToHeightV2(x, y) {
  const a = BigInt(intV2(x)), b = BigInt(intV2(y)), ax = a < 0n ? -a : a, ay = b < 0n ? -b : b, r = ax > ay ? ax : ay;
  if (!r) return '0'; const side = 2n * r;
  const d = b === -r ? r - a : a === -r ? side + b + r : b === r ? 2n * side + a + r : 3n * side + r - b;
  return String((side + 1n) ** 2n - 1n - d);
}
export function findIdV2(height, pattern) { return `f2:${uintV2(height)}:${uintV2(pattern)}`; }
export function parseFindIdV2(id) {
  assert(typeof id === 'string', 'find_id_v2');
  const parts = id.split(':');
  assert(parts.length === 3 && parts[0] === 'f2', 'find_id_v2');
  return { height: uintV2(parts[1]), pattern: uintV2(parts[2]) };
}

// Resource-sized array positions remain numbers. Persistent clocks and IDs use
// this codec at activation; accepting a legacy number here is a lossless import,
// never an authorization to emit numeric v2 wire fields.
export function ordinalCodec(decimal = true) {
  const value = n => {
    if (typeof n === 'string') intV2(n);
    else assert(Number.isSafeInteger(n), 'integer_v2');
    return decimal ? String(n) : (assert(Number.isSafeInteger(Number(n)), 'integer_v2'), Number(n));
  };
  const compare = (a, b) => { const x = BigInt(value(a)), y = BigInt(value(b)); return x < y ? -1 : x > y ? 1 : 0; };
  const add = (a, b = 1) => value(String(BigInt(value(a)) + BigInt(value(b))));
  return { value, compare, add, zero: value(0), one: value(1),
    min: (a, b) => value(compare(a, b) < 0 ? a : b), max: (a, b) => value(compare(a, b) > 0 ? a : b),
    valid: n => decimal ? typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n) : Number.isSafeInteger(n) && n >= 0 };
}
export const compareOrdinal = (a, b) => ordinalCodec().compare(a, b);
