import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { rules } from './rules.mjs';
import { check } from './util.mjs';
// One computational worker isolates regex/history scans and batch signature
// verification from HTTP.
export class Replay {
  constructor() { this.worker = new Worker(new URL('./replay-worker.mjs', import.meta.url)); this.id = 0; }
  async run(input, history) {
    check(!this.busy, 'replay_busy', 503); this.busy = true;
    try {
      const heights = new Set([input.tip, input.height]);
      for (const r of input.state.rounds ?? []) { heights.add(r.window); if (r.window + 2 <= input.tip) heights.add(r.window + 2); }
      for (const { move, receipt } of input.entries) {
        heights.add(move.b); heights.add(receipt.tip);
        if (move.t === 'header') heights.add(move.p.height);
        if (move.p.header) heights.add(move.p.header.height);
      }
      for (const { move } of input.entries) if (move.t === 'claim') for (const plot of move.p.plots) heights.add(plot.block);
      const database = history.store ? join(history.store.directory, 'index.sqlite') : null;
      // Disk history is scanned through a bounded page cache in a read snapshot.
      // Small in-memory test fixtures supply their rows directly.
      if (!database && (input.state.discoveryQueue?.length || input.entries.some(e => e.move.t === 'discovery-reveal'))) {
        check(input.height < 20000, 'discovery_history_adapter_required', 503);
        for (let h = 0; h <= input.height; h++) heights.add(h);
      }
      for (const m of input.mintOperations ?? []) if (m.evidence.cancellation) heights.add(m.evidence.cancellation.height);
      const headers = [...heights].filter(h => h >= 0 && h < history.length).map(h => [h, history.raw(h)]), id = ++this.id;
      return await new Promise((resolve, reject) => {
        const done = () => { this.worker.off('message', message); this.worker.off('error', error); this.worker.off('exit', exit); };
        const message = msg => { if (msg.id !== id) return; done(); if (msg.error) reject(Error(msg.error)); else resolve(msg.output); };
        const error = e => { done(); reject(e); }, exit = () => error(Error('replay_worker_exit'));
        this.worker.on('message', message); this.worker.once('error', error); this.worker.once('exit', exit);
        this.worker.postMessage({ id, input, headers, length: history.length, database, branch: history.branch });
      });
    } finally { this.busy = false; }
  }
  async close() { await this.worker.terminate(); }
}
