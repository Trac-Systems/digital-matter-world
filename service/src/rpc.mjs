import { readFile } from 'node:fs/promises';
import { localURL } from './config.mjs';
import { check } from './util.mjs';
import { jsonRequest } from './http-client.mjs';
export function rpcClient(endpoint, { cookieFile, token, timeout = 10000, maxBytes = 2_000_000 } = {}) {
  const url = localURL(endpoint); let sequence = 0;
  return async (method, params = []) => {
    const authorization = cookieFile ? `Basic ${Buffer.from((await readFile(cookieFile, 'utf8')).trim()).toString('base64')}` : token ? `Bearer ${token}` : null;
    const { ok, value: result } = await jsonRequest(url, { method: 'POST', timeout, maxBytes, limitCode: 'rpc_response_limit',
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) });
    check(ok && !result.error, 'rpc_failed', 503); return result.result;
  };
}
