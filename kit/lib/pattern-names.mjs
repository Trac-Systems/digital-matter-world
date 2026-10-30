// Small, local word stock: names describe a motif, never encode a hash or a field.
const roots = ['null', 'sol', 'gem', 'tri', 'tetr', 'pent', 'hex', 'sept', 'oct', 'nov'];
const modifiers = ['amber', 'blue', 'cedar', 'dawn', 'ember', 'frost', 'gold', 'jade',
  'lunar', 'mist', 'opal', 'pearl', 'rose', 'silver', 'snow', 'sun', 'verdant', 'violet'];
const endings = { 4: ['ite', 'ith', 'stone', 'spar'], 10: ['ine', 'alis', 'arine', 'oria'] };
const identity = p => `${p.fld}:${p.dt}:${p.pat}${p.amountMode === 'field-value' ? ':field-value' : ''}`;

function wordFor({ pat, fld, dt }) {
  const run = /^([0-9])(?:\{([1-4])\})?$/.exec(pat);
  if (run && endings[fld]) return (roots[Number(run[1])] + endings[fld][Number(run[2] ?? 1) - 1]).replace(/([aeiou])\1/g, '$1');
  const motif = pat.startsWith('^') && pat.endsWith('$') ? 'crown'
    : pat.startsWith('^') ? 'dawn' : pat.endsWith('$') ? 'dusk'
    : pat.includes('|') ? 'braid' : pat.includes('{') ? 'ribbon'
    : pat.includes('-') ? 'prism' : pat.includes('[') ? 'mosaic' : 'glimmer';
  return motif + (fld === 4 ? 'ite' : fld === 10 ? 'ine' : dt === 'h' ? 'spar' : 'ium');
}

function* variations(word) {
  yield word;
  for (const prefix of modifiers) yield prefix + word;
  for (const first of modifiers) for (const second of modifiers) yield first + second + word;
}

// Same definitions and occupied names give the same names, regardless of input
// order. Reserve catalog names; prefer unused two-letter display symbols, then
// allow symbol reuse rather than turning a readable name into an identifier.
export function namePatterns(proposals, existing = []) {
  const used = new Set(existing.map(p => p.name));
  const symbols = new Set([...used].map(name => name.slice(3, 5)));
  const named = new Map();
  const definitions = new Map(proposals.map(p => [identity(p), p]));
  for (const key of [...definitions.keys()].sort()) {
    let fallback, chosen;
    for (const word of variations(wordFor(definitions.get(key)))) {
      if (word.length > 29 || used.has('dmw' + word)) continue;
      fallback ??= 'dmw' + word;
      if (!symbols.has(word.slice(0, 2))) { chosen = 'dmw' + word; break; }
    }
    chosen ??= fallback;
    if (!chosen) throw new Error('Readable pattern names exhausted for this motif');
    named.set(key, chosen); used.add(chosen); symbols.add(chosen.slice(3, 5));
  }
  return proposals.map(p => ({ ...p, name: named.get(identity(p)) }));
}

export function patternName(proposal, existing = []) {
  return namePatterns([proposal], existing)[0].name;
}
