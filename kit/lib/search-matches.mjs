import { amountWith, hashObject, stableJSON, validateDefinition, validPatternName, canonicalDefinition } from '../../rules/src/index.js';
import { assertHistoryTip, historyProof } from './headers.mjs';
import { check } from './check.mjs';

// A self-contained local cursor survives process restart without touching the
// action journal. It pins the proposal and independently verified snapshot.
export async function searchMatchPage({ history, tip, proposal, cursor, pageSize = 100, signal, settings, executionHeight = '0' }) {
  if (settings) {
    const proof = historyProof(history);
    check(Number.isSafeInteger(tip.height) && tip.height >= 0 && tip.height < proof.count && history.get(tip.height).hash === tip.hash, 'Local search snapshot is not in verified history');
  } else assertHistoryTip(history, tip);
  if (settings) { check(validPatternName(proposal.name, executionHeight), 'pattern_name'); canonicalDefinition(proposal, settings); }
  else { check(proposal.amountMode === undefined, 'Pattern amount modes require v2 rules'); validateDefinition(proposal); }
  check(Number.isSafeInteger(pageSize) && pageSize >= (settings ? 1 : 3) && pageSize <= (settings?.values.occurrencePageSize ?? 200), 'Invalid local match page size');
  let searchSnapshot = { height: tip.height, hash: tip.hash }, saved;
  let start = 0;
  if (cursor) {
    check(typeof cursor === 'string' && cursor.length <= 1024, 'Invalid local match cursor');
    try { saved = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw Error('Invalid local match cursor'); }
    check(saved?.snapshot && Number.isSafeInteger(saved.snapshot.height) && saved.snapshot.height >= 0 && saved.snapshot.height <= tip.height &&
      history.get(saved.snapshot.height).hash === saved.snapshot.hash, 'Local match snapshot or cursor changed');
    searchSnapshot = saved.snapshot;
    check(saved.result === hashObject(['dmw-local-pattern-matches-v1', proposal, searchSnapshot]) && Number.isSafeInteger(saved.next) && saved.next >= 0 && saved.next <= searchSnapshot.height + 1 &&
      Buffer.from(stableJSON(saved)).toString('base64url') === cursor, 'Local match snapshot or cursor changed');
    start = saved.next;
  }
  const localResultId = hashObject(['dmw-local-pattern-matches-v1', proposal, searchSnapshot]);
  const matches = [], re = new RegExp(proposal.pat, 'g'); let height = start;
  for (; height <= searchSnapshot.height; height++) {
    signal?.throwIfAborted();
    const count = amountWith(proposal, re, history.field(height, proposal.fld, proposal.dt));
    if (count !== '0') matches.push({ height: String(height), hash: history.get(height).hash, count });
    if (matches.length === pageSize) { height++; break; }
    if ((height - start) % 4096 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  return { proposal, searchSnapshot, localResultId, matches, searchedRange: { from: start, to: height - 1 },
    completeLocalSearch: height > searchSnapshot.height,
    nextCursor: height > searchSnapshot.height ? null : Buffer.from(stableJSON({ result: localResultId, snapshot: searchSnapshot, next: height })).toString('base64url') };
}
