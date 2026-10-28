import { assert, hashObject, hex, stableJSON, utf8 } from './core.js';
import { uintV2, compareUint, nextUint, patternAssetV2 } from './integers-v2.js';
import { validateSettingsDocument } from './settings-v2.js';
import { namedGet, namedSet } from './named-index.js';

// Positive integer masses and rational known-match fractions are immutable
// arithmetic circuits. Each recipe adds O(inputs) bytes and references its
// parents; generation and expanded digit counts never gate another craft.
// Fixed-point intervals are certificates for display/tier evaluation only.
// The exact expression root, not its approximation, defines the asset.
export const emptyExactCompounds = () => ({ version: 2, nodes: null, certificates: null, assets: null });
// Activated execution keeps every expression and certificate under the same
// authenticated named root as the catalog. Standalone previews use local trees.
export const exactGet = (state, space, key) => namedGet(Object.hasOwn(state, 'records') ? state.records : state[space], Object.hasOwn(state, 'records') ? `compound/${space}/${key}` : key);
export function exactSet(state, space, key, value) {
  if (Object.hasOwn(state, 'records')) state.records = namedSet(state.records, `compound/${space}/${key}`, value);
  else state[space] = namedSet(state[space], key, value);
}
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const ceil = (a, b) => (a + b - 1n) / b;
function putNode(state, node) {
  const root = hashObject(['dmw-exact-v2', node]);
  exactSet(state, 'nodes', root, node); return root;
}
const certificateKey = (root, bits) => `${root}/${bits}`;
function certificate(state, root, bits) { return exactGet(state, 'certificates', certificateKey(root, bits)); }
function policy(settings) { validateSettingsDocument(settings); return settings.values; }
function setCertificate(state, root, bits, low, high, exact = null) {
  const value = { root, bits, low: String(low), high: String(high), exact };
  exactSet(state, 'certificates', certificateKey(root, bits), value); return value;
}
// One named node is refined at a time. Missing child certificates describe
// resumable work, not a limit on the age/size/depth of a compound. Callers store
// progress and schedule those named dependencies, never recursively expand a
// recipe on an admission path.
export function refineExactFraction(state, root, bits, settings) {
  const s = policy(settings);
  assert(Number.isSafeInteger(bits) && bits > 0 && bits <= s.compoundPrecisionBits, 'compound_precision_budget');
  const cached = certificate(state, root, bits); if (cached) return { state, certificate: cached, needed: [] };
  const node = exactGet(state, 'nodes', root); assert(node && ['fraction', 'product'].includes(node.op), 'exact_fraction_unknown');
  const next = { ...state }, Q = 1n << BigInt(bits);
  if (node.op === 'fraction') {
    const n = BigInt(node.n), d = BigInt(node.d);
    const g = gcd(n, d);
    return { state: next, certificate: setCertificate(next, root, bits, n * Q / d, ceil(n * Q, d), { n: String(n / g), d: String(d / g) }), needed: [] };
  }
  assert(node.terms.length <= s.compoundInputs && node.terms.reduce((n, t) => n + BigInt(t.power), 0n) <= BigInt(s.compoundWorkBudget), 'compound_work_budget');
  const needed = node.terms.filter(t => !certificate(state, t.root, bits)).map(t => t.root);
  if (needed.length) return { state, certificate: null, needed: [...new Set(needed)] };
  let low = Q, high = Q, exact = { n: 1n, d: BigInt(node.divisor) };
  for (const term of node.terms) {
    const c = certificate(state, term.root, bits);
    for (let n = 0n; n < BigInt(term.power); n++) { low = low * BigInt(c.low) / Q; high = ceil(high * BigInt(c.high), Q); }
    if (exact && c.exact && BigInt(exact.n.toString(2).length + exact.d.toString(2).length) +
      BigInt(BigInt(c.exact.n).toString(2).length + BigInt(c.exact.d).toString(2).length) * BigInt(term.power) <= BigInt(s.compoundWorkBudget)) {
      exact.n *= BigInt(c.exact.n) ** BigInt(term.power); exact.d *= BigInt(c.exact.d) ** BigInt(term.power);
      const g = gcd(exact.n, exact.d); exact.n /= g; exact.d /= g;
    } else exact = null;
  }
  low /= BigInt(node.divisor); high = ceil(high, BigInt(node.divisor));
  return { state: next, certificate: setCertificate(next, root, bits, low, high, exact && { n: String(exact.n), d: String(exact.d) }), needed: [] };
}
export function exactTier(state, root, historyLength, settings) {
  const s = policy(settings); uintV2(historyLength); assert(historyLength !== '0', 'compound_snapshot');
  const expression = { op: 'tier', fraction: root, historyLength, thresholds: s.tierThresholds, settingsHash: hashObject(settings) };
  const c = certificate(state, root, s.compoundPrecisionBits);
  if (!c) return { value: null, expression };
  if (c.exact) {
    const at = s.tierThresholds.findIndex(t => BigInt(c.exact.n) * BigInt(historyLength) <= BigInt(t) * BigInt(c.exact.d));
    return { value: at < 0 ? 1 : 5 - at, expression };
  }
  const Q = 1n << BigInt(c.bits), H = BigInt(historyLength);
  for (let i = 0; i < s.tierThresholds.length; i++) {
    const threshold = BigInt(s.tierThresholds[i]) * Q;
    if (BigInt(c.high) * H <= threshold) return { value: 5 - i, expression };
    if (BigInt(c.low) * H <= threshold) return { value: null, expression };
  }
  return { value: 1, expression };
}
export function pinPatternPropertiesV2(state, record, snapshot, settings) {
  const s = policy(settings); uintV2(snapshot.height); uintV2(record.number); uintV2(record.catalogRevision);
  uintV2(record.knownMatchCount); assert(record.knownMatchCount !== '0' && hex(snapshot.hash, 32) &&
    compareUint(snapshot.height, record.anchor.height) >= 0, 'compound_snapshot');
  const H = nextUint(snapshot.height); assert(compareUint(record.knownMatchCount, H) <= 0, 'pattern_properties');
  const next = { ...state }, mass = putNode(next, { op: 'integer', value: '1' });
  const rarity = putNode(next, { op: 'fraction', n: record.knownMatchCount, d: H });
  const refined = refineExactFraction(next, rarity, s.compoundPrecisionBits, settings);
  const properties = { version: 2, mass, massResidue: 1, charge: Number(BigInt(record.number) % 65521n),
    spectrum: 1 << [4, 10, 11].indexOf(record.fld), generation: '0', rarity,
    source: { patternKey: record.key, catalogRevision: record.catalogRevision, snapshot, settingsHash: record.settingsHash } };
  return { state: refined.state, asset: patternAssetV2(record.number), properties };
}
// lookup(asset) must return an independently accepted input record. Raw
// client-supplied properties cannot override it. Each input pins its exact
// catalog/compound revision through the complete property commitment.
export function compoundV2(state, { recipe, inputs, snapshot, settings, lookup }) {
  const s = policy(settings); uintV2(snapshot.height); assert(hex(snapshot.hash, 32), 'compound_snapshot');
  assert(['fusion', 'resonance'].includes(recipe) && Array.isArray(inputs) && inputs.length >= 2 && inputs.length <= s.compoundInputs && typeof lookup === 'function', 'recipe');
  assert(inputs.every(p => Array.isArray(p) && p.length === 2), 'compound_inputs');
  assert(utf8(stableJSON({ recipe, inputs, snapshot })).length <= s.moveBytes, 'compound_bytes');
  const sorted = [...inputs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  assert(sorted.every(([a, n], i) => typeof a === 'string' && (a.startsWith('p2:') || /^c2:[0-9a-f]{64}$/.test(a)) && uintV2(n) !== '0' && (!i || a !== sorted[i - 1][0])), 'compound_inputs');
  const scale = sorted.reduce((n, [, a]) => gcd(n, BigInt(a)), BigInt(sorted[0][1]));
  const normalized = sorted.map(([asset, a]) => [asset, String(BigInt(a) / scale)]);
  const total = normalized.reduce((n, [, a]) => n + BigInt(a), 0n);
  assert(total <= BigInt(s.compoundRatio) && total <= BigInt(s.compoundWorkBudget), 'compound_ratio');
  let next = { ...state }, massResidue = 0n, charge = 0n, spectrum = 0, generation = '0';
  const parents = [];
  for (const [asset, amount] of normalized) {
    const input = lookup(asset); assert(input, 'compound_input_unknown');
    let p;
    if (asset.startsWith('p2:')) {
      const pinned = pinPatternPropertiesV2(next, input, snapshot, settings); assert(pinned.asset === asset, 'compound_input_identity'); next = pinned.state; p = pinned.properties;
    } else {
      const accepted = exactGet(next, 'assets', asset);
      assert(input.id === asset && input.commitment === asset.slice(3) && accepted?.commitment === input.commitment, 'compound_input_identity'); p = accepted.properties;
    }
    assert(p.version === 2 && hex(p.mass, 32) && hex(p.rarity, 32), 'compound_properties'); uintV2(p.generation);
    const units = BigInt(amount); massResidue = (massResidue + BigInt(p.massResidue) * units) % 65521n;
    charge = (charge + BigInt(p.charge) * BigInt(p.massResidue) * units) % 65521n; spectrum |= p.spectrum;
    if (compareUint(p.generation, generation) > 0) generation = p.generation;
    parents.push({ asset, amount, properties: p });
  }
  if (recipe === 'resonance') assert(parents.every(p => p.properties.charge === parents[0].properties.charge), 'resonance_charge');
  const mass = putNode(next, { op: 'sum', terms: parents.map(p => ({ root: p.properties.mass, multiplier: p.amount })) });
  const rarity = putNode(next, { op: 'product', terms: parents.map(p => ({ root: p.properties.rarity, power: p.amount })), divisor: recipe === 'resonance' ? String(total) : '1' });
  const refinement = refineExactFraction(next, rarity, s.compoundPrecisionBits, settings); next = refinement.state;
  const properties = { version: 2, mass, massResidue: Number(massResidue), charge: Number(charge), spectrum, generation: nextUint(generation), rarity };
  const body = { v: 3, recipe, inputs: parents, snapshot, settingsHash: hashObject(settings), properties };
  const commitment = hashObject(body), id = `c2:${commitment}`, tier = exactTier(next, rarity, nextUint(snapshot.height), settings);
  const record = { id, commitment, ...body, tier, modeledMatches: { op: 'ceil-fraction-times', fraction: rarity, multiplier: nextUint(snapshot.height) } };
  const old = exactGet(next, 'assets', id);
  assert(!old || old.commitment === commitment && hashObject({ v: old.v, recipe: old.recipe, inputs: old.inputs, snapshot: old.snapshot, settingsHash: old.settingsHash, properties: old.properties }) === commitment, 'compound_hash_collision');
  exactSet(next, 'assets', id, old ?? record);
  return { state: next, record: old ?? record, amount: String(scale), refinementNeeded: refinement.needed };
}
