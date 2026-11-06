import { check } from './check.mjs';

// Bulk links have their own send budget, so mining and linking never use up each other's turns.
export function linkSettings({ maxBlocks = 500, linkConcurrency = 8, linkPacing = {} } = {}) {
  check(Number.isSafeInteger(maxBlocks) && maxBlocks > 0, 'Invalid maxBlocks');
  check(Number.isSafeInteger(linkConcurrency) && linkConcurrency > 0, 'Invalid linkConcurrency');
  check(linkPacing && typeof linkPacing === 'object' && !Array.isArray(linkPacing) &&
    Object.keys(linkPacing).every(k => ['intervalMs', 'perTip'].includes(k)), 'Invalid linkPacing');
  const { intervalMs = 500, perTip = 120 } = linkPacing;
  check(Number.isSafeInteger(intervalMs) && intervalMs >= 0 && Number.isSafeInteger(perTip) && perTip > 0, 'Invalid linkPacing');
  return { maxBlocks, linkConcurrency, linkPacing: { intervalMs, perTip } };
}

export function journalPacing(value = {}) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k => ['intervalMs', 'perTip'].includes(k)), 'Invalid journalPacing');
  const { intervalMs = 1000, perTip = 12 } = value;
  check(Number.isSafeInteger(intervalMs) && intervalMs >= 0 && Number.isSafeInteger(perTip) && perTip > 0, 'Invalid rate limits');
  return { intervalMs, perTip };
}
