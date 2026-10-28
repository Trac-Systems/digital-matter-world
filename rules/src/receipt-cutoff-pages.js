import { assert, exactKeys, hashObject, stableJSON, utf8, hex } from './core.js';
import { nextUint, uintV2 } from './integers-v2.js';
import { settingsSuccessor } from './settings-v2.js';
import { verifyReceiptSignatureV2 } from './receipt-v2.js';
import { verifyReceiptSegment, receiptSegmentHash } from './receipt-segments.js';
import { ClaimStorage, claimEvidenceReader, claimStateRoot } from './claim-state.js';
import { recordGet, recordSet } from './record-index.js';

export const RECEIPT_CUTOFF_END = hashObject(['dmw-receipt-cutoff-end-v2']);
export const receiptCutoffLink = (index, seal, next) => hashObject(['dmw-receipt-cutoff-link-v2', uintV2(index), receiptSegmentHash(seal), next]);
export const receiptCutoffPageKey = (settingsHash, index) => `${settingsHash}/${uintV2(index)}`;

// A synthetic claim checkpoint carries only the validated receipt-chain and
// sequence updates between certification pages. It never changes game state.
export function verifyReceiptCutoffPage(c, document, progress, page) {
  assert(page.index === progress.index && claimStateRoot(page.checkpoint) === progress.claims &&
    hashObject(document) === c.settingsHash, 'receipt_cutoff_page');
  const { seal, receipts } = page.segment;
  assert(utf8(stableJSON(page.segment)).length <= document.values.auditTotalBytes &&
    receipts.length <= document.values.receiptSegmentEntries &&
    seal.settingsHash === c.settingsHash && seal.settingsRevision === document.revision && seal.ruleset === document.ruleset &&
    verifyReceiptSegment(seal, receipts, { network: c.network, gateway: c.gateway, tip: seal.tip, hash: seal.hash }), 'receipt_cutoff_segment');
  const storage = new ClaimStorage({ get: claimEvidenceReader(page.claimEvidence, document), cacheSize: document.values.proofDepth });
  const state = storage.load({ claimSnapshot: page.checkpoint, claimRoot: progress.claims });
  const key = `${seal.tip}/${seal.hash}`, prior = recordGet(state.receiptSegments, key);
  assert(seal.segment === (prior ? nextUint(String(prior.segment)) : '0') && seal.previous === (prior?.hash ?? null), 'receipt_cutoff_segment_chain');
  let sequence = progress.sequence;
  for (const receipt of receipts) {
    assert(receipt.sequence === nextUint(sequence) && receipt.settingsHash === c.settingsHash &&
      receipt.batch === nextUint(c.predecessor.n) && verifyReceiptSignatureV2(receipt, { network: c.network, gateway: c.gateway }), 'receipt_cutoff_range');
    sequence = receipt.sequence;
  }
  state.receiptSegments = recordSet(state.receiptSegments, key, { segment: seal.segment, hash: receiptSegmentHash(seal) });
  state.namedSequence = sequence;
  const saved = storage.save(state);
  return { progress: { index: nextUint(progress.index), sequence, claims: saved.state.claimRoot }, checkpoint: saved.state.claimSnapshot, writes: saved.writes };
}

export function validatePagedCutoffEvidence(c, evidence) {
  assert(c.v === 2 && exactKeys(evidence, ['document', 'successor', 'checkpoint', 'paged']) && evidence.paged === true,
    'receipt_cutoff_evidence');
  settingsSuccessor(evidence.document, evidence.successor);
  assert(hashObject(evidence.document) === c.settingsHash && hashObject(evidence.successor) === c.successorHash &&
    claimStateRoot(evidence.checkpoint) === c.predecessor.claims &&
    evidence.checkpoint.hot.namedSequence === c.acceptedSequence && hex(c.segments, 32), 'receipt_cutoff_binding');
  return { index: '0', sequence: c.acceptedSequence, claims: c.predecessor.claims, chain: c.segments };
}

export const receiptRenewalSliceCommitment = (renewal, batch) => hashObject(['dmw-receipt-renewal-slice-v2',
  renewal.id, batch.n, batch.previous, batch.root, renewal.cursor, batch.renewal.slice]);
