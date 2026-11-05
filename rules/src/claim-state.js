import { assert, hashObject, stableJSON, utf8 } from './core.js';
import { NamedStorage } from './named-storage.js';
import { namedRoot } from './named-index.js';
import { recordChanges, recordSet } from './record-index.js';
import { decimalV2, ordinalCodec } from './integers-v2.js';
import { decodeNodeHints } from './node-evidence.js';
import { indexRowBytes } from './index-row-cache.js';

export const CLAIM_MAPS = Object.freeze(['receiptSegments', 'claimAgents', 'claimInputs', 'claimSlots', 'claimReservations',
  'settlementPages', 'headerAwards', 'headerInputs', 'headerTickets', 'headerPools', 'finds']);
const HOT = Object.freeze(['counted', 'lastTip', 'highestTip', 'observation', 'rounds', 'lastSequence', 'namedSequence', 'settlementRoundCursor']);
export const claimStateRoot = snapshot => hashObject(['dmw-claim-state-v2', snapshot]);

// Start the new receipt domain from a deterministic empty checkpoint bound
// to the terminal notary. The pending-work importer fills this same schema
// with authenticated legacy rounds before the import roots are pinned.
export function initialClaimSnapshot(manifest, lastTo) {
  const clock = ordinalCodec(), tip = decimalV2(manifest.bitcoinAnchor.height);
  return { version: 1, hot: { counted: decimalV2(lastTo), lastTip: clock.add(tip, -1), highestTip: clock.add(tip, -1), observation: '0',
    rounds: [], lastSequence: '-1', namedSequence: '0', settlementRoundCursor: '0' },
    maps: Object.fromEntries(CLAIM_MAPS.map(k => [k, { storage: null, root: namedRoot(null) }])) };
}

// All reads (including absence) walk content-addressed paths. A missing node
// is an integrity failure, never an empty map. Saving shares untouched paths;
// neither proof generation nor restart enumerates lifetime rows.
export class ClaimStorage {
  constructor({ get, cacheSize }) {
    this.storage = new NamedStorage({ get, cacheSize });
    const row = this.storage.row.bind(this.storage);
    this.storage.row = (id, ancestors) => {
      try { return row(id, ancestors); }
      // Includes malformed/deep JSON, missing nodes and remote-reader errors.
      // None may be caught as an ordinary claim rejection by the move engine.
      catch { throw Error('claim_state_proof'); }
    };
  }
  load(state, { decimal = false } = {}) {
    const snapshot = state.claimSnapshot;
    assert(snapshot?.version === 1 && claimStateRoot(snapshot) === state.claimRoot, 'claim_state_predecessor');
    // Reject alternate hot-state copies as well as ignoring untrusted map
    // copies. Only this authenticated checkpoint drives execution.
    for (const k of HOT) assert(stableJSON(state[k] ?? snapshot.hot[k]) === stableJSON(snapshot.hot[k]), 'claim_state_hot');
    const hot = structuredClone(snapshot.hot);
    if (decimal) {
      // Authenticate the retained bytes above before crossing the execution
      // boundary. The old snapshot/root and untouched map nodes stay intact.
      const clock = ordinalCodec();
      for (const key of HOT) if (key !== 'rounds' && hot[key] !== undefined) hot[key] = clock.value(hot[key]);
      for (const round of hot.rounds) {
        for (const key of ['window', 'originalWindow', 'claimableHeight', 'inputPages', 'headerCount', 'cursor', 'pages', 'total', 'claimCount'])
          if (round[key] !== undefined && !(key === 'window' && String(round[key]).startsWith('lazy/'))) round[key] = clock.value(round[key]);
        if (round.catalog) for (const key of ['nextNumber', 'revision']) if (round.catalog[key] !== undefined) round.catalog[key] = clock.value(round.catalog[key]);
      }
    }
    const loaded = { ...state, ...hot, balances: {} };
    for (const k of CLAIM_MAPS) {
      const { storage, root } = snapshot.maps[k];
      assert(storage || root === namedRoot(null), 'claim_state_empty_root');
      loaded[k] = { $claimIndex: 1, root: this.storage.node(storage, 'named', root), changes: {} };
    }
    return loaded;
  }
  save(state) {
    const writes = new Map(), maps = {}, changes = {};
    for (const k of CLAIM_MAPS) {
      assert(state[k]?.$claimIndex === 1, 'claim_state_index');
      const saved = this.storage.save({ version: 2, nextPattern: '0', catalogRevision: '0', records: state[k].root, evidence: {}, evidenceByRoot: {} });
      maps[k] = { storage: saved.snapshot.records, root: saved.snapshot.catalogRoot };
      for (const row of saved.writes) writes.set(row.id, { ...row, space: 'claimNodes' });
      changes[k] = Object.entries(recordChanges(state[k])).reduce((index, [key, value]) => recordSet(index, key, value), {});
    }
    const snapshot = { version: 1, hot: Object.fromEntries(HOT.map(k => [k, state[k]])), maps };
    return { state: { ...state, ...changes, claimSnapshot: snapshot, claimRoot: claimStateRoot(snapshot) }, writes: [...writes.values()] };
  }
}

export function claimEvidenceReader(evidence, document, get) {
  const hints = evidence?.hints;
  assert(Array.isArray(evidence?.nodes) && utf8(stableJSON(hints === undefined ? evidence.nodes : { nodes: evidence.nodes, hints })).length <= document.values.auditTotalBytes, 'claim_proof_budget');
  decodeNodeHints(hints, 'claim_proof_hints');
  const nodes = new Map(evidence.nodes);
  assert(nodes.size === evidence.nodes.length, 'claim_proof_duplicate');
  return (id, ancestors) => {
    let row;
    try { row = nodes.get(id) ?? get?.(id, ancestors); } catch { throw Error('claim_node_read'); }
    assert(!row || indexRowBytes(row) <= document.values.auditTotalBytes, 'claim_proof_node_budget');
    return row;
  };
}
