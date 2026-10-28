import { assert, stableJSON, utf8 } from './core.js';
import { NamedStorage } from './named-storage.js';
import { namedGet } from './named-index.js';
import { emptyNamedDiscovery } from './named-discovery.js';
import { namedStateRoot } from './named-execution.js';

export function proveNamedRecord({ snapshot, get, key, settings }) {
  const nodes = new Map(), storage = new NamedStorage({ cacheSize: settings.values.proofDepth,
    get(id) { const row = get(id); if (row) nodes.set(id, row); return row; } });
  const state = snapshot ? storage.load(snapshot) : emptyNamedDiscovery();
  const value = namedGet(state.records, key) ?? null;
  const proof = { key, root: namedStateRoot(state), snapshot: snapshot ?? null, nodes: [...nodes], value };
  assert(utf8(stableJSON(proof)).length <= settings.values.proofBytes, 'named_proof_budget'); return proof;
}
export function verifyNamedRecord(proof, { root, key, settings }) {
  assert(proof?.key === key && proof.root === root && Array.isArray(proof.nodes) &&
    utf8(stableJSON(proof)).length <= settings.values.proofBytes, 'named_record_proof');
  const nodes = new Map(proof.nodes), storage = new NamedStorage({ get: id => nodes.get(id), cacheSize: settings.values.proofDepth });
  const state = proof.snapshot ? storage.load(proof.snapshot) : emptyNamedDiscovery();
  assert(namedStateRoot(state) === root, 'named_record_root');
  const value = namedGet(state.records, key) ?? null;
  assert(stableJSON(value) === stableJSON(proof.value), 'named_record_value'); return value;
}
