import { ed25519 } from '@noble/curves/ed25519';
import { assert, exactKeys, hex, digest, hash, stableJSON, parseCanonical, hexToBytes, bytesToHex, hashObject } from './core.js';
import { uintV2, compareUint } from './integers-v2.js';
import { validateSettingsDocument } from './settings-v2.js';
import { leadingZeroBits } from './moves.js';
import { validateCraftPayload } from './craft-v2.js';
import { validateTransferPayload } from './transfer-v2.js';

export const namedMoveTypes = Object.freeze(['discovery-commit-v2', 'discovery-reveal-v2', 'submit-occurrences-v2', 'challenge-count-v2']);
export function validateNamedPayload(type, p, settings, executionHeight = '0') {
  validateSettingsDocument(settings);
  const s = settings.values;
  // Preserve the original move_type outcome when replaying older documents.
  if (type === 'transfer-v2' && s.publicMintActivationHeight !== undefined) validateTransferPayload(p, settings);
  else if (type === 'craft-v2') validateCraftPayload(p, settings, executionHeight);
  else if (type === 'compound-refine-v2') {
    assert(exactKeys(p, ['asset', 'cursor', 'steps']) && /^c2:[0-9a-f]{64}$/.test(p.asset), 'compound_refine_payload'); uintV2(p.cursor);
    assert(Number.isSafeInteger(p.steps) && p.steps > 0 && p.steps <= s.compoundWorkBudget, 'compound_work_budget');
  } else if (type === 'header-v2') {
    assert(exactKeys(p, ['height', 'raw']) && hex(p.raw, 80), 'header_payload'); uintV2(p.height);
  } else if (type === 'claim-v2') {
    assert(exactKeys(p, ['window', 'plots', ...(p.header ? ['header'] : [])]) && Array.isArray(p.plots) && p.plots.length > 0 && p.plots.length <= s.movePlots, 'claim_payload');
    uintV2(p.window); let pairs = 0;
    for (const plot of p.plots) {
      assert(exactKeys(plot, ['block', 'patterns']) && Array.isArray(plot.patterns) && plot.patterns.length > 0 && plot.patterns.length <= s.movePatternsPerPlot, 'claim_plot');
      uintV2(plot.block); plot.patterns.forEach(uintV2); pairs += plot.patterns.length;
      assert(new Set(plot.patterns).size === plot.patterns.length, 'claim_duplicate');
    }
    assert(pairs <= s.namedPairBudget, 'claim_pairs');
    if (p.header) validateNamedPayload('header-v2', p.header, settings);
  } else if (type === 'discovery-commit-v2') assert(exactKeys(p, ['commitment']) && hex(p.commitment, 32), 'discovery_commit_payload');
  else if (type === 'discovery-reveal-v2' || type === 'submit-occurrences-v2') {
    const reveal = type === 'discovery-reveal-v2';
    assert(exactKeys(p, reveal ? ['commitmentId', 'proposal', 'salt', 'anchor', 'matches', 'witnessRoot'] : ['patternKey', 'anchor', 'matches']), 'named_payload');
    if (reveal) {
      assert(hex(p.commitmentId, 32) && hex(p.salt, 32) && hex(p.witnessRoot, 32), 'discovery_opening');
      // The original commitment's grammar revision is selected during replay.
      assert(exactKeys(p.proposal, ['name', 'pat', 'fld', 'dt']), 'proposal_payload');
    } else assert(hex(p.patternKey, 32), 'pattern_key');
    assert(exactKeys(p.anchor, ['height', 'hash']) && hex(p.anchor.hash, 32), 'discovery_anchor'); uintV2(p.anchor.height);
    assert(Array.isArray(p.matches) && p.matches.length >= 1 && p.matches.length <= s.occurrencePageSize, 'discovery_witness_budget');
    for (let i = 0; i < p.matches.length; i++) {
      const m = p.matches[i]; assert(exactKeys(m, ['height', 'hash', 'count']) && hex(m.hash, 32), 'occurrence'); uintV2(m.height); uintV2(m.count);
      assert(m.count !== '0' && compareUint(m.height, p.anchor.height) <= 0 && (!i || compareUint(p.matches[i - 1].height, m.height) < 0), 'occurrence_order');
    }
  } else if (type === 'challenge-count-v2') {
    assert(exactKeys(p, ['patternKey', 'revision', 'height', 'statementHash']) && hex(p.patternKey, 32) && hex(p.statementHash, 32), 'challenge_payload');
    uintV2(p.revision); uintV2(p.height);
  } else throw Error('move_type');
  return p;
}
export function validateMoveV2(move, settings, executionHeight = move.b) {
  validateSettingsDocument(settings);
  assert(exactKeys(move, ['v', 'ruleset', 'settingsRevision', 'settingsHash', 'network', 'a', 't', 'b', 'h', 'p', 'w', 'sig']), 'move_shape');
  assert(move.v === 2 && move.ruleset === 'dmw-v2' && move.network === settings.network && move.settingsRevision === settings.revision && move.settingsHash === hashObject(settings), 'move_settings');
  uintV2(move.b);
  assert(hex(move.a, 32) && hex(move.h, 32) && typeof move.w === 'string' && /^(0|[1-9a-f][0-9a-f]*)$/.test(move.w) && hex(move.sig, 64), 'move_fields');
  validateNamedPayload(move.t, move.p, settings, executionHeight);
  assert(new TextEncoder().encode(stableJSON(move)).length <= settings.values.moveBytes, 'move_bytes'); return move;
}
export const unsignedMoveV2 = ({ sig, ...body }) => body;
export const moveDigestV2 = move => digest('dmw-move-v2', move.network, unsignedMoveV2(move));
export const moveIdV2 = move => bytesToHex(moveDigestV2(move));
export const puzzleHashV2 = move => hash(`dmw-puzzle-v2|${stableJSON(unsignedMoveV2(move))}`);
export function checkMoveV2(move, { settings, tip, hashAt, executionHeight = tip }) {
  try {
    validateMoveV2(move, settings, executionHeight); uintV2(tip);
    if (compareUint(move.b, tip) > 0 || BigInt(tip) - BigInt(move.b) > BigInt(settings.values.moveFreshnessTips) || hashAt(move.b) !== move.h) return 'stale';
    if (leadingZeroBits(puzzleHashV2(move)) < settings.values.puzzleBits) return 'puzzle';
    if (!ed25519.verify(hexToBytes(move.sig), moveDigestV2(move), hexToBytes(move.a), { zip215: false })) return 'signature';
    return null;
  } catch (error) { return error.message; }
}
export function parseMoveV2(text, settings) { return validateMoveV2(parseCanonical(text, settings.values.moveBytes), settings); }
