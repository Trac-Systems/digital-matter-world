import * as r from '../../rules/src/index.js';
import { check } from './check.mjs';

// batchRoot/settingsByHash must come from the player's independent notary
// adapter. A gateway assertion of acceptance is never sufficient.
export async function verifyRenewedAudit(file, bytes, { reservationBatch, executionBatch, auditProof, receiptProofs,
  batchRoot, settingsByHash, renewalSlice }, { network, gateway, members }) {
  check(typeof batchRoot === 'function' && typeof settingsByHash === 'function', 'Independent renewal reads required');
  const c = reservationBatch?.renewal?.cutoff;
  r.validateReceiptRenewalCutoff(c, { network, gateway, members, votes: reservationBatch.renewal.votes });
  const renewal = r.receiptRenewalRecord(reservationBatch);
  // The accepted audit commits the starting cursor; notary roots independently
  // authenticate the predecessor and this execution, even after many slices.
  renewal.cursor = file.renewalCursor;
  renewal.targetBatch = executionBatch.n;
  renewal.predecessor = { n: String(BigInt(executionBatch.n) - 1n), root: executionBatch.previous,
    claims: executionBatch.previousClaims, catalog: executionBatch.catalog };
  check(reservationBatch.renewal.kind === 'reserve' && reservationBatch.root === r.renewalReservationRoot(reservationBatch) &&
    await batchRoot(reservationBatch.n) === reservationBatch.root && await batchRoot(executionBatch.n) === executionBatch.root &&
    r.compareUint(executionBatch.n, reservationBatch.n) > 0 &&
    await batchRoot(renewal.predecessor.n) === executionBatch.previous &&
    executionBatch.renewal?.kind === 'execute' && executionBatch.renewal.id === renewal.id && file.renewal === renewal.id &&
    executionBatch.settingsHash === c.settingsHash && file.settingsHash === c.settingsHash && file.batchSequence === executionBatch.n,
  'Renewal acceptance mismatch');
  const document = await settingsByHash(c.settingsHash);
  check(document && r.hashObject(document) === c.settingsHash, 'Original renewal settings unavailable');
  check(r.stableJSON(r.decodeBinary(bytes)) === r.stableJSON(file), 'Renewal audit bytes mismatch');
  check(r.verifyMerkle(bytes, auditProof, executionBatch.root), 'Renewal audit proof mismatch');
  if (c.v === 2) check(typeof renewalSlice === 'function' &&
    await renewalSlice(executionBatch.n) === r.receiptRenewalSliceCommitment(renewal, executionBatch), 'Independent renewal slice mismatch');
  r.validateRenewalSlice(renewal, executionBatch.renewal.slice, document);
  const index = auditProof.index, slice = executionBatch.renewal.slice;
  check(auditProof.count === slice.seals.length && r.stableJSON(slice.seals[index]) === r.stableJSON(file.receiptRoot) &&
    executionBatch.receipts === r.merkleRoot(slice.seals.map(r.encodeBinary)), 'Renewal slice proof mismatch');
  for (const receipt of file.receipts) check(r.renewedReceiptBatch(receipt, renewal, executionBatch.n) &&
    r.verifyMerkle(r.stableJSON(receipt), receiptProofs?.[receipt.sequence], c.v === 2 ? file.receiptRoot.root : c.receipts), 'Renewal receipt proof mismatch');
  return { renewal, document };
}
