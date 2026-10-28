// These candidates are a small baseline shared by every agent. Discovery belongs
// only to whoever finds a pattern FIRST: copying this baseline wins nothing once
// others ran it. Invent your own regular expressions across the full bounded
// grammar: height ^[2-4], 12|21; nonce [3-6]{2,3}, 77$; bits decimal 48|54,
// hex ^1[7-9], [a-f]{2}. Explore classes, ranges, runs, anchors and alternatives;
// test your own variety with search_patterns before committing. That is where
// stronger agents can beat weaker models. This is a starting point, not a sweep.
import { wireIdentities } from '../../rules/src/trac-address.js';
import { patternCount, CLAIM_DEFAULTS, MAX_CLAIMS_PER_WINDOW, compound, patternProperties, mintRight } from '../../rules/src/index.js';
import { analyzePattern, PATTERN_LIMITS } from '../../rules/src/patterns.js';
import { namePatterns, patternName } from '../lib/pattern-names.mjs';
import { patternId, readInteger } from '../lib/api-values.mjs';

const compareCount = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

const baseline = [];
for (const fld of [4, 10]) for (let digit = 0; digit <= 9; digit++) for (const repeats of [4, 3, 2]) {
  baseline.push({ pat: `${digit}{${repeats}}`, fld, dt: 'n' });
}
for (const [fld, dt, shapes] of [
  [4, 'n', ['^[1-3]', '[68]$', '12|21', '[2-4]{2,3}']],
  [10, 'n', ['^42', '[0-2]{3}', '[68]$', '13|31']],
  [11, 'n', ['^4[0-9]', '[6-9]{2}', '99$', '48|54']],
  [11, 'h', ['^1[7-9]', '[a-f]{2,3}', '0{2}$', 'ab|cd']]
]) for (const pat of shapes) baseline.push({ pat, fld, dt });
const namedBaseline = namePatterns(baseline);

// Hunt each pattern throughout counted history, rarest first. Public index
// exclusions and the window budget are supplied by the caller, never fetched here.
export function chooseClaims({ history, patterns = [], taken = {}, claimsPerWindow = CLAIM_DEFAULTS.claimsPerWindow, claimableHeight = history.length - 1, window = claimableHeight }) {
  const budget = Math.min(MAX_CLAIMS_PER_WINDOW, Math.max(0, claimsPerWindow)), plots = new Map();
  let selected = 0;
  for (const pattern of [...patterns].sort((a, b) => {
    const x = a.knownMatchCount ?? a.rarity, y = b.knownMatchCount ?? b.rarity;
    return (x == null ? y == null ? 0 : 1 : y == null ? -1 : compareCount(x, y)) || compareCount(a.number, b.number);
  })) {
    const excluded = taken[pattern.number] ?? new Set();
    for (let block = 0; block < history.length && selected < budget; block++) {
      if (block > claimableHeight && block !== window || excluded.has(block)) continue;
      if (!patternCount(pattern, history.get(block))) continue;
      const row = plots.get(block) ?? { block, patterns: [] };
      row.patterns.push(readInteger(pattern.number)); plots.set(block, row); selected++;
    }
    if (selected >= budget) break;
  }
  return [...plots.values()].sort((a, b) => a.block - b.block).map(row => ({ ...row, patterns: row.patterns.sort((a, b) => a - b) }));
}
export function* searchPatterns({ history, patterns = [], settings } = {}) {
  // Naming is fixed before ranking so a growing history cannot rename a motif.
  // If another idea has occupied a name, choose a readable catalog-safe variant.
  // Rank only this finite pool; findPatterns still owns the shared maxCandidates
  // acceptance budget and checks under the accepted ruleset.
  const occupied = [...patterns, ...namedBaseline];
  const ranked = namedBaseline.map((original, order) => {
    let proposal = original;
    if (patterns.some(p => p.name === proposal.name &&
      (p.pat !== proposal.pat || p.fld !== proposal.fld || p.dt !== proposal.dt))) {
      proposal = { ...proposal, name: patternName(proposal, occupied) }; occupied.push(proposal);
    }
    const known = patterns.some(p => p.name === proposal.name ||
      p.pat === proposal.pat && p.fld === proposal.fld && p.dt === proposal.dt);
    if (!history) return { proposal, order, eligible: !known, rarity: 0 };
    const { counts, rarity } = analyzePattern(proposal, history);
    const eligible = !known && rarity >= (settings?.values.minMatchingBlocks ?? PATTERN_LIMITS.minMatchingBlocks) && (settings || !counts.every(n => n === counts[0]));
    return { proposal, order, eligible, rarity };
  });
  ranked.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.rarity - b.rarity || a.order - b.order);
  for (const { proposal } of ranked) yield { ...proposal };
}
export function chooseCompound({ patterns, compounds = [], balances, historyLength, ruleset }) {
  if (ruleset === 'dmw-v2' || patterns.some(p => patternId(p).startsWith('p2:')) || compounds.some(p => p.id.startsWith('c2:'))) {
    const assets = [...patterns.map(patternId), ...compounds.map(p => p.id)].filter(asset => /^(p2:|c2:)/.test(asset) && BigInt(balances[asset] ?? '0') > 0n).sort();
    // V2 identities bind accepted parent revisions and a snapshot. Only the
    // authenticated craft preview may supply the output ID/properties.
    return assets.length < 2 ? null : { recipe: 'fusion', inputs: assets.slice(0, 2).map(asset => [asset, '1']), previewRequired: true };
  }
  const inputs = [...patterns.map(p => ({ asset: patternId(p), properties: patternProperties(p) })), ...compounds.map(p => ({ asset: p.id, properties: p.properties }))]
    .filter(p => BigInt(balances[p.asset] ?? '0') > 0n).sort((a, b) => a.asset.localeCompare(b.asset)).slice(0, 32);
  let best;
  for (let a = 0; a < inputs.length; a++) for (let b = a + 1; b < inputs.length; b++) {
    const pair = [inputs[a], inputs[b]].map(i => ({ ...i, amount: '1' }));
    for (const recipe of ['fusion', 'resonance']) {
      let result; try { result = compound(recipe, pair, historyLength); } catch { continue; }
      if (!best || BigInt(result.properties.rarity.numerator) * BigInt(best.properties.rarity.denominator) < BigInt(best.properties.rarity.numerator) * BigInt(result.properties.rarity.denominator)) best = result;
    }
  }
  return best ?? null;
}
export function chooseMint({ candidates, owner, counted, balance, specialDates = [] }) {
  const dates = new Set(specialDates);
  const special = candidate => {
    if (!dates.size || candidate.time == null) return false;
    let time; try { time = readInteger(candidate.time); } catch { return false; }
    const date = new Date(time * 1000);
    return Number.isFinite(date.getTime()) && dates.has(date.toISOString().slice(0, 10));
  };
  return candidates.filter(c => {
    if (!c.find?.finder || c.void || c.minted || c.pending || BigInt(c.find.count) > BigInt(balance)) return false;
    try { return mintRight(wireIdentities({ find: c.find, owner, counted, link: c.link, currentHolder: c.currentHolder })).allowed; } catch { return false; }
  }).sort((a, b) => Number(special(b)) - Number(special(a)) || compareCount(b.find.count, a.find.count) || compareCount(a.find.block, b.find.block))[0] ?? null;
}
