import { publicIdentities, decodeTracAddress } from '../../rules/src/trac-address.js';
import { evaluateDiscovery, validPatternName, canonicalDefinition, amountWith, definitionKey } from '../../rules/src/index.js';
import { assertHistoryTip } from './headers.mjs';
import { check } from './check.mjs';
import { searchPatterns } from '../strategies/default.mjs';
import { searchMatchPage } from './search-matches.mjs';

export function checkProposal({ proposal, history, tip, existing, owner, limits }) {
  check(proposal.amountMode === undefined, 'Pattern amount modes require v2 rules');
  assertHistoryTip(history, tip);
  return evaluateDiscovery({ proposal, discoverer: owner, history, existing, limits,
    number: existing.reduce((n, p) => Math.max(n, p.number + 1), 0) });
}
export async function findPatterns({ history, tip, existing, owner, limits, settings, executionHeight = '0', strategy = searchPatterns, maxCandidates = 60, candidates = [], signal, onProgress = () => {} }) {
  owner = decodeTracAddress(owner);
  assertHistoryTip(history, tip); check(Number.isSafeInteger(maxCandidates) && maxCandidates > 0 && maxCandidates <= 10000, 'Invalid search budget');
  const accepted = [], rejected = []; let tried = 0;
  function* proposals() { yield* candidates; yield* strategy({ history, patterns: publicIdentities(existing), settings, executionHeight }); }
  const keyOf = p => { try { return p.key ?? definitionKey(p, settings); } catch { return null; } };
  const taken = new Map(), known = new Set();
  if (settings) for (const p of existing) { const k = keyOf(p); if (k) { known.add(k); if (p.name) taken.set(p.name, k); } }
  for (const proposal of proposals()) {
    tried++;
    signal?.throwIfAborted();
    try {
      if (settings) {
        check(validPatternName(proposal.name, executionHeight), 'pattern_name');
        canonicalDefinition(proposal, settings);
        // Refuse what reveal would refuse or merge: a taken name, or a definition already accepted.
        const key = definitionKey(proposal, settings), nameKey = taken.get(proposal.name);
        check(nameKey === undefined || nameKey === key, 'pattern_exists');
        check(!known.has(key), 'pattern_duplicate');
        const re = new RegExp(proposal.pat, 'g'); let count = 0n, total = 0n;
        for (let h = 0; h <= tip.height; h++) {
          const n = amountWith(proposal, re, history.field(h, proposal.fld, proposal.dt)); if (n !== '0') { count++; total += BigInt(n); }
          if (h % 4096 === 0) { signal?.throwIfAborted(); await new Promise(resolve => setImmediate(resolve)); }
        }
        check(count >= BigInt(settings.values.minMatchingBlocks), 'pattern_too_rare');
        const page = await searchMatchPage({ history, tip, proposal, signal, settings, executionHeight, pageSize: settings.values.occurrencePageSize });
        known.add(key); taken.set(proposal.name, key);
        accepted.push({ ...page, key, localMatchCount: String(count), localOccurrenceTotal: String(total),
          completeLocalSearch: true, searchedRange: { from: 0, to: tip.height } });
      } else {
      const result = checkProposal({ proposal, history, tip, existing: [...existing, ...accepted.map(r => r.record)], owner, limits });
      const page = await searchMatchPage({ history, tip, proposal, signal });
      accepted.push({ ...result, ...page, localMatchCount: String(result.record.rarity),
        completeLocalSearch: true, searchedRange: { from: 0, to: tip.height } });
      }
    }
    catch (e) { rejected.push({ name: proposal.name, reason: e.message }); }
    onProgress({ tried, accepted: accepted.length }); await new Promise(resolve => setImmediate(resolve));
    if (tried >= maxCandidates) break;
  }
  return publicIdentities({ accepted, rejected });
}
