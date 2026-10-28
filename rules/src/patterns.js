import { assert, integer, hash, stableJSON } from './core.js';
export const PATTERN_LIMITS = Object.freeze({ maxLength: 64, maxLiteralDigits: 6, maxAlternatives: 4, maxAtoms: 12, maxQuantifiers: 4, minMatchingBlocks: 3 });
export const TIER_THRESHOLDS = Object.freeze([100, 1000, 10000, 100000]);
// No groups, negation, escapes, flags, wildcard or nested repetition. Each branch
// has at most four bounded repetitions and haystacks contain at most ten bytes.
export function validatePattern(pattern, limits = PATTERN_LIMITS) {
  const l = { ...PATTERN_LIMITS, ...limits };
  for (const key of ['maxLength', 'maxLiteralDigits', 'maxAlternatives', 'maxAtoms', 'maxQuantifiers']) {
    assert(integer(l[key], PATTERN_LIMITS[key]), 'pattern_limits');
  }
  assert(l.maxLength > 0 && l.maxAlternatives > 0 && l.maxAtoms > 0 && integer(l.minMatchingBlocks, 0xffffffff) && l.minMatchingBlocks > 0, 'pattern_limits');
  assert(typeof pattern === 'string' && pattern.length > 0 && pattern.length <= l.maxLength, 'pattern_length');
  const branches = pattern.split('|'); assert(branches.length <= l.maxAlternatives, 'pattern_alternatives');
  let literals = 0;
  for (let branch of branches) {
    if (branch.startsWith('^')) branch = branch.slice(1);
    if (branch.endsWith('$')) branch = branch.slice(0, -1);
    let i = 0, atoms = 0, repetitions = 0;
    assert(branch.length > 0, 'pattern_empty_branch');
    while (i < branch.length) {
      if (/[0-9a-f]/.test(branch[i])) { if (/[0-9]/.test(branch[i])) literals++; i++; }
      else if (branch[i] === '[') {
        const end = branch.indexOf(']', i + 1); assert(end > i + 1, 'pattern_class');
        const c = branch.slice(i + 1, end); let j = 0;
        while (j < c.length) {
          assert(/[0-9a-f]/.test(c[j]), 'pattern_class');
          if (/[0-9]/.test(c[j])) literals++;
          if (c[j + 1] === '-') {
            assert(j + 2 < c.length && /[0-9a-f]/.test(c[j + 2]) && c[j] <= c[j + 2] &&
              (/[0-9]/.test(c[j]) === /[0-9]/.test(c[j + 2])), 'pattern_range');
            if (/[0-9]/.test(c[j + 2])) literals++; j += 3;
          } else j++;
        }
        i = end + 1;
      } else throw new Error('pattern_atom');
      atoms++;
      if (branch[i] === '?') { repetitions++; i++; }
      else if (branch[i] === '{') {
        const m = /^\{(0|[1-9][0-9]?)(?:,(0|[1-9][0-9]?))?\}/.exec(branch.slice(i));
        assert(m, 'pattern_quantifier');
        const min = Number(m[1]), max = Number(m[2] ?? m[1]);
        assert(min <= max && max <= 10, 'pattern_quantifier');
        repetitions++; i += m[0].length;
      }
    }
    assert(atoms <= l.maxAtoms && repetitions <= l.maxQuantifiers, 'pattern_complexity');
  }
  assert(literals <= l.maxLiteralDigits, 'pattern_literal_digits');
  new RegExp(pattern, 'g');
  return { literalDigits: literals, branches: branches.length };
}
export function validateDefinition(p, limits) {
  assert(p && [4, 10, 11].includes(p.fld) && (p.dt === 'n' || (p.fld === 11 && p.dt === 'h')), 'field');
  validatePattern(p.pat, limits); return p;
}
export function fieldValue(header, field, dt = 'n') {
  validateField(field, dt);
  const n = field === 4 ? header.height : field === 10 ? header.nonce : header.bits;
  if (field === 4 && typeof n === 'string') { assert(/^(0|[1-9][0-9]*)$/.test(n), 'field_value'); return n; }
  assert(integer(n, 0xffffffff), 'field_value'); return n.toString(dt === 'h' ? 16 : 10);
}
function validateField(field, dt) { assert([4, 10, 11].includes(field) && (dt === 'n' || (field === 11 && dt === 'h')), 'field'); }
// null preserves ord-tap's None on no match or an invalid V8 pattern.
export function ordMatchCount(pattern, haystack) {
  try { return String(haystack).match(new RegExp(pattern, 'g'))?.length ?? null; } catch { return null; }
}
export function countWith(regex, haystack) {
  regex.lastIndex = 0;
  let n = 0, m;
  while ((m = regex.exec(haystack)) !== null) { n++; if (m[0].length === 0) regex.lastIndex++; }
  return n;
}
export function patternCount(pattern, header) {
  validateDefinition(pattern);
  return countWith(new RegExp(pattern.pat, 'g'), fieldValue(header, pattern.fld, pattern.dt));
}
export function tierFor(rarity, thresholds = TIER_THRESHOLDS) {
  assert(integer(rarity) && thresholds.length === 4 && thresholds.every((n, i) => integer(n) && (i === 0 || n > thresholds[i - 1])), 'rarity');
  const index = thresholds.findIndex(n => rarity <= n); return index === -1 ? 1 : 5 - index;
}
export function analyzePattern(p, history, thresholds) {
  validateDefinition(p); const re = new RegExp(p.pat, 'g'), counts = new Uint8Array(history.length);
  let rarity = 0, total = 0;
  for (let i = 0; i < history.length; i++) {
    const n = countWith(re, history.field(i, p.fld, p.dt)); counts[i] = n; total += n; if (n) rarity++;
  }
  return { counts, rarity, total, tier: tierFor(rarity, thresholds), fingerprint: hash(counts), historyLength: history.length };
}
export function sameCounts(a, b) { return a.length === b.length && a.every((n, i) => n === b[i]); }
export function evaluateDiscovery({ proposal, discoverer, history, existing = [], limits = PATTERN_LIMITS, thresholds, number }) {
  validateDefinition(proposal, limits);
  assert(typeof proposal.name === 'string' && /^dmw[a-z0-9]{2,29}$/.test(proposal.name), 'pattern_name');
  assert(typeof discoverer === 'string' && /^[0-9a-f]{64}$/.test(discoverer) && integer(number, 0xffffffff), 'discoverer');
  assert(!existing.some(p => p.name === proposal.name || p.number === number), 'pattern_exists');
  assert(!new RegExp(proposal.pat).test(''), 'pattern_nullable');
  const analysis = analyzePattern(proposal, history, thresholds);
  assert(!analysis.counts.every(n => n === analysis.counts[0]), 'pattern_constant');
  assert(analysis.rarity >= (limits.minMatchingBlocks ?? PATTERN_LIMITS.minMatchingBlocks), 'pattern_too_rare');
  for (const p of existing) {
    const other = analyzePattern(p, history, thresholds);
    assert(!sameCounts(analysis.counts, other.counts), 'pattern_duplicate');
  }
  const record = { number, name: proposal.name, pat: proposal.pat, fld: proposal.fld, dt: proposal.dt,
    discoverer, rarity: analysis.rarity, total: analysis.total, tier: analysis.tier,
    historyHeight: history.length - 1, historyHash: history.get(history.length - 1).hash, fingerprint: analysis.fingerprint };
  return { record, commitment: hash(stableJSON(record)) };
}

export function markMainnetPatterns(patterns, elements) {
  return patterns.map(p => ({ ...p, mainnet: elements.filter(e => Number(e.fld) === p.fld && e.pat === p.pat).map(e => ({ name: e.tick, inscription: e.ins })) }));
}
