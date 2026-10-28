// This is the service's only import boundary for the versioned rules API.
import * as api from '../../rules/src/index.js';
export const rules = api;
export function initialState(firstTip, anchorHash, counted) {
  return { lastTip: firstTip - 1, counted, highestTip: firstTip - 1,
    balances: {}, finds: {}, types: {}, usedNonces: {}, linkPayments: {}, rounds: [] };
}
export function processObservation(input, readers) {
  if (input.settings?.batchVersion === 2) return api.processBlockV2(input, readers);
  if (input.ruleset !== undefined && input.ruleset !== 'dmw-v1') throw Error('ruleset_v2_execution_not_installed');
  return api.legacyRules.processBlock(input);
}
export function buildBatch(input) {
  if (input.files?.[0]?.v === 5) return api.buildBatchV2(input);
  if (input.ruleset !== undefined && input.ruleset !== 'dmw-v1') throw Error('ruleset_v2_execution_not_installed');
  return api.legacyRules.buildBatch(input);
}
