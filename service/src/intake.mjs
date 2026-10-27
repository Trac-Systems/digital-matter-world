import { rules } from './rules.mjs';
import { Limiter } from './limiter.mjs';
import { check, edPublic, heightKey } from './util.mjs';
// A conservative bound for the shared-string binary codec. Reference indices
// are charged three bytes, independent of eventual sorted-object traversal order.
const varint = n => { let bytes = 1; while (n >= 128) { n = Math.floor(n / 128); bytes++; } return bytes; };
function reserve(value, strings, added) {
  if (value === null || typeof value === 'boolean') return 1;
  if (typeof value === 'number') { let n = Math.abs(value), bytes = 2; while (n >= 128) { n = Math.floor(n / 128); bytes++; } return bytes; }
  if (typeof value === 'string') {
    if (strings.has(value)) return 3;
    strings.add(value); added.push(value);
    const size = value.length >= 8 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value) ? value.length / 2 : Buffer.byteLength(value);
    return 1 + varint(size) + size;
  }
  if (Array.isArray(value)) return 1 + varint(value.length) + value.reduce((n, v) => n + reserve(v, strings, added), 0);
  const entries = Object.entries(value);
  return 1 + varint(entries.length) + entries.reduce((n, [k, v]) => n + reserve(k, strings, added) + reserve(v, strings, added), 0);
}
export class Intake {
  constructor({ store, network, secret, hashAt, puzzleBits = 12, maxPending = 16000, maxEntries = 1000, auditLimit = 1500000, discoveryMaxHeight = 19999, limiter = new Limiter() }) {
    Object.assign(this, { store, network, secret, hashAt, puzzleBits, maxPending, maxEntries, auditLimit, discoveryMaxHeight, limiter });
    this.gateway = edPublic(secret); this.head = store.get('meta', 'head'); this.sequence = store.get('meta', 'receiptSequence') ?? 0;
    this.pending = new Map(); this.strings = new Set(); this.reserved = 24000; this.count = 0; this.reveals = 0; this.crafts = 0;
    if (this.head) for (const { value } of this.entries()) this.account(value);
  }
  entries() { return this.head ? this.store.list('intake/' + this.head.id, { limit: this.maxEntries }) : []; }
  account(entry) { this.reserved += reserve({ move: entry.move, receipt: entry.receipt, reason: 'accepted' }, this.strings, []); this.count++; if (entry.move.t === 'discovery-reveal') this.reveals++; if (entry.move.t === 'craft') this.crafts++; }
  async accept(text) {
    check(this.head && !this.rotating, 'tip_transition', 503);
    const move = rules.parseMove(text, rules.MOVE_DEFAULTS.maxBytes);
    check(['header', 'claim', 'discovery-commit', 'discovery-reveal', 'craft'].includes(move.t), 'move_type');
    const id = rules.moveId(move);
    const pending = this.pending.get(id); if (pending) return pending;
    const known = this.store.get('dedupe', id); if (known) return known.receipt;
    check(!this.store.get('receiptObservations', `${this.head.tip}/${this.head.hash}`), 'receipt_window_sealed', 503);
    check(!rules.checkMove(move, { network: this.network, tip: this.head.tip, hashAt: this.hashAt, puzzleBits: this.puzzleBits }), 'invalid_move');
    check(this.limiter.take(move.a), 'sender_rate', 429);
    check(move.t !== 'discovery-reveal' || this.head.counted <= this.discoveryMaxHeight, 'discovery_history_adapter_required', 503);
    check(move.t !== 'discovery-reveal' || this.reveals < 1, 'reveal_capacity', 429);
    check(move.t !== 'craft' || this.crafts < 8, 'craft_capacity', 429);
    check(this.count < this.maxEntries && this.store.count('dedupe') + this.pending.size < this.maxPending, 'pending_capacity', 503);
    const sequence = this.sequence + 1;
    const receipt = rules.signReceipt(move, { tip: this.head.tip, hash: this.head.hash, sequence, highestTip: this.head.highestTip }, this.secret);
    const entry = { move, receipt }, added = [], bytes = reserve({ ...entry, reason: 'accepted' }, this.strings, added);
    if (this.reserved + bytes > this.auditLimit || this.strings.size > 16000) { for (const s of added) this.strings.delete(s); throw Object.assign(Error('audit_capacity'), { status: 429 }); }
    this.sequence = sequence; this.reserved += bytes; this.count++; if (move.t === 'discovery-reveal') this.reveals++; if (move.t === 'craft') this.crafts++;
    const promise = this.store.transact([
      { space: 'intake/' + this.head.id, id: heightKey(sequence), value: entry },
      { space: 'dedupe', id, value: { receipt, tip: this.head.tip, observation: this.head.id } },
      { space: 'meta', id: 'receiptSequence', value: sequence }
    ]).then(() => receipt).catch(error => { this.rotating = true; throw error; }).finally(() => this.pending.delete(id));
    this.pending.set(id, promise); return promise;
  }
  async observe(head) {
    check(!this.rotating, 'tip_transition', 503); this.rotating = true;
    try {
      await Promise.all(this.pending.values());
      if (!head.force && this.head?.hash === head.hash && this.head.tip === head.tip && this.head.counted === head.counted && this.head.confirmed === head.confirmed && this.head.revision === head.revision) return null;
      check(Number.isSafeInteger(head.tip) && head.tip >= 0 && this.hashAt(head.tip) === head.hash, 'head_unverified');
      const next = { ...head, highestTip: Math.max(this.head?.highestTip ?? head.tip, head.tip), id: String((this.store.get('meta', 'observation') ?? 0) + 1).padStart(16, '0') };
      const operations = [{ space: 'meta', id: 'head', value: next }, { space: 'meta', id: 'observation', value: Number(next.id) }];
      let sealed = null;
      if (this.head) {
        const entries = this.entries().map(r => r.value);
        const receiptRoot = rules.sealReceipts(entries.map(e => e.receipt), { network: this.network, tip: this.head.tip, hash: this.head.hash }, this.secret);
        sealed = { ...this.head, receiptRoot, count: entries.length };
        operations.push({ space: 'observations', id: this.head.id, value: sealed });
        if (entries.length) operations.push({ space: 'receiptObservations', id: `${this.head.tip}/${this.head.hash}`, value: { seal: receiptRoot, receipts: entries.map(e => e.receipt) } });
      }
      await this.store.transact(operations); this.head = next; this.count = 0; this.reveals = 0; this.crafts = 0; this.strings.clear(); this.reserved = 24000;
      return sealed;
    } finally { if (!this.store.failed) this.rotating = false; }
  }
  seal() { check(this.head, 'head_missing'); return this.observe({ ...this.head, force: true }); }
}
