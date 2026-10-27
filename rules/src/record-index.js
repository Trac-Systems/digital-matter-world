import { hash } from './core.js';
// Persistent compressed radix index. Updates copy at most 64 small nodes; unary
// paths are compressed so retained tree size is linear in the number of keys.
// Current gateway replay hydrates flat row maps; the first update shares that
// immutable base and adds a radix path. Subsequent observations reuse the index.
const wrap = index => index?.$dmwIndex ? index : { $dmwIndex: 1, base: index ?? {}, root: null, size: Object.keys(index ?? {}).length };
function find(node, path, offset = 0) {
  if (!node || !path.startsWith(node.prefix, offset)) return null;
  offset += node.prefix.length;
  return offset === path.length ? node : find(node.children?.[path[offset]], path, offset);
}
export function recordGet(index, key) {
  if (!index?.$dmwIndex) return index?.[key];
  const node = find(index.root, hash(String(key)));
  return node ? node.value : index.base?.[key];
}
function put(node, path, key, value, offset = 0) {
  if (!node) return { prefix: path.slice(offset), key: String(key), ...(value === undefined ? {} : { value }) };
  let common = 0;
  while (common < node.prefix.length && node.prefix[common] === path[offset + common]) common++;
  if (common < node.prefix.length) return { prefix: node.prefix.slice(0, common), children: {
    [node.prefix[common]]: { ...node, prefix: node.prefix.slice(common) },
    [path[offset + common]]: put(null, path, key, value, offset + common),
  } };
  offset += common;
  if (offset === path.length) return { prefix: node.prefix, key: String(key), ...(value === undefined ? {} : { value }) };
  return { ...node, children: { ...node.children, [path[offset]]: put(node.children[path[offset]], path, key, value, offset) } };
}
export function recordSet(index, key, value) {
  const map = wrap(index);
  return { ...map, root: put(map.root, hash(String(key)), key, value), size: map.size + (recordGet(map, key) === undefined ? 1 : 0) };
}
export function recordObject(index) {
  if (!index?.$dmwIndex) return index ?? {};
  const out = { ...index.base };
  const visit = node => {
    if (!node) return;
    if (node.children) for (const child of Object.values(node.children)) visit(child);
    else if (node.value === undefined) delete out[node.key];
    else Object.defineProperty(out, node.key, { value: node.value, enumerable: true, configurable: true, writable: true });
  };
  visit(index.root); return out;
}
export const recordSize = index => index?.$dmwIndex ? index.size : Object.keys(index ?? {}).length;
export function recordDelete(index, key) {
  if (recordGet(index, key) === undefined) return index;
  const map = wrap(index), path = hash(String(key));
  if (Object.hasOwn(map.base, key)) return { ...map, root: put(map.root, path, key, undefined), size: map.size - 1 };
  const remove = (node, offset = 0) => {
    if (!node || !path.startsWith(node.prefix, offset)) return node;
    offset += node.prefix.length;
    if (offset === path.length) return null;
    const children = { ...node.children }, child = remove(children[path[offset]], offset);
    if (child) children[path[offset]] = child; else delete children[path[offset]];
    const remaining = Object.values(children);
    return remaining.length === 0 ? null : remaining.length === 1 ? { ...remaining[0], prefix: node.prefix + remaining[0].prefix } : { ...node, children };
  };
  return { ...map, root: remove(map.root), size: map.size - 1 };
}
