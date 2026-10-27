import assert from 'node:assert/strict';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { invariants } from '../../../contract/tests/helpers/harness.mjs';
import { rules } from '../../src/rules.mjs';

export async function diskSize(directory) {
  let bytes = 0, allocated = 0, files = 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name); let s;
    try { s = await lstat(path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) { const child = await diskSize(path); bytes += child.bytes; allocated += child.allocated; files += child.files; }
    else if (s.isFile()) { bytes += s.size; allocated += s.blocks * 512; files++; }
  }
  return { bytes, allocated, files };
}
export function delta(after, before, blocks = 1) {
  assert.ok(blocks > 0);
  return Object.fromEntries(Object.keys(after).map(k => [k, (after[k] - before[k]) / blocks]));
}
// Fixed bins bound memory regardless of run length; p99 is an upper bound.
export class Histogram {
  constructor() { this.bins = new Uint32Array(1002); this.count = 0; this.max = 0; }
  add(ms) { assert.ok(Number.isFinite(ms) && ms >= 0); this.bins[Math.min(1001, Math.ceil(ms / 10))]++; this.count++; this.max = Math.max(this.max, ms); }
  summary() {
    const at = q => { if (!this.count) return null; let n = 0; for (let i = 0; i < this.bins.length; i++) { n += this.bins[i]; if (n >= Math.ceil(q * this.count)) return i === 1001 ? this.max : i * 10; } };
    return { count: this.count, p50: at(.5), p99: at(.99), max: this.max, resolutionMs: 10 };
  }
}
export function memoryTrend(samples, { rssSlope = 1_048_576, heapSlope = 524_288 } = {}) {
  const groups = new Map();
  for (const r of samples) { const group = groups.get(r.pid) ?? []; group.push(r); groups.set(r.pid, group); }
  const segments = [];
  for (const [pid, group] of groups) {
    const warm = group.filter(r => r.block >= group[0].block + 25);
    if (warm.length < 3) continue;
    const slope = key => {
      const x = warm.reduce((n, r) => n + r.block, 0) / warm.length, y = warm.reduce((n, r) => n + r[key], 0) / warm.length;
      return warm.reduce((n, r) => n + (r.block - x) * (r[key] - y), 0) / warm.reduce((n, r) => n + (r.block - x) ** 2, 0);
    };
    segments.push({ pid, samples: warm.length, rssBytesPerBlock: slope('rss'), heapBytesPerBlock: slope('heapUsed') });
  }
  return { status: !segments.length ? 'insufficient_samples' : segments.every(r => r.rssBytesPerBlock <= rssSlope && r.heapBytesPerBlock <= heapSlope) ? 'pass' : 'fail', rssSlopeLimit: rssSlope, heapSlopeLimit: heapSlope, segments };
}
export class Accounting {
  constructor() { this.supply = new Map(); this.pending = new Map(); this.lastBatch = 0; this.counted = 0; this.operations = {}; }
  apply(batch, network) {
    assert.equal(batch.n, this.lastBatch + 1, 'accounting_batch_gap');
    const add = (asset, n) => this.supply.set(asset, (this.supply.get(asset) ?? 0n) + n);
    for (const op of batch.ops) {
      this.operations[op.op] = (this.operations[op.op] ?? 0) + 1;
      if (op.op === 'ac') for (const [asset, amount] of op.assets) add(asset, BigInt(amount));
      if (op.op === 'mk') add(op.asset, BigInt(op.amount));
      if (op.op === 'xc') { for (const [a, q] of op.request.in) add(a, -BigInt(q)); for (const [a, q] of op.request.out) add(a, BigInt(q)); }
      if (op.op === 'rq') this.pending.set(rules.pendingId(network, op.request), op.request);
      if (op.op === 'mc') { const p = this.pending.get(op.id); assert.ok(p, 'consumption_without_request'); add(p.asset, -BigInt(p.amount)); this.pending.delete(op.id); }
      if (op.op === 'rx') this.pending.delete(op.id);
    }
    this.lastBatch = batch.n;
  }
  async update(store, trac, config, receipt = () => {}) {
    for (;;) {
      // Finish each SQLite statement before yielding to RPC or filesystem I/O.
      const rows = store.database().prepare('SELECT value FROM records WHERE space=? AND id>? ORDER BY id LIMIT 64').all('batches', String(this.lastBatch).padStart(16, '0'));
      for (const r of rows) {
        const { batch, publications } = JSON.parse(r.value);
        assert.equal(await trac('root', [batch.n]), batch.root, 'accepted_root');
        const bytes = await Promise.all(publications.map(p => readFile(join(config.data, 'static', p.audit.path.slice(1)))));
        assert.equal(rules.merkleRoot(bytes), batch.root, 'audit_root');
        for (const file of bytes.map(b => rules.decodeBinary(b))) for (const r of file.receipts) receipt(r);
        this.apply(batch, config.network);
      }
      if (rows.length < 64) break;
    }
  }
  async snapshot(store, trac, config, readRows, receipt = () => {}) {
    const deadline = Date.now() + 60000;
    for (;;) {
      const before = await trac('stamp');
      await this.update(store, trac, config, receipt);
      const rows = await readRows(), after = await trac('stamp');
      // Pagination and local acceptance can lag or overlap a committed mutation.
      // Check conservation only when both sources describe the same revision.
      if (before.revision === after.revision && before.last.n === after.last.n && this.lastBatch === after.last.n) {
        return { ...this.check(rows), revision: after.revision };
      }
      assert.ok(Date.now() < deadline, 'accounting_snapshot_timeout');
      await delay(25);
    }
  }
  check(rows) {
    const db = new Map(rows); this.counted = invariants(db, this.counted, this.supply);
    let locks = 0, requests = 0;
    for (const [k, v] of db) {
      if (/^l\/[0-9a-f]{64}$/.test(k)) { assert.ok(Number.isSafeInteger(v.refund) && v.refund >= 0, 'lock_without_timeout'); locks++; }
      if (/^m\/[0-9a-f]{64}$/.test(k) && v.s === 0) { assert.ok(Number.isSafeInteger(v.e) && v.e >= 0, 'mint_without_timeout'); requests++; }
    }
    return { assets: Object.fromEntries([...this.supply].map(([a, q]) => [a, q.toString()])), counted: this.counted, batches: this.lastBatch, locks, requests, operations: this.operations };
  }
}
export function terminalPayment({ released, refunded }, label) {
  assert.equal(Number(released) + Number(refunded), 1, 'payment_terminal_exclusivity: ' + label);
  return released ? 'released' : 'refunded';
}
