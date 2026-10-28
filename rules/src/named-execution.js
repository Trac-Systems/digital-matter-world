import { assert, hashObject } from './core.js';
import { uintV2 } from './integers-v2.js';
import { namedGet, namedSet, namedRoot } from './named-index.js';
import { checkMoveV2, moveIdV2 } from './moves-v2.js';
import { emptyNamedDiscovery, commitNamedDiscovery, revealNamedDiscovery, submitOccurrences, challengeNamedCount, migrateLegacyCommit } from './named-discovery.js';
import { verifyReceiptV2 } from './receipt-v2.js';
import { compareUint } from './integers-v2.js';
import { executeCraftV2 } from './craft-v2.js';
import { advanceCompoundTier } from './compound-tier-v2.js';

export const namedStateRoot = state => hashObject(['dmw-named-state-v2', state.nextPattern, state.catalogRevision, namedRoot(state.records)]);

// Shared gateway/signer replay of an authenticated receipt segment. The batch
// verifier separately checks segment inclusion/quorum and predecessor roots.
export function replayNamedEntries(state, { entries, settings, settingsHistory, batch, gateway, history, hashAt, counted, lastSequence, craftCatalog = state, renewal }) {
  uintV2(lastSequence);
  assert(Array.isArray(entries) && entries.length <= settings.values.observationBudget, 'named_observation_budget');
  const ordered = [...entries].sort((a, b) => compareUint(a.receipt.sequence, b.receipt.sequence));
  let next = state, sequence = lastSequence, pairs = 0, reveals = 0, challenges = 0; const outcomes = [];
  for (const { move, receipt } of ordered) {
    assert(compareUint(receipt.sequence, sequence) > 0 && verifyReceiptV2(receipt, move, { network: settings.network, gateway, hashAt, batch, renewal }), 'receipt_invalid'); sequence = receipt.sequence;
    pairs += move.p.matches?.length ?? 0; reveals += move.t === 'discovery-reveal-v2' ? 1 : 0; challenges += move.t === 'challenge-count-v2' ? 1 : 0;
    assert(pairs <= settings.values.namedPairBudget && reveals <= settings.values.revealBudget && challenges <= settings.values.challengeBudget, 'named_work_budget');
    try {
      const original = move.settingsHash === hashObject(settings) ? settings : settingsHistory.get(move.settingsHash);
      const result = executeNamedMove(next, { move, settings: original, settingsHistory, tip: receipt.tip, counted, receiptPosition: receipt.sequence, history, hashAt, craftCatalog,
        provenance: { batch, receipt: hashObject(receipt), agent: move.a, ruleset: move.ruleset, settingsHash: move.settingsHash } });
      next = result.state; outcomes.push({ id: receipt.move, reason: 'accepted', record: result.record ?? null, results: result.results ?? null, challenge: result.challenge ?? null,
        ...(result.craft ? { craft: result.craft } : {}), ...(result.progress ? { progress: result.progress } : {}) });
    } catch (error) {
      // Missing historical policy or authenticated storage is unavailable
      // replay evidence, never an ordinary rejection of an acknowledged move.
      if (/^(settings_|named_storage_)/.test(error.message)) throw error;
      outcomes.push({ id: receipt.move, reason: error.message });
    }
  }
  return { state: next, outcomes, lastSequence: sequence, root: namedStateRoot(next) };
}

// Gateway and signers call this same transition AFTER authenticating the
// receipt/segment. No receipt is acknowledged here. Only the bounded named
// headers and indexed state passed by the caller are available to execution.
export function executeNamedMove(state, { move, settings, settingsHistory, tip, counted, receiptPosition, history, hashAt, provenance = null, craftCatalog = state }) {
  uintV2(tip); uintV2(counted); uintV2(receiptPosition);
  const invalid = checkMoveV2(move, { settings, tip, hashAt }); assert(!invalid, invalid);
  const id = moveIdV2(move);
  assert(!namedGet(state.records, `executed/${id}`), 'move_already_executed');
  const common = { agent: move.a, tip, counted, receiptPosition, settings, history, provenance };
  let result;
  if (['header-v2', 'claim-v2'].includes(move.t)) result = { state };
  else if (move.t === 'craft-v2') result = executeCraftV2(state, { move, settings, counted, hashAt, provenance, catalog: craftCatalog });
  else if (move.t === 'compound-refine-v2') result = advanceCompoundTier(state, { ...move.p, settings });
  else if (move.t === 'discovery-commit-v2') result = { state: commitNamedDiscovery(state, { ...common, ...move.p }) };
  else if (move.t === 'discovery-reveal-v2') {
    const c = namedGet(state.records, `commit/${move.a}/${move.p.commitmentId}`); assert(c, 'discovery_commit_unknown');
    const original = settingsHistory.get(c.settingsHash);
    result = revealNamedDiscovery(state, { ...common, ...move.p, settings: original, currentSettings: settings });
  } else if (move.t === 'submit-occurrences-v2') result = submitOccurrences(state, { ...common, ...move.p });
  else if (move.t === 'challenge-count-v2') {
    const record = namedGet(state.records, `revision/${move.p.patternKey}/${move.p.revision}`);
    assert(record && hashObject(record) === move.p.statementHash, 'challenge_statement');
    const challenge = challengeNamedCount(state, { ...move.p, history });
    result = { state, challenge: { ...challenge, statementHash: move.p.statementHash, provenance: record.provenance } };
  } else throw Error('move_type');
  result.state = { ...result.state, records: namedSet(result.state.records, `executed/${id}`, { receiptPosition, settingsHash: hashObject(settings), provenance }) };
  return result;
}

// Only an offline terminal-state import may enumerate legacy commitments.
// Queued openings retain their exact old packet and become evidence-awaiting;
// the server never manufactures their new signed witness attachment.
export function importLegacyDiscoveries({ commitments, queued, settings, receiptPosition, lifetime, minDelay }) {
  let state = emptyNamedDiscovery();
  for (const c of commitments) state = migrateLegacyCommit(state, c, { network: settings.network, settingsHash: hashObject(settings), receiptPosition: String(c.receiptPosition ?? receiptPosition), lifetime, minDelay });
  for (const q of queued) {
    const agent = q.agent, commitment = q.commitment;
    if (!namedGet(state.records, `commit/${agent}/${commitment}`)) state = migrateLegacyCommit(state, q, { network: settings.network, settingsHash: hashObject(settings), receiptPosition: String(q.receiptPosition ?? receiptPosition), lifetime, minDelay });
    state.records = namedSet(state.records, `legacy-reveal/${agent}/${commitment}`, { original: q, status: 'awaiting_block_evidence' });
  }
  return state;
}
