import { assert, exactKeys, hashObject } from './core.js';
import { uintV2, nextUint } from './integers-v2.js';
import { freezeDocument } from './settings-v2.js';

// Local resources are independently pinned and retained. They never change
// consensus acceptance. Nodes which cannot reserve a packet decline it before
// signing a receipt. Defaults are profiles, not verifier fallbacks.
export const RESOURCE_PROFILE = Object.freeze({
  intakePending: 16000, intakeEntries: 1000, intakeStrings: 16000, intakeReserveBytes: 24000,
  legacyRevealsPerObservation: 1, craftsPerObservation: 8,
  senderCapacity: 8192, senderBurst: 8, senderPerSecond: 2, senderTtlMs: 120000,
  puzzleAttempts: 10000000, puzzleWorkMs: 90000, puzzleYieldEvery: 1024,
  searchCandidates: 60, searchPageSize: 100, searchPageMaximum: 200, searchYieldEvery: 4096, searchCursorBytes: 1024,
  localSendIntervalMs: 1000, localSendsPerTip: 12, downloadTimeoutMs: 120000,
  requestTimeoutMs: 60000, responseBytes: 2000000, namedNodeCache: 4096,
  closureWorkPerSecond: 500, closureReadsPerSecond: 10000, closureBytesPerSecond: 2097152, closureTimeoutPaddingMs: 10000,
  signerSessionMs: 180000, signerPrepareMs: 60000, outboxCapacity: 128, outboxRetryMs: 1000, outboxBackoffMs: 30000,
  httpInFlight: 1024, httpConnections: 1200, sourceRps: 2, sourceQueue: 64, sourceTimeoutMs: 15000, sourceRetries: 2,
  journalFrameBytes: 4194304, journalQueue: 4096, journalGroup: 128, journalGroupDelayMs: 3,
  journalFragmentBytes: 256000, journalGroupBytes: 4194340, storePageRows: 4096,
  feedEventRows: 128, feedEventsPerTick: 4, feedPagesPerTick: 4, patternPageHeights: 256, patternDetailRows: 64,
  feedVersions: 16, rankingRows: 20, ownerRefreshRows: 40, ownerRefreshMs: 30000, outboxFallbackMs: 5000, publicCachePages: 64,
  checkpointBytes: 2097152, sqliteCacheKiB: 4096, headerCachePages: 8, headerPageSize: 1024,
  archiveWritePage: 4096, archiveSnapshots: 3,
  branchCacheViews: 4, headerAppendRows: 2048, replayTimeoutMs: 120000, signerRequestBytes: 4000000, archiveCacheEntries: 16, archiveObjectBytes: 8000000,
  sourceResponseBytes: 16000000, sourceBackoffMs: 250, sourceMaxBackoffMs: 10000,
  httpHeaderTimeoutMs: 30000, httpSocketTimeoutMs: 90000, httpKeepAliveMs: 5000,
  httpRateCapacity: 1024, httpRateBurst: 1200, httpRatePerSecond: 1000,
  relayObservationPage: 64, committeeHealthMs: 1000, committeeReadyMs: 15000,
  committeeRequestMs: 15000, committeeResponseBytes: 4000000, committeePollMs: 100,
  committeeHistoryPage: 256,
  sponsorshipTransactions: '0', sponsorshipAtoms: '0', sponsorshipRunwayTransactions: '0',
  assetActiveMints: 2000, assetActiveLinks: 2000, assetMintsPerAgent: 8, assetLinksPerAgent: 8, assetInputCapacity: 2000, assetWorkPage: 128, assetCreditPage: 128, publicPageSize: 50, publicPageMaximum: 200, publicPreviewBytes: 60000
});
const resourceV2Keys = new Set(['journalFragmentBytes', 'journalGroupBytes', 'storePageRows', 'feedEventRows', 'feedEventsPerTick', 'feedPagesPerTick',
  'patternPageHeights', 'patternDetailRows', 'feedVersions', 'rankingRows', 'ownerRefreshRows', 'ownerRefreshMs', 'outboxFallbackMs', 'publicCachePages']);
