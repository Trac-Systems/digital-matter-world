import { localURL } from './config.mjs';
import { check } from './util.mjs';

const guarded = Symbol.for('dmw.localFetch');
function deadline(signal, timeout) {
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeout); timer.unref();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}
export function installLocalFetch() {
  if (globalThis.fetch[guarded]) return;
  const upstream = globalThis.fetch;
  const fetch = async (input, options = {}) => {
    localURL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const limit = deadline(options.signal, 45000);
    try {
      const response = await upstream(input, { ...options, signal: limit.signal, redirect: 'error' });
      if (!response.body) { limit.dispose(); return response; }
      const reader = response.body.getReader(); let bytes = 0;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { limit.dispose(); reader.releaseLock(); controller.close(); return; }
            bytes += value.byteLength; check(bytes <= 4_000_000, 'response_limit', 503); controller.enqueue(value);
          } catch (e) { limit.dispose(); controller.error(e); await reader.cancel(e).catch(() => {}); reader.releaseLock(); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); limit.dispose(); } }
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (e) { limit.dispose(); throw e; }
  };
  fetch[guarded] = upstream; globalThis.fetch = fetch;
}

export async function jsonRequest(url, { maxBytes = 4_000_000, timeout = 30000, limitCode = 'response_limit', signal, publicQuery = false, ...options } = {}) {
  if (publicQuery) {
    const parsed = new URL(url); localURL(parsed.origin);
    check(!parsed.username && !parsed.password && !parsed.hash, 'endpoint_must_be_loopback');
  } else localURL(url);
  const limit = deadline(signal, timeout);
  let reader;
  try {
    // This reader already enforces both limits. Avoid allocating another
    // timeout, TransformStream and Response in the global fetch guard.
    const request = globalThis.fetch[guarded] ?? globalThis.fetch;
    const response = await request(url, { ...options, redirect: 'error', signal: limit.signal });
    reader = response.body.getReader(); const chunks = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; check(bytes <= maxBytes, limitCode, 503); chunks.push(value);
    }
    return { ok: response.ok, status: response.status, value: JSON.parse(Buffer.concat(chunks).toString()) };
  } finally {
    limit.dispose();
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
export async function rpc(url, method, params = [], cookie) {
  const { ok, value } = await jsonRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { authorization: `Basic ${Buffer.from(cookie).toString('base64')}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  check(value.id === 1, 'rpc_identity', 503);
  if (value.error) throw Object.assign(Error('bitcoin_rpc_failed'), { rpcCode: value.error.code });
  check(ok, 'bitcoin_http_failed', 503); return value.result;
}
// Transitional call names used by the playground relay; the only reader is ord.
export async function bitcoin(manifest, method, params = [], wallet) {
  const client = manifest.bitcoin;
  check(client?.kind === 'ord' && !wallet, 'bitcoin_ord_required');
  switch (method) {
    case 'getblockchaininfo': { const tip = await client.tip(); return { chain: client.network === 'regtest' ? 'regtest' : 'main', blocks: tip.height, bestblockhash: tip.hash }; }
    case 'getblockcount': return (await client.tip()).height;
    case 'getbestblockhash': return (await client.tip()).hash;
    case 'getblockhash': return client.blockHash(params[0]);
    case 'getblockheader': return params[1] === false ? client.header(params[0]) : client.headerInfo(params[0]);
    case 'getrawtransaction': return params[1] ? client.transaction(params[0]) : (await client.transaction(params[0])).hex;
    case 'getblock': return params[1] === 0 ? (await client.rawBlock(params[0])).toString('hex') : client.block(params[0]);
    case 'decoderawtransaction': return client.decode(params[0]);
    default: throw Error('bitcoin_read_unsupported');
  }
}
export async function ordJson(manifest, path) {
  const { ok, value } = await jsonRequest(manifest.ord.url + path, { headers: { accept: 'application/json' }, timeout: 15000, publicQuery: true });
  check(ok, 'indexer_http_failed', 503); return value;
}
