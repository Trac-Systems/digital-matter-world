import { createServer } from 'node:http';
import { bindLifecycle } from './lifecycle.mjs';
import { check } from './util.mjs';

// Keep one dispatch function for the lifetime of the listener. Host admission
// wraps it before initialization and remains in place when the app is installed.
export async function startupListener({ host = '127.0.0.1', port = 0 } = {}) {
  check(host === '127.0.0.1', 'local_listener_required');
  let handler, closing, state = 'starting';
  const pending = new Set();
  const invoke = bindLifecycle((callback, req, res) => callback(req, res));
  const track = callback => (req, res) => {
    const work = Promise.resolve().then(() => invoke(callback, req, res));
    pending.add(work);
    work.catch(() => res.destroy()).finally(() => pending.delete(work));
    return work;
  };
  const server = createServer(track((req, res) => {
    if (!handler || state === 'stopping') {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '1' });
      res.end(JSON.stringify(req.url === '/health' ? { ok: false, ready: false, phase: state } : { error: 'service_not_ready' }));
      return;
    }
    return handler(req, res);
  }));
  server.headersTimeout = 5000; server.requestTimeout = 30000; server.timeout = 30000; server.maxConnections = 64;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, track, url: `http://127.0.0.1:${server.address().port}`,
    install(next) { check(state === 'starting', 'listener_stopping'); handler = next; state = 'running'; },
    close() { return closing ??= (async () => {
      state = 'stopping';
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await stopped; await Promise.allSettled([...pending]);
    })(); }
  };
}
