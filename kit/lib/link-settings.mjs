import { check } from './check.mjs';

export function linkSettings({ maxBlocks = 500, linkConcurrency = 8 } = {}) {
  check(Number.isSafeInteger(maxBlocks) && maxBlocks > 0, 'Invalid maxBlocks');
  check(Number.isSafeInteger(linkConcurrency) && linkConcurrency > 0, 'Invalid linkConcurrency');
  return { maxBlocks, linkConcurrency };
}

export function journalPacing(value = {}) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k => ['intervalMs', 'perTip'].includes(k)), 'Invalid journalPacing');
  const { intervalMs = 1000, perTip = 12 } = value;
  check(Number.isSafeInteger(intervalMs) && intervalMs >= 0 && Number.isSafeInteger(perTip) && perTip > 0, 'Invalid rate limits');
  return { intervalMs, perTip };
}
