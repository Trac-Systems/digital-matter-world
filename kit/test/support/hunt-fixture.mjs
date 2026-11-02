// Offline catalog: the default baseline plus tier-five height/nonce literals.
export function huntFixture(history, rareCount = 1151) {
  const patterns = [], taken = {};
  for (const fld of [4, 10]) for (let digit = 0; digit <= 9; digit++) for (const repeats of [4, 3, 2])
    patterns.push({ pat: `${digit}{${repeats}}`, fld, dt: 'n' });
  for (const [fld, dt, shapes] of [
    [4, 'n', ['^[1-3]', '[68]$', '12|21', '[2-4]{2,3}']],
    [10, 'n', ['^42', '[0-2]{3}', '[68]$', '13|31']],
    [11, 'n', ['^4[0-9]', '[6-9]{2}', '99$', '48|54']],
    [11, 'h', ['^1[7-9]', '[a-f]{2,3}', '0{2}$', 'ab|cd']]
  ]) for (const pat of shapes) patterns.push({ pat, fld, dt });
  for (const [number, pattern] of patterns.entries()) Object.assign(pattern, { number, rarity: 100000 });
  const literals = new Map();
  for (let i = 0; i < rareCount; i++) {
    const number = patterns.length, fld = i % 2 ? 10 : 4, pat = String(10000 + i);
    patterns.push({ number, pat, fld, dt: 'n', tier: 5 });
    taken[number] = new Set(); literals.set(`${fld}:${pat}`, number);
  }
  // One pass builds exclusions; there are no header hashes or network reads.
  for (let block = 0; block < history.length; block++) for (const fld of [4, 10]) {
    const field = history.field(block, fld, 'n');
    for (let start = 0; start <= field.length - 5; start++) {
      const number = literals.get(`${fld}:${field.slice(start, start + 5)}`);
      if (number !== undefined) taken[number].add(block);
    }
  }
  for (const p of patterns.slice(76)) p.knownMatchCount = String(taken[p.number].size);
  return { history, patterns, taken, claimsPerWindow: 100, claimableHeight: history.length - 2, window: history.length - 1 };
}
