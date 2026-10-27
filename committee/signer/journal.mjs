import { open, readFile, mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalJSON, check, mac, safeEqual } from './crypto.mjs';

// Reservations are durable before the sidecar receives permission to sign.
// A torn record is a hard failure, never silently truncated or repaired.
export class Journal {
  constructor(path, key, network, signer) { Object.assign(this, { path, key, network, signer }); this.slots = new Map(); this.records = []; this.head = '0'.repeat(64); }
  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let text;
    try { check((await lstat(this.path)).mode % 512 === 0o600, 'journal_mode'); text = await readFile(this.path, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; text = ''; }
    check(!text || text.endsWith('\n'), 'journal_truncated');
    for (const line of text.split('\n').filter(Boolean)) {
      const row = JSON.parse(line), { tag, ...entry } = row;
      check(canonicalJSON(row) === line && entry.previous === this.head && entry.index === this.records.length && entry.network === this.network && entry.signer === this.signer && safeEqual(tag, mac(this.key, entry)), 'journal_integrity');
      this.apply(entry); this.head = tag; this.records.push(entry);
    }
    this.file = await open(this.path, 'a', 0o600); return this;
  }
  apply(entry) {
    if (entry.type === 'retired-batch') {
      const old = this.slots.get(entry.slot), p = entry.proof;
      check(old && old.digest === entry.digest && entry.slot === `batch/${old.details.epoch}/${old.details.n}` &&
        Number.isSafeInteger(p.counted) && p.counted >= 0 && Number.isSafeInteger(p.epoch) && p.epoch >= old.details.epoch &&
        Number.isSafeInteger(p.last?.n) && p.last.n < old.details.n && p.root === null &&
        (p.epoch > old.details.epoch || Number.isSafeInteger(old.details.deadline) && p.counted > old.details.deadline), 'journal_retirement');
      this.slots.delete(entry.slot);
    }
    if (entry.type === 'cancelled-slot') {
      const old = this.slots.get(entry.slot); check(old && old.details.id === entry.request, 'journal_cancellation'); this.slots.delete(entry.slot);
    }
    if (entry.type === 'reserve') {
      for (const slot of entry.slots) { const old = this.slots.get(slot); check(!old || slot.startsWith('batch/') && old.digest === entry.digest, 'journal_double_reservation'); this.slots.set(slot, entry); }
    }
  }
  async append(type, fields) {
    const entry = { index: this.records.length, network: this.network, signer: this.signer, previous: this.head, type, ...fields }, tag = mac(this.key, entry);
    await this.file.write(canonicalJSON({ ...entry, tag }) + '\n'); await this.file.sync();
    this.apply(entry); this.head = tag; this.records.push(entry); return entry;
  }
  async reserve(slots, digest, session, details = {}) {
    check(slots.length > 0 && new Set(slots).size === slots.length, 'slots');
    for (const slot of slots) { const old = this.slots.get(slot); check(!old || slot.startsWith('batch/') && old.digest === digest, old?.digest === digest ? 'slot_already_reserved' : 'slot_conflict'); }
    return this.append('reserve', { slots, digest, session, details });
  }
  async retireBatch(slot, reads) {
    const old = this.slots.get(slot); check(old && slot.startsWith('batch/'), 'batch_reservation_missing');
    // Only committed reads prove expiry. Refused combined headers and a
    // preflight error cannot retire a digest that may still execute later.
    const before = await reads.authority(), last = await reads.batchLast(), root = await reads.batchRoot(old.details.n), counted = await reads.counted();
    const after = await reads.authority(), currentLast = await reads.batchLast();
    check(canonicalJSON(before) === canonicalJSON(after) && canonicalJSON(last) === canonicalJSON(currentLast), 'batch_retirement_snapshot');
    const proof = { epoch: after.epoch, counted, last, root };
    check(Number.isSafeInteger(proof.epoch) && proof.epoch >= old.details.epoch && Number.isSafeInteger(counted) && counted >= 0 &&
      Number.isSafeInteger(last?.n) && last.n < old.details.n && root === null &&
      (proof.epoch > old.details.epoch || Number.isSafeInteger(old.details.deadline) && counted > old.details.deadline), 'batch_retirement_unproven');
    return this.append('retired-batch', { slot, digest: old.digest, session: old.session, proof });
  }
  async close() { await this.file?.close(); }
}
