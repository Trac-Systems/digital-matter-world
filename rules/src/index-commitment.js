import { hashObject, hashCanonicalText } from './core.js';

// Strings without UTF-16 surrogates need no pair-by-pair Unicode validation.
// JSON.stringify performs exactly the canonical encoder's escaping for them.
const jsonString = value => typeof value === 'string' && !/[\ud800-\udfff]/.test(value);
function branchHash(prefix, children) {
  const value = ['dmw-named-branch-v2', prefix, children];
  return jsonString(prefix) && children.every(pair => pair.every(jsonString))
    ? hashCanonicalText(JSON.stringify(value)) : hashObject(value);
}

// Constructing the entry pairs here avoids rechecking array shape on every
// copied radix path. Source strings still receive the same canonical validation.
export function indexBranchRootOf(prefix, children, rootOf) {
  return branchHash(prefix, Object.keys(children).sort().map(key => [key, rootOf(children[key])]));
}

// Branch commitments have a fixed, shallow array schema. JSON.stringify is
// byte-identical to canonical JSON for these arrays of validated strings;
// other inputs retain the general encoder and its validation errors.
export function indexBranchRoot(prefix, children) {
  const value = ['dmw-named-branch-v2', prefix, children];
  return Array.isArray(children) && !('toJSON' in children) && Object.keys(children).length === children.length &&
    children.every(pair => Array.isArray(pair) && !('toJSON' in pair) && pair.length === 2 && Object.keys(pair).length === 2)
    ? branchHash(prefix, children) : hashObject(value);
}

export function storedBranchHash(row) {
  const plain = value => value && typeof value === 'object' && !('toJSON' in value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (plain(row) && Object.keys(row).length === 3 && ['children', 'commitment', 'prefix'].every(key => Object.hasOwn(row, key)) && jsonString(row.prefix) &&
      jsonString(row.commitment) && plain(row.children)) {
    const keys = Object.keys(row.children).sort();
    if (keys.every(key => /^[0-9a-f]$/.test(key) && plain(row.children[key]) && Object.keys(row.children[key]).length === 2 && Object.hasOwn(row.children[key], 'commitment') && Object.hasOwn(row.children[key], 'storage') &&
        jsonString(row.children[key].commitment) && jsonString(row.children[key].storage))) {
      const children = Object.fromEntries(keys.map(key => [key, { commitment: row.children[key].commitment, storage: row.children[key].storage }]));
      return hashCanonicalText(JSON.stringify(['dmw-stored-index-v2', { children, commitment: row.commitment, prefix: row.prefix }]));
    }
  }
  return hashObject(['dmw-stored-index-v2', row]);
}
