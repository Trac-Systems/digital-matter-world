import { hashObject } from '../rules/src/core.js';
import { settingsSuccessor, effectiveSettings, RECEIPT_RENEWABLE_LIMITS } from '../rules/src/settings-v2.js';
import { decimalV2, compareUint } from '../rules/src/integers-v2.js';
import { accountSettings } from '../rules/src/account-settings.js';

export async function batchSettingsDocument(state, batch, height) {
  const current = await state.get('v2/settings');
  return current && effectiveSettings(current, await state.get('v2/settings-next'), decimalV2(batch), decimalV2(height));
}
export function installSettings(state, document) {
  const hash = hashObject(document);
  state.put('v2/settings', document);
  state.put('v2/settings/' + hash, document);
  state.put('v2/settings-revision/' + document.revision, hash);
  state.put('s/assets', { version: 2, settings: accountSettings(document) });
}
// The existing administrator governs amendments. A settings amendment needs
// no admin delay: it takes effect at its own pinned batch and Bitcoin boundaries.
export async function proposeSettings(state, document, height) {
  const previous = await state.get('v2/settings');
  if (!previous) return 'settings_inactive';
  if (await state.get('v2/settings-next')) return 'settings_amendment_pending';
  settingsSuccessor(previous, document);
  // A reservation already acknowledged under the predecessor must still fit.
  // Lowering these envelopes needs an authenticated drain/renewal transition;
  // a pinned quorum-receipt deployment can renew admission/grouping work
  // across bounded batches. V2 always uses two fixed KV notary records.
  // Other execution/proof envelopes still lack complete right renewal.
  for (const key of ['batchBytes', 'batchOps', 'batchAssets', 'batchKv', 'auditChunkBytes', 'auditTotalBytes', 'summaryBytes',
    'observationBudget', 'receiptSegmentEntries', 'proofBytes', 'accountLeaves', 'accountProofNodes', 'accountProofBytes', 'accountActions']) {
    if (document.values[key] < previous.values[key] &&
      !(RECEIPT_RENEWABLE_LIMITS.includes(key) && await state.get('v2/receipt-protocol') === 1)) return 'settings_capacity_drain_required';
  }
  const last = await state.batchLast(), at = decimalV2(height);
  if (compareUint(document.effectiveBatch, decimalV2(last.n)) <= 0 ||
      compareUint(document.effectiveBitcoinWindow, at) < 0) return 'settings_amendment_boundary';
  state.put('ad/p/settings', { value: document, at });
  return null;
}
export async function authorizeSettings(state, document) {
  const previous = await state.get('v2/settings');
  settingsSuccessor(previous, document);
  if (await state.get('v2/settings-next')) return 'settings_amendment_pending';
  if (compareUint(document.effectiveBatch, decimalV2((await state.batchLast()).n)) <= 0) return 'settings_amendment_boundary';
  // Quotes pinned to the outgoing document must keep resolving it by hash.
  state.put('v2/settings/' + hashObject(previous), previous);
  state.put('v2/settings/' + hashObject(document), document);
  state.put('v2/settings-revision/' + document.revision, hashObject(document));
  state.put('v2/settings-next', document);
  return null;
}
