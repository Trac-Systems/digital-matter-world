// Local resource settings. Consensus settings belong to the activated ruleset.
export const ASSET_RESOURCES = Object.freeze({
  activeMints: 2000, activeLinks: 2000, mintsPerAgent: 32, linksPerAgent: 8, pendingMintsPerAgent: 8,
  publicMintsPerPayer: 8, publicMintsPerIP: 32, publicMintStartsPerMinute: 12,
  publicBulkMintBlocks: 64, publicBulkInputBytes: 16384, publicBulkResponseBytes: 1048576,
  mintInputCapacity: 2000, workPage: 128, creditPage: 128,
  creditSources: 32, outboxPage: 128,
  bulkOrdersPerAgent: 24, activeBulkOrders: 512, bulkMintEnabled: true, bulkQuoteAttempts: 3,
  // Extra blocks an agent bulk order stays reserved after its payment window, so a
  // payment sent in time can still confirm and mint with the existing operations.
  bulkLateBlocks: 24,
  // How long a move waits for admission to reopen while a batch is signed, and how often it checks.
  admissionWaitMs: 8000, admissionPollMs: 200,
  // How long a move refused that way gets the retryable busy answer before the final refusal.
  admissionBusyMs: 150000,
});
export function assetResources(overrides = {}) {
  const settings = { ...ASSET_RESOURCES, ...overrides };
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'bulkMintEnabled') {
      if (typeof value !== 'boolean') throw Error('asset_resource_setting');
      continue;
    }
    if (!Object.hasOwn(ASSET_RESOURCES, key) || !Number.isSafeInteger(value) || value < (['bulkLateBlocks', 'admissionBusyMs'].includes(key) ? 0 : 1) ||
        (['workPage', 'creditPage', 'outboxPage'].includes(key) && value > 4096)) throw Error('asset_resource_setting');
  }
  // The v1 independent reader's declared compatibility envelope. V2 funding
  // uses payment pages instead of raising this legacy per-packet setting.
  if (settings.creditSources > 32) throw Error('legacy_credit_capability');
  return settings;
}
