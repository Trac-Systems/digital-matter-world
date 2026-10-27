import { assert, integer, hash, stableJSON, compare } from './core.js';
import { tierFor } from './patterns.js';
import { assetId, amount } from './operations.js';
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function fraction(n, d) { const g = gcd(n, d); return { numerator: (n / g).toString(), denominator: (d / g).toString() }; }
export function patternProperties(pattern) {
  const historyLength = pattern.historyHeight + 1;
  assert(integer(historyLength) && historyLength > 0 && integer(pattern.rarity) && pattern.rarity > 0 && pattern.rarity <= historyLength, 'pattern_properties');
  assert([4, 10, 11].includes(pattern.fld) && integer(pattern.number, 0xffffffff), 'pattern_properties');
  return { mass: '1', charge: pattern.number % 65521, spectrum: 1 << [4, 10, 11].indexOf(pattern.fld), generation: 0,
    rarity: fraction(BigInt(pattern.rarity), BigInt(historyLength)) };
}
// Quantities reduce by their GCD: 2A+2B makes two units of the same type as A+B.
// The type depends on input types, ratio and recipe, never on finder or block.
export function compound(recipe, inputs, historyLength, thresholds) {
  assert(['fusion', 'resonance'].includes(recipe) && Array.isArray(inputs) && inputs.length >= 2 && inputs.length <= 8 &&
    integer(historyLength) && historyLength > 0, 'recipe');
  const ordered = [...inputs].sort((a, b) => compare(a.asset, b.asset));
  assert(ordered.every(i => assetId(i.asset) && amount(i.amount)) && new Set(ordered.map(i => i.asset)).size === ordered.length, 'compound_duplicate_or_amount');
  const scale = ordered.reduce((n, i) => gcd(n, BigInt(i.amount)), BigInt(ordered[0].amount));
  const normalized = ordered.map(i => ({ ...i, amount: (BigInt(i.amount) / scale).toString() }));
  assert(normalized.reduce((n, i) => n + BigInt(i.amount), 0n) <= 64n, 'compound_ratio');
  let mass = 0n, charge = 0n, spectrum = 0, generation = 0, numerator = 1n, denominator = 1n;
  for (const { amount: a, properties: p } of normalized) {
    assert(p && amount(p.mass) && integer(p.charge, 65520) && integer(p.spectrum, 7) && p.spectrum > 0 && integer(p.generation, 62), 'compound_properties');
    assert(/^[1-9][0-9]{0,255}$/.test(p.rarity.numerator) && /^[1-9][0-9]{0,255}$/.test(p.rarity.denominator), 'compound_rarity');
    const n = BigInt(p.rarity.numerator), d = BigInt(p.rarity.denominator), units = BigInt(a); assert(n <= d, 'compound_probability');
    mass += BigInt(p.mass) * units; charge += BigInt(p.charge) * BigInt(p.mass) * units; spectrum |= p.spectrum;
    generation = Math.max(generation, p.generation + 1); numerator *= n ** units; denominator *= d ** units;
  }
  if (recipe === 'resonance') {
    assert(normalized.every(i => i.properties.charge === normalized[0].properties.charge), 'resonance_charge');
    denominator *= normalized.reduce((n, i) => n + BigInt(i.amount), 0n);
  }
  const rarity = fraction(numerator, denominator);
  assert(amount(mass.toString()) && rarity.denominator.length <= 256, 'compound_limit');
  const properties = { mass: mass.toString(), charge: Number(charge % 65521n), spectrum, generation, rarity };
  const commitment = hash(stableJSON({ v: 2, recipe, inputs: normalized, properties }));
  const id = `c${BigInt(`0x${commitment}`).toString(36).padStart(50, '0').slice(0, 23)}`;
  const modeledMatches = Number((numerator * BigInt(historyLength) + denominator - 1n) / denominator);
  return { id, commitment, recipe, inputs: normalized.map(i => [i.asset, i.amount]), amount: scale.toString(), properties, modeledMatches, tier: tierFor(modeledMatches, thresholds) };
}
