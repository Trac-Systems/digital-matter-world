import { hash, hashObject } from './core.js';
import { freezeDocument } from './settings-v2.js';
import { indexBranchRootOf } from './index-commitment.js';

// Immutable compressed radix tree with cached child commitments. A named read
// or write follows at most 64 hexadecimal digits, independent of catalog size.
export const EMPTY_NAMED_ROOT = hashObject(['dmw-named-index-v2', null]);
export const namedRoot = node => node?.root ?? EMPTY_NAMED_ROOT;
function seal(node) {
  node.root = node.children ? indexBranchRootOf(node.prefix, node.children, child => child.root) :
    hashObject(['dmw-named-leaf-v2', node.prefix, node.key, node.value]);
  if (node.children) Object.freeze(node.children);
  return Object.freeze(node);
}
export function namedGet(node, key) {
  const path = hash(key); let offset = 0;
  while (node) {
    const prefix = node.prefix;
    if (!path.startsWith(prefix, offset)) return;
    offset += prefix.length;
    if (offset === path.length) return node.key === key ? node.value : undefined;
    node = node.children?.[path[offset]];
  }
}
export function namedSet(index, key, value) {
  const path = hash(key);
  value = freezeDocument(structuredClone(value));
  function put(node, offset = 0) {
    if (!node) return seal({ prefix: path.slice(offset), key, value });
    const prefix = node.prefix;
    let common = 0;
    while (common < prefix.length && prefix[common] === path[offset + common]) common++;
    if (common < prefix.length) return seal({ prefix: prefix.slice(0, common), children: {
      [prefix[common]]: seal({ ...node, prefix: prefix.slice(common) }),
      [path[offset + common]]: put(null, offset + common)
    } });
    offset += common;
    if (offset === path.length) {
      if (node.key !== key) throw Error('named_index_hash_collision');
      return seal({ prefix, key, value });
    }
    const children = node.children;
    return seal({ prefix, children: { ...children, [path[offset]]: put(children[path[offset]], offset) } });
  }
  return put(index);
}
