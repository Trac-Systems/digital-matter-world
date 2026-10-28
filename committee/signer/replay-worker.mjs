import { Worker, isMainThread, parentPort, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { rebuildBatch } from './adapter.mjs';
import { ReplayHistories } from './replay-history.mjs';

export const DEFAULT_REPLAY_TIMEOUT_MS = 120000;
if (!isMainThread) {
  const histories = new ReplayHistories();
  parentPort.on('message', ({ port, signal, network, proposal, context, sources }) => {
    const flag = new Int32Array(signal);
    const call = (view, method, args) => {
      Atomics.store(flag, 0, 0); port.postMessage({ view, method, args });
      while (!Atomics.load(flag, 0)) Atomics.wait(flag, 0, 0);
      const { message } = receiveMessageOnPort(port); if (message.error) throw Error(message.error); return message.value;
    };
    // Custom/in-memory adapters retain their exact semantics. Production views
    // read their verified local store directly, with no per-header thread RPC.
    const view = i => ({ hashAt: h => call(i, 'hashAt', [h]), history: { length: call(i, 'length', []), get: h => call(i, 'get', [h]), field: (...args) => call(i, 'field', args) } });
    try {
      const local = histories.views(sources), views = sources.map((_, i) => local[i] ?? view(i));
      const { state: _state, patterns: _patterns, ...result } = rebuildBatch(network, proposal, { ...context, ...views[0], views });
      parentPort.postMessage({ result });
    } catch (e) { parentPort.postMessage({ error: e.message }); }
    finally { port.close(); }
  });
  parentPort.postMessage({ ready: true });
}
// A healthy worker retains its rules runtime. Releases must stay immutable:
// replacement workers load the same release after a timeout or crash.
export class BatchReplay {
  constructor({ timeoutMs = DEFAULT_REPLAY_TIMEOUT_MS } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw Error('replay_timeout_setting');
    this.timeoutMs = timeoutMs;
    this.spawn();
  }
  spawn() {
    const worker = this.worker = new Worker(new URL('./replay-worker.mjs', import.meta.url));
    this.failure = null;
    worker.on('error', error => { if (this.worker === worker) this.failure = error; });
    worker.on('exit', () => { if (this.worker === worker) this.failure ??= Error('replay_exit'); });
    this.ready = new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
      const error = e => { cleanup(); if (this.worker === worker) this.failure = e; reject(e); };
      const message = value => { if (!value.ready) return error(Error('replay_startup')); cleanup(); resolve(); };
      const exit = () => error(Error('replay_exit'));
      const timer = setTimeout(() => { error(Error('replay_timeout')); void worker.terminate(); }, this.timeoutMs);
      worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
    });
    // A startup failure while idle is reported by run()/the signer's health
    // startup await, without creating an unhandled rejection in the meantime.
    this.ready.catch(() => {});
  }
  async discard() {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
  async run(network, proposal, context) {
    if (this.closed) throw Error('replay_closed');
    if (this.busy) throw Error('replay_busy');
    this.busy = true;
    try {
      if (this.failure || !this.worker) { await this.discard(); if (this.closed) throw Error('replay_closed'); this.spawn(); }
      await this.ready;
      if (this.closed) throw Error('replay_closed');
      if (this.failure) throw this.failure;
      return await this.perform(network, proposal, context);
    } finally { this.busy = false; }
  }
  perform(network, proposal, context) {
    const { history, hashAt, views, ...data } = context;
    const source = views ?? context.inputs.map(() => ({ history, hashAt }));
    const signal = new SharedArrayBuffer(4), flag = new Int32Array(signal), { port1, port2 } = new MessageChannel();
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      port1.on('message', ({ view, method, args }) => {
        try { const s = source[view]; port1.postMessage({ value: method === 'length' ? s.history.length : method === 'hashAt' ? s.hashAt(...args) : s.history[method](...args) }); }
        catch (e) { port1.postMessage({ error: e.message }); }
        Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
      });
      const cleanup = () => { clearTimeout(timer); port1.close(); port2.close(); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
      const message = ({ result, error: failure }) => { cleanup(); failure ? reject(Error(failure)) : resolve(result); };
      const error = e => { cleanup(); reject(e); }, exit = () => error(Error('replay_exit'));
      const timer = setTimeout(() => { this.failure = Error('replay_timeout'); void worker.terminate(); error(this.failure); }, this.timeoutMs);
      worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
      try { worker.postMessage({ network, proposal, context: data, signal, port: port2, sources: source.map(s => s.history.replaySource ?? null) }, [port2]); }
      catch (e) { error(e); }
    });
  }
  async close() { this.closed = true; await this.discard(); }
}
export async function replayBatchWorker(network, proposal, context, options) {
  const replay = new BatchReplay(options);
  try { return await replay.run(network, proposal, context); }
  finally { await replay.close(); }
}
