import { accountEmptyRoot, accountBranch, accountLeaf, verifyAccountProof } from '../../contract/account-tree.js';
import { check } from './util.mjs';

const bit = (key, depth) => (parseInt(key[Math.floor(depth / 4)], 16) >> (3 - depth % 4)) & 1;
const split = (rows, depth) => { const i = rows.findIndex(r => bit(r.key, depth)); return i < 0 ? [rows, []] : [rows.slice(0, i), rows.slice(i)]; };
// Content-addressed paths are read only for the requested keys. No account or
// asset enumeration is available to this online proof producer.
export class AccountAvailability {
  constructor(store) { this.store = store; this.pending = new Map(); }
  node(root, depth, expanded) {
    if (root === accountEmptyRoot(depth)) return null;
    if (expanded?.has(root)) { const row = expanded.get(root); expanded.delete(root); return row.node; }
    const row = this.pending.get(root) ?? this.store.get('accountNodes', root);
    if (row?.skip !== undefined) {
      check(Object.keys(row).length === 2 && typeof row.skip === 'string' && /^[01]+$/.test(row.skip) &&
        depth + row.skip.length <= 256 && /^[0-9a-f]{64}$/.test(row.child), 'account_availability');
      // Local storage compresses unary sparse-tree paths. Reconstruct and
      // authenticate the exact original binary commitments before using them;
      // contract roots and wire proofs retain their original encoding.
      let hash = row.child; const nodes = new Map();
      for (let i = row.skip.length - 1; i >= 0; i--) {
        const empty = accountEmptyRoot(depth + i + 1), node = row.skip[i] === '0' ? { left: hash, right: empty } : { left: empty, right: hash };
        hash = accountBranch(node.left, node.right); nodes.set(hash, { node, compact: { skip: row.skip.slice(i), child: row.child } });
      }
      check(hash === root, 'account_availability');
      const first = nodes.get(root).node; nodes.delete(root);
      if (expanded) for (const [hash, node] of nodes) expanded.set(hash, node);
      return first;
    }
    check(row && (depth === 256 ? accountLeaf(row.key, row.value) : accountBranch(row.left, row.right)) === root, 'account_availability'); return row;
  }
  prove(root, keys, frontierRows) {
    const leaves = [...new Set(keys)].sort().map(key => ({ key, value: null })), nodes = [], expanded = new Map(); let frontier = 0;
    check(leaves.length > 0, 'account_keys');
    const walk = (hash, rows, depth) => {
      if (!rows.length) {
        const position = frontier++;
        if (hash !== accountEmptyRoot(depth)) {
          nodes.push([position, hash]);
          const compact = expanded.get(hash)?.compact;
          if (compact && frontierRows) frontierRows.set(hash, compact);
        }
        return;
      }
      const node = this.node(hash, depth, expanded);
      if (depth === 256) { if (node) { check(node.key === rows[0].key, 'account_leaf'); rows[0].value = node.value; } return; }
      const [left, right] = split(rows, depth);
      walk(node?.left ?? accountEmptyRoot(depth + 1), left, depth + 1); walk(node?.right ?? accountEmptyRoot(depth + 1), right, depth + 1);
    };
    walk(root, leaves, 0); return { leaves, nodes };
  }
  update(root, proof, replacements, settings) {
    const expected = verifyAccountProof(root, proof, replacements, settings);
    const leaves = proof.empty ? [...replacements].sort(([a], [b]) => a < b ? -1 : 1).map(([key]) => ({ key, value: null })) : proof.leaves;
    const nodes = proof.nodes ?? [], staged = new Map(); let frontier = 0, cursor = 0;
    // A partial update can split a stored compact path at a virtual frontier.
    // Authenticate the predecessor's requested paths and persist those suffixes
    // before the new root references them. This also works with a serialized
    // proof produced by another instance; read-only proofs retain no cache.
    if (!proof.empty) this.prove(root, leaves.map(row => row.key), staged);
    const keep = (hash, depth, node) => { if (hash !== accountEmptyRoot(depth)) staged.set(hash, node); return hash; };
    const walk = (rows, depth) => {
      if (!rows.length) { const position = frontier++; return nodes[cursor]?.[0] === position ? nodes[cursor++][1] : accountEmptyRoot(depth); }
      if (depth === 256) { const key = rows[0].key, value = replacements.get(key); return keep(accountLeaf(key, value), depth, { key, value }); }
      const [l, r] = split(rows, depth), left = walk(l, depth + 1), right = walk(r, depth + 1);
      const empty = accountEmptyRoot(depth + 1), hash = accountBranch(left, right);
      if (left === empty || right === empty) {
        const direction = left === empty ? '1' : '0', child = left === empty ? right : left, lower = staged.get(child);
        if (lower?.skip) {
          staged.delete(child); return keep(hash, depth, { skip: direction + lower.skip, child: lower.child });
        }
        return keep(hash, depth, { skip: direction, child });
      }
      return keep(hash, depth, { left, right });
    };
    check(walk(leaves, 0) === expected, 'account_availability_root');
    for (const [hash, node] of staged) this.pending.set(hash, node);
    return expected;
  }
  writes() { return [...this.pending].map(([id, value]) => ({ space: 'accountNodes', id, value })); }
}
