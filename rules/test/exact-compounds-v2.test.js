import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_PROFILE, settingsRevision, hash, emptyExactCompounds, compoundV2, namedGet, namedSet,
  heightToPlotV2, plotToHeightV2, uintKeyV2, compareUint, refineExactFraction, exactTier, parseHeaderV2, headerByteOffsetV2 } from '../src/index.js';
const settings = settingsRevision({ network: 'fixture', effectiveBatch: '43', effectiveBitcoinWindow: '0', values: { ...SETTINGS_PROFILE } });
const snapshot = { height: '999999', hash: hash('snapshot') };
const pattern = n => ({ number: String(n), key: hash('pattern' + n), fld: 10, catalogRevision: '1', knownMatchCount: '3', anchor: snapshot, settingsHash: hash('old settings') });

test('exact compound chains cross generation, mass and rational digit ceilings without expanding parents', () => {
  let state = emptyExactCompounds(), previous;
  for (let i = 0; i < 350; i++) {
    let reads = 0;
    const result = compoundV2(state, { recipe: 'fusion', inputs: [[previous?.id ?? 'p2:1', '63'], ['p2:2', '1']], snapshot, settings,
      lookup: asset => { reads++; return asset.startsWith('p2:') ? pattern(asset.slice(3)) : previous; } });
    assert.equal(reads, 2); assert.equal(result.record.properties.generation, String(i + 1));
    assert.equal(result.record.id.length, 67); assert.equal(result.record.id.slice(3), result.record.commitment);
    assert.ok(JSON.stringify(result.record).length < 3000); assert.equal(result.record.tier.value, 5);
    // Modulo mass is enough for the existing charge formula; the full exact
    // mass and fraction remain the immutable expression roots.
    const expected = previous ? (BigInt(previous.properties.massResidue) * 63n + 1n) % 65521n : 64n;
    assert.equal(result.record.properties.massResidue, Number(expected));
    assert.equal(namedGet(result.state.nodes, result.record.properties.mass).terms.length, 2);
    assert.equal(namedGet(result.state.nodes, result.record.properties.rarity).terms.length, 2);
    state = result.state; previous = result.record;
  }
  assert.ok(63n ** 350n > 10n ** 600n);
});
test('accepted parent properties cannot be replaced; input revisions and snapshots are committed', () => {
  // Before the v4 activation height, identities still commit input revisions and snapshots.
  const options = { recipe: 'fusion', inputs: [['p2:1', '1'], ['p2:2', '1']], snapshot, settings, executionHeight: '0', lookup: asset => pattern(asset.slice(3)) };
  const one = compoundV2(emptyExactCompounds(), options);
  const changed = compoundV2(emptyExactCompounds(), { ...options, lookup: asset => ({ ...pattern(asset.slice(3)), catalogRevision: '2', knownMatchCount: '4' }) });
  assert.notEqual(one.record.id, changed.record.id);
  const forged = { ...one.record, properties: { ...one.record.properties, massResidue: 55, generation: '9007199254740993' } };
  const two = compoundV2(one.state, { ...options, inputs: [[one.record.id, '1'], ['p2:2', '1']], lookup: a => a === one.record.id ? forged : pattern('2') });
  assert.equal(two.record.properties.generation, '2');
  assert.equal(two.record.properties.massResidue, 3);
});
test('small exact certificates resolve threshold equality; intervals never guess when precision is insufficient', () => {
  const low = settingsRevision({ network: 'fixture', effectiveBatch: '43', effectiveBitcoinWindow: '0', values: { ...SETTINGS_PROFILE, compoundPrecisionBits: 2 } });
  const root = hash('test fraction'), state = { ...emptyExactCompounds(), nodes: namedSet(null, root, { op: 'fraction', n: '1', d: '100' }) };
  const refined = refineExactFraction(state, root, 2, low);
  assert.equal(exactTier(refined.state, root, '10000', low).value, 5);
  const precise = refineExactFraction(refined.state, root, 256, settings);
  // 1/100 is not dyadic. Exact integer arithmetic proves the equality.
  assert.equal(exactTier(precise.state, root, '10000', settings).value, 5);
  assert.equal(exactTier(precise.state, root, '9999', settings).value, 5);
});
test('decimal coordinates and ordered storage keys do not wrap at u32 or safe integers', () => {
  const values = ['0', '1', '9', '10', '99', '100', '4294967296', '9007199254740993', '9'.repeat(100)];
  for (const height of values) { const p = heightToPlotV2(height); assert.equal(plotToHeightV2(p.x, p.y), height); }
  assert.equal(parseHeaderV2(new Uint8Array(80), values.at(-1)).height, values.at(-1));
  assert.equal(headerByteOffsetV2('9007199254740993'), String(9007199254740993n * 80n));
  assert.deepEqual([...values].sort((a, b) => uintKeyV2(a) < uintKeyV2(b) ? -1 : 1), [...values].sort(compareUint));
});
