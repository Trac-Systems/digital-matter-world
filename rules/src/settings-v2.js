import { assert, exactKeys, hashObject, networkId } from './core.js';
import { uintV2, compareUint, nextUint } from './integers-v2.js';

// These limits bound receipt admission/batch grouping or the two fixed v2
// notary records. They do not narrow any individual account/proof operation.
export const RECEIPT_RENEWABLE_LIMITS = Object.freeze(['receiptSegmentEntries', 'observationBudget', 'batchKv']);
export const requiresReceiptCutoff = (previous, successor) => RECEIPT_RENEWABLE_LIMITS.some(key => successor.values[key] < previous.values[key]);

// A launch profile, not fallback values during verification. Every revision
// contains every key; the operator pins its hash before it can be used.
export const SETTINGS_PROFILE = Object.freeze({
  claimsPerWindow: 100, claimWindowTips: 2,
  minMatchingBlocks: 3, occurrencePageSize: 100, minRevealDelay: 2, commitLifetime: 144,
  tierThresholds: Object.freeze(['100', '1000', '10000', '100000']),
  patternMaxLength: 64, patternMaxLiteralDigits: 6, patternMaxAlternatives: 4,
  patternMaxAtoms: 12, patternMaxQuantifiers: 4,
  finderWindow: 1008, pendingBlocks: 432, requestMinBlocks: 6, requestMaxBlocks: 2016,
  lockMinBlocks: 6, lockMaxBlocks: 2016, linkRefundPadding: 144,
  batchBytes: 98304, batchOps: 512, batchAssets: 4096, batchKv: 16,
  batchDeadlineTips: 6, batchMaxDeadlineTips: 36,
  auditChunkBytes: 262144, auditTotalBytes: 1500000, observationBudget: 512,
  receiptSegmentEntries: 32, settlementPageRows: 100, settlementPagesPerObservation: 2,
  closureWorkBudget: 2048, closureReadBudget: 131072, closureByteBudget: 67108864,
  closureBacklogPairs: 200000, closureBacklogBytes: 67108864, closureBacklogWindows: 64,
  observationsPerBatch: 1, summaryBytes: 1000000, batchEnvelopeReserveBytes: 4096, batchHeaders: 20,
  accountLeaves: 4096, accountProofNodes: 65536, accountProofBytes: 98304,
  paymentPage: 32, accountActions: 512, recoveryHeaders: 20,
  namedPairBudget: 10000, revealBudget: 32, mintOperationBudget: 32, linkOperationBudget: 16,
  moveBytes: 16384, movePlots: 1000, movePatternsPerPlot: 64, operationAssets: 16,
  headerPageSize: 4096, proofBytes: 1048576, proofDepth: 256, challengeBudget: 32,
  puzzleBits: 12, moveFreshnessTips: 2, challengeRewardAtoms: '0',
  // These economic values retain the existing splits. Base fees remain pinned
  // to their existing fee-policy revision, never inferred from this profile.
  feePolicyRevision: '0', finderShareBps: 3000, discovererShareBps: 500, landownerShareBps: 1500,
  findBurnBps: 2000, unlinkedBurnBps: 1500, firstMakerShareBps: 3000, compoundBurnBps: 3500, linkBurnBps: 5000,
  linkMultiplier: 3, quoteLifetimeTips: 2016, quoteLifetimeMs: 300000,
  compoundInputs: 8, compoundRatio: 64, compoundWorkBudget: 4096, compoundPrecisionBits: 256,
  mintAllocationBudget: 64, mintCreditBudget: 32,
  adminDelayTips: 432, pauseTips: 144, pauseCooldownTips: 144
});

// Capabilities describe this parser, separately from operator policy. Larger
// grammar/envelopes require a coordinated parser release, not local overrides.
export const SETTINGS_CAPABILITIES = Object.freeze({
  patternMaxLength: 64, patternMaxLiteralDigits: 6, patternMaxAlternatives: 4,
  patternMaxAtoms: 12, patternMaxQuantifiers: 4,
  batchBytes: 120000, batchOps: 512, batchAssets: 8192, batchKv: 64,
  moveBytes: 131072, operationAssets: 16, proofDepth: 256
});
const zeroAllowed = new Set(['batchKv', 'puzzleBits', 'patternMaxLiteralDigits', 'patternMaxQuantifiers',
  'finderShareBps', 'discovererShareBps', 'landownerShareBps', 'findBurnBps', 'unlinkedBurnBps',
  'firstMakerShareBps', 'compoundBurnBps', 'linkBurnBps']);
