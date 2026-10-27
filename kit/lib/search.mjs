import { publicIdentities, decodeTracAddress } from '../../rules/src/trac-address.js';
import { evaluateDiscovery } from '../../rules/src/index.js';
import { assertHistoryTip } from './headers.mjs';
import { check } from './check.mjs';
import { searchPatterns } from '../strategies/default.mjs';

export function checkProposal({ proposal, history, tip, existing, owner, limits }) {
  assertHistoryTip(history, tip);
  return evaluateDiscovery({ proposal, discoverer: owner, history, existing, limits,
    number: existing.reduce((n, p) => Math.max(n, p.number + 1), 0) });
}
export async function findPatterns({ history, tip, existing, owner, limits, strategy = searchPatterns, maxCandidates = 60, candidates = [], signal, onProgress = () => {} }) {
  owner = decodeTracAddress(owner);
  assertHistoryTip(history, tip); check(Number.isSafeInteger(maxCandidates) && maxCandidates > 0 && maxCandidates <= 10000, 'Invalid search budget');
  const accepted = [], rejected = []; let tried = 0;
  function* proposals() { yield* candidates; yield* strategy({ history, patterns: publicIdentities(existing) }); }
  for (const proposal of proposals()) {
    tried++;
    signal?.throwIfAborted();
    try { const result = checkProposal({ proposal, history, tip, existing: [...existing, ...accepted.map(r => r.record)], owner, limits }); accepted.push(result); }
    catch (e) { rejected.push({ name: proposal.name, reason: e.message }); }
    onProgress({ tried, accepted: accepted.length }); await new Promise(resolve => setImmediate(resolve));
    if (tried >= maxCandidates) break;
  }
  return publicIdentities({ accepted, rejected });
}
