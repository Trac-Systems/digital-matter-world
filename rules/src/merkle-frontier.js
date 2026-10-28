import { hash, hashBytes, utf8, hexToBytes, bytesToHex, stableJSON } from './core.js';
const join = (tag, ...parts) => {
  const bytes = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0)); bytes[0] = tag;
  let offset = 1; for (const p of parts) { bytes.set(p, offset); offset += p.length; } return bytes;
};
const parent = (a, b) => bytesToHex(hashBytes(join(1, hexToBytes(a), hexToBytes(b))));
export const emptyFrontier = () => ({ count: '0', peaks: [] });
export function appendFrontier(frontier, value) {
  let node = bytesToHex(hashBytes(join(0, typeof value === 'string' ? utf8(value) : value))), level = 0, n = BigInt(frontier.count);
  const peaks = [...frontier.peaks];
  while (n & 1n) { node = parent(peaks[level], node); peaks[level++] = null; n >>= 1n; }
  peaks[level] = node; return { count: String(BigInt(frontier.count) + 1n), peaks };
}
export function frontierRoot({ count, peaks }) {
  if (count === '0') return hash(new Uint8Array([2]));
  let node, level = 0;
  for (let i = 0; i < peaks.length; i++) if (peaks[i]) {
    if (!node) { node = peaks[i]; level = i; continue; }
    while (level < i) { node = parent(node, node); level++; }
    node = parent(peaks[i], node); level = i + 1;
  }
  // Existing Merkle files use numeric leaf counts. This frontier is used for
  // bounded windows whose admitted row count remains a safe integer.
  const n = Number(count); if (!Number.isSafeInteger(n)) throw Error('merkle_count');
  return hash(join(3, utf8(stableJSON([n, node]))));
}
