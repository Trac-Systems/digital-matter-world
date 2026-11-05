import { hashCanonicalText, hashObject, stableJSON, unicode, utf8 } from './core.js';
import { canonicalJSON } from '../../contract/signing.js';
import { indexBranchRootOf } from './index-commitment.js';

// Only rows owned by a reader may opt into memoization. Freezing the whole
// document makes cached authentication and size checks safe across consumers;
// ordinary mutable adapters retain their existing validation on every read.
const immutable = new WeakMap();
function freezeDepth(value) {
  if (!value || typeof value !== 'object') return 0;
  const known = immutable.get(value); if (known) return known.depth;
  let depth = 0;
  for (const child of Object.values(value)) depth = Math.max(depth, 1 + freezeDepth(child));
  Object.freeze(value); return depth;
}
export function immutableIndexRow(row) {
  if (row && typeof row === 'object' && !immutable.has(row)) {
    immutable.set(row, { depth: freezeDepth(row) });
  }
  return row;
}
function rowJSON(row, depth) {
  const memo = immutable.get(row);
  if (!memo) return canonicalJSON(row, depth, unicode);
  if (memo.text === undefined) {
    memo.text = canonicalJSON(row, depth, unicode); memo.validatedDepth = depth;
  } else if (depth > memo.validatedDepth) {
    // Depth is part of canonical validation even though it changes no bytes.
    if (depth + memo.depth > 16) throw new TypeError('json_depth');
    memo.validatedDepth = depth;
  }
  return memo.text;
}
export function indexRowBytes(row, depth = 0) {
  const text = rowJSON(row, depth), memo = immutable.get(row);
  return memo ? memo.bytes ??= utf8(text).length : utf8(text).length;
}
export function indexRowHash(row) {
  const memo = immutable.get(row);
  if (!memo) return hashObject(['dmw-stored-index-v2', row]);
  return memo.hash ??= hashCanonicalText('["dmw-stored-index-v2",' + rowJSON(row, 1) + ']');
}
export function indexRowCommitment(row) {
  const memo = immutable.get(row);
  const calculate = () => row.children ? indexBranchRootOf(row.prefix, row.children, child => child.commitment) :
    hashObject(['dmw-named-leaf-v2', row.prefix, row.key, row.value]);
  return memo ? memo.commitment ??= calculate() : calculate();
}

// Bound both row count and canonical bytes. Oversized rows remain valid but
// are read through without displacing the entire useful working set.
export class IndexRowCache {
  constructor(entries, bytes) {
    if (!Number.isSafeInteger(entries) || entries < 1 || !Number.isSafeInteger(bytes) || bytes < 1) throw Error('index_row_cache_setting');
    this.entries = entries; this.limit = bytes; this.bytes = 0; this.rows = new Map();
  }
  has(id) { return this.rows.has(id); }
  delete(id) {
    const row = this.rows.get(id);
    if (row) { this.bytes -= indexRowBytes(row); this.rows.delete(id); }
  }
  get(id) {
    const row = this.rows.get(id);
    if (row) { this.rows.delete(id); this.rows.set(id, row); }
    return row;
  }
  set(id, value) {
    const row = immutableIndexRow(value); if (!row) return row;
    const size = indexRowBytes(row);
    const old = this.rows.get(id);
    if (old) { this.bytes -= indexRowBytes(old); this.rows.delete(id); }
    if (size > this.limit) return row;
    while (this.rows.size && (this.rows.size >= this.entries || this.bytes + size > this.limit)) {
      const first = this.rows.keys().next().value;
      this.bytes -= indexRowBytes(this.rows.get(first)); this.rows.delete(first);
    }
    this.rows.set(id, row); this.bytes += size; return row;
  }
}
