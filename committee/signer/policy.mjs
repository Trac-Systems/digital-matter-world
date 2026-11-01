import { paidMintPlan } from './pay-first.mjs';
import { replayBatchWorker } from './replay-worker.mjs';
import { canonicalJSON, check, equal, isHex, sha256 } from './crypto.mjs';
import { rules, pendingRecord, permit, requestID } from './adapter.mjs';
import { escrowRelease, escrowRotation, expectedEscrowSplit, committeeAddress, ethAddress, uint256, ZERO_ADDRESS } from './escrow.mjs';
import { verifyBatchEvidence } from './batch-evidence.mjs';
import { verifyFinancialExecution } from './financial-execution.mjs';
import { financialMintId, financialPaymentHash } from '../../rules/src/financial-mint.js';
import { verifyRecoveryBatch } from './recovery-batch.mjs';
import { readPublicWinner, readPublicWinners, verifyPublicMintEvidence, verifyPublicPermit } from './public-claims.mjs';
import { verifyBulkPermit, bulkPublicReads } from './bulk-mint.mjs';

const uint = n => Number.isSafeInteger(n) && n >= 0 || typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n);
const positive = n => typeof n === 'string' && /^[1-9][0-9]*$/.test(n) && BigInt(n) < 1n << 256n;
export class Policy {
  constructor({ network, publicKey, reads, receiptFences, bitcoinNetwork = reads.bindings?.bitcoinNetwork ?? 'mainnet', confirmations = 1, escrow = null, authorizedMint, replayBatch = replayBatchWorker }) {
    check(/^[a-zA-Z0-9._:-]{1,96}$/.test(network) && Number.isSafeInteger(confirmations) && confirmations === 1, 'policy_config');
    Object.assign(this, { network, publicKey, reads, receiptFences, bitcoinNetwork, confirmations, escrow, authorizedMint, replayBatch });
  }
  async batch(proposal) {
    if (proposal.recovery) return verifyRecoveryBatch(this, proposal);
    const clock = rules.ordinalCodec(!!proposal.batch?.settingsHash);
    const authority = await this.reads.authority();
    check(authority?.network === this.network && authority.committee === this.publicKey && uint(authority.epoch), 'batch_authority');
    check(clock.valid(proposal.batch?.epoch) && clock.compare(proposal.batch.epoch, authority.epoch) === 0, 'batch_epoch');
    let context = await this.reads.batchContext(proposal.batch?.n);
    if (proposal.batch.ruleset === 'dmw-v2') {
      const accepted = await this.reads.rulesContext?.();
      check(accepted?.ready && accepted.ruleset === 'dmw-v2', 'batch_activation_read');
      check(accepted.receiptProtocol !== 1 || this.receiptFences, 'receipt_protocol_required');
      const manifest = rules.activationManifest(accepted.manifest, accepted.manifestHash);
      if (proposal.batch.renewal?.kind === 'reserve') return this.reserveReceiptRenewal(proposal, context, accepted, authority);
      check(!accepted.receiptRenewal || proposal.batch.renewal?.kind === 'execute', 'renewal_pending');
      check(!proposal.batch.renewal || accepted.receiptRenewal && proposal.batch.renewal.id === accepted.receiptRenewal.id, 'renewal_binding');
      const selected = accepted.receiptRenewal ? await this.reads.settingsByHash(accepted.receiptRenewal.cutoff.settingsHash) :
        rules.effectiveSettings(accepted.settings, accepted.scheduledSettings, rules.decimalV2(proposal.batch.n), rules.decimalV2(proposal.batch.execution.height));
      context = { ...context, renewal: accepted.receiptRenewal ?? undefined };
      // Separate codes name the failing read in the refusal log.
      check(manifest.network === this.network && rules.hashObject(accepted.settings) === accepted.settingsHash, 'batch_settings_read');
      check(selected, 'batch_settings_selected_unknown');
      check(rules.hashObject(context.settings.document) === rules.hashObject(selected), 'batch_settings_context_mismatch');
      check(proposal.batch.settingsHash === rules.hashObject(selected), 'batch_settings_proposal_mismatch');
      check(context.activation?.manifestHash === accepted.manifestHash, 'batch_settings_activation_mismatch');
      const documents = new Map(context.inputs.flatMap(i => i.settingsDocuments ?? []).map(d => [rules.hashObject(d), d]));
      for (const [hash, document] of documents) {
        const pinned = hash === accepted.settingsHash ? accepted.settings : await this.reads.settingsByHash?.(hash);
        check(pinned && rules.hashObject(pinned) === hash && equal(document, pinned), 'settings_history_read');
      }
      check(equal(context.last, accepted.last) && context.state.catalogRoot === accepted.catalogRoot &&
        context.state.accountRoot === accepted.accountsRoot && context.state.claimRoot === accepted.claimsRoot &&
        rules.claimStateRoot(context.state.claimSnapshot) === accepted.claimsRoot && proposal.batch.previousClaims === accepted.claimsRoot, 'batch_predecessor_state');
    }
    check(clock.compare(proposal.batch.to, context.counted) <= 0, 'batch_uncounted');
    const counted = await this.reads.counted();
    check(uint(counted) && clock.compare(counted, proposal.batch.to) >= 0 && clock.compare(counted, context.counted) >= 0, 'signer_not_caught_up');
    const horizon = proposal.batch.v === 2 ? rules.batchSettings(context.settings).batchDeadlineMaxBlocks : rules.MAX_BATCH_HORIZON;
    check(uint(proposal.batch.deadline) && clock.compare(proposal.batch.deadline, counted) >= 0 && clock.compare(proposal.batch.deadline, clock.add(counted, horizon)) <= 0, 'batch_deadline');
    // A free observation can be replayed at a newer execution snapshot. Always
    // compare the rebuilt proposal AND every file byte before reserving. Craft,
    // mint and link inputs retain their original execution-height checks.
    if (proposal.batch.v === 1 && proposal.batch.ops.every(op => op.op === 'kv') && !proposal.batch.hx?.length && context.inputs.every(input =>
      !input.mintOperations?.length && !input.linkOperations?.length && input.entries.every(e => e.move.t !== 'craft')))
      context = { ...context, counted };
    const publicReads = bulkPublicReads(this.reads);
    const approval = await this.replayBatch(this.network, proposal, { ...context, authority,
      replayNodes: this.reads.replayNodes?.bind(this.reads), claimNode: this.reads.claimNode?.bind(this.reads), namedNode: this.reads.namedNode?.bind(this.reads),
      publicMintGet: (asset, block, deployment) => readPublicWinner(publicReads, asset, block, { counted: context.counted, last: context.last }, deployment),
      publicMintBatch: pairs => readPublicWinners(publicReads, pairs, { counted: context.counted, last: context.last }) });
    await verifyPublicMintEvidence(approval.files, publicReads, { counted: context.counted, last: context.last });
    this.receiptFences?.checkBatch(proposal.batch, approval.files, context.renewal);
    for (const [index, file] of approval.files.entries()) {
      const root = await this.reads.receiptCertificate(file.tip, file.tipHash, file.receiptRoot.v === 2 ? file.receiptRoot.segment : undefined);
      // A tip's first observation can precede intake and its certified seal.
      // Backlog replay may include both in one batch. Only an empty, unattested
      // precursor may defer to a later file, whose exact seal AND receipt bytes
      // have already passed replay. Never defer to a certificate alone: that
      // would permit omission of the certified receipts from this batch.
      const sealedLater = file.receiptRoot.v !== 2 && root !== null && file.receipts.length === 0 && file.rootAttestations.length === 0 && file.receiptReference === null &&
        approval.files.slice(index + 1).some(later => later.tip === file.tip && later.tipHash === file.tipHash && later.rootAttestations.length > 0 && equal(later.receiptRoot, root.seal));
      check(root === null ? file.receipts.length === 0 && file.rootAttestations.length === 0 : (file.receiptReference === root.seal.root || equal(root.seal, file.receiptRoot) || sealedLater) && rules.verifyRootAttestations(root.seal, root.attestations, context.settings?.receiptSigners), 'receipt_certificate_read');
    }
    const financialV2 = approval.files.some(f => f.financialOperations?.length);
    const financial = financialV2 || approval.files.some(f => f.mintOperations.length || f.linkOperations.length);
    let stamp;
    if (financial) {
      stamp = await this.reads.batchStamp();
      const last = approval.files.at(-1);
      check(stamp && uint(stamp.revision) && clock.compare(stamp.counted, context.counted) === 0 && equal(stamp.last, context.last) && clock.compare(stamp.tip, last.tip) === 0 && stamp.tipHash === last.tipHash, 'batch_snapshot');
      check(clock.compare(await this.reads.counted(), context.counted) === 0, 'batch_clock_changed');
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
    if (financialV2) {
      check(clock.compare(approval.files.at(-1).height, context.counted) === 0, 'financial_execution_height');
      await verifyFinancialExecution({ files: approval.files, reads: this.reads, document: context.settings.document,
        network: this.network, height: context.counted, at: { counted: context.counted, last: context.last } });
    }
    if (financial) {
      check(clock.compare(await this.reads.counted(), context.counted) === 0, 'batch_clock_changed');
      check(equal(await this.reads.batchStamp(), stamp), 'batch_snapshot_changed');
    }
    const preflight = await this.reads.preflight(approval.batch, { counted: context.counted, last: context.last });
    check(preflight?.ok === true && clock.compare(preflight.counted, context.counted) >= 0 && equal(preflight.last, context.last) && preflight.digest === approval.digest, 'batch_preflight');
    const current = await this.reads.authority();
    check(current?.network === authority.network && current.committee === authority.committee && current.epoch === authority.epoch, 'batch_authority_changed');
    const { files, state, patterns, ...result } = approval; return result;
  }
  async reserveReceiptRenewal(proposal, context, accepted, authority) {
    const b = proposal.batch, c = b.renewal.cutoff, evidence = proposal.cutoffEvidence;
    check(!accepted.receiptRenewal && this.receiptFences, 'renewal_pending');
    rules.validateReceiptRenewalCutoff(c, { network: this.network, gateway: context.gateway,
      members: context.settings.receiptSigners, votes: b.renewal.votes });
    if (c.v === 2) rules.validatePagedCutoffEvidence(c, evidence); else rules.verifyReceiptCutoff(c, evidence);
    check(equal(evidence.document, accepted.settings) && equal(evidence.successor, accepted.scheduledSettings), 'renewal_policy');
    // Cutoff votes never substitute for a timely Bitcoin-window certificate.
    for (const segment of evidence.segments ?? []) {
      const certificate = await this.reads.receiptCertificate(segment.seal.tip, segment.seal.hash, segment.seal.segment);
      check(certificate && equal(certificate.seal, segment.seal) &&
        rules.verifyRootAttestations(segment.seal, certificate.attestations, context.settings.receiptSigners), 'receipt_certificate_read');
    }
    check(!(await this.receiptFences.cutoff(c, evidence)).pending, 'receipt_cutoff_incomplete');
    const built = rules.buildReceiptRenewalBatch({ cutoff: c, votes: b.renewal.votes, document: accepted.settings,
      epoch: rules.decimalV2(authority.epoch), last: accepted.last, accounts: accepted.accountsRoot,
      observation: rules.decimalV2(context.state.observation ?? 0), execution: b.execution, deadline: b.deadline });
    check(equal(built.batch, b) && Array.isArray(proposal.files) && proposal.files.length === 0, 'renewal_transition');
    const counted = await this.reads.counted(), preflight = await this.reads.preflight(b, { counted, last: accepted.last });
    const digest = rules.bytesToHex(built.signingDigest);
    check(preflight?.ok && preflight.digest === digest && equal(preflight.last, accepted.last), 'batch_preflight');
    check(equal(accepted, await this.reads.rulesContext()) && equal(authority, await this.reads.authority()), 'renewal_snapshot');
    return { digest, slots: [`batch/${b.epoch}/${b.n}`, `receipt-renewal/${rules.hashObject(c)}/reserve`],
      details: { root: b.root, epoch: b.epoch, n: b.n, deadline: b.deadline, batch: b }, batch: b };
  }
  async mint(proposal) {
    if (proposal.version === 'bulk-v1') {
      check(rules.exactKeys(proposal, ['network', 'kind', 'version', 'orderId', 'index']), 'bulk_permit_proposal');
      return verifyBulkPermit({ reads: this.reads, network: this.network, publicKey: this.publicKey,
        orderId: proposal.orderId, index: proposal.index, at: await this.reads.batchStamp() });
    }
    if (proposal.version === 'public-v1') {
      const at = await this.reads.batchStamp();
      const { source, funding, permit: p } = await this.reads.publicMintPermit(proposal.id, at);
      await verifyPublicPermit({ reads: bulkPublicReads(this.reads), source, funding, permit: p, id: proposal.id, at });
      check(source.receiver === proposal.receiver && source.deployment.privilegePublicKey === this.publicKey &&
        equal(at, await this.reads.batchStamp()), 'public_permit_binding');
      return { digest: p.digest, slots: [`mint/request/${proposal.id}`, 'mint/block/' + rules.mintPlotKey(source.asset, source.request.block, source.capacity?.supplyScope)],
        details: { version: 'public-v1', id: proposal.id, receiver: source.receiver, request: source.request, intent: source.intent,
          payment: { kind: 'tap', commitment: funding.consumedRoot }, deployment: source.deployment, permit: p }, permit: p };
    }
    if (proposal.version === 2) {
      check(typeof this.reads.financialPermit === 'function', 'financial_source_adapter_required');
      const id = financialMintId(this.network, proposal.request), at = await this.reads.batchStamp();
      const { row, source, funding, permit: p } = await this.reads.financialPermit(id, at, { consumed: true });
      check(equal(row.request, proposal.request) && row.signature === proposal.signature && row.receiver === proposal.receiver &&
        source.deployment.privilegePublicKey === this.publicKey, 'financial_permit_binding');
      check(equal(at, await this.reads.batchStamp()), 'financial_snapshot_changed');
      const details = { version: 2, id, request: row.request, signature: row.signature, receiver: row.receiver, deployment: source.deployment,
        payment: { kind: row.kind, commitment: financialPaymentHash(funding) }, permit: p, commissions: [] };
      return { digest: p.digest, slots: [`mint/request/${id}`, ...(source.deployment.kind === 'dmt' ? ['mint/block/' + rules.mintPlotKey(row.request.asset, row.request.block, source.capacity?.supplyScope)] : [])], details, permit: p };
    }
    const plan = await paidMintPlan({ reads: this.reads, bitcoinNetwork: this.bitcoinNetwork, network: this.network, publicKey: this.publicKey, confirmations: this.confirmations, request: proposal.request, signature: proposal.signature, receiver: proposal.receiver, consumed: true });
    const { details, permit: p } = plan;
    return { digest: p.digest, slots: [`mint/request/${details.id}`, ...(details.deployment.kind === 'dmt' ? [`mint/block/${details.request.asset}/${details.request.block}`] : [])], details, permit: p };
  }
  async paymentRelease(proposal) {
    const { id } = proposal;
    if (proposal.version === 2) {
      const at = await this.reads.batchStamp(), funding = await this.reads.financialRecord('fp/' + id, at), obligation = await this.reads.financialRecord('ao/' + id, at);
      check(funding?.state === 'open' && obligation?.state === 'reserved', 'financial_exit_state');
      const snapshot = await this.reads.financialEscrow(id, proposal.references, at); this.escrowState(snapshot);
      check(snapshot.deposit.status === 1 && BigInt(snapshot.deposit.expiry) > BigInt(snapshot.timestamp), 'escrow_expired');
      const signed = escrowRelease(this.escrow, id, snapshot.deposit, snapshot.committeeEpoch);
      check(signed.digest === snapshot.releaseDigest && equal(at, await this.reads.batchStamp()), 'escrow_release_digest');
      return { ...signed, slots: [`ethereum/release/${snapshot.chainId}/${snapshot.address}/${snapshot.payer}/${id}`], details: { id, payer: snapshot.payer, typedData: signed.typedData } };
    }
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
