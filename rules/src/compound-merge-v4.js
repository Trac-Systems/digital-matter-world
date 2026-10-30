import { assert, exactKeys, hashObject, hex } from './core.js';
import { compareUint, uintV2 } from './integers-v2.js';
import { namedGet, namedSet } from './named-index.js';
import { exactGet, exactSet } from './compounds-v2.js';
import { compoundIdentityV4, compoundIdentityV4Active, compoundRecordCommitment } from './compound-identity-v4.js';
import { COMPOUND_IDENTITY_V4_MERGES } from './compound-merge-manifest.js';

export const COMPOUND_MERGE_MARKER = 'compound/identity-v4';
export const COMPOUND_MERGE_ACCOUNT_MARKER = 'ar/compound-identity-v4';
export function compoundMergeManifest(network, height, manifest = COMPOUND_IDENTITY_V4_MERGES) {
  if (!compoundIdentityV4Active(height) || manifest.network !== network) return null;
  assert(manifest.ready === true, 'compound_merge_manifest_unprepared');
  return manifest;
}
export function validateCompoundMerges(manifest) {
  assert(exactKeys(manifest, ['network', 'ready', 'rows']) && manifest.ready === true && Array.isArray(manifest.rows), 'compound_merge_manifest');
  const pairs = new Set(), targets = new Map();
  for (const row of manifest.rows) {
    assert(exactKeys(row, ['oldId', 'newId', 'holder', 'amount']) && /^c2:[0-9a-f]{64}$/.test(row.oldId) &&
      /^c2:[0-9a-f]{64}$/.test(row.newId) && row.oldId !== row.newId && hex(row.holder, 32), 'compound_merge_row');
    uintV2(row.amount);
    const key = row.oldId + '/' + row.holder;
    assert(!pairs.has(key) && (!targets.has(row.oldId) || targets.get(row.oldId) === row.newId), 'compound_merge_duplicate');
    pairs.add(key); targets.set(row.oldId, row.newId);
  }
  for (const id of targets.values()) assert(!targets.has(id), 'compound_merge_target');
  return targets;
}
export const compoundMergeAction = merge => merge ? [{ type: 'compound-merge', manifest: merge.manifest }] : [];

// One fixed conversion at the first execution at/after the gate. Subsequent
// observations/crafts do only a marker point read; no history or catalog scan.
export function mergeCompoundCatalogV4(state, { network, height, manifest = COMPOUND_IDENTITY_V4_MERGES }) {
  const active = compoundMergeManifest(network, height, manifest);
  if (!active || namedGet(state.records, COMPOUND_MERGE_MARKER)) return { state, merge: null };
  const targets = validateCompoundMerges(active), groups = new Map(), next = { ...state }, types = [];
  for (const [oldId, newId] of targets) {
    const old = exactGet(state, 'assets', oldId);
    assert(old?.v === 3 && old.id === oldId && old.commitment === oldId.slice(3) && compoundRecordCommitment(old) === old.commitment && !old.retired, 'compound_merge_source');
    const inputs = old.inputs.map(p => [targets.get(p.asset) ?? p.asset, p.amount]);
    const identity = compoundIdentityV4(old.recipe, inputs);
    assert(identity.id === newId && identity.amount === '1', 'compound_merge_identity');
    // No chain may retain a time-dependent compound as a canonical parent.
    for (const p of old.inputs) if (p.asset.startsWith('c2:')) assert(targets.has(p.asset), 'compound_merge_parent');
    const group = groups.get(newId) ?? [];
    group.push(old); groups.set(newId, group);
  }
  for (const [newId, records] of groups) {
    assert(!exactGet(state, 'assets', newId), 'compound_merge_target_exists');
    records.sort((a, b) => compareUint(a.snapshot.height, b.snapshot.height) || (a.id < b.id ? -1 : 1));
    const oldest = records[0], maker = namedGet(state.records, `compound/maker/${oldest.id}`);
    assert(hex(maker?.owner, 32), 'compound_merge_maker');
    const record = { ...oldest, id: newId, commitment: newId.slice(3), v: 4,
      inputs: oldest.inputs.map(p => ({ ...p, asset: targets.get(p.asset) ?? p.asset })).sort((a, b) => a.asset < b.asset ? -1 : 1) };
    exactSet(next, 'assets', newId, record);
    next.records = namedSet(next.records, `compound/maker/${newId}`, maker);
    const progress = exactGet(state, 'tiers', oldest.id);
    if (progress) exactSet(next, 'tiers', newId, progress);
    types.push({ ...record, firstMaker: maker.owner, ...(progress ? { tierProgress: progress } : {}) });
    for (const old of records) {
      const retired = { ...old, retired: true, mergedInto: newId };
      exactSet(next, 'assets', old.id, retired); types.push(retired);
    }
  }
  const commitment = hashObject(active);
  next.records = namedSet(next.records, COMPOUND_MERGE_MARKER, commitment);
  return { state: next, merge: { manifest: commitment, types } };
}
