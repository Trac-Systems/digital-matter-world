import { ed25519 } from '@noble/curves/ed25519';
import { assert, exactKeys, hex, hashObject, stableJSON, hexToBytes, digest, utf8 } from './core.js';
import { uintV2, compareUint, ordinalCodec } from './integers-v2.js';
import { namedGet, namedSet } from './named-index.js';
import { compoundV2, exactGet } from './compounds-v2.js';
import { NamedStorage } from './named-storage.js';
import { mergeCompoundCatalogV4 } from './compound-merge-v4.js';
import { compoundIdentityV4Active } from './compound-identity-v4.js';
import { patternCatalogId } from './public-claims.js';
import { namedStateRoot } from './named-execution.js';
export const craftActionDigest = (network, { sig, ...action }) => digest('dmw-account-action-v2', network, action);

export function validateCraftPayload(p, settings, executionHeight = '0') {
  assert(exactKeys(p, ['recipe', 'snapshot', 'action']) && ['fusion', 'resonance'].includes(p.recipe), 'craft_payload');
  assert(exactKeys(p.snapshot, ['height', 'hash']) && hex(p.snapshot.hash, 32), 'compound_snapshot'); uintV2(p.snapshot.height);
  const a = p.action;
  assert(exactKeys(a, ['type', 'owner', 'revision', 'nonce', 'until', 'in', 'out', 'compound', 'sig']) && a.type === 'craft' && hex(a.owner, 32) && hex(a.nonce, 32) && hex(a.sig, 64) && hex(a.compound, 32), 'craft_authorization');
  uintV2(a.revision); assert(ordinalCodec(typeof a.until === 'string').valid(a.until), 'craft_expiry');
  assert(Array.isArray(a.in) && a.in.length >= 2 && a.in.length <= settings.values.compoundInputs && Array.isArray(a.out) && a.out.length === 1, 'craft_inputs');
  for (const pairs of [a.in, a.out]) for (let i = 0; i < pairs.length; i++) {
    const row = pairs[i]; assert(Array.isArray(row) && row.length === 2 && (/^(p2:(0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/.test(row[0]) || pairs === a.in && compoundIdentityV4Active(executionHeight) && /^p[0-9a-z]{1,23}$/.test(row[0])) && (!i || pairs[i - 1][0] < row[0]), 'craft_inputs');
    uintV2(row[1]); assert(row[1] !== '0', 'craft_amount');
  }
}
export function previewCraftV2(state, { recipe, inputs, snapshot, settings, catalog = state, executionHeight = snapshot.height }) {
  // In batch execution catalog is the authenticated predecessor, so another
  // receipt's new occurrence count cannot reprice this signed recipe mid-batch.
  const migrated = mergeCompoundCatalogV4(state, { network: settings.network, height: executionHeight });
  if (migrated.merge) {
    catalog = catalog === state ? migrated.state : mergeCompoundCatalogV4(catalog, { network: settings.network, height: executionHeight }).state;
    state = migrated.state;
  }
  return compoundV2(state, { recipe, inputs, snapshot, settings, executionHeight, lookup(asset) {
    if (asset.startsWith('c2:')) return exactGet(catalog, 'assets', asset);
    const canonical = patternCatalogId(asset);
    const key = canonical && namedGet(catalog.records, `number/${canonical.slice(3)}`); return key && namedGet(catalog.records, `pattern/${key}`);
  } });
}
export function executeCraftV2(state, { move, settings, counted, executionHeight = counted, hashAt, provenance, catalog = state }) {
  const { recipe, snapshot, action } = move.p; validateCraftPayload(move.p, settings, executionHeight);
  assert(action.owner === move.a && ordinalCodec().compare(executionHeight, action.until) <= 0 && ed25519.verify(hexToBytes(action.sig), craftActionDigest(settings.network, action), hexToBytes(action.owner), { zip215: false }), 'craft_authorization');
  assert(compareUint(snapshot.height, counted) <= 0 && hashAt(snapshot.height) === snapshot.hash, 'compound_snapshot');
  const nonceKey = `craft-nonce/${move.a}/${action.nonce}`;
  assert(!namedGet(state.records, nonceKey), 'account_replay');
  const result = previewCraftV2(state, { recipe, inputs: action.in, snapshot, settings, catalog, executionHeight });
  assert(action.compound === result.record.commitment && stableJSON(action.out) === stableJSON([[result.record.id, result.amount]]), 'craft_output');
  result.state.records = namedSet(result.state.records, nonceKey, { commitment: result.record.commitment, provenance });
  const maker = `compound/maker/${result.record.id}`;
  if (!namedGet(result.state.records, maker)) result.state.records = namedSet(result.state.records, maker, { owner: move.a, provenance, created: counted, settingsHash: hashObject(settings) });
  return { state: result.state, craft: { id: result.record.id, firstMaker: namedGet(result.state.records, maker).owner, record: result.record, amount: result.amount, action } };
}
export function craftPreviewProof({ snapshot, get, recipe, inputs, anchor, settings, executionHeight = anchor.height }) {
  const nodes = new Map(), storage = new NamedStorage({ cacheSize: settings.values.proofDepth,
    get(id) { const row = get(id); if (row) nodes.set(id, row); return row; } });
  const state = storage.load(snapshot);
  const result = previewCraftV2(state, { recipe, inputs, snapshot: anchor, settings, executionHeight });
  const proof = { root: namedStateRoot(state), snapshot, nodes: [...nodes], record: result.record, amount: result.amount, existing: result.existing };
  assert(utf8(stableJSON(proof)).length <= settings.values.proofBytes, 'named_proof_budget'); return proof;
}
export function verifyCraftPreview(proof, { root, recipe, inputs, snapshot, settings, executionHeight = snapshot.height }) {
  assert(proof?.root === root && Array.isArray(proof.nodes) && utf8(stableJSON(proof)).length <= settings.values.proofBytes, 'craft_preview_proof');
  const nodes = new Map(proof.nodes), storage = new NamedStorage({ get: id => nodes.get(id), cacheSize: settings.values.proofDepth });
  const state = storage.load(proof.snapshot); assert(namedStateRoot(state) === root, 'craft_preview_root');
  const result = previewCraftV2(state, { recipe, inputs, snapshot, settings, executionHeight });
  assert(stableJSON(result.record) === stableJSON(proof.record) && result.amount === proof.amount, 'craft_preview_value');
  return { record: result.record, amount: result.amount, existing: result.existing };
}
