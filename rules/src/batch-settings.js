import { assert, hex } from './core.js';
import { validateSettingsDocument } from './settings-v2.js';
import { hashObject } from './core.js';
import { activationManifest } from './activation.js';
import { decimalV2, compareOrdinal } from './integers-v2.js';
import { settingsEffective } from './settings-v2.js';

export function activatedBatchSettings({ manifest, manifestHash, document, receiptSigners }) {
  const m = activationManifest(manifest, manifestHash);
  validateSettingsDocument(document);
  assert(document.network === m.network && hashObject(document) === m.settingsHash && document.effectiveBatch === m.effectiveBatch, 'activation_settings');
  return batchSettings({ document, receiptSigners, batchVersion: 2, activation: {
    sequence: m.effectiveBatch, previousRoot: m.previousBatchRoot,
    height: m.bitcoinAnchor.height, hash: m.bitcoinAnchor.hash,
    ruleset: m.toRuleset, settingsRevision: document.revision, settingsHash: m.settingsHash,
    manifest: m, manifestHash,
  } });
}

// R3's consensus settings namespace; merged into R1's revisioned document at
// integration. Defaults do not activate v2 or reinterpret a legacy file.
export const BATCH_V2_DEFAULTS = Object.freeze({
  claimsPerWindow: 100, claimWindowBlocks: 2, settlementPageRows: 1024, receiptSegmentEntries: 32,
  settlementPagesPerObservation: 16, observationsPerBatch: 1, auditPageBytes: 250000,
  auditMaxBytes: 1500000, summaryMaxBytes: 1000000,
  maxBatchBytes: 98304, maxOps: 512, maxAssets: 4096, maxKv: 16,
  maxObservations: 512, maxHeaders: 20, creditAssetsPerOperation: 16,
  batchEnvelopeReserveBytes: 4096, batchDeadlineBlocks: 6, batchDeadlineMaxBlocks: 36,
});
export function batchSettings(settings = {}) {
  if (settings.document) {
    const d = validateSettingsDocument(settings.document), v = d.values;
    const mapped = { claimsPerWindow: v.claimsPerWindow, claimWindowBlocks: v.claimWindowTips,
      receiptSegmentEntries: v.receiptSegmentEntries, settlementPageRows: v.settlementPageRows,
      settlementPagesPerObservation: v.settlementPagesPerObservation, observationsPerBatch: v.observationsPerBatch,
      auditPageBytes: v.auditChunkBytes, auditMaxBytes: v.auditTotalBytes, summaryMaxBytes: v.summaryBytes,
      maxBatchBytes: v.batchBytes, maxOps: v.batchOps, maxAssets: v.batchAssets, maxKv: v.batchKv,
      maxObservations: v.observationBudget, maxHeaders: v.batchHeaders, creditAssetsPerOperation: v.operationAssets,
      batchEnvelopeReserveBytes: v.batchEnvelopeReserveBytes, batchDeadlineBlocks: v.batchDeadlineTips,
      batchDeadlineMaxBlocks: v.batchMaxDeadlineTips, puzzleBits: v.puzzleBits, freshness: v.moveFreshnessTips,
      ruleset: d.ruleset, settingsRevision: d.revision, settingsHash: hashObject(d),
      ...(v.closureWorkBudget === undefined ? {} : Object.fromEntries(['closureWorkBudget', 'closureReadBudget', 'closureByteBudget',
        'closureBacklogPairs', 'closureBacklogBytes', 'closureBacklogWindows'].map(k => [k, v[k]]))) };
    for (const [key, value] of Object.entries(mapped)) assert(settings[key] === undefined || settings[key] === value, 'settings_override');
    return { ...settings, ...mapped };
  }
  const s = { ...BATCH_V2_DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) };
  for (const key of Object.keys(BATCH_V2_DEFAULTS)) assert(Number.isSafeInteger(s[key]) && s[key] > 0, 'batch_settings');
  assert(s.maxOps >= 3 && s.maxKv >= 2 && s.maxBatchBytes > s.batchEnvelopeReserveBytes && s.auditMaxBytes >= s.auditPageBytes, 'batch_minimum_progress');
  // The deployed ac operation has a 16-leaf encoding. Negotiate a new codec
  // before increasing this setting; changing it alone cannot widen the parser.
  assert(s.creditAssetsPerOperation <= 16, 'batch_credit_capability');
  assert(s.claimWindowBlocks === 2, 'claim_window_capability');
  return s;
}
export function batchActivation({ sequence, previousRoot, height, hash, activation, document }) {
  assert(activation && activation.ruleset && (activation.manifest ? hex(activation.settingsHash, 32) : hex(activation.settingsRevision, 32)) &&
    compareOrdinal(sequence, activation.sequence) >= 0 && compareOrdinal(height, activation.height) >= 0, 'batch_activation');
  if (compareOrdinal(sequence, activation.sequence) === 0) assert(previousRoot === activation.previousRoot && hash === activation.hash && compareOrdinal(height, activation.height) === 0, 'batch_activation_anchor');
  if (activation.manifest) {
    const m = activationManifest(activation.manifest, activation.manifestHash);
    assert(m.settingsHash === activation.settingsHash && m.toRuleset === activation.ruleset &&
      m.effectiveBatch === String(activation.sequence) && m.previousBatchRoot === activation.previousRoot &&
      m.bitcoinAnchor.height === String(activation.height) && m.bitcoinAnchor.hash === activation.hash, 'activation_binding');
  }
  if (document) {
    validateSettingsDocument(document);
    assert(document.network === activation.manifest.network && settingsEffective(document, decimalV2(sequence), decimalV2(height)) &&
      (compareOrdinal(sequence, activation.sequence) !== 0 || hashObject(document) === activation.settingsHash), 'batch_settings');
    return { ruleset: document.ruleset, settingsRevision: document.revision, settingsHash: hashObject(document) };
  }
  return { ruleset: activation.ruleset, settingsRevision: activation.settingsRevision, ...(activation.settingsHash ? { settingsHash: activation.settingsHash } : {}) };
}
