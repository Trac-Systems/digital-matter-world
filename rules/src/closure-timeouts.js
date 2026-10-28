import { assert } from './core.js';

// Throughput estimates are operator resources, never consensus constants.
// Budget all three dimensions rather than extending a fixed RPC ceiling when
// a window grows. The configured chunk, not the window's total, sets the time.
export function closureTimeouts(document, resources) {
  const s = document?.values, v = resources?.values ?? resources;
  if (!s?.closureWorkBudget || !v?.closureWorkPerSecond) return null;
  const seconds = s.closureWorkBudget / v.closureWorkPerSecond +
    s.closureReadBudget / v.closureReadsPerSecond + s.closureByteBudget / v.closureBytesPerSecond;
  const prepareMs = v.closureTimeoutPaddingMs + Math.ceil(seconds * 1000);
  const evidenceMs = prepareMs + v.closureTimeoutPaddingMs;
  const sessionMs = prepareMs + v.signerSessionMs;
  assert([prepareMs, evidenceMs, sessionMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647), 'closure_timeout_setting');
  return { prepareMs, replayMs: prepareMs, evidenceMs, sessionMs };
}