const closureKeys = ['closureWorkBudget', 'closureReadBudget', 'closureByteBudget', 'closureBacklogPairs', 'closureBacklogBytes', 'closureBacklogWindows'];
export const PUBLIC_MINT_SETTINGS = Object.freeze({ publicMintActivationHeight: '0', publicMintLegacyFinderWindow: 1008, publicMintScanBlocks: 2, publicMintPageSize: 50 });
export function freezeDocument(value) {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freezeDocument(v); Object.freeze(value); }
  return value;
}
export function validateSettings(values, capabilities = SETTINGS_CAPABILITIES) {
  // Retained documents keep their original execution. New profiles opt into
  // bounded closure as a complete group, authenticated by the settings hash.
  const bounded = Object.hasOwn(values, 'closureWorkBudget');
  const publicMint = Object.hasOwn(values, 'publicMintActivationHeight');
  const neverClose = Object.hasOwn(values, 'claimsNeverCloseHeight');
  assert(exactKeys(values, [...Object.keys(SETTINGS_PROFILE).filter(k => bounded || !closureKeys.includes(k)),
    ...(publicMint ? Object.keys(PUBLIC_MINT_SETTINGS) : []), ...(neverClose ? ['claimsNeverCloseHeight'] : [])]), 'settings_keys');
  if (neverClose) assert(publicMint && compareUint(uintV2(values.claimsNeverCloseHeight), values.publicMintActivationHeight) >= 0, 'settings_claims_never_close');
  for (const [key, value] of Object.entries(values)) {
    if (key === 'tierThresholds') {
      assert(Array.isArray(value) && value.length === 4 && value.every((n, i) => {
        uintV2(n); return compareUint(n, '0') > 0 && (!i || compareUint(n, value[i - 1]) > 0);
      }), 'settings_tiers');
    } else if (key === 'feePolicyRevision') assert(value === '0' || typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'settings_fee_revision');
    else if (typeof SETTINGS_PROFILE[key] === 'string' || key === 'publicMintActivationHeight' || key === 'claimsNeverCloseHeight') uintV2(value);
    else assert(Number.isSafeInteger(value) && value >= (zeroAllowed.has(key) ? 0 : 1), 'settings_value');
    if (Object.hasOwn(capabilities, key)) assert(value <= capabilities[key], 'settings_capability');
  }
  assert(values.minMatchingBlocks <= values.occurrencePageSize && values.occurrencePageSize <= values.namedPairBudget, 'settings_witness_budget');
  assert(values.minRevealDelay <= values.commitLifetime, 'settings_commit_window');
  assert(values.batchDeadlineTips <= values.batchMaxDeadlineTips && values.requestMinBlocks <= values.requestMaxBlocks && values.lockMinBlocks <= values.lockMaxBlocks, 'settings_window');
  assert(values.finderShareBps + values.discovererShareBps + Math.max(values.landownerShareBps, values.unlinkedBurnBps) + values.findBurnBps <= 10000 &&
    values.firstMakerShareBps + values.compoundBurnBps <= 10000 && values.linkBurnBps <= 10000, 'settings_splits');
  assert(values.puzzleBits <= 256 && values.auditChunkBytes <= values.auditTotalBytes, 'settings_budget');
  assert(values.claimWindowTips === 2 && values.batchOps >= 3 && values.batchKv >= 2 &&
    values.batchBytes > values.batchEnvelopeReserveBytes && values.observationsPerBatch <= values.observationBudget,
    'settings_minimum_progress');
  // A scan/index step may revisit an input-page leaf while splitting radix
  // paths. Reserve those accesses plus one large authenticated metadata row
  // and branch paths. Hash paths have 64 hexadecimal digits, 16-way branches;
  // the budget must admit one complete step even with cold proofs.
  const closureStepBytes = 64 * values.auditChunkBytes + 8 * values.auditTotalBytes + 4 * values.moveBytes + 16 * 64 * 4096;
  if (bounded) assert(Number.isSafeInteger(closureStepBytes) && values.closureWorkBudget >= values.observationsPerBatch &&
    values.closureReadBudget / values.observationsPerBatch >= 32768 && values.closureByteBudget / values.observationsPerBatch >= 16777216 &&
    values.closureByteBudget / values.observationsPerBatch >= closureStepBytes &&
    values.closureBacklogPairs >= values.claimsPerWindow && values.closureBacklogBytes >= values.moveBytes, 'settings_closure_progress');
  return values;
}
export function settingsRevision({ network, effectiveBatch, effectiveBitcoinWindow, values, previous = null }) {
  networkId(network); uintV2(effectiveBatch); uintV2(effectiveBitcoinWindow);
  if (previous) validateSettingsDocument(previous);
  const document = { version: 1, ruleset: 'dmw-v2', network, revision: previous ? nextUint(previous.revision) : '0',
    effectiveBatch, effectiveBitcoinWindow, previousRevisionHash: previous ? hashObject(previous) : null,
    values: structuredClone(validateSettings(values)) };
  validateSettingsDocument(document);
  return freezeDocument(document);
}
export function validateSettingsDocument(document) {
  assert(exactKeys(document, ['version', 'ruleset', 'network', 'revision', 'effectiveBatch', 'effectiveBitcoinWindow', 'previousRevisionHash', 'values']) &&
    document.version === 1 && document.ruleset === 'dmw-v2', 'settings_version');
  networkId(document.network); uintV2(document.revision); uintV2(document.effectiveBatch); uintV2(document.effectiveBitcoinWindow);
  assert(document.previousRevisionHash === null || /^[0-9a-f]{64}$/.test(document.previousRevisionHash), 'settings_previous');
  validateSettings(document.values); return document;
}
export function settingsSuccessor(previous, document) {
  validateSettingsDocument(previous); validateSettingsDocument(document);
  assert(document.network === previous.network && document.revision === nextUint(previous.revision) &&
    document.previousRevisionHash === hashObject(previous), 'settings_history');
  assert(compareUint(document.effectiveBatch, previous.effectiveBatch) > 0 &&
    compareUint(document.effectiveBitcoinWindow, previous.effectiveBitcoinWindow) >= 0, 'settings_order');
  const old = previous.values.publicMintActivationHeight, next = document.values.publicMintActivationHeight;
  assert(old === undefined ? next === undefined || compareUint(next, document.effectiveBitcoinWindow) >= 0 : next === old, 'settings_public_mint_boundary');
  if (next !== undefined) assert(old === undefined ? document.values.publicMintLegacyFinderWindow === document.values.finderWindow :
    document.values.publicMintLegacyFinderWindow === previous.values.publicMintLegacyFinderWindow, 'settings_public_claim_window');
  const priorClaims = previous.values.claimsNeverCloseHeight, claims = document.values.claimsNeverCloseHeight;
  assert(priorClaims === undefined ? claims === undefined || compareUint(claims, document.effectiveBitcoinWindow) >= 0 : claims === priorClaims,
    'settings_claims_never_close_boundary');
  return document;
}
export function settingsEffective(document, batch, window) {
  return compareUint(document.effectiveBatch, uintV2(batch)) <= 0 && compareUint(document.effectiveBitcoinWindow, uintV2(window)) <= 0;
}
// Both documents must come from the independently read notary snapshot. A
// future Bitcoin boundary never prevents batches under the current revision.
export function effectiveSettings(current, scheduled, batch, window) {
  validateSettingsDocument(current);
  if (scheduled) settingsSuccessor(current, scheduled);
  const selected = scheduled && settingsEffective(scheduled, batch, window) ? scheduled : current;
  assert(settingsEffective(selected, batch, window), 'settings_not_effective');
  return selected;
}
export class SettingsHistory {
  #entries = []; #byHash = new Map();
  // expectedHash must come from the accepted activation/governance record,
  // never from an untrusted document's self-declared hash.
  append(document, expectedHash) {
    validateSettingsDocument(document);
    assert(hashObject(document) === expectedHash, 'settings_pin');
    const previous = this.#entries.at(-1);
    assert(document.revision === (previous ? nextUint(previous.revision) : '0') &&
      document.previousRevisionHash === (previous ? hashObject(previous) : null), 'settings_history');
    if (previous) settingsSuccessor(previous, document);
    const saved = freezeDocument(structuredClone(document));
    this.#entries.push(saved); this.#byHash.set(expectedHash, saved); return saved;
  }
  get(hash) { const value = this.#byHash.get(hash); assert(value, 'settings_unknown'); return value; }
  at(batch, window) {
    uintV2(batch); uintV2(window);
    let lo = 0, hi = this.#entries.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (settingsEffective(this.#entries[mid], batch, window)) lo = mid + 1; else hi = mid; }
    const selected = this.#entries[lo - 1];
    assert(selected && compareUint(selected.effectiveBitcoinWindow, window) <= 0, 'settings_not_effective');
    return selected;
  }
}
