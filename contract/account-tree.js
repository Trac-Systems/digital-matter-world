import { sha256, utf8ToBytes, bytesToHex, hexToBytes, canonicalJSON, jsonBytes } from './signing.js';
import { assetSettings } from './asset-settings.js';

const check = (ok, reason) => { if (!ok) throw Error(reason); };
const hex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const digest = x => bytesToHex(sha256(utf8ToBytes(x)));
export const accountKey = (kind, id) => digest('dmw-account-key-v2|' + canonicalJSON([kind, id]));
const leaf = (key, value) => value === null ? EMPTY[256] : digest('dmw-account-leaf-v2|' + key + '|' + canonicalJSON(value));
const branch = (left, right) => {
  const bytes = new Uint8Array(65); bytes[0] = 2; bytes.set(hexToBytes(left), 1); bytes.set(hexToBytes(right), 33);
  return bytesToHex(sha256(bytes));
};
const EMPTY = new Array(257); EMPTY[256] = digest('dmw-account-empty-v2');
for (let depth = 255; depth >= 0; depth--) EMPTY[depth] = branch(EMPTY[depth + 1], EMPTY[depth + 1]);
export const EMPTY_ACCOUNT_ROOT = EMPTY[0];
export const accountEmptyRoot = depth => EMPTY[depth];
export const accountBranch = branch;
export const accountLeaf = leaf;
const bit = (key, depth) => (parseInt(key[Math.floor(depth / 4)], 16) >> (3 - depth % 4)) & 1;
const split = (rows, depth) => { const i = rows.findIndex(r => bit(r.key, depth)); return i < 0 ? [rows, []] : [rows.slice(0, i), rows.slice(i)]; };

// A shared frontier reconstructs both roots. Empty subtrees are omitted;
// nonempty frontier nodes carry the DFS position, so no bitmap scales with 256
// times the leaf count. All supplied nodes must be used exactly once.
export function verifyAccountProof(root, proof, replacements, limits = {}) {
  const settings = assetSettings(limits);
  if (proof?.empty === true) {
    check(Object.keys(proof).length === 1 && root === EMPTY_ACCOUNT_ROOT && replacements instanceof Map && replacements.size > 0 &&
      replacements.size <= settings.accountLeaves, 'account_empty_proof');
    return accountTree(replacements).root;
  }
  check(hex(root) && proof && Array.isArray(proof.leaves) && Array.isArray(proof.nodes), 'account_proof');
  check(proof.leaves.length > 0 && proof.leaves.length <= settings.accountLeaves && proof.nodes.length <= settings.proofNodes && jsonBytes(proof) <= settings.proofBytes, 'account_proof_budget');
  check(replacements instanceof Map && replacements.size === proof.leaves.length, 'account_replacements');
  let previous = '';
  for (const row of proof.leaves) {
    check(row && Object.keys(row).length === 2 && hex(row.key) && row.key > previous && Object.hasOwn(row, 'value') && replacements.has(row.key), 'account_leaf_order');
    previous = row.key;
  }
  let frontier = 0, cursor = 0;
  const walk = (rows, depth) => {
    if (!rows.length) {
      const node = proof.nodes[cursor], position = frontier++;
      if (node && node[0] === position) {
        check(Array.isArray(node) && node.length === 2 && hex(node[1]) && node[1] !== EMPTY[depth], 'account_frontier'); cursor++;
        return [node[1], node[1]];
      }
      check(!node || Number.isSafeInteger(node[0]) && node[0] > position, 'account_frontier_order');
      return [EMPTY[depth], EMPTY[depth]];
    }
    if (depth === 256) { const row = rows[0]; return [leaf(row.key, row.value), leaf(row.key, replacements.get(row.key))]; }
    const [left, right] = split(rows, depth), l = walk(left, depth + 1), r = walk(right, depth + 1);
    // A read proof reconstructs identical before/after paths. New leaves also
    // have long empty predecessor paths in this sparse tree. Reuse these exact
    // commitments instead of hashing each unchanged/empty branch twice.
    const old = l[0] === EMPTY[depth + 1] && r[0] === EMPTY[depth + 1] ? EMPTY[depth] : branch(l[0], r[0]);
    const next = l[0] === l[1] && r[0] === r[1] ? old :
      l[1] === EMPTY[depth + 1] && r[1] === EMPTY[depth + 1] ? EMPTY[depth] : branch(l[1], r[1]);
    return [old, next];
  };
  const [oldRoot, newRoot] = walk(proof.leaves, 0);
  check(cursor === proof.nodes.length && oldRoot === root, 'account_root');
  return newRoot;
}

// Availability-side builder. The contract verifier never enumerates this map.
// Production callers persist nodes and fetch only paths for the named keys.
export function accountTree(entries = new Map()) {
  const rows = [...entries].filter(([, v]) => v !== null).map(([key, value]) => ({ key, value })).sort((a, b) => a.key < b.key ? -1 : 1);
  check(rows.every(r => hex(r.key)), 'account_key');
  const build = (list, depth) => {
    if (!list.length) return { root: EMPTY[depth] };
    if (depth === 256) return { root: leaf(list[0].key, list[0].value) };
    const [l, r] = split(list, depth), left = build(l, depth + 1), right = build(r, depth + 1);
    return { root: branch(left.root, right.root), left, right };
  };
  const tree = build(rows, 0);
  return { root: tree.root, prove(keys) {
    const leaves = [...new Set(keys)].sort().map(key => ({ key, value: entries.get(key) ?? null }));
    check(leaves.length && leaves.every(r => hex(r.key)), 'account_keys');
    const nodes = []; let frontier = 0;
    const walk = (node, list, depth) => {
      if (!list.length) { const position = frontier++; if (node?.root && node.root !== EMPTY[depth]) nodes.push([position, node.root]); return; }
      if (depth === 256) return;
      const [left, right] = split(list, depth); walk(node?.left, left, depth + 1); walk(node?.right, right, depth + 1);
    };
    walk(tree, leaves, 0); return { leaves, nodes };
  } };
}

export function readAccountLeaf(root, proof, key, settings) {
  check(proof.leaves.length === 1 && proof.leaves[0].key === key, 'account_read');
  verifyAccountProof(root, proof, new Map([[key, proof.leaves[0].value]]), settings);
  return proof.leaves[0].value;
}
