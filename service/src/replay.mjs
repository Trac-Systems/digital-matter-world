import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
import { closureTimeouts } from '../../rules/src/closure-timeouts.js';
// One computational worker isolates regex/history scans and batch signature
// verification from HTTP.
export class Replay {
  constructor({ headerPageSize = 1024, headerCachePages = 8, cacheKiB = 4096, timeoutMs = 120000 } = {}) {
    check(Number.isSafeInteger(headerPageSize) && headerPageSize > 0, 'replay_header_page_size');
    Object.assign(this, { headerPageSize, headerCachePages, cacheKiB, timeoutMs });
    this.worker = new Worker(new URL('./replay-worker.mjs', import.meta.url)); this.id = '0';
  }
  async run(input, history, claims) {
    check(!this.busy, 'replay_busy', 503); this.busy = true;
    try {
      const decimal = !!input.settings?.document, clock = rules.ordinalCodec(decimal);
      const heights = new Set([input.tip, input.height]);
      for (const r of input.state.rounds ?? []) { if (!clock.valid(r.window)) continue; heights.add(r.window); const deciding = clock.add(r.window, r.policy?.claimWindowBlocks ?? 2); if (clock.compare(deciding, input.tip) <= 0) heights.add(deciding); }
      for (const { move, receipt } of input.entries) {
        heights.add(move.b); heights.add(receipt.tip);
        if (move.t === 'header') heights.add(move.p.height);
        if (move.p.header) heights.add(move.p.header.height);
      }
      for (const { move } of input.entries) {
        if (['claim', 'claim-v2'].includes(move.t)) for (const plot of move.p.plots) heights.add(plot.block);
        if (move.v === 2) {
          if (move.t === 'header-v2') heights.add(move.p.height);
          if (move.p.anchor) heights.add(move.p.anchor.height);
          if (move.p.snapshot) heights.add(move.p.snapshot.height);
          for (const match of move.p.matches ?? []) heights.add(match.height);
        }
      }
      const database = !decimal && history.store ? join(history.store.directory, 'index.sqlite') : null;
      // Legacy replay can request bounded pages from any raw-header adapter.
      // No height cliff and no whole-history structured clone. Only the worker
      // thread waits for the main thread to fill its one shared page buffer.
      const headerPageSize = this.headerPageSize;
      const shared = database ? null : new SharedArrayBuffer(4 + headerPageSize * 80);
      for (const m of input.mintOperations ?? []) if (m.evidence.cancellation) heights.add(m.evidence.cancellation.height);
      const headers = [...new Set([...heights].map(h => clock.value(h)))]
        .filter(h => clock.compare(h, 0) >= 0 && clock.compare(h, history.length) < 0).map(h => [h, history.raw(h)]), id = this.id = rules.nextUint(this.id);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { const old = this.worker; error(Error('replay_timeout')); void old.terminate(); this.worker = new Worker(new URL('./replay-worker.mjs', import.meta.url)); },
          closureTimeouts(input.settings?.document, this.resources)?.replayMs ?? this.timeoutMs);
        const done = () => { clearTimeout(timer); this.worker.off('message', message); this.worker.off('error', error); this.worker.off('exit', exit); };
        const message = msg => {
          if (msg.id !== id) return;
          if (msg.requestHeaders) {
            const control = new Int32Array(shared, 0, 1), bytes = new Uint8Array(shared, 4);
            try {
              const { start, count } = msg.requestHeaders;
              check(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(count) && count > 0 && count <= headerPageSize && start + count <= history.length, 'replay_header_request');
              for (let i = 0; i < count; i++) {
                const raw = history.raw(start + i), row = typeof raw === 'string' ? Buffer.from(raw, 'hex') : raw;
                check(row?.length === 80, 'replay_header_missing'); bytes.set(row, i * 80);
              }
              Atomics.store(control, 0, 1);
            } catch { Atomics.store(control, 0, -1); }
            Atomics.notify(control, 0); return;
          }
          done(); if (msg.error) reject(Error(msg.error)); else resolve(msg.output);
        };
        const error = e => { done(); reject(e); }, exit = () => error(Error('replay_worker_exit'));
        this.worker.on('message', message); this.worker.once('error', error); this.worker.once('exit', exit);
        this.worker.postMessage({ id, input, headers, length: history.length, database, branch: history.branch, shared, headerPageSize, headerCachePages: this.headerCachePages, cacheKiB: this.cacheKiB,
          ...(claims ? { claimDatabase: join(claims.store.directory, 'index.sqlite'), claimCacheKiB: claims.store.cacheKiB,
            claimNodes: [...claims.staged], namedNodes: [...(claims.namedStaged ?? [])] } : {}) });
      });
    } finally { this.busy = false; }
  }
  async close() { await this.worker.terminate(); }
}
