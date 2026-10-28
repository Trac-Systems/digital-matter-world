import { AsyncLocalStorage } from 'node:async_hooks';

const lanes = new AsyncLocalStorage();
export const withPublicReads = read => lanes.run(3, read);
export const withBackgroundReads = read => lanes.run(2, read);
export const withPaidReads = read => lanes.run(1, read);
export const withClockReads = read => lanes.run(0, read);

export class AdapterError extends Error {
  constructor(code, fields = {}) { super(code); this.name = 'AdapterError'; Object.assign(this, fields); }
}
export const requireValue = (ok, code) => { if (!ok) throw new AdapterError(code); };

// Four bounded lanes share one pacing budget. Clock and paid reads reserve
// independent queue capacity ahead of background and public reads. Game reads take priority at every
// dispatch, including retries. Provider bodies and URLs never
// become errors; they may contain credentials even on ordinary HTTP failures.
export class HttpSource {
  #url; #headers; #queues = [[], [], [], []]; #queued = [0, 0, 0, 0]; #pending = new Map(); #nextBackground = 0; #next = 0; #nextPublic = 0; #running = false; #timer;
  constructor({ url, headers = {}, requestsPerSecond = 2, publicRequestsPerSecond = 1, publicMaxQueue = 16, clockMaxQueue = 8, backgroundMaxQueue = 16, backgroundRequestsPerSecond = 1, timeoutMs = 15000, maxBytes = 2000000, retries = 2, backoffMs = 250, maxQueue = 64, fetchImpl = fetch }) {
    requireValue(Number.isFinite(requestsPerSecond) && requestsPerSecond > 0 && requestsPerSecond <= 100 && Number.isInteger(timeoutMs) && timeoutMs > 0 && Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= 16000000 && Number.isInteger(retries) && retries >= 0 && retries <= 5 && Number.isInteger(maxQueue) && maxQueue > 0 && maxQueue <= 1024 && backoffMs >= 0 && backoffMs <= 10000, 'http_policy');
    requireValue(Number.isFinite(publicRequestsPerSecond) && publicRequestsPerSecond > 0 && publicRequestsPerSecond <= 100 && Number.isInteger(publicMaxQueue) && publicMaxQueue > 0 && publicMaxQueue <= 1024, 'http_public_policy');
    requireValue(Number.isInteger(clockMaxQueue) && clockMaxQueue > 0 && clockMaxQueue <= 1024 && Number.isInteger(backgroundMaxQueue) && backgroundMaxQueue > 0 && backgroundMaxQueue <= 1024 && Number.isFinite(backgroundRequestsPerSecond) && backgroundRequestsPerSecond > 0 && backgroundRequestsPerSecond <= 100, 'http_background_policy');
    this.#url = url.replace(/\/$/, ''); this.#headers = headers;
    Object.assign(this, { requestsPerSecond, publicRequestsPerSecond, publicMaxQueue, clockMaxQueue, backgroundMaxQueue, backgroundRequestsPerSecond, timeoutMs, maxBytes, retries, backoffMs, maxQueue, fetchImpl });
  }
  sameOrigin(other) { return other instanceof HttpSource && new URL(this.#url).origin === new URL(other.#url).origin; }
  request(path = '', { method = 'GET', body, format = 'json', retry = method === 'GET', maxBytes = this.maxBytes } = {}) {
    requireValue(typeof path === 'string' && (path === '' || path.startsWith('/') && !path.startsWith('//')) && !/[\r\n\\]/.test(path), 'http_path');
    const lane = lanes.getStore() ?? 1, key = method === 'GET' ? JSON.stringify([path, format, maxBytes, retry]) : null;
    const pending = key && this.#pending.get(key);
    if (pending) {
      // Promote a queued public read when a paid/clock caller needs it too.
      const index = this.#queues[pending.lane].indexOf(pending);
      if (lane < pending.lane && index >= 0 && this.#queued[lane] < this.#capacity(lane)) {
        this.#queues[pending.lane].splice(index, 1); this.#queued[pending.lane]--;
        pending.lane = lane; this.#queued[lane]++; this.#queues[lane].push(pending); this.#pump();
      }
      return pending.promise.then(value => Buffer.isBuffer(value) ? Buffer.from(value) : structuredClone(value));
    }
    requireValue(this.#queued[lane] < this.#capacity(lane) && maxBytes > 0 && maxBytes <= this.maxBytes, 'http_capacity');
    this.#queued[lane]++;
    const job = { lane, key, path, options: { method, body, format, maxBytes }, retry, attempt: 0, ready: 0 };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    if (key) this.#pending.set(key, job);
    this.#queues[lane].push(job); this.#pump();
    return job.promise.then(value => Buffer.isBuffer(value) ? Buffer.from(value) : structuredClone(value));
  }
  #capacity(lane) { return [this.clockMaxQueue, this.maxQueue, this.backgroundMaxQueue, this.publicMaxQueue][lane];
  }
  #pump() {
    if (this.#running) return;
    clearTimeout(this.#timer);
    const now = Date.now(), ready = this.#queues.map((queue, lane) => queue.length
      ? Math.max(queue[0].ready, this.#next, lane === 3 ? this.#nextPublic : lane === 2 ? this.#nextBackground : 0) : Infinity);
    const lane = ready.findIndex(time => time <= now);
    if (lane < 0) {
      const next = Math.min(...ready);
      if (Number.isFinite(next)) this.#timer = setTimeout(() => this.#pump(), next - now);
      return;
    }
    const job = this.#queues[lane].shift(); this.#running = true;
    this.#next = now + 1000 / this.requestsPerSecond;
    if (lane === 3) this.#nextPublic = now + 1000 / this.publicRequestsPerSecond;
    if (lane === 2) this.#nextBackground = now + 1000 / this.backgroundRequestsPerSecond;
    this.#once(job.path, job.options).then(value => {
      this.#queued[lane]--; if (job.key) this.#pending.delete(job.key); job.resolve(value);
    }, error => {
      if (job.retry && job.attempt < this.retries && error.retryable) {
        job.ready = Date.now() + Math.min(10000, this.backoffMs * 2 ** job.attempt++);
        this.#queues[lane].unshift(job);
      } else { this.#queued[lane]--; if (job.key) this.#pending.delete(job.key); job.reject(error); }
    }).finally(() => { this.#running = false; this.#pump(); });
  }
  async #once(path, { method, body, format, maxBytes }) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader;
    try {
      const target = new URL(this.#url), query = path.indexOf('?'), suffix = query < 0 ? path : path.slice(0, query);
      target.pathname = target.pathname.replace(/\/$/, '') + suffix;
      if (query >= 0) for (const [key, value] of new URLSearchParams(path.slice(query + 1))) target.searchParams.set(key, value);
      const response = await this.fetchImpl(target.href, { method, redirect: 'error', signal: controller.signal, headers: { accept: 'application/json', ...this.#headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AdapterError('http_status', { status: response.status, retryable: response.status === 429 || response.status >= 500 });
      }
      requireValue(!response.headers.get('content-length') || Number(response.headers.get('content-length')) <= maxBytes, 'http_response_limit');
      reader = response.body?.getReader(); requireValue(reader, 'http_body');
      const parts = []; let length = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; requireValue(length <= maxBytes, 'http_response_limit'); parts.push(Buffer.from(part.value)); }
      const bytes = Buffer.concat(parts);
      if (format === 'bytes') return bytes;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (format === 'rawText') return text;
      return format === 'text' ? text.trim() : JSON.parse(text);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(controller.signal.aborted ? 'http_timeout' : 'http_unavailable', { retryable: !(error instanceof SyntaxError || error instanceof TypeError && !controller.signal.aborted && reader) });
    } finally { clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}); }
  }
}
export function jsonRpc(source, { path = '', retry = method => /^(get|list|decode|estimate|eth_get|eth_call|eth_chainId|eth_estimate|eth_gasPrice)/.test(method) } = {}) {
  let sequence = 0;
  return async (method, params = []) => {
    const id = ++sequence, response = await source.request(path, { method: 'POST', body: { jsonrpc: '2.0', id, method, params }, retry: retry(method) });
    requireValue(response && response.id === id, 'rpc_identity');
    if (response.error) throw new AdapterError('rpc_error', { rpcCode: response.error.code });
    requireValue(Object.hasOwn(response, 'result'), 'rpc_result');
    return response.result;
  };
}
