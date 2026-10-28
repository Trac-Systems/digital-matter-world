import { assert, integer, hex, utf8, hexToBytes, bytesToHex, hash, hashBytes, stableJSON } from './core.js';
function concat(...arrays) { const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0)); let offset = 0; for (const a of arrays) { out.set(a, offset); offset += a.length; } return out; }
const leafHash = bytes => hashBytes(concat(new Uint8Array([0]), bytes));
const parentHash = (a, b) => hashBytes(concat(new Uint8Array([1]), a, b));
const commitTree = (root, count) => hash(concat(new Uint8Array([3]), utf8(stableJSON([count, bytesToHex(root)]))));
export function merkleRoot(files) {
  if (!files.length) return hash(new Uint8Array([2]));
  let level = files.map(f => leafHash(typeof f === 'string' ? utf8(f) : f));
  while (level.length > 1) {
    const next = []; for (let i = 0; i < level.length; i += 2) next.push(parentHash(level[i], level[i + 1] ?? level[i])); level = next;
  }
  return commitTree(level[0], files.length);
}
export function merkleProof(files, index) {
  assert(integer(index) && index < files.length, 'merkle_index');
  let level = files.map(f => leafHash(typeof f === 'string' ? utf8(f) : f)), cursor = index;
  const siblings = [];
  while (level.length > 1) {
    siblings.push(bytesToHex(level[cursor ^ 1] ?? level[cursor]));
    const next = []; for (let i = 0; i < level.length; i += 2) next.push(parentHash(level[i], level[i + 1] ?? level[i]));
    level = next; cursor = Math.floor(cursor / 2);
  }
  return { index, count: files.length, siblings };
}
export function verifyMerkle(file, proof, root) {
  try {
    assert(integer(proof.index) && integer(proof.count) && proof.index < proof.count && hex(root, 32), 'proof');
    let n = proof.count, i = proof.index, current = leafHash(typeof file === 'string' ? utf8(file) : file), cursor = 0;
    while (n > 1) {
      const sibling = hexToBytes(proof.siblings[cursor++]); assert(sibling.length === 32, 'proof');
      if (i === n - 1 && n % 2) assert(bytesToHex(sibling) === bytesToHex(current), 'proof_duplicate');
      current = i % 2 ? parentHash(sibling, current) : parentHash(current, sibling); n = Math.ceil(n / 2); i = Math.floor(i / 2);
    }
    return cursor === proof.siblings.length && commitTree(current, proof.count) === root;
  } catch { return false; }
}
