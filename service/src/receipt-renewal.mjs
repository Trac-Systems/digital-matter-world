import { rules } from './rules.mjs';
import { check, hash, heightKey } from './util.mjs';

// Publish proof material before the atomic local acceptance checkpoint. The
// point-lookup descriptors become visible only with that checkpoint, and can
// be regenerated identically after an interrupted write.
export async function publishReceiptRenewal({ store, files }, draft) {
  const renewal = draft.settings.receiptRenewal, batch = draft.proposal.batch;
  const reservation = store.get('batches', heightKey(renewal.reserved.n))?.batch;
  const cutoff = store.get('receiptCutoffs', renewal.id);
  check(reservation?.root === renewal.reserved.root && cutoff && rules.hashObject(cutoff.cutoff) === renewal.id,
    'renewal_evidence_missing');
  const originalReceipts = cutoff.evidence.segments?.flatMap(s => s.receipts);
  const originalBytes = originalReceipts?.map(rules.stableJSON);
  const auditBytes = draft.proposal.files.map(hex => Buffer.from(hex, 'hex'));
  check(rules.merkleRoot(auditBytes) === batch.root && (renewal.cutoff.v === 2 || rules.merkleRoot(originalBytes) === renewal.cutoff.receipts), 'renewal_evidence_root');
  const writes = [];
  for (const [index, item] of draft.items.entries()) {
    const receipts = originalReceipts ?? item.output.file.receipts, receiptBytes = originalBytes ?? receipts.map(rules.stableJSON);
    const receiptIndex = new Map(receipts.map((r, i) => [r.sequence, i]));
    const receiptProofs = {};
    for (const receipt of item.output.file.receipts) {
      const position = receiptIndex.get(receipt.sequence);
      check(position !== undefined && receiptBytes[position] === rules.stableJSON(receipt), 'renewal_evidence_member');
      receiptProofs[receipt.sequence] = rules.merkleProof(receiptBytes, position);
    }
    const bytes = Buffer.from(JSON.stringify({ reservationBatch: reservation, executionBatch: batch,
      auditProof: rules.merkleProof(auditBytes, index), receiptProofs }));
    const observation = rules.decimalV2(item.output.file.observation);
    const descriptor = await files.immutable(`records/receipt-renewals/${renewal.id}/${observation}-${hash(bytes)}.json`, bytes);
    writes.push({ space: 'receiptRenewalProofs', id: `${renewal.id}/${observation}`, value: descriptor });
  }
  return writes;
}
