import { rules } from './adapter.mjs';
import { check, equal } from './crypto.mjs';

const snapshot = value => Object.fromEntries(['ready', 'manifestHash', 'settingsHash', 'last', 'claimsRoot', 'catalogRoot', 'scheduledSettings']
  .concat('receiptRenewal', 'receiptProtocol').map(key => [key, value?.[key] ?? null]));

// Calls share one gate with each other; the service also serializes them with
// prepare/root witnessing. Journal writes precede every returned attestation.
export class ReceiptFences {
  constructor({ journal, reads, network, gateway, signer, secret, members }) {
    Object.assign(this, { journal, reads, network, gateway, signer, secret, membersPin: members });
    this.tail = Promise.resolve(); this.receipts = new Map(); this.byBatch = new Map(); this.fences = new Map(); this.pageProgress = new Map(); this.pageMembers = new Map();
    for (const row of journal.records) this.apply(row);
  }
  apply(row) {
    if (row.type === 'receipt-admission') {
      const old = this.receipts.get(row.receipt.sequence);
      check(!old || equal(old.receipt, row.receipt), 'receipt_admission_conflict');
      this.receipts.set(row.receipt.sequence, row);
      if (!this.byBatch.has(row.receipt.batch)) this.byBatch.set(row.receipt.batch, new Map());
      this.byBatch.get(row.receipt.batch).set(row.receipt.sequence, row.receipt);
    }
    if (row.type === 'receipt-cutoff-start') {
      this.fences.set(row.cutoff.settingsHash, row);
      this.pageProgress.set(row.cutoff.settingsHash, row.progress);
    }
    if (row.type === 'receipt-cutoff-page') {
      this.pageProgress.set(row.settingsHash, row.progress);
      if (!this.pageMembers.has(row.settingsHash)) this.pageMembers.set(row.settingsHash, new Map());
      for (const [sequence, hash] of row.members) this.pageMembers.get(row.settingsHash).set(sequence, hash);
    }
    if (row.type === 'receipt-cutoff') {
      const old = this.fences.get(row.cutoff.settingsHash);
      check(!old || equal(old.cutoff, row.cutoff), 'receipt_cutoff_conflict');
      this.fences.set(row.cutoff.settingsHash, row);
    }
  }
  members(fence) { return fence.cutoff.v === 2 ? this.pageMembers.get(fence.cutoff.settingsHash) ?? new Map() : new Map(fence.members); }
  run(fn) { const result = this.tail.then(() => { check(!this.failed, 'receipt_journal_uncertain'); return fn(); }); this.tail = result.catch(() => {}); return result; }
  async persist(type, fields) {
    try { const row = await this.journal.append(type, fields); this.apply(row); return row; }
    catch (error) { this.failed = true; throw error; }
  }
  admit(receipt, checkpoint) { return this.run(async () => {
    check(this.secret?.length === 32, 'receipt_witness_identity');
    check(rules.verifyReceiptSignatureV2(receipt, this), 'receipt_invalid');
    const old = this.receipts.get(receipt.sequence);
    if (old) { check(equal(old.receipt, receipt), 'receipt_admission_conflict'); return old.vote; }
    const fence = this.fences.get(receipt.settingsHash);
    if (fence) {
      check(this.members(fence).get(receipt.sequence) === rules.hashObject(receipt), 'receipt_admission_fenced');
      // An uncertain admission included in the immutable cutoff can recover
      // its original receipt, even if this witness missed its first request.
      const vote = rules.attestReceiptFence('admission', receipt, this.signer, this.secret);
      await this.persist('receipt-admission', { receipt, vote }); return vote;
    }
    let accepted = await this.reads.rulesContext(), clock = await this.reads.tip(), authority = await this.reads.authority();
    // Warm shared reads can trail a new block or batch by a few seconds; re-read once before refusing.
    if (rules.compareUint(receipt.tip, rules.decimalV2(clock.tip)) > 0 || receipt.batch !== rules.nextUint(rules.decimalV2(accepted?.last?.n ?? '0'))) {
      [accepted, clock, authority] = await Promise.all([(this.reads.rulesContext.fresh ?? this.reads.rulesContext)(), (this.reads.tip.fresh ?? this.reads.tip)(), (this.reads.authority.fresh ?? this.reads.authority)()]);
    }
    check(!accepted?.receiptRenewal, 'renewal_pending');
    check(accepted?.ready && rules.hashObject(accepted.settings) === accepted.settingsHash &&
      receipt.batch === rules.nextUint(rules.decimalV2(accepted.last.n)), 'receipt_admission_predecessor');
    check(checkpoint && rules.claimStateRoot(checkpoint) === accepted.claimsRoot &&
      rules.compareUint(receipt.sequence, rules.uintV2(checkpoint.hot.namedSequence)) > 0, 'receipt_admission_checkpoint');
    const document = rules.effectiveSettings(accepted.settings, accepted.scheduledSettings, receipt.batch, rules.decimalV2(clock.tip));
    check(rules.hashObject(document) === accepted.settingsHash, 'receipt_policy_boundary');
    check(rules.compareUint(receipt.sequence, rules.addUint(checkpoint.hot.namedSequence, String(Math.min(document.values.receiptSegmentEntries, document.values.observationBudget)))) <= 0,
      'receipt_admission_capacity');
    check(receipt.settingsHash === rules.hashObject(document) && rules.compareUint(receipt.tip, rules.decimalV2(clock.tip)) <= 0,
      'receipt_admission_policy');
    check(!this.journal.slots.has(`batch/${authority.epoch}/${receipt.batch}`), 'receipt_batch_reserved');
    const vote = rules.attestReceiptFence('admission', receipt, this.signer, this.secret);
    check(equal(snapshot(accepted), snapshot(await this.reads.rulesContext())) && equal(authority, await this.reads.authority()), 'receipt_admission_snapshot');
    await this.persist('receipt-admission', { receipt, vote }); return vote;
  }); }
  cutoff(cutoff, evidence) { return this.run(async () => {
    check(this.secret?.length === 32, 'receipt_witness_identity');
    check(cutoff.network === this.network && cutoff.gateway === this.gateway, 'receipt_cutoff_domain');
    const old = this.fences.get(cutoff.settingsHash);
    if (old) { check(equal(old.cutoff, cutoff), 'receipt_cutoff_conflict'); if (old.vote) return old.vote; }
    const accepted = await this.reads.rulesContext();
    check(accepted?.ready && cutoff.settingsHash === accepted.settingsHash && equal(evidence.document, accepted.settings) &&
      cutoff.predecessor.n === rules.decimalV2(accepted.last.n) && cutoff.predecessor.claims === accepted.claimsRoot &&
      cutoff.predecessor.catalog === accepted.catalogRoot && cutoff.predecessor.root ===
        (BigInt(accepted.last.n) ? await this.reads.batchRoot(accepted.last.n) : accepted.manifest.previousBatchRoot), 'receipt_cutoff_predecessor');
    check(accepted.scheduledSettings && equal(evidence.successor, accepted.scheduledSettings) &&
      rules.hashObject(accepted.scheduledSettings) === cutoff.successorHash, 'receipt_cutoff_successor');
    if (cutoff.v === 2) return this.cutoffPage(cutoff, evidence, accepted, old);
    rules.verifyReceiptCutoff(cutoff, evidence);
    const authority = await this.reads.authority(), batch = rules.nextUint(rules.decimalV2(accepted.last.n)), slot = `batch/${authority.epoch}/${batch}`;
    if (this.journal.slots.has(slot)) {
      // This succeeds only after independent expiry/epoch and nonacceptance
      // proof. Neither a gateway assertion nor a timeout retires signing work.
      await this.journal.retireBatch(slot, this.reads);
    }
    const members = new Map(evidence.segments.flatMap(s => s.receipts).map(r => [r.sequence, r]));
    for (const receipt of this.byBatch.get(batch)?.values() ?? []) {
      if (rules.compareUint(receipt.sequence, cutoff.acceptedSequence) <= 0) continue;
      // Include uncertain acknowledgments too. A lost response is not an
      // authorization to omit the durable admission reservation.
      check(members.has(receipt.sequence) && equal(members.get(receipt.sequence), receipt), 'receipt_cutoff_omission');
    }
    for (const segment of evidence.segments) {
      const independent = await this.reads.receiptObservation(segment.seal.tip, segment.seal.hash, segment.seal.segment);
      check(equal(independent.seal, segment.seal) && equal(independent.receipts, segment.receipts), 'receipt_cutoff_segment_read');
    }
    check(equal(snapshot(accepted), snapshot(await this.reads.rulesContext())) && equal(authority, await this.reads.authority()), 'receipt_cutoff_snapshot');
    const vote = rules.attestReceiptFence('cutoff', cutoff, this.signer, this.secret);
    await this.persist('receipt-cutoff', { cutoff, vote, members: [...members].map(([sequence, r]) => [sequence, rules.hashObject(r)]) });
    return vote;
  }); }
  async cutoffPage(cutoff, evidence, accepted, old) {
    rules.validateReceiptCutoffShape(cutoff, this);
    const initial = rules.validatePagedCutoffEvidence(cutoff, evidence), settingsHash = cutoff.settingsHash;
    const authority = await this.reads.authority(), batch = rules.nextUint(rules.decimalV2(accepted.last.n)), slot = `batch/${authority.epoch}/${batch}`;
    if (this.journal.slots.has(slot)) await this.journal.retireBatch(slot, this.reads);
    check(typeof this.reads.receiptCutoffPage === 'function', 'receipt_cutoff_reader_required');
    if (!old) await this.persist('receipt-cutoff-start', { cutoff, progress: initial });
    let progress = this.pageProgress.get(settingsHash);
    for (let n = 0; n < evidence.document.values.observationsPerBatch && progress.index !== cutoff.segmentCount; n++) {
      check(rules.compareUint(progress.index, cutoff.segmentCount) < 0, 'receipt_cutoff_page');
      const page = await this.reads.receiptCutoffPage(settingsHash, progress.index);
      check(page && rules.receiptCutoffLink(page.index, page.segment.seal, page.next) === progress.chain, 'receipt_cutoff_page_link');
      const result = rules.verifyReceiptCutoffPage(cutoff, evidence.document, progress, page), { seal, receipts } = page.segment;
      const independent = await this.reads.receiptObservation(seal.tip, seal.hash, seal.segment);
      check(equal(independent.seal, seal) && equal(independent.receipts, receipts), 'receipt_cutoff_segment_read');
      const certificate = await this.reads.receiptCertificate(seal.tip, seal.hash, seal.segment);
      check(certificate && equal(certificate.seal, seal) && rules.verifyRootAttestations(seal, certificate.attestations,
        this.membersPin), 'receipt_certificate_read');
      check(equal(snapshot(accepted), snapshot(await this.reads.rulesContext())) && equal(authority, await this.reads.authority()), 'receipt_cutoff_snapshot');
      progress = { ...result.progress, chain: page.next };
      await this.persist('receipt-cutoff-page', { settingsHash, progress, members: receipts.map(r => [r.sequence, rules.hashObject(r)]) });
    }
    if (progress.index !== cutoff.segmentCount) return { pending: true, signer: this.signer, cutoff: rules.hashObject(cutoff), next: progress.index };
    check(progress.sequence === cutoff.lastSequence && progress.chain === rules.RECEIPT_CUTOFF_END, 'receipt_cutoff_range');
    const members = this.members(this.fences.get(settingsHash));
    for (const receipt of this.byBatch.get(batch)?.values() ?? []) {
      if (rules.compareUint(receipt.sequence, cutoff.acceptedSequence) <= 0) continue;
      check(members.get(receipt.sequence) === rules.hashObject(receipt), 'receipt_cutoff_omission');
    }
    check(equal(snapshot(accepted), snapshot(await this.reads.rulesContext())) && equal(authority, await this.reads.authority()), 'receipt_cutoff_snapshot');
    const vote = rules.attestReceiptFence('cutoff', cutoff, this.signer, this.secret);
    await this.persist('receipt-cutoff', { cutoff, vote });
    return vote;
  }
  checkSegment(seal, receipts) {
    check(!this.failed, 'receipt_journal_uncertain');
    const fence = this.fences.get(seal.settingsHash); if (!fence) return;
    const members = this.members(fence);
    for (const receipt of receipts) check(rules.compareUint(receipt.sequence, fence.cutoff.acceptedSequence) <= 0 ||
      members.get(receipt.sequence) === rules.hashObject(receipt), 'receipt_admission_fenced');
  }
  checkBatch(batch, files, renewal) {
    check(!this.failed, 'receipt_journal_uncertain');
    const members = new Map(files.flatMap(f => f.receipts).filter(r => r.v === 2).map(r => [r.sequence, r]));
    if (renewal) rules.verifyRenewalSegments(renewal, files.map(f => ({ seal: f.receiptRoot, receipts: f.receipts })), String(batch.n), batch.renewal.slice);
    for (const receipt of this.byBatch.get(String(batch.n))?.values() ?? [])
      check(members.has(receipt.sequence) && equal(members.get(receipt.sequence), receipt), 'receipt_batch_omission');
    const fence = this.fences.get(batch.settingsHash);
    check(!fence || renewal, 'receipt_admission_fenced');
    if (fence && rules.nextUint(fence.cutoff.predecessor.n) === String(batch.n)) for (const [sequence, hash] of this.members(fence))
      check(members.has(sequence) && rules.hashObject(members.get(sequence)) === hash, 'receipt_batch_omission');
    for (const file of files) this.checkSegment(file.receiptRoot, file.receipts);
  }
}
