// Local resource settings. Consensus settings belong to the activated ruleset.
export const ASSET_RESOURCES = Object.freeze({
  activeMints: 2000, activeLinks: 2000, mintsPerAgent: 8, linksPerAgent: 8,
  publicMintsPerPayer: 8, publicMintsPerIP: 32, publicMintStartsPerMinute: 12,
  mintInputCapacity: 2000, workPage: 128, creditPage: 128,
  creditSources: 32, outboxPage: 128,
});
export function assetResources(overrides = {}) {
  const settings = { ...ASSET_RESOURCES, ...overrides };
  for (const [key, value] of Object.entries(settings)) {
    if (!Object.hasOwn(ASSET_RESOURCES, key) || !Number.isSafeInteger(value) || value < 1 ||
        (['workPage', 'creditPage', 'outboxPage'].includes(key) && value > 4096)) throw Error('asset_resource_setting');
  }
  // The v1 independent reader's declared compatibility envelope. V2 funding
  // uses payment pages instead of raising this legacy per-packet setting.
  if (settings.creditSources > 32) throw Error('legacy_credit_capability');
  return settings;
}
