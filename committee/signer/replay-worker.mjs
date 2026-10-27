import { Worker, isMainThread, parentPort, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { rebuildBatch } from './adapter.mjs';
if (!isMainThread) {
  parentPort.on('message', ({ port, signal, network, proposal, context, viewCount }) => {
    const flag = new Int32Array(signal);
    const call = (view, method, args) => {
      Atomics.store(flag, 0, 0); port.postMessage({ view, method, args });
      while (!Atomics.load(flag, 0)) Atomics.wait(flag, 0, 0);
      const { message } = receiveMessageOnPort(port); if (message.error) throw Error(message.error); return message.value;
    };
    const view = i => ({ hashAt: h => call(i, 'hashAt', [h]), history: { length: call(i, 'length', []), get: h => call(i, 'get', [h]), field: (...args) => call(i, 'field', args) } });
    try {
      const views = Array.from({ length: viewCount }, (_, i) => view(i));
      const { state: _state, patterns: _patterns, ...result } = rebuildBatch(network, proposal, { ...context, ...views[0], views });
      parentPort.postMessage({ result });
    } catch (e) { parentPort.postMessage({ error: e.message }); }
    port.close();
  });
  parentPort.postMessage({ ready: true });
}
// Load rules once alongside the signer, before it advertises health. Creating
// a fresh worker per batch silently mixed new on-disk rules with old live state.
export class BatchReplay {
  constructor() {
    this.worker = new Worker(new URL('./replay-worker.mjs', import.meta.url));
    this.ready = new Promise((resolve, reject) => {
      this.worker.once('message', message => message.ready ? resolve() : reject(Error('replay_startup')));
      this.worker.once('error', reject);
      this.worker.once('exit', () => reject(Error('replay_exit')));
    });
    this.worker.on('error', error => { this.failure = error; });
    this.worker.on('exit', () => { this.failure ??= Error('replay_exit'); });
  }
  async run(network, proposal, context) {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.busy) throw Error('replay_busy');
    this.busy = true;
    try { return await this.perform(network, proposal, context); }
    finally { this.busy = false; }
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
      const cleanup = () => { clearTimeout(timer); port1.close(); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
      const message = ({ result, error: failure }) => { cleanup(); failure ? reject(Error(failure)) : resolve(result); };
      const error = e => { cleanup(); reject(e); }, exit = () => error(Error('replay_exit'));
      const timer = setTimeout(() => { this.failure = Error('replay_timeout'); void worker.terminate(); error(this.failure); }, 30000);
      worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
      worker.postMessage({ network, proposal, context: data, signal, port: port2, viewCount: source.length }, [port2]);
    });
  }
  async close() { await this.worker.terminate(); }
}
export async function replayBatchWorker(network, proposal, context) {
  const replay = new BatchReplay();
  try { return await replay.run(network, proposal, context); }
  finally { await replay.close(); }
}
