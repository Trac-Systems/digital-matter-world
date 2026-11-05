import { rejectionSlot, rejectionGuard, attestBatchRejection, verifyBatchRejection } from './batch-retirement.mjs';
import { compareOrdinal, ordinalCodec } from '../../rules/src/integers-v2.js';
import { open, readFile, mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJSON, check, mac, safeEqual } from './crypto.mjs';

const uint = n => Number.isSafeInteger(n) && n >= 0 || typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n);
// Reservations are durable before the sidecar receives permission to sign.
// A torn record is a hard failure, never silently truncated or repaired.
export class Journal {
  constructor(path, key, network, signer, { decimalIndex = false } = {}) {
    Object.assign(this, { path, key, network, signer }); this.slots = new Map(); this.records = []; this.head = '0'.repeat(64);
    this.rejectedBatches = new Set(); this.retiredBatches = new Set();
    this.clock = ordinalCodec(decimalIndex); this.nextIndex = this.clock.zero;
  }
  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let text;
    try { check((await lstat(this.path)).mode % 512 === 0o600, 'journal_mode'); text = await readFile(this.path, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; text = ''; }
    check(!text || text.endsWith('\n'), 'journal_truncated');
    let decimalTail = false;
    for (const line of text.split('\n').filter(Boolean)) {
      const row = JSON.parse(line), { tag, ...entry } = row;
      check(canonicalJSON(row) === line && entry.previous === this.head && uint(entry.index) && compareOrdinal(entry.index, this.nextIndex) === 0 && entry.network === this.network && entry.signer === this.signer && safeEqual(tag, mac(this.key, entry)), 'journal_integrity');
      check(!decimalTail || typeof entry.index === 'string', 'journal_integer_downgrade');
      // A retained decimal tail is never rewritten as numeric records on reopen.
      if (typeof entry.index === 'string') { this.clock = ordinalCodec(true); decimalTail = true; }
      this.apply(entry); this.head = tag; this.records.push(entry); this.nextIndex = this.clock.add(entry.index);
    }
    this.file = await open(this.path, 'a', 0o600); return this;
  }
  apply(entry) {
    if (entry.type === 'batch-rejection-vote' || entry.type === 'retired-rejected-batch') {
      // The authenticated journal retains the roster used to verify the proof.
      const vote = entry.type === 'batch-rejection-vote';
      const target = verifyBatchRejection(entry.certificate, { network: this.network, members: entry.members, minimum: vote ? 1 : 3 });
      const slot = rejectionSlot(target), old = this.slots.get(slot);
      check(!this.records.some(r => r.type === 'signed' && r.digest === target.digest), 'batch_retirement_signed');
      if (vote) check(old?.digest === rejectionGuard(target) && entry.certificate.votes.length === 1 &&
        entry.certificate.votes[0].signer === this.signer && !this.records.some(r => r.type === 'reserve' && r.digest === target.digest), 'batch_retirement_reserved');
      this.rejectedBatches.add(target.digest);
      if (!vote) {
        this.retiredBatches.add(target.digest);
        if (old && [target.digest, rejectionGuard(target)].includes(old.digest)) for (const held of old.slots) {
          if (held === slot || held.startsWith('receipt-renewal/')) {
            check(this.slots.get(held)?.digest === old.digest, 'journal_retirement'); this.slots.delete(held);
          }
        }
      }
    }
    if (entry.type === 'retired-batch') {
      const old = this.slots.get(entry.slot), p = entry.proof;
      check(old && old.digest === entry.digest && entry.slot === `batch/${old.details.epoch}/${old.details.n}` &&
        uint(p.counted) && uint(p.epoch) && compareOrdinal(p.epoch, old.details.epoch) >= 0 &&
        uint(p.last?.n) && compareOrdinal(p.last.n, old.details.n) < 0 && p.root === null &&
        (compareOrdinal(p.epoch, old.details.epoch) > 0 || uint(old.details.deadline) && compareOrdinal(p.counted, old.details.deadline) > 0), 'journal_retirement');
      // Receipt renewal consumption is reserved atomically with its batch.
      // Only this independently proven retirement can release both locks.
      for (const slot of old.slots) if (slot === entry.slot || slot.startsWith('receipt-renewal/')) {
        check(this.slots.get(slot)?.digest === old.digest, 'journal_retirement'); this.slots.delete(slot);
      }
    }
    if (entry.type === 'cancelled-slot') {
      const old = this.slots.get(entry.slot); check(old && old.details.id === entry.request, 'journal_cancellation'); this.slots.delete(entry.slot);
    }
    if (entry.type === 'reserve') {
      check(!this.rejectedBatches.has(entry.digest), 'batch_digest_rejected');
      for (const slot of entry.slots) {
        const old = this.slots.get(slot);
        const retry = old && slot.startsWith('mint/') && entry.retryOf === old.session && entry.session !== old.session && old.digest === entry.digest &&
          canonicalJSON(old.slots) === canonicalJSON(entry.slots) && canonicalJSON(old.details) === canonicalJSON(entry.details);
        check(!old || (slot.startsWith('batch/') || slot.startsWith('receipt-renewal/')) && old.digest === entry.digest || retry, 'journal_double_reservation'); this.slots.set(slot, entry);
      }
    }
  }
  async append(type, fields) {
    check(!['index', 'network', 'signer', 'previous', 'type'].some(k => Object.hasOwn(fields, k)), 'journal_fields');
    const entry = { index: this.nextIndex, network: this.network, signer: this.signer, previous: this.head, type, ...fields }, tag = mac(this.key, entry);
    await this.file.write(canonicalJSON({ ...entry, tag }) + '\n'); await this.file.sync();
    this.apply(entry); this.head = tag; this.records.push(entry); this.nextIndex = this.clock.add(entry.index); return entry;
  }
  async reserve(slots, digest, session, details = {}) {
    check(!this.rejectedBatches.has(digest), 'batch_digest_rejected');
    check(slots.length > 0 && new Set(slots).size === slots.length, 'slots');
    for (const slot of slots) { const old = this.slots.get(slot); check(!old || (slot.startsWith('batch/') || slot.startsWith('receipt-renewal/')) && old.digest === digest, old?.digest === digest ? 'slot_already_reserved' : 'slot_conflict'); }
    return this.append('reserve', { slots, digest, session, details });
  }
  async retryMint(slots, digest, session) {
    const old = this.slots.get(slots[0]);
    check(old && slots.every(slot => slot.startsWith('mint/') && this.slots.get(slot)?.session === old.session) &&
      canonicalJSON(old.slots) === canonicalJSON(slots) && old.digest === digest, 'mint_retry_binding');
    check(session !== old.session && !this.records.some(r => r.type === 'reserve' && r.session === session), 'ceremony_reused');
    check(!this.records.some(r => r.type === 'signed' && r.digest === digest), 'permit_result_available');
    return this.append('reserve', { slots, digest, session, details: old.details, retryOf: old.session });
  }
  async rejectBatch(target, batch, stamp, members, secret, beforeWrite = () => {}) {
    check(target.epoch === batch.epoch && target.n === batch.n && target.deadline === batch.deadline, 'batch_retirement_proposal');
    const saved = this.records.find(r => r.type === 'batch-rejection-vote' && r.certificate.target.digest === target.digest);
    if (saved) return saved.certificate.votes[0];
    check(!this.retiredBatches.has(target.digest), 'batch_digest_rejected');
    check(!this.records.some(r => r.type === 'reserve' && r.digest === target.digest), 'batch_retirement_reserved');
    const slot = rejectionSlot(target), guard = rejectionGuard(target), old = this.slots.get(slot);
    check(!old || old.digest === guard, 'slot_conflict');
    const vote = attestBatchRejection(target, stamp, this.signer, secret), certificate = { target, votes: [vote] };
    verifyBatchRejection(certificate, { network: this.network, members, minimum: 1 });
    // Old readers understand this guard and cannot reserve the rejected digest.
    // Its deadline is the original batch deadline, so expiry cannot revive it.
    beforeWrite();
    if (!old) await this.reserve([slot], guard, guard, { epoch: batch.epoch, n: batch.n, deadline: batch.deadline, root: batch.root, batch });
    await this.append('batch-rejection-vote', { certificate, members }); return vote;
  }
  async retireRejectedBatch(certificate, members, beforeWrite = () => {}) {
    const target = verifyBatchRejection(certificate, { network: this.network, members });
    const saved = this.records.find(r => r.type === 'retired-rejected-batch' && r.certificate.target.digest === target.digest);
    if (saved) return saved;
    check(!this.records.some(r => r.type === 'signed' && r.digest === target.digest), 'batch_retirement_signed');
    beforeWrite();
    return this.append('retired-rejected-batch', { certificate, members });
  }
  async retireBatch(slot, reads) {
    const old = this.slots.get(slot); check(old && slot.startsWith('batch/'), 'batch_reservation_missing');
    // Only committed reads prove expiry. Refused combined headers and a
    // preflight error cannot retire a digest that may still execute later.
    const before = await reads.authority(), last = await reads.batchLast(), root = await reads.batchRoot(old.details.n), counted = await reads.counted();
    const after = await reads.authority(), currentLast = await reads.batchLast();
    check(canonicalJSON(before) === canonicalJSON(after) && canonicalJSON(last) === canonicalJSON(currentLast), 'batch_retirement_snapshot');
    const proof = { epoch: after.epoch, counted, last, root };
    check(uint(proof.epoch) && compareOrdinal(proof.epoch, old.details.epoch) >= 0 && uint(counted) &&
      uint(last?.n) && compareOrdinal(last.n, old.details.n) < 0 && root === null &&
      (compareOrdinal(proof.epoch, old.details.epoch) > 0 || uint(old.details.deadline) && compareOrdinal(counted, old.details.deadline) > 0), 'batch_retirement_unproven');
    return this.append('retired-batch', { slot, digest: old.digest, session: old.session, proof });
  }
  async close() { await this.file?.close(); }
}
