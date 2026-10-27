// This is the service's only import boundary for the versioned rules API.
import * as api from '../../rules/src/index.js';
export const rules = api;
export function initialState(firstTip, anchorHash, counted) {
  return { lastTip: firstTip - 1, counted, highestTip: firstTip - 1,
    balances: {}, finds: {}, types: {}, usedNonces: {}, linkPayments: {}, rounds: [] };
}
export function processObservation(input) { return api.processBlock(input); }
export const buildBatch = api.buildBatch;
