import { downloadHeaders, historyProof } from './headers.mjs';
import { explainError } from './errors.mjs';

// A session owns one background transfer. A complete verified snapshot is
// swapped in atomically; tools never see an incomplete file or stale snapshot.
export class HistorySync {
  constructor(options) {
    this.options = options; this.history = undefined; this.phase = 'downloading'; this.percent = 0; this.controller = new AbortController();
  }
  start() { void this.refresh(); return this; }
  refresh() {
    if (this.pending || this.controller.signal.aborted) return this.pending;
    clearTimeout(this.timer);
    this.pending = downloadHeaders({ ...this.options, currentHistory: this.history, signal: this.controller.signal,
      onProgress: p => { this.phase = p.phase ?? 'downloading'; this.percent = Math.min(99, Math.floor(100 * p.count / p.target)); },
      onHistory: history => { this.history = history; },
    }).then(() => { this.phase = 'ready'; this.percent = 100; this.error = undefined; }, error => {
      this.phase = 'retrying'; this.error = explainError(error);
    }).finally(() => {
      this.pending = null;
      if (!this.controller.signal.aborted) {
        this.nextRefresh = Date.now() + (this.options.pollMs ?? 30000);
        this.timer = setTimeout(() => void this.refresh(), this.options.pollMs ?? 30000); this.timer.unref();
      }
    });
    return this.pending;
  }
  available(tip) {
    if (this.history) {
      const proof = historyProof(this.history);
      if (!tip || proof.count === tip.height + 1 && proof.tip === tip.hash) return this.history;
    }
    if (this.phase === 'ready') { this.phase = 'downloading'; this.percent = 0; }
    if (!this.pending && (!this.nextRefresh || Date.now() >= this.nextRefresh)) void this.refresh();
    return undefined;
  }
  status() {
    const state = this.phase === 'ready' ? 'ready' : 'history_downloading';
    return { state, message: state === 'ready' ? 'history ready' : `history downloading (${this.percent}%)`, phase: this.phase, percent: this.percent,
      ...(this.error ? { retrying: true, reason: this.error } : {}) };
  }
  async close() { clearTimeout(this.timer); this.controller.abort(); await this.pending; }
}
