import { assert } from './core.js';

import { validateChosenTicker } from './ticker-grammar.js';
export { validateChosenTicker };

// officialName must point-resolve both catalog names and allocated official
// tickers, including fallback names, across patterns and compounds.
export async function tickerConflicts(tick, { officialName } = {}) {
  tick = validateChosenTicker(tick);
  assert(typeof officialName === 'function', 'ticker_official_lookup_required');
  for (const name of [tick, 'dmt-' + tick]) {
    const found = await officialName(name);
    assert(found === null || found === false, 'ticker_conflict');
  }
  return false;
}
