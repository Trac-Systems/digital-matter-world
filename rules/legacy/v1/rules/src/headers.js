import { assert, integer, hexToBytes, bytesToHex, hashBytes, hash } from './core.js';
export const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
export function targetFromBits(bits) {
  assert(integer(bits, 0xffffffff), 'bits');
  const size = bits >>> 24, word = bits & 0x7fffff;
  assert(word && !(bits & 0x800000) && size <= 34 && !(word > 255 && size > 33) && !(word > 65535 && size > 32), 'target');
  const n = size <= 3 ? BigInt(word) >> BigInt(8 * (3 - size)) : BigInt(word) << BigInt(8 * (size - 3));
  assert(n > 0n && n < 1n << 256n, 'target'); return n;
}
export function bitsFromTarget(n) {
  assert(typeof n === 'bigint' && n > 0n && n < 1n << 256n, 'target');
  let size = Number((BigInt(n.toString(16).length) + 1n) / 2n);
  let word = size <= 3 ? Number(n << BigInt(8 * (3 - size))) : Number(n >> BigInt(8 * (size - 3)));
  if (word & 0x800000) { word >>= 8; size++; }
  return size * 0x1000000 + word;
}
export function parseHeader(input, height = 0) {
  const raw = typeof input === 'string' ? hexToBytes(input) : input;
  assert(raw instanceof Uint8Array && raw.length === 80 && integer(height, 0xffffffff), 'header');
  const v = new DataView(raw.buffer, raw.byteOffset, 80);
  return { height, hash: bytesToHex(hashBytes(hashBytes(raw)).reverse()),
    prev: bytesToHex(Uint8Array.from(raw.subarray(4, 36)).reverse()), version: v.getInt32(0, true),
    time: v.getUint32(68, true), bits: v.getUint32(72, true), nonce: v.getUint32(76, true) };
}
export class HeaderHistory {
  constructor(bytes) {
    assert(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length % 80 === 0, 'headers_length');
    this.bytes = new Uint8Array(bytes); this.length = bytes.length / 80;
    this.view = new DataView(this.bytes.buffer);
  }
  raw(height) { assert(integer(height) && height < this.length, 'history_height'); return this.bytes.slice(height * 80, (height + 1) * 80); }
  get(height) { return parseHeader(this.raw(height), height); }
  field(height, field, dt = 'n') {
    assert(integer(height) && height < this.length, 'history_height');
    assert((field === 4 || field === 10) ? dt === 'n' : field === 11 && (dt === 'n' || dt === 'h'), 'field');
    const n = field === 4 ? height : this.view.getUint32(height * 80 + (field === 10 ? 76 : 72), true);
    return n.toString(dt === 'h' ? 16 : 10);
  }
}
export function verifyHistory(history) {
  const limit = targetFromBits(0x1d00ffff);
  let previous, periodTime, work = 0n, times = [];
  for (let height = 0; height < history.length; height++) {
    const h = history.get(height), target = targetFromBits(h.bits);
    assert(target <= limit && BigInt(`0x${h.hash}`) <= target, `header_pow:${height}`);
    if (!height) {
      assert(h.hash === GENESIS_HASH && h.prev === '0'.repeat(64), 'genesis'); periodTime = h.time;
    } else {
      assert(h.prev === previous.hash, `header_link:${height}`);
      let expected = previous.bits;
      if (height % 2016 === 0) {
        const elapsed = Math.max(302400, Math.min(4838400, previous.time - periodTime));
        const next = targetFromBits(previous.bits) * BigInt(elapsed) / 1209600n;
        expected = bitsFromTarget(next > limit ? limit : next); periodTime = h.time;
      }
      assert(h.bits === expected, `header_bits:${height}`);
      const sorted = [...times].sort((a, b) => a - b);
      assert(h.time > sorted[Number(BigInt(sorted.length) / 2n)], `header_time:${height}`);
    }
    times.push(h.time); if (times.length > 11) times.shift();
    work += (1n << 256n) / (target + 1n); previous = h;
  }
  return { count: history.length, tip: previous.hash, chainwork: work.toString(), sha256: hash(history.bytes) };
}
