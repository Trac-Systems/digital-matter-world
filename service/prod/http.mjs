import { setTimeout as delay } from 'node:timers/promises';

export class AdapterError extends Error {
  constructor(code, fields = {}) { super(code); this.name = 'AdapterError'; Object.assign(this, fields); }
}
export const requireValue = (ok, code) => { if (!ok) throw new AdapterError(code); };

// One bounded FIFO per source, including retries. Provider bodies and URLs never
// become errors; they may contain credentials even on ordinary HTTP failures.
export class HttpSource {
  #url; #headers; #tail = Promise.resolve(); #queued = 0; #next = 0;
  constructor({ url, headers = {}, requestsPerSecond = 2, timeoutMs = 15000, maxBytes = 2000000, retries = 2, backoffMs = 250, maxQueue = 64, fetchImpl = fetch }) {
    requireValue(Number.isFinite(requestsPerSecond) && requestsPerSecond > 0 && requestsPerSecond <= 100 && Number.isInteger(timeoutMs) && timeoutMs > 0 && Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= 16000000 && Number.isInteger(retries) && retries >= 0 && retries <= 5 && Number.isInteger(maxQueue) && maxQueue > 0 && maxQueue <= 1024 && backoffMs >= 0 && backoffMs <= 10000, 'http_policy');
    this.#url = url.replace(/\/$/, ''); this.#headers = headers;
    Object.assign(this, { requestsPerSecond, timeoutMs, maxBytes, retries, backoffMs, maxQueue, fetchImpl });
  }
  sameOrigin(other) { return other instanceof HttpSource && new URL(this.#url).origin === new URL(other.#url).origin; }
  request(path = '', { method = 'GET', body, format = 'json', retry = method === 'GET', maxBytes = this.maxBytes } = {}) {
    requireValue(typeof path === 'string' && (path === '' || path.startsWith('/') && !path.startsWith('//')) && !/[\r\n\\]/.test(path), 'http_path');
    requireValue(this.#queued < this.maxQueue && maxBytes > 0 && maxBytes <= this.maxBytes, 'http_capacity');
    this.#queued++;
    const job = this.#tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = this.#next - Date.now(); if (wait > 0) await delay(wait);
        this.#next = Date.now() + 1000 / this.requestsPerSecond;
        try { return await this.#once(path, { method, body, format, maxBytes }); }
        catch (error) {
          if (!retry || attempt >= this.retries || !error.retryable) throw error;
          await delay(Math.min(10000, this.backoffMs * 2 ** attempt));
        }
      }
    });
    this.#tail = job.catch(() => {}).finally(() => { this.#queued--; });
    return job;
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
