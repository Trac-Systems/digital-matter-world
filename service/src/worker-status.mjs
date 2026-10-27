import { serial } from './util.mjs';

// Cancellation and pipeline work run independently. A successful sibling must
// not clear another worker's failure, and status writes must retain that order.
export class WorkerStatus {
  constructor(store) { this.store = store; this.gate = serial(); }
  async run(worker, task) {
    try { const result = await task(); await this.succeeded(worker); return result; }
    catch (error) { await this.failed(error, worker); }
  }
  failed(error, worker) { return this.gate(() => this.store.put('meta', 'workerStatus', {
    worker, code: /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'dependency_unavailable', at: Date.now()
  })).catch(() => {}); }
  succeeded(worker) { return this.gate(async () => {
    if (this.store.get('meta', 'workerStatus')?.worker === worker) await this.store.put('meta', 'workerStatus', undefined);
  }); }
}
