import { RECEIPT_CUTOFF_END, receiptCutoffLink } from './receipt-cutoff-pages.js';
import { assert, exactKeys, hashObject, stableJSON, hex, utf8 } from './core.js';
import { uintV2, nextUint, compareUint, addUint } from './integers-v2.js';
import { verifyReceiptFenceVotes } from './receipt-cutoff.js';
import { merkleRoot, merkleProof, verifyMerkle } from './merkle.js';
import { encodeBinary } from './binary.js';
import { receiptSegmentHash } from './receipt-segments.js';
import { batchDigest } from './operations.js';

// A reservation advances only the notary sequence. It does not execute or
// rewrite a receipt, close its Bitcoin window, or alter game/account roots.
export function validateReceiptCutoffShape(c, { network, gateway }) {
  assert(exactKeys(c, ['v', 'network', 'gateway', 'predecessor', 'settingsHash', 'successorHash', 'acceptedSequence',
    'lastSequence', 'segments', 'segmentCount', ...(c.v === 1 ? ['receipts', 'batchReceipts'] : [])]) && [1, 2].includes(c.v) && c.network === network &&
    c.gateway === gateway && exactKeys(c.predecessor, ['n', 'root', 'claims', 'catalog']), 'renewal_cutoff');
  for (const k of ['settingsHash', 'successorHash', 'segments', ...(c.v === 1 ? ['receipts', 'batchReceipts'] : [])]) assert(hex(c[k], 32), 'renewal_cutoff');
  for (const k of ['root', 'claims', 'catalog']) assert(hex(c.predecessor[k], 32), 'renewal_cutoff');
  for (const n of [c.predecessor.n, c.acceptedSequence, c.lastSequence, c.segmentCount]) uintV2(n);
  assert(compareUint(c.lastSequence, c.acceptedSequence) >= 0 && compareUint(c.segmentCount, '0') > 0, 'renewal_empty');
  return c;
}

export function validateReceiptRenewalCutoff(c, { network, gateway, members, votes }) {
  validateReceiptCutoffShape(c, { network, gateway });
  assert(verifyReceiptFenceVotes('cutoff', c, votes, members), 'renewal_quorum');
  return c;
}

export function receiptRenewalRecord(batch) {
  const { cutoff } = batch.renewal;
  return { id: hashObject(cutoff), cutoff, reserved: { n: batch.n, root: batch.root }, targetBatch: nextUint(batch.n),
    cursor: { segment: '0', sequence: cutoff.acceptedSequence, ...(cutoff.v === 2 ? { chain: cutoff.segments } : {}) },
    predecessor: { n: batch.n, root: batch.root, claims: batch.claims, catalog: batch.catalog } };
}

export function renewalReservationRoot(batch) {
  const { root, sig, ...body } = batch;
  return hashObject(['dmw-receipt-renewal-v1', body]);
}

export function buildReceiptRenewalBatch({ cutoff, votes, document, epoch, last, accounts, observation, execution, deadline }) {
  assert(hashObject(document) === cutoff.settingsHash && last.n === cutoff.predecessor.n, 'renewal_policy');
  const batch = { v: 2, epoch, n: nextUint(last.n), from: last.to, to: last.to, deadline,
    previous: cutoff.predecessor.root, ruleset: document.ruleset, settingsRevision: document.revision, settingsHash: cutoff.settingsHash,
    execution, observation, receipts: cutoff.batchReceipts ?? cutoff.segments, finds: merkleRoot([]), catalog: cutoff.predecessor.catalog,
    accounts, previousClaims: cutoff.predecessor.claims, claims: cutoff.predecessor.claims, ops: [],
    renewal: { kind: 'reserve', cutoff, votes } };
  batch.root = renewalReservationRoot(batch);
  assert(utf8(stableJSON({ ...batch, sig: '0'.repeat(128) })).length <= document.values.batchBytes, 'batch_bytes');
  return { batch, fileBytes: [], signingDigest: batchDigest(document.network, batch) };
}