const resourceV3Keys = new Set(['branchCacheViews', 'headerAppendRows', 'replayTimeoutMs', 'signerRequestBytes', 'archiveCacheEntries', 'archiveObjectBytes',
  'sourceResponseBytes', 'sourceBackoffMs', 'sourceMaxBackoffMs', 'httpHeaderTimeoutMs', 'httpSocketTimeoutMs', 'httpKeepAliveMs',
  'httpRateCapacity', 'httpRateBurst', 'httpRatePerSecond', 'sponsorshipTransactions', 'sponsorshipAtoms', 'sponsorshipRunwayTransactions',
  'assetActiveMints', 'assetActiveLinks', 'assetMintsPerAgent', 'assetLinksPerAgent', 'assetInputCapacity', 'assetWorkPage', 'assetCreditPage']);
const resourceV4Keys = new Set(['relayObservationPage', 'committeeHealthMs', 'committeeReadyMs', 'committeeRequestMs',
  'committeeResponseBytes', 'committeePollMs', 'committeeHistoryPage',
  'closureWorkPerSecond', 'closureReadsPerSecond', 'closureBytesPerSecond', 'closureTimeoutPaddingMs']);
export function validateResources(values, version = 4) {
  assert(exactKeys(values, Object.keys(RESOURCE_PROFILE).filter(key => (version !== 1 || !resourceV2Keys.has(key)) && (version >= 3 || !resourceV3Keys.has(key)) && (version >= 4 || !resourceV4Keys.has(key)))), 'resource_keys');
  for (const [key, n] of Object.entries(values)) {
    if (key.startsWith('sponsorship')) { uintV2(n); continue; }
    assert(Number.isSafeInteger(n) && n >= (['localSendIntervalMs', 'sourceRetries', 'journalGroupDelayMs'].includes(key) ? 0 : 1), 'resource_value');
    if (key.endsWith('Ms')) assert(n <= 2147483647, 'resource_timer_capability');
  }
  assert(values.searchPageSize <= values.searchPageMaximum && values.publicPageSize <= values.publicPageMaximum, 'resource_page');
  if (version >= 2) assert(values.journalFrameBytes > 512 && values.journalGroupBytes >= values.journalFrameBytes + 36 &&
    values.journalFragmentBytes < values.journalFrameBytes && values.patternDetailRows < values.storePageRows &&
    values.feedEventRows <= values.storePageRows && values.feedEventsPerTick <= values.storePageRows && values.feedPagesPerTick <= values.storePageRows, 'resource_progress');
  if (version >= 4) assert(values.relayObservationPage <= values.storePageRows && values.committeeHistoryPage <= values.storePageRows, 'resource_page');
  return values;
}
export function resourceRevision({ operator, values, previous = null }) {
  assert(typeof operator === 'string' && operator.length > 0, 'resource_operator');
  if (previous) validateResourceDocument(previous);
  assert(!previous || previous.operator === operator, 'resource_operator');
  return freezeDocument({ version: 4, operator, revision: previous ? nextUint(previous.revision) : '0',
    previousHash: previous ? hashObject(previous) : null, values: structuredClone(validateResources(values)) });
}
export function validateResourceDocument(d) {
  assert(exactKeys(d, ['version', 'operator', 'revision', 'previousHash', 'values']) && [1, 2, 3, 4].includes(d.version) && typeof d.operator === 'string' && d.operator.length > 0, 'resource_document');
  uintV2(d.revision); assert(d.previousHash === null || /^[0-9a-f]{64}$/.test(d.previousHash), 'resource_previous'); validateResources(d.values, d.version); return d;
}
export class ResourceHistory {
  #last; #byHash = new Map();
  append(document, expectedHash) {
    validateResourceDocument(document); assert(hashObject(document) === expectedHash, 'resource_pin');
    assert(document.revision === (this.#last ? nextUint(this.#last.revision) : '0') && document.previousHash === (this.#last ? hashObject(this.#last) : null) &&
      (!this.#last || document.operator === this.#last.operator), 'resource_history');
    this.#last = freezeDocument(structuredClone(document)); this.#byHash.set(expectedHash, this.#last); return this.#last;
  }
  get(hash) { const d = this.#byHash.get(hash); assert(d, 'resource_unknown'); return d; }
  current() { assert(this.#last, 'resource_missing'); return this.#last; }
}
