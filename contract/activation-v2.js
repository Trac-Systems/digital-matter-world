import { decimalV2, nextUint } from '../rules/src/integers-v2.js';
import { activationManifest } from '../rules/src/activation.js';
import { validateSettingsDocument } from '../rules/src/settings-v2.js';
import { accountSettings } from '../rules/src/account-settings.js';
import { hashObject } from '../rules/src/core.js';
import { activatedBatchSettings } from '../rules/src/batch-settings.js';
import { jsonBytes } from './signing.js';
import { initialClaimSnapshot, claimStateRoot } from '../rules/src/claim-state.js';
import { installSettings } from './settings-v2.js';

export const EMPTY_IMPORT_ROOT = hashObject(['dmw-terminal-import-v2']);
export const importPageRoot = (previous, rows) => hashObject(['dmw-terminal-import-page-v2', previous, rows]);
export function validateV2Deployment(options) {
  const v = options.v2, m = activationManifest(v.manifest, v.manifestHash);
  validateSettingsDocument(v.document);
  if (v.receiptProtocol !== undefined && (v.receiptProtocol !== 1 || !v.gateway || !v.receiptSigners)) throw Error('activation_receipt_protocol');
  if (v.gateway !== undefined || v.receiptSigners !== undefined) {
    const members = v.receiptSigners;
    if (!/^[0-9a-f]{64}$/.test(v.gateway ?? '') || !Array.isArray(members) || members.length !== 5 ||
      members.some(m => !m || typeof m.id !== 'string' || !m.id.length || !/^[0-9a-f]{64}$/.test(m.identity ?? '')) ||
      new Set(members.map(m => m.id)).size !== 5 || new Set(members.map(m => m.identity)).size !== 5) throw Error('activation_receipt_roster');
  }
  if (m.network !== options.network || hashObject(v.document) !== m.settingsHash || !/^[0-9a-f]{64}$/.test(v.importRoot) || !Number.isSafeInteger(v.importRows) || v.importRows < 1) throw Error('activation_deployment');
  return activatedBatchSettings({ manifest: m, manifestHash: v.manifestHash, document: v.document });
}
// A new notary accepts only these pinned import pages until the exact terminal
// snapshot has arrived. Each page is atomic and retries are idempotent. This
// is an explicit new-deployment route, never an in-place v1 code upgrade.
export async function applyTerminalImport(state, value, address) {
  const v = state.options.v2; if (!v || address !== state.options.admin) return 'activation_import_authority';
  validateV2Deployment(state.options);
  if (await state.get('v2/ready')) return 'activation_already_complete';
  const old = await state.get('v2/import') ?? { part: 0, root: EMPTY_IMPORT_ROOT, rows: 0, lastKey: '' };
  if (!value || !Number.isSafeInteger(value.part) || !Array.isArray(value.records) || !value.records.length || typeof value.final !== 'boolean' || jsonBytes(value) > v.document.values.batchBytes) return 'activation_import_page';
  const digest = importPageRoot(value.previous, value.records);
  if (value.part < old.part) return await state.get('v2/import-page/' + value.part) === digest ? null : 'activation_import_conflict';
  if (value.part !== old.part || value.previous !== old.root) return 'activation_import_sequence';
  let key = old.lastKey;
  for (const row of value.records) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || row[0] <= key || row[0].startsWith('v2/')) return 'activation_import_order';
    key = row[0];
  }
  const total = old.rows + value.records.length;
  if (total > v.importRows || value.final && (total !== v.importRows || digest !== v.importRoot)) return 'activation_import_root';
  for (const [key, record] of value.records) state.put(key, record);
  state.put('v2/import-page/' + value.part, digest);
  state.put('v2/import', { part: old.part + 1, root: digest, rows: total, lastKey: key });
  if (value.final) {
    const m = v.manifest, last = await state.batchLast();
    if (nextUint(decimalV2(last.n)) !== m.effectiveBatch || await state.get('bt/' + last.n) !== m.previousBatchRoot ||
      await state.beacon().hashAt(m.bitcoinAnchor.height) !== m.bitcoinAnchor.hash ||
      await state.get('v2-financial-root') !== m.accountsRoot) return 'activation_terminal_state';
    state.put('s/assets', { version: 2, settings: accountSettings(v.document) });
    state.put('s/assetExits', { version: 2 });
    state.put('v2/manifest', m); installSettings(state, v.document);
    if (v.receiptProtocol === 1) state.put('v2/receipt-protocol', 1);
    state.put('v2/catalog', m.catalogRoot); state.put('v2/accounts', m.accountsRoot);
    const pending = await state.get('v2-pending-work');
    if (pending && (pending.version !== 1 || pending.network !== m.network || pending.settingsHash !== m.settingsHash ||
      pending.catalogRoot !== m.catalogRoot || hashObject(pending.anchor) !== hashObject(m.bitcoinAnchor) ||
      pending.counted !== decimalV2(last.to) || claimStateRoot(pending.claimSnapshot) !== pending.claimsRoot)) return 'activation_pending_state';
    state.put('v2/claims', pending?.claimsRoot ?? claimStateRoot(initialClaimSnapshot(m, last.to)));
    state.put('v2/ready', v.manifestHash);
  }
  return null;
}