// Each execution proves an exact nonempty prefix of the remaining certified
// segments. The cursor is accepted notary state, never supplied by the gateway.
export function validateRenewalSlice(renewal, slice, document) {
  const c = renewal.cutoff, cursor = renewal.cursor;
  assert(renewal.id === hashObject(c) && renewal.reserved.n === nextUint(c.predecessor.n) &&
    renewal.targetBatch === nextUint(renewal.predecessor.n), 'renewal_binding');
  assert(exactKeys(slice, ['from', 'to', 'sequence', 'seals', c.v === 1 ? 'proofs' : 'next']) &&
    slice.from === cursor.segment && Array.isArray(slice.seals) && slice.seals.length > 0 &&
    (c.v === 2 || Array.isArray(slice.proofs) && slice.proofs.length === slice.seals.length) &&
    slice.to === addUint(slice.from, String(slice.seals.length)) && compareUint(slice.to, c.segmentCount) <= 0, 'renewal_slice');
  if (document) assert(hashObject(document) === c.settingsHash && slice.seals.length <= document.values.observationBudget &&
    (c.v === 2 || utf8(stableJSON(slice)).length <= document.values.proofBytes &&
    slice.proofs.every(p => p.siblings.length <= document.values.proofDepth)), 'renewal_slice_budget');
  if (c.v === 2) {
    assert(hex(slice.next, 32), 'renewal_slice_member');
    let chain = slice.next;
    for (let i = slice.seals.length - 1; i >= 0; i--) chain = receiptCutoffLink(addUint(slice.from, String(i)), slice.seals[i], chain);
    assert(chain === cursor.chain && (slice.to !== c.segmentCount || slice.next === RECEIPT_CUTOFF_END), 'renewal_slice_member');
  }
  let sequence = cursor.sequence;
  for (const [i, seal] of slice.seals.entries()) {
    const proof = slice.proofs?.[i];
    assert((c.v === 2 || String(proof.index) === addUint(slice.from, String(i)) && String(proof.count) === c.segmentCount &&
      verifyMerkle(receiptSegmentHash(seal), proof, c.segments)) && seal.settingsHash === c.settingsHash, 'renewal_slice_member');
    assert(Number.isSafeInteger(seal.count) && seal.count >= 0, 'renewal_range');
    if (seal.count) {
      assert(seal.first === nextUint(sequence) && seal.last === addUint(sequence, String(seal.count)), 'renewal_range');
      sequence = seal.last;
    } else assert(seal.first === null && seal.last === null, 'renewal_range');
  }
  assert(slice.sequence === sequence && compareUint(sequence, c.lastSequence) <= 0 &&
    (slice.to !== c.segmentCount || sequence === c.lastSequence), 'renewal_range');
  return slice;
}

export function buildRenewalSlice(renewal, segments, allSegments, document) {
  const from = Number(renewal.cursor.segment), hashes = allSegments.map(s => receiptSegmentHash(s.seal));
  const slice = { from: renewal.cursor.segment, to: addUint(renewal.cursor.segment, String(segments.length)),
    sequence: segments.flatMap(s => s.receipts).at(-1)?.sequence ?? renewal.cursor.sequence,
    seals: segments.map(s => s.seal), proofs: segments.map((_, i) => merkleProof(hashes, from + i)) };
  return validateRenewalSlice(renewal, slice, document);
}

export function advanceReceiptRenewal(renewal, batch) {
  validateRenewalSlice(renewal, batch.renewal.slice);
  const slice = batch.renewal.slice;
  return { ...renewal, targetBatch: nextUint(batch.n), cursor: { segment: slice.to, sequence: slice.sequence, ...(renewal.cutoff.v === 2 ? { chain: slice.next } : {}) },
    predecessor: { n: batch.n, root: batch.root, claims: batch.claims, catalog: batch.catalog } };
}

export function verifyRenewalSegments(renewal, segments, batch, slice) {
  validateRenewalSlice(renewal, slice);
  assert(batch === renewal.targetBatch && stableJSON(segments.map(s => s.seal)) === stableJSON(slice.seals), 'renewal_members');
  let sequence = renewal.cursor.sequence;
  for (const segment of segments) {
    assert(merkleRoot(segment.receipts.map(stableJSON)) === segment.seal.root && segment.receipts.length === segment.seal.count, 'renewal_members');
    for (const r of segment.receipts) {
      assert(r.sequence === nextUint(sequence) && r.batch === renewal.reserved.n && r.settingsHash === renewal.cutoff.settingsHash, 'renewal_range');
      sequence = r.sequence;
    }
  }
  assert(sequence === slice.sequence, 'renewal_range');
  return true;
}

export function renewedReceiptBatch(receipt, renewal, batch) {
  return !!renewal && renewal.id === hashObject(renewal.cutoff) && renewal.reserved.n === nextUint(renewal.cutoff.predecessor.n) &&
    renewal.targetBatch === nextUint(renewal.predecessor.n) && batch === renewal.targetBatch && receipt.batch === renewal.reserved.n &&
    receipt.settingsHash === renewal.cutoff.settingsHash && compareUint(receipt.sequence, renewal.cursor.sequence) > 0 &&
    compareUint(receipt.sequence, renewal.cutoff.lastSequence) <= 0;
}
