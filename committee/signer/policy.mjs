import { paidMintPlan } from './pay-first.mjs';
import { replayBatchWorker } from './replay-worker.mjs';
import { canonicalJSON, check, equal, isHex, sha256 } from './crypto.mjs';
import { rules, pendingRecord, permit, requestID } from './adapter.mjs';
import { escrowRelease, escrowRotation, expectedEscrowSplit, committeeAddress, ethAddress, uint256, ZERO_ADDRESS } from './escrow.mjs';
import { verifyBatchEvidence } from './batch-evidence.mjs';

const uint = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => typeof n === 'string' && /^[1-9][0-9]*$/.test(n) && BigInt(n) < 1n << 256n;
export class Policy {
  constructor({ network, publicKey, reads, bitcoinNetwork = reads.bindings?.bitcoinNetwork ?? 'mainnet', confirmations = 1, escrow = null, authorizedMint, replayBatch = replayBatchWorker }) {
    check(/^[a-zA-Z0-9._:-]{1,96}$/.test(network) && Number.isSafeInteger(confirmations) && confirmations === 1, 'policy_config');
    Object.assign(this, { network, publicKey, reads, bitcoinNetwork, confirmations, escrow, authorizedMint, replayBatch });
  }
  async batch(proposal) {
    const authority = await this.reads.authority();
    check(authority?.network === this.network && authority.committee === this.publicKey && uint(authority.epoch), 'batch_authority');
    check(uint(proposal.batch?.epoch) && proposal.batch.epoch === authority.epoch, 'batch_epoch');
    let context = await this.reads.batchContext(proposal.batch?.n);
    check(proposal.batch.to <= context.counted, 'batch_uncounted');
    const counted = await this.reads.counted();
    check(uint(counted) && counted >= proposal.batch.to && counted >= context.counted, 'signer_not_caught_up');
    check(uint(proposal.batch.deadline) && proposal.batch.deadline >= counted && proposal.batch.deadline - counted <= rules.MAX_BATCH_HORIZON, 'batch_deadline');
    // A free observation can be replayed at a newer execution snapshot. Always
    // compare the rebuilt proposal AND every file byte before reserving. Craft,
    // mint and link inputs retain their original execution-height checks.
    if (proposal.batch.ops.every(op => op.op === 'kv') && !proposal.batch.hx?.length && context.inputs.every(input =>
      !input.mintOperations?.length && !input.linkOperations?.length && input.entries.every(e => e.move.t !== 'craft')))
      context = { ...context, counted };
    const approval = await this.replayBatch(this.network, proposal, { ...context, authority });
    for (const [index, file] of approval.files.entries()) {
      const root = await this.reads.receiptCertificate(file.tip, file.tipHash);
      // A tip's first observation can precede intake and its certified seal.
      // Backlog replay may include both in one batch. Only an empty, unattested
      // precursor may defer to a later file, whose exact seal AND receipt bytes
      // have already passed replay. Never defer to a certificate alone: that
      // would permit omission of the certified receipts from this batch.
      const sealedLater = root !== null && file.receipts.length === 0 && file.rootAttestations.length === 0 && file.receiptReference === null &&
        approval.files.slice(index + 1).some(later => later.tip === file.tip && later.tipHash === file.tipHash && later.rootAttestations.length > 0 && equal(later.receiptRoot, root.seal));
      check(root === null ? file.receipts.length === 0 && file.rootAttestations.length === 0 : (file.receiptReference === root.seal.root || equal(root.seal, file.receiptRoot) || sealedLater) && rules.verifyRootAttestations(root.seal, root.attestations, context.settings?.receiptSigners), 'receipt_certificate_read');
    }
    const financial = approval.files.some(f => f.mintOperations.length || f.linkOperations.length);
    let stamp;
    if (financial) {
      stamp = await this.reads.batchStamp();
      const last = approval.files.at(-1);
      check(stamp && uint(stamp.revision) && stamp.counted === context.counted && equal(stamp.last, context.last) && stamp.tip === last.tip && stamp.tipHash === last.tipHash, 'batch_snapshot');
      check(await this.reads.counted() === context.counted, 'batch_clock_changed');
    }
    for (const file of approval.files) for (const input of file.linkOperations) {
      const id = rules.linkId(this.network, input.request), at = { observation: file.observation, height: file.height, tip: file.tip, tipHash: file.tipHash };
      check(equal(input.bitmap, await this.reads.bitmap(input.request.height, at)) && equal(input.previous, await this.reads.link(input.request.height, at)), 'link_state_read');
      check(equal(input.terms, await this.reads.linkTerms(id, input.request, at)) && equal(input.payment, await this.reads.linkPayment(id, at)), 'link_payment_read');
      check(input.payment.confirmations >= this.confirmations && input.payment.settlement.confirmations >= this.confirmations, 'link_confirmations');
    }
    // Existing free-move adapters already verify their balance snapshots. Mint
    // inputs additionally recheck contract balances and project earlier ops.
    if (approval.files.some(f => f.mintOperations.length)) {
      await verifyBatchEvidence({ reads: this.reads, bitcoinNetwork: this.bitcoinNetwork, network: this.network, publicKey: this.publicKey, context, files: approval.files, authorizedMint: this.authorizedMint, confirmations: this.confirmations });
    }
    if (financial) {
      check(await this.reads.counted() === context.counted, 'batch_clock_changed');
      check(equal(await this.reads.batchStamp(), stamp), 'batch_snapshot_changed');
    }
    const preflight = await this.reads.preflight(approval.batch, { counted: context.counted, last: context.last });
    check(preflight?.ok === true && preflight.counted === context.counted && equal(preflight.last, context.last) && preflight.digest === approval.digest, 'batch_preflight');
    const current = await this.reads.authority();
    check(current?.network === authority.network && current.committee === authority.committee && current.epoch === authority.epoch, 'batch_authority_changed');
    const { files, state, patterns, ...result } = approval; return result;
  }
  async mint(proposal) {
    const plan = await paidMintPlan({ reads: this.reads, bitcoinNetwork: this.bitcoinNetwork, network: this.network, publicKey: this.publicKey, confirmations: this.confirmations, request: proposal.request, signature: proposal.signature, receiver: proposal.receiver, consumed: true });
    const { details, permit: p } = plan;
    return { digest: p.digest, slots: [`mint/request/${details.id}`, ...(details.deployment.kind === 'dmt' ? [`mint/block/${details.request.asset}/${details.request.block}`] : [])], details, permit: p };
  }
  async paymentRelease(proposal) {
    const { id } = proposal;
    const payment = await this.reads.mintPayment(id);
    check(payment?.kind === 'ethereum' && payment.depositFinal === true, 'escrow_funded');
    const row = await this.reads.mintRequest(id);
    // A seen deposit first pins the reservation, so release cannot race an
    // ordinary unpaid expiry. Release is paid for by the player or recipient.
    const plan = await paidMintPlan({ reads: this.reads, bitcoinNetwork: this.bitcoinNetwork, network: this.network, publicKey: this.publicKey, confirmations: this.confirmations, request: row.request, signature: row.signature, receiver: row.receiver, final: false });
    check(plan.raw.s === 0 && plan.raw.h === true || plan.raw.s === 2 && await this.reads.counted() > plan.pending.expiry, 'pending_not_held');
    const snapshot = await this.reads.escrowDeposit(payment.payer, id);
    this.escrowState(snapshot);
    check(snapshot.requestId === id && snapshot.payer === ethAddress(payment.payer) && snapshot.deposit.payer === ethAddress(payment.payer) && snapshot.confirmations >= this.confirmations, 'escrow_funded');
    check(snapshot.deposit.amount === (payment.depositAmount ?? plan.fees.reduce((n,f)=>n+BigInt(f.amount),0n).toString()), 'escrow_split');
    check(snapshot.deposit.status === 1 && BigInt(snapshot.deposit.expiry) > BigInt(snapshot.timestamp), 'escrow_expired');
    check(equal(snapshot.deposit.split, payment.split), 'escrow_split');
    const signed = escrowRelease(this.escrow, id, snapshot.deposit, snapshot.committeeEpoch);
    check(signed.digest === snapshot.releaseDigest, 'escrow_release_digest');
    return { ...signed, slots: [`ethereum/release/${snapshot.chainId}/${snapshot.address}/${payment.payer}/${id}`], details: { id, payer: payment.payer, typedData: signed.typedData } };
  }
  escrowState(snapshot) {
    check(this.escrow && snapshot?.chainId === this.escrow.chainId && snapshot.address === ethAddress(this.escrow.address) && snapshot.token === ethAddress(this.escrow.token), 'escrow_domain');
    check(snapshot.committee === committeeAddress(this.publicKey), 'escrow_committee');
    uint256(snapshot.committeeEpoch); uint256(snapshot.timestamp);
  }
  async rotation(proposal) {
    // A gateway may relay a rotation, but cannot choose the next authority.
    const approved = await this.reads.committeeRotation();
    const requested = { newCommittee: proposal.newCommittee, nonce: proposal.nonce, committeeEpoch: proposal.committeeEpoch, deadline: proposal.deadline };
    check(approved && equal(approved, requested), 'rotation_not_authorized');
    const snapshot = await this.reads.escrowRotation(approved.newCommittee, approved.deadline);
    this.escrowState(snapshot);
    check(typeof snapshot.pendingCommittee?.adminOrigin === 'boolean', 'rotation_origin');
    check(!snapshot.pendingCommittee.adminOrigin, 'admin_recovery_pending');
    check(ethAddress(approved.newCommittee) !== ZERO_ADDRESS && ethAddress(approved.newCommittee) !== snapshot.address && ethAddress(approved.newCommittee) !== snapshot.committee, 'rotation_successor');
    check(approved.nonce === snapshot.rotationNonce && approved.committeeEpoch === snapshot.committeeEpoch, 'rotation_stale');
    check(BigInt(uint256(approved.deadline)) >= BigInt(snapshot.timestamp), 'rotation_expired');
    const signed = escrowRotation(this.escrow, approved.newCommittee, approved.nonce, approved.committeeEpoch, approved.deadline);
    check(signed.digest === snapshot.rotationDigest, 'escrow_rotation_digest');
    return { ...signed, slots: [`ethereum/rotation/${snapshot.chainId}/${snapshot.address}/${approved.nonce}`], details: { typedData: signed.typedData } };
  }
  async approve(proposal) {
    check(proposal?.network === this.network, 'network');
    if (proposal.kind === 'batch') return this.batch(proposal);
    if (proposal.kind === 'mint') return this.mint(proposal);
    if (proposal.kind === 'ethereum-payment-release') return this.paymentRelease(proposal);
    if (proposal.kind === 'ethereum-rotation') return this.rotation(proposal);
    throw Error('proposal_kind');
  }
}
