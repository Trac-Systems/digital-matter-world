import { requireValue as check } from './http.mjs';

// Local resource budgets. These bound one unit of work, never retained history.
export const LOOKUP_DEFAULTS = Object.freeze({ pageRows: 500, pagesPerTick: 4, pageBytes: 2000000, contentBytes: 200000,
  walletItemsPerTick: 16, walletBlocksPerTick: 1, refreshMs: 1000,
  headerPageRows: 1024, headerCachePages: 4, headerCacheKiB: 4096, seedChunkRows: 4096,
  paymentIds: 64, creditSources: 32, inscriptionBytes: 65536,
  bulkReadCacheEntries: 1024, bulkReadCacheBytes: 8000000 });
export function lookupSettings(input = {}) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'lookup_settings');
  const settings = { ...LOOKUP_DEFAULTS, ...input };
  for (const [key, value] of Object.entries(settings)) check(Object.hasOwn(LOOKUP_DEFAULTS, key) && Number.isSafeInteger(value) && value > 0, 'lookup_setting_' + key);
  check(settings.refreshMs <= 0x7fffffff, 'lookup_refresh_timer');
  return Object.freeze(settings);
}
