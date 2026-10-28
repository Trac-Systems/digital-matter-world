import { validateResourceDocument } from '../../rules/src/resource-settings.js';
import { closureTimeouts } from '../../rules/src/closure-timeouts.js';
// Legacy callers retain their defaults. Activated runtimes map the complete
// operator document once; consensus limits never come from this local profile.
export const R3_RESOURCES = Object.freeze({
  journalFrameBytes: 4_000_000, journalFragmentBytes: 256_000, journalGroupBytes: 4_000_036,
  checkpointBytes: 2_000_000, storePageRows: 4096, sqliteCacheKiB: 4096,
  feedEventRows: 128, feedEventsPerTick: 4, feedPagesPerTick: 4,
  patternPageHeights: 256, patternDetailRows: 64, publicPageBytes: 60_000,
  feedVersions: 16, rankingRows: 20, ownerRefreshRows: 40, ownerRefreshMs: 30_000,
  publicCachePages: 64,
});
export function runtimeResources(document, consensus) {
  if (![2, 3, 4].includes(document?.version)) throw Error('resource_upgrade_required');
  const v = validateResourceDocument(document).values;
  const timing = closureTimeouts(consensus, document);
  return {
    store: { journalFrameBytes: v.journalFrameBytes, journalFragmentBytes: v.journalFragmentBytes, journalGroupBytes: v.journalGroupBytes,
      queueLimit: v.journalQueue, groupSize: v.journalGroup, groupDelay: v.journalGroupDelayMs, storePageRows: v.storePageRows,
      checkpointBytes: v.checkpointBytes, sqliteCacheKiB: v.sqliteCacheKiB },
    feeds: Object.fromEntries(Object.keys(R3_RESOURCES).map(key => [key, key === 'publicPageBytes' ? v.publicPreviewBytes : v[key]])),
    outbox: { maxJobs: v.outboxCapacity, retryMs: v.outboxRetryMs, backoffMs: v.outboxBackoffMs, fallbackMs: v.outboxFallbackMs },
    http: { maxInFlight: v.httpInFlight, maxConnections: v.httpConnections, requestTimeoutMs: v.requestTimeoutMs, ...(document.version >= 3 ? { headerTimeoutMs: v.httpHeaderTimeoutMs, socketTimeoutMs: v.httpSocketTimeoutMs, keepAliveMs: v.httpKeepAliveMs, rateCapacity: v.httpRateCapacity, rateBurst: v.httpRateBurst, ratePerSecond: v.httpRatePerSecond } : {}) },
    committee: { timeoutMs: timing?.sessionMs ?? v.signerSessionMs, prepareMs: timing?.prepareMs ?? v.signerPrepareMs,
      ...(document.version >= 4 ? { healthMs: v.committeeHealthMs, readyMs: v.committeeReadyMs, requestMs: v.committeeRequestMs,
        responseBytes: v.committeeResponseBytes, pollMs: v.committeePollMs, historyPage: v.committeeHistoryPage } : {}) },
    replay: { headerPageSize: v.headerPageSize, headerCachePages: v.headerCachePages, cacheKiB: v.sqliteCacheKiB, timeoutMs: timing?.replayMs ?? v.replayTimeoutMs },
    history: { branchCache: v.branchCacheViews, appendRows: v.headerAppendRows },
    archiveWritePage: v.archiveWritePage,
    ...(document.version >= 3 ? {
      source: { requestsPerSecond: v.sourceRps, timeoutMs: v.sourceTimeoutMs, retries: v.sourceRetries, maxQueue: v.sourceQueue,
        maxBytes: v.sourceResponseBytes, backoffMs: v.sourceBackoffMs, maxBackoffMs: v.sourceMaxBackoffMs },
      assets: { activeMints: v.assetActiveMints, activeLinks: v.assetActiveLinks, mintsPerAgent: v.assetMintsPerAgent, linksPerAgent: v.assetLinksPerAgent,
        mintInputCapacity: v.assetInputCapacity, workPage: v.assetWorkPage, creditPage: v.assetCreditPage, outboxPage: v.outboxCapacity },
      lookups: { headerPageRows: v.headerPageSize, headerCachePages: v.headerCachePages, headerCacheKiB: v.sqliteCacheKiB, seedChunkRows: v.archiveWritePage },
      readers: { auditFileBytes: v.archiveObjectBytes, auditTotalBytes: v.archiveObjectBytes,
        auditCacheEntries: v.archiveCacheEntries, contextBytes: v.archiveObjectBytes, contextRetentionBatches: v.archiveSnapshots },
      // Retained archive generations are not concurrent authenticated readers.
      // Snapshot and immutable-node capacities use their own evidence settings.
      evidence: { cacheEntries: v.archiveCacheEntries, maxObjectBytes: v.archiveObjectBytes, ...(timing ? { maxAgeMs: timing.evidenceMs } : {}) },
    } : {}),
  };
}

// Both the gateway and independently started signers use the same resource
// mapping. Reader configuration is not inherited from the gateway process.
export function configuredResources(config) {
  if (!config.v2) return config;
  const r = runtimeResources(config.v2.resources, config.v2.document);
  return { ...config, storeSettings: r.store, assetResources: r.assets ?? config.assetResources,
    prod: config.prod && { ...config.prod,
      http: { ...config.prod.http, ...r.source }, lookupSettings: { ...config.prod.lookupSettings, ...r.lookups },
      readerSettings: { ...config.prod.readerSettings, ...r.readers }, evidenceSettings: { ...config.prod.evidenceSettings, ...r.evidence },
      ...(config.prod.evidence ? { evidence: { ...config.prod.evidence, settings: { ...config.prod.evidence.settings, ...r.evidence } } } : {}),
    } };
}
