import { setTimeout as delay } from 'node:timers/promises';
import { lifecycleSignal } from '../src/lifecycle.mjs';

export class AdapterError extends Error {
  constructor(code, fields = {}) { super(code); this.name = 'AdapterError'; Object.assign(this, fields); }
}
export const requireValue = (ok, code) => { if (!ok) throw new AdapterError(code); };

// A bounded connection pool shares one dispatch clock, including retries.
// Provider bodies and URLs never become errors; they may contain credentials.
export class HttpSource {
  #url; #headers; #pace = Promise.resolve(); #queued = 0; #next = 0; #active = 0; #waiting = [];
  constructor({ url, headers = {}, requestsPerSecond = 2, timeoutMs = 15000, maxBytes = 2000000, retries = 2, backoffMs = 250, maxBackoffMs = 10000, maxQueue = 64, maxConcurrent = 8, fetchImpl = fetch, signal = lifecycleSignal() }) {
    requireValue(Number.isFinite(requestsPerSecond) && requestsPerSecond > 0 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 0x7fffffff && Number.isSafeInteger(maxBytes) && maxBytes > 0 && Number.isSafeInteger(retries) && retries >= 0 && Number.isSafeInteger(maxQueue) && maxQueue > 0 && Number.isSafeInteger(backoffMs) && backoffMs >= 0 && Number.isSafeInteger(maxBackoffMs) && maxBackoffMs >= 0 && maxBackoffMs <= 0x7fffffff, 'http_policy');
    this.#url = url.replace(/\/$/, ''); this.#headers = headers;
    requireValue(Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0 && maxConcurrent <= 64, 'http_policy');
    Object.assign(this, { requestsPerSecond, timeoutMs, maxBytes, retries, backoffMs, maxBackoffMs, maxQueue, maxConcurrent, fetchImpl, signal });
  }
  sameOrigin(other) { return other instanceof HttpSource && new URL(this.#url).origin === new URL(other.#url).origin; }
  #acquire(signal) {
    signal.throwIfAborted();
    if (this.#active < this.maxConcurrent) { this.#active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const entry = { resolve: () => { signal.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { this.#waiting.splice(this.#waiting.indexOf(entry), 1); reject(signal.reason); };
      this.#waiting.push(entry); signal.addEventListener('abort', abort, { once: true });
    });
  }
  #release() { const next = this.#waiting.shift(); if (next) next.resolve(); else this.#active--; }
  #dispatch(signal) {
    const ready = this.#pace.then(async () => {
      signal.throwIfAborted();
      const wait = this.#next - Date.now(); if (wait > 0) await delay(wait, undefined, { signal });
      signal.throwIfAborted(); this.#next = Date.now() + 1000 / this.requestsPerSecond;
    });
    this.#pace = ready.catch(() => {}); return ready;
  }
  request(path = '', { method = 'GET', body, format = 'json', retry = method === 'GET', maxBytes = this.maxBytes, timeoutMs = this.timeoutMs } = {}) {
    requireValue(typeof path === 'string' && (path === '' || path.startsWith('/') && !path.startsWith('//')) && !/[\r\n\\]/.test(path), 'http_path');
    requireValue(maxBytes > 0 && maxBytes <= this.maxBytes && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 0x7fffffff, 'http_capacity');
    if (this.#queued >= this.maxQueue) throw new AdapterError('http_capacity', { status: 503, retryable: true });
    this.#queued++;
    const controller = new AbortController(), signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    // The deadline includes pool wait, pacing, retries, headers and body.
    const timer = setTimeout(() => controller.abort(new AdapterError('http_timeout', { retryable: true })), timeoutMs);
    const job = (async () => {
      for (let attempt = 0; ; attempt++) {
        await this.#acquire(signal);
        try {
          await this.#dispatch(signal);
          return await this.#once(path, { method, body, format, maxBytes, signal });
        }
        catch (error) {
          signal.throwIfAborted();
          if (!retry || attempt >= this.retries || !error.retryable) throw error;
        } finally { this.#release(); }
        await delay(Math.min(this.maxBackoffMs, this.backoffMs * 2 ** attempt), undefined, { signal });
      }
    })().catch(error => { if (signal.aborted) throw signal.reason; throw error; }).finally(() => { clearTimeout(timer); controller.abort(); this.#queued--; });
    return job;
  }
  async #once(path, { method, body, format, maxBytes, signal }) {
    let reader;
    try {
      const target = new URL(this.#url), query = path.indexOf('?'), suffix = query < 0 ? path : path.slice(0, query);
      target.pathname = target.pathname.replace(/\/$/, '') + suffix;
      if (query >= 0) for (const [key, value] of new URLSearchParams(path.slice(query + 1))) target.searchParams.set(key, value);
      const response = await this.fetchImpl(target.href, { method, redirect: 'error', signal, headers: { accept: 'application/json', ...this.#headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
      this.signal?.throwIfAborted();
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(signal.aborted ? 'http_timeout' : 'http_unavailable', { retryable: !(error instanceof SyntaxError || error instanceof TypeError && !signal.aborted && reader) });
    } finally { await reader?.cancel().catch(() => {}); }
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
