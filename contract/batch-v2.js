import { ordinalCodec, compareOrdinal } from '../rules/src/integers-v2.js';
import { hashObject } from '../rules/src/core.js';
import { accountOperationsRoot } from '../rules/src/account-batch.js';
import { compoundIdentityV4Active } from '../rules/src/compound-identity-v4.js';
import { COMPOUND_IDENTITY_V4_MERGES } from '../rules/src/compound-merge-manifest.js';
import { compoundMergeManifest, COMPOUND_MERGE_ACCOUNT_MARKER } from '../rules/src/compound-merge-v4.js';
import { executionSettingsDocument, checkReceiptRenewalBatch } from './receipt-renewal.js';
// Canonical activation is pinned in the new deployment and installed only by
// its complete terminal import. Prototype fixtures retain their isolated gate.
export async function checkBatchV2(state, batch, last) {
  const a = state.options.batchActivation, uint = ordinalCodec(!!state.options.v2).valid, hex = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
  if (!a || compareOrdinal(batch.n, a.sequence) < 0 || batch.ruleset !== a.ruleset || !a.manifest && batch.settingsRevision !== a.settingsRevision) return 'batch_activation';
  if (a.manifest) {
    const manifest = await state.get('v2/manifest'), document = await executionSettingsDocument(state, batch);
    if (!manifest || hashObject(manifest) !== a.manifestHash || !document || hashObject(document) !== batch.settingsHash || document.revision !== batch.settingsRevision) return 'batch_settings';
    if (batch.renewal?.kind !== 'reserve' && batch.accounts !== accountOperationsRoot(batch.ops)) return 'batch_account_root';
    if (!hex(batch.claims) || batch.previousClaims !== await state.get('v2/claims')) return 'batch_claim_root';
  }
  if (!hex(batch.previous) || batch.previous !== (BigInt(last.n) > 0n ? await state.get(`bt/${last.n}`) : a.previousRoot)) return 'batch_predecessor';
  const renewalError = await checkReceiptRenewalBatch(state, batch, last); if (renewalError) return renewalError;
  if (!batch.execution || !uint(batch.execution.height) || !hex(batch.execution.hash) || compareOrdinal(batch.execution.height, batch.to) < 0 || !uint(batch.observation) || batch.renewal?.kind !== 'reserve' && compareOrdinal(batch.observation, await state.get('bt/observation') ?? 0) <= 0) return 'batch_execution';
  if (!['receipts', 'finds', 'catalog', 'accounts'].every(k => hex(batch[k]))) return 'batch_roots';
  if (compareOrdinal(batch.n, a.sequence) === 0 && (batch.previous !== a.previousRoot || compareOrdinal(batch.execution.height, a.height) !== 0 || batch.execution.hash !== a.hash)) return 'batch_activation_anchor';
  if (await state.beacon().hashAt(batch.execution.height) !== batch.execution.hash) return 'batch_execution_branch';
  if (a.manifest && batch.renewal?.kind !== 'reserve') {
    try {
      const completed = await state.get(COMPOUND_MERGE_ACCOUNT_MARKER);
      if (completed && state.options.network === COMPOUND_IDENTITY_V4_MERGES.network && !compoundIdentityV4Active(batch.execution.height)) return 'compound_identity_height';
      const manifest = compoundMergeManifest(state.options.network, batch.execution.height);
      const merges = batch.ops.flatMap(op => op.actions ?? []).filter(action => action.type === 'compound-merge');
      const pending = manifest && !completed;
      if (pending ? merges.length !== 1 || merges[0].manifest !== hashObject(manifest) || batch.ops[0]?.actions?.[0] !== merges[0] : merges.length !== 0) return 'compound_merge_required';
    } catch (error) { return error.message; }
  }
  if (!batch.ops.length && batch.renewal?.kind !== 'reserve') return 'batch_no_progress';
  return null;
}
