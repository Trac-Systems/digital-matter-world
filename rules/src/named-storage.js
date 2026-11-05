import { hashObject } from './core.js';
import { namedRoot, EMPTY_NAMED_ROOT } from './named-index.js';
import { indexRowHash, indexRowCommitment } from './index-row-cache.js';
import { storedBranchHash } from './index-commitment.js';

// Persist only changed radix paths. Each row contains child hashes, never an
// embedded subtree. Cold loads are lazy and the cache is a bounded local
// resource. The root pointer and returned writes must share the caller's
// receipt/batch transaction; a partial write can never publish a new root.
export class NamedStorage {
  constructor({ get, cacheSize }) {
    if (typeof get !== 'function' || !Number.isSafeInteger(cacheSize) || cacheSize < 1) throw Error('named_storage_config');
    this.get = get; this.cacheSize = cacheSize; this.cache = new Map(); this.saved = new WeakMap(); this.views = new WeakMap();
  }
  row(root, ancestors = []) {
    try { return this.readRow(root, ancestors); }
    catch (error) {
      if (/^named_storage_/.test(error.message)) throw error;
      // Malformed remote JSON is a storage failure, never a rejected move.
      throw Error('named_storage_integrity');
    }
  }
  readRow(root, ancestors) {
    let row = this.cache.get(root);
    if (row && this.latest === root) return row;
    if (!row) {
      row = this.get(root, ancestors); if (!row || indexRowHash(row) !== root) throw Error('named_storage_integrity');
      if (row.commitment) {
        const commitment = indexRowCommitment(row);
        if (commitment !== row.commitment) throw Error('named_storage_commitment');
      }
    }
    this.latest = root; this.cache.delete(root); this.cache.set(root, row);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return row;
  }
  node(root, kind, expected, ancestors = []) {
    if (!root) return null;
    const proxy = {}, read = () => { const row = this.row(root, ancestors); if (expected && row.commitment !== expected) throw Error('named_storage_commitment'); return row; };
    Object.defineProperties(proxy, {
      prefix: { enumerable: true, get: () => read().prefix },
      children: { enumerable: true, get: () => {
        const row = read(); if (!row.children) return undefined;
        // Reuse lazy child handles while this verified row is in the bounded
        // cache. Recreating all siblings at every path access multiplies proxy
        // allocation by tree fanout, even for a single named lookup. Weak keys
        // let row eviction release these handles; no subtree is materialized.
        let views = this.views.get(row); if (!views) this.views.set(row, views = {});
        return views[kind] ??= Object.freeze(Object.fromEntries(Object.entries(row.children).map(([k, v]) => [k,
          kind === 'named' ? this.node(v.storage, kind, v.commitment, [root, ...ancestors]) : this.node(v, kind, undefined, [root, ...ancestors])])));
      } },
      key: { enumerable: true, get: () => read().key },
      value: { enumerable: true, get: () => kind === 'evidence' ? this.node(read().value, 'named', undefined, [root, ...ancestors]) : read().value },
      // A parent already authenticates each child commitment. Reading an
      // untouched sibling's root must not fetch that sibling's whole row.
      root: { enumerable: kind === 'named', get: () => expected ?? read().commitment }
    });
    this.saved.set(proxy, root); return proxy;
  }
  save(state) {
    const writes = new Map(), staged = new WeakMap(), acknowledged = [];
    const node = (value, kind) => {
      if (!value) return null;
      const saved = this.saved.get(value) ?? staged.get(value); if (saved) return saved;
      const children = value.children;
      const row = { prefix: value.prefix, ...(children ? { children: Object.fromEntries(Object.entries(children).map(([k, child]) => [k,
        kind === 'named' ? { storage: node(child, kind), commitment: namedRoot(child) } : node(child, kind)])) } :
        { key: value.key, value: kind === 'evidence' ? node(value.value, 'named') : value.value }),
        ...(kind === 'named' ? { commitment: namedRoot(value) } : {}) };
      const root = children && kind === 'named' ? storedBranchHash(row) : hashObject(['dmw-stored-index-v2', row]); writes.set(root, row); staged.set(value, root); acknowledged.push([value, root]); return root;
    };
    const evidence = value => {
      if (!value?.$dmwIndex) {
        if (Object.keys(value ?? {}).length) throw Error('named_storage_offline_import_required');
        return { root: null, size: 0 };
      }
      if (Object.keys(value.base ?? {}).length) throw Error('named_storage_offline_import_required');
      return { root: node(value.root, 'evidence'), size: value.size };
    };
    const snapshot = { version: state.version, nextPattern: state.nextPattern, catalogRevision: state.catalogRevision,
      records: node(state.records, 'named'), evidence: evidence(state.evidence), evidenceByRoot: evidence(state.evidenceByRoot),
      catalogRoot: state.records ? namedRoot(state.records) : EMPTY_NAMED_ROOT };
    return { snapshot, writes: [...writes].map(([id, value]) => ({ space: 'namedNodes', id, value })),
      committed: () => { for (const [value, root] of acknowledged) this.saved.set(value, root); } };
  }
  load(snapshot) {
    if (snapshot.records && this.row(snapshot.records).commitment !== snapshot.catalogRoot) throw Error('named_storage_commitment');
    const evidence = value => ({ $dmwIndex: 1, base: {}, root: this.node(value.root, 'evidence'), size: value.size });
    const state = { version: snapshot.version, nextPattern: snapshot.nextPattern, catalogRevision: snapshot.catalogRevision,
      records: this.node(snapshot.records, 'named', snapshot.catalogRoot), evidence: evidence(snapshot.evidence), evidenceByRoot: evidence(snapshot.evidenceByRoot) };
    if (namedRoot(state.records) !== snapshot.catalogRoot) throw Error('named_storage_catalog_root');
    return state;
  }
}
