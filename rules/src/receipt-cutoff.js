import { ed25519 } from '@noble/curves/ed25519';
import { assert, exactKeys, hex, hashObject, stableJSON, digest, bytesToHex, hexToBytes } from './core.js';
import { uintV2, nextUint } from './integers-v2.js';
import { settingsSuccessor } from './settings-v2.js';
import { verifyReceiptSignatureV2 } from './receipt-v2.js';
import { verifyReceiptSegment, receiptSegmentHash } from './receipt-segments.js';
import { claimStateRoot, ClaimStorage, claimEvidenceReader } from './claim-state.js';
import { recordGet, recordSet } from './record-index.js';
import { merkleRoot } from './merkle.js';
import { encodeBinary } from './binary.js';

const kinds = ['admission', 'cutoff'];
const unsigned = ({ sig, ...body }) => body;
export function attestReceiptFence(kind, value, signer, secret) {
  assert(kinds.includes(kind), 'receipt_fence_kind');
  const body = { v: 1, network: value.network, kind, commitment: hashObject(value), signer };
  return { ...body, sig: bytesToHex(ed25519.sign(digest('dmw-receipt-fence-v1', body.network, body), secret)) };
}
export function verifyReceiptFenceVotes(kind, value, votes, members, quorum = 3) {
  try {
    assert(kinds.includes(kind) && members?.length === 5 && new Set(members.map(m => m.id)).size === 5 &&
      new Set(members.map(m => m.identity)).size === 5, 'receipt_members');
    assert(Array.isArray(votes) && votes.length >= quorum && votes.length <= 5 && new Set(votes.map(v => v.signer)).size === votes.length, 'receipt_quorum');
    return votes.every(v => {
      const member = members.find(m => m.id === v.signer);
      return member && exactKeys(v, ['v', 'network', 'kind', 'commitment', 'signer', 'sig']) && v.v === 1 &&
        v.network === value.network && v.kind === kind && v.commitment === hashObject(value) && hex(v.sig, 64) &&
        ed25519.verify(hexToBytes(v.sig), digest('dmw-receipt-fence-v1', value.network, unsigned(v)), hexToBytes(member.identity), { zip215: false });
    });
  } catch { return false; }
}

// A cutoff is bound to the accepted claim checkpoint, never a queue-empty bit.
// Every unprocessed sequence is present exactly once, in its immutable segment.
// The separate witness protocol closes the otherwise unknowable omitted tail.
export function receiptCutoff({ network, gateway, predecessor, document, successor, checkpoint, segments, claimEvidence }) {
  settingsSuccessor(document, successor);
  assert(document.network === network && hex(gateway, 32) && exactKeys(predecessor, ['n', 'root', 'claims', 'catalog']) &&
    ['root', 'claims', 'catalog'].every(k => hex(predecessor[k], 32)), 'receipt_cutoff_predecessor');
  uintV2(predecessor.n);
  assert(claimStateRoot(checkpoint) === predecessor.claims, 'receipt_cutoff_checkpoint');
  const acceptedSequence = uintV2(checkpoint.hot.namedSequence), settingsHash = hashObject(document);
  assert(Array.isArray(segments) && segments.length <= document.values.observationBudget, 'receipt_cutoff_budget');
  const storage = new ClaimStorage({ get: claimEvidenceReader(claimEvidence ?? { nodes: [] }, document), cacheSize: document.values.proofDepth });
  const state = storage.load({ claimSnapshot: checkpoint, claimRoot: predecessor.claims });
  let sequence = acceptedSequence, receipts = [];
  const segmentHashes = [];
  for (const { seal, receipts: members } of segments) {
    assert(seal.settingsHash === settingsHash && seal.settingsRevision === document.revision && seal.ruleset === document.ruleset &&
      members.length <= document.values.receiptSegmentEntries && verifyReceiptSegment(seal, members, { network, gateway, tip: seal.tip, hash: seal.hash }), 'receipt_cutoff_segment');
    const key = `${seal.tip}/${seal.hash}`, prior = recordGet(state.receiptSegments, key);
    assert(seal.segment === (prior ? nextUint(String(prior.segment)) : '0') && seal.previous === (prior?.hash ?? null), 'receipt_cutoff_segment_chain');
    for (const receipt of members) {
      assert(receipt.sequence === nextUint(sequence) && receipt.settingsHash === settingsHash &&
        receipt.batch === nextUint(predecessor.n) && verifyReceiptSignatureV2(receipt, { network, gateway }), 'receipt_cutoff_range');
      sequence = receipt.sequence; receipts.push(receipt);
    }
    segmentHashes.push(receiptSegmentHash(seal));
    state.receiptSegments = recordSet(state.receiptSegments, key, { segment: seal.segment, hash: receiptSegmentHash(seal) });
  }
  assert(receipts.length <= document.values.observationBudget, 'receipt_cutoff_budget');
  return { v: 1, network, gateway, predecessor, settingsHash, successorHash: hashObject(successor),
    acceptedSequence, lastSequence: sequence, receipts: merkleRoot(receipts.map(stableJSON)),
    segments: merkleRoot(segmentHashes), batchReceipts: merkleRoot(segments.map(s => encodeBinary(s.seal))), segmentCount: String(segments.length) };
}

export function verifyReceiptCutoff(cutoff, evidence) {
  assert(stableJSON(cutoff) === stableJSON(receiptCutoff({ ...evidence, network: cutoff.network, gateway: cutoff.gateway,
    predecessor: cutoff.predecessor })), 'receipt_cutoff_binding');
  return cutoff;
}
