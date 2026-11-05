import { ed25519 } from '@noble/curves/ed25519';
import { canonicalJSON, check, equal, hex, isHex, sha256 } from './crypto.mjs';
import { rules } from './adapter.mjs';

const uint = n => Number.isSafeInteger(n) && n >= 0 || typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n);
const domain = 'dmw-batch-rejection-v1';
export const rejectionSlot = target => `batch/${target.epoch}/${target.n}`;
export const rejectionGuard = target => sha256(canonicalJSON(['dmw-batch-rejection-guard-v1', target]));

export function financialRetirementTarget(network, proposal) {
  const b = proposal?.batch;
  check(proposal?.network === network && proposal.kind === 'batch' && b && !proposal.recovery && !b.renewal &&
    [1, 2].includes(b.v) && uint(b.epoch) && uint(b.n) && BigInt(b.n) > 0n && uint(b.deadline) &&
    Array.isArray(proposal.files) && proposal.files.length > 0 && proposal.files.length <= 512, 'batch_retirement_proposal');
  const bytes = proposal.files.map(file => { check(typeof file === 'string' && /^(?:[0-9a-f]{2})+$/.test(file), 'batch_retirement_proposal'); return Buffer.from(file, 'hex'); });
  check(rules.merkleRoot(bytes) === b.root, 'batch_retirement_proposal');
  const files = bytes.map(file => rules.decodeBinary(file)), last = files.at(-1);
  check(files.some(f => f.financialOperations?.length || f.mintOperations?.length || f.linkOperations?.length) &&
    uint(last.tip) && isHex(last.tipHash), 'batch_retirement_proposal');
  return { domain, network, epoch: b.epoch, n: b.n, deadline: b.deadline,
    digest: hex(rules.batchDigest(network, b)), tip: last.tip, tipHash: last.tipHash };
}

function checkTarget(target, network) {
  check(target?.domain === domain && target.network === network && uint(target.epoch) && uint(target.n) && BigInt(target.n) > 0n &&
    uint(target.deadline) && uint(target.tip) && isHex(target.digest) && isHex(target.tipHash), 'batch_retirement_certificate');
}
export function checkRejectionStamp(target, stamp) {
  check(stamp && uint(stamp.revision) && uint(stamp.tip) && isHex(stamp.tipHash) && uint(stamp.counted) &&
    uint(stamp.last?.n) && uint(stamp.last?.to) && BigInt(stamp.last.n) + 1n === BigInt(target.n) &&
    rules.compareOrdinal(stamp.tip, target.tip) > 0, 'batch_retirement_snapshot');
}
export function attestBatchRejection(target, stamp, signer, secret) {
  checkTarget(target, target.network); checkRejectionStamp(target, stamp);
  return { signer, stamp, sig: hex(ed25519.sign(Buffer.from(canonicalJSON({ target, stamp })), Buffer.from(secret, 'hex'))) };
}
export function verifyBatchRejection(certificate, { network, members, target, minimum = 3 }) {
  const value = certificate?.target, votes = certificate?.votes;
  checkTarget(value, network);
  check(!target || equal(target, value), 'batch_retirement_certificate');
  check(Array.isArray(members) && members.length === 5 && new Set(members.map(m => m.id)).size === 5 &&
    new Set(members.map(m => m.identity)).size === 5 && members.every(m => isHex(m.identity)), 'batch_retirement_roster');
  check(Array.isArray(votes) && votes.length >= minimum && votes.length <= 5 &&
    new Set(votes.map(v => v.signer)).size === votes.length, 'batch_retirement_quorum');
  for (const vote of votes) {
    checkRejectionStamp(value, vote.stamp);
    const member = members.find(m => m.id === vote.signer);
    check(member && isHex(vote.sig, 64) && ed25519.verify(vote.sig, Buffer.from(canonicalJSON({ target: value, stamp: vote.stamp })),
      member.identity, { zip215: false }), 'batch_retirement_attestation');
  }
  return value;
}
