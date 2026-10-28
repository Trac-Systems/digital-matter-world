import { receiptRenewalSliceCommitment } from '../rules/src/receipt-cutoff-pages.js';
import { encodeBinary } from '../rules/src/binary.js';
import { hashObject, exactKeys } from '../rules/src/core.js';
import { compareUint } from '../rules/src/integers-v2.js';
import { settingsEffective, requiresReceiptCutoff } from '../rules/src/settings-v2.js';
import { validateReceiptRenewalCutoff, receiptRenewalRecord, renewalReservationRoot, validateRenewalSlice, advanceReceiptRenewal } from '../rules/src/receipt-renewal.js';
import { merkleRoot } from '../rules/src/merkle.js';
import { batchSettingsDocument } from './settings-v2.js';

export async function executionSettingsDocument(state, batch) {
  if (!batch.renewal) return batchSettingsDocument(state, batch.n, batch.execution?.height);
  const active = await state.get('v2/receipt-renewal');
  if (batch.renewal.kind === 'execute' && !active && (await state.get('v2/receipt-renewal/' + batch.renewal.id))?.state === 'consumed')
    throw Error('renewal_consumed');
  const hash = batch.renewal.kind === 'reserve' ? batch.renewal.cutoff?.settingsHash : active?.cutoff.settingsHash;
  const document = hash && await state.get('v2/settings/' + hash);
  if (!document || hashObject(document) !== hash) throw Error('renewal_policy');
  return document;
}

export async function checkReceiptRenewalBatch(state, batch, last) {
  const active = await state.get('v2/receipt-renewal');
  if (!batch.renewal) {
    if (active) return 'renewal_pending';
    const current = await state.get('v2/settings'), effective = await batchSettingsDocument(state, batch.n, batch.execution?.height);
    // Reducing a renewable admission/grouping limit cannot revoke an older
    // reservation. Even an empty gateway queue needs a certified cutoff.
    if (current && requiresReceiptCutoff(current, effective)) return 'settings_cutoff_required';
    return null;
  }
  if (batch.renewal.kind === 'reserve') {
    if (active || !exactKeys(batch.renewal, ['kind', 'cutoff', 'votes'])) return 'renewal_pending';
    const c = batch.renewal.cutoff, pin = state.options.v2;
    try { validateReceiptRenewalCutoff(c, { network: state.options.network, gateway: pin?.gateway,
      members: pin?.receiptSigners, votes: batch.renewal.votes }); } catch (e) { return e.message; }
    const current = await state.get('v2/settings'), successor = await state.get('v2/settings-next');
    if (hashObject(current) !== c.settingsHash || !successor || hashObject(successor) !== c.successorHash ||
      batch.settingsHash !== c.settingsHash || await state.get('v2/receipt-renewal/' + hashObject(c))) return 'renewal_policy';
    if (!settingsEffective(successor, String(BigInt(batch.n) + 1n), batch.execution?.height)) return 'renewal_successor_boundary';
    if (c.predecessor.n !== last.n || c.predecessor.root !== batch.previous || c.predecessor.claims !== batch.previousClaims ||
      c.predecessor.catalog !== await state.get('v2/catalog')) return 'renewal_predecessor';
    if (compareUint(batch.n, pin.manifest.effectiveBatch) <= 0) return 'renewal_activation';
    if (batch.to !== last.to || batch.observation !== (await state.get('bt/observation') ?? '0') || batch.ops.length || batch.hx ||
      batch.claims !== batch.previousClaims || batch.catalog !== c.predecessor.catalog || batch.accounts !== await state.get('v2/accounts') ||
      batch.receipts !== (c.batchReceipts ?? c.segments) || batch.finds !== merkleRoot([]) || batch.root !== renewalReservationRoot(batch)) return 'renewal_transition';
    return null;
  }
  if (!exactKeys(batch.renewal, ['kind', 'id', 'slice']) || batch.renewal.kind !== 'execute' || !active || batch.renewal.id !== active.id ||
    batch.n !== active.targetBatch || batch.previous !== active.predecessor.root || batch.settingsHash !== active.cutoff.settingsHash ||
    batch.previousClaims !== active.predecessor.claims) return 'renewal_binding';
  try { validateRenewalSlice(active, batch.renewal.slice, await executionSettingsDocument(state, batch)); } catch (e) { return e.message; }
  if (batch.receipts !== merkleRoot(batch.renewal.slice.seals.map(s => encodeBinary(s)))) return 'renewal_members';
  return null;
}

export function applyReceiptRenewalBatch(state, batch, active) {
  if (batch.renewal?.kind === 'reserve') {
    const record = receiptRenewalRecord(batch);
    state.put('v2/receipt-renewal', record);
    state.put('v2/receipt-renewal/' + record.id, { ...record, state: 'reserved' });
  } else if (batch.renewal?.kind === 'execute') {
    state.put('v2/receipt-renewal-slice/' + batch.n, receiptRenewalSliceCommitment(active, batch));
    const next = advanceReceiptRenewal(active, batch), complete = next.cursor.segment === active.cutoff.segmentCount;
    if (complete) state.del('v2/receipt-renewal'); else state.put('v2/receipt-renewal', next);
    state.put('v2/receipt-renewal/' + active.id, { ...next, state: complete ? 'consumed' : 'reserved',
      ...(complete ? { consumed: { n: batch.n, root: batch.root } } : {}) });
  }
}
