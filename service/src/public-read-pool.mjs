import './paging.mjs'; // Initialize the process cursor key before spawning.
import { Worker, MessageChannel } from 'node:worker_threads';
import { publicReadSettings } from './public-read-settings.mjs';
import { publicWorkerRoute } from './public-read-routes.mjs';

const busy = () => Object.assign(Error('service_busy'), { status: 503, retryable: true });
export class PublicReadPool {
  static async open(options) {
    const pool = new PublicReadPool(options);
    try { await pool.ready; return pool; } catch (error) { await pool.close(); throw error; }
  }
  constructor({ publicAPI, mints, ...options }) {
    this.settings = publicReadSettings(options.settings);
    this.routing = { ...options, publicAPI, liveRights: !!mints?.publicMints,
      headers: !!options.headerOptions, bindings: !!options.bindingsOptions };
    this.mints = mints;
    // Explicit public-only construction data. Never clone config, adapters,
    // gateway keys, requester credentials or committee clients into a worker.
    this.data = { directory: options.directory, filesDirectory: options.filesDirectory, settings: this.settings,
      storeSettings: options.storeSettings, apiSettings: options.apiSettings, api: !!publicAPI,
      bindingsOptions: options.bindingsOptions, headerOptions: options.headerOptions,
      checkout: !!options.checkout, operator: !!options.operator, bulkReads: !!options.bulkReads, financialActions: !!options.financialActions };
    this.slots = Array.from({ length: this.settings.threads }, () => ({ queue: [], active: null, worker: null, ready: false }));
    this.ready = new Promise((resolve, reject) => {
      this.startReject = reject;
      this.started = () => { if (this.slots.every(s => s.ready)) { this.startReject = null; clearTimeout(this.startTimer); resolve(); } };
      this.startTimer = setTimeout(() => reject(busy()), this.settings.startupTimeoutMs);
      this.slots.forEach(slot => this.spawn(slot));
    });
  }
  handles(req) {
    // Malformed inputs must reach validation in the original router order,
    // including web.handle's Vary header before publicAPI.handles can reject.
    try { return publicWorkerRoute(req, this.routing); } catch { return false; }
  }
  spawn(slot) {
    if (this.closed) return;
    const worker = slot.worker = new Worker(new URL('./public-read-worker.mjs', import.meta.url), { workerData: this.data });
    worker.on('message', message => {
      if (slot.worker !== worker || message.type !== 'ready') return;
      slot.ready = true; this.started(); this.dispatch(slot);
    });
    worker.on('error', () => this.failed(slot, worker));
    worker.on('exit', () => this.failed(slot, worker));
  }
  failed(slot, worker) {
    if (!worker || slot.worker !== worker) return;
    slot.worker = null; slot.ready = false;
    if (slot.active) this.finish(slot, slot.active, busy());
    // Retain bounded waiting requests; only the crashed worker's active request
    // fails. A broken installation backs off instead of spinning on startup.
    slot.stopping = worker.terminate().catch(() => {});
    slot.stopping.then(() => {
      if (!this.closed) slot.restartTimer = setTimeout(() => this.spawn(slot), this.settings.restartDelayMs);
    });
  }
  serve(req, res) {
    if (res.destroyed || res.writableEnded) return Promise.resolve();
    if (this.closed) return Promise.reject(busy());
    const available = this.slots.filter(s => s.ready && !s.active || s.queue.length < this.settings.queuePerWorker);
    const slot = available.sort((a, b) => (a.queue.length + (a.active || !a.ready ? 1 : 0)) - (b.queue.length + (b.active || !b.ready ? 1 : 0)))[0];
    if (!slot) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const job = { req, res, resolve, reject };
      job.cancel = () => {
        if (job.ending || job.finished) return;
        if (slot.active === job) {
          this.finish(slot, job);
          // Cancellation also bounds a stuck synchronous read. Replace its
          // worker; queued requests are still independent and can continue.
          this.failed(slot, slot.worker);
        } else {
          const at = slot.queue.indexOf(job); if (at >= 0) slot.queue.splice(at, 1);
          this.finish(slot, job);
        }
      };
      res.once('close', job.cancel);
      slot.queue.push(job); this.dispatch(slot);
    });
  }
  dispatch(slot) {
    if (this.closed || !slot.ready || slot.active) return;
    let job;
    while ((job = slot.queue.shift())) {
      if (!job.res.destroyed && !job.res.writableEnded) break;
      this.finish(slot, job);
    }
    if (!job) return;
    slot.active = job;
    const { port1, port2 } = new MessageChannel(); job.port = port1;
    const applyHeaders = () => {
      if (job.res.headersSent || !job.headers) return;
      if (job.headers.explicit) { job.res.writeHead(job.headers.status, job.headers.headers); return; }
      job.res.statusCode = job.headers.status;
      for (const [key, value] of Object.entries(job.headers.headers)) job.res.setHeader(key, value);
    };
    port1.on('message', message => {
      if (job.finished) return;
      if (!job.ending && (job.res.destroyed || job.res.writableEnded)) { job.cancel(); return; }
      if (message.type === 'headers') job.headers = message;
      else if (message.type === 'chunk') {
        applyHeaders();
        const ack = () => { if (!job.finished) port1.postMessage('ack'); };
        if (job.res.write(message.bytes)) ack(); else job.res.once('drain', ack);
      } else if (message.type === 'end') {
        applyHeaders(); job.ending = true; job.res.end();
      } else if (message.type === 'done') {
        this.finish(slot, job); this.dispatch(slot);
      } else if (message.type === 'failed' || message.type === 'destroy') {
        this.finish(slot, job, busy()); this.dispatch(slot);
      }
    });
    const headers = Object.fromEntries(['accept', 'if-none-match', 'range', 'if-range'].filter(k => job.req.headers[k] !== undefined).map(k => [k, job.req.headers[k]]));
    // The indexed rights view only needs this public setting. Capture its live
    // value when dispatching, so a settings refresh invalidates the usual cache.
    const document = this.mints?.document ? { values: { bitmapMintOpenHeight: this.mints.document.values.bitmapMintOpenHeight } } : undefined;
    slot.worker.postMessage({ request: { method: job.req.method, url: job.req.url, headers }, context: { document }, port: port2 }, [port2]);
  }
  finish(slot, job, error) {
    if (job.finished) return;
    job.finished = true; job.res.off('close', job.cancel); job.port?.close();
    if (slot.active === job) slot.active = null;
    if (error) { if (job.res.headersSent) job.res.destroy(); job.reject(error); } else job.resolve();
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true; clearTimeout(this.startTimer);
    this.startReject?.(busy()); this.startReject = null;
    this.closing = Promise.all(this.slots.map(async slot => {
      clearTimeout(slot.restartTimer);
      for (const job of slot.queue.splice(0)) this.finish(slot, job, busy());
      if (slot.active) this.finish(slot, slot.active, busy());
      const worker = slot.worker; slot.worker = null;
      await worker?.terminate(); await slot.stopping;
    }));
    await this.closing;
  }
}
