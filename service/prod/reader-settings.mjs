import { check } from '../src/util.mjs';
export const READER_DEFAULTS = Object.freeze({ auditFileBytes: 1_500_000, auditTotalBytes: 1_800_000, auditFiles: 512,
  auditCacheEntries: 16, contextBytes: 8_000_000, legacyActivePageRows: 256, contextRetentionBatches: 8,
  supplyPageBatches: 32, supplyPageOperations: 512 });
export function readerSettings(settings = {}) {
  check(Object.keys(settings).every(k => Object.hasOwn(READER_DEFAULTS, k)), 'reader_settings');
  const result = { ...READER_DEFAULTS, ...settings };
  check(Object.values(result).every(n => Number.isSafeInteger(n) && n > 0), 'reader_settings'); return result;
}
