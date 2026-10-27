import { privateRead, check, integer, hex32, localOrigin } from './check.mjs';
import { serviceError, safeCode } from './errors.mjs';

// Only read methods are exposed, and every request checks the local chain mode.
export function regtestSource({ origin, cookiePath, fetchImpl = fetch, timeoutMs = 10000 }) {
  const base = localOrigin(origin);
  async function rpc(method, params = []) {
    const failure = (code, reason, status) => serviceError({ service: 'Bitcoin regtest reader', origin: base, route: `/ (RPC ${method})`, method: 'POST', status, code, reason });
    const cookie = (await privateRead(cookiePath, 1024)).toString('utf8').trim();
    check(cookie.length > 0 && cookie.includes(':'), 'Invalid local Bitcoin cookie');
    let response;
    try {
      response = await fetchImpl(base, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(cookie).toString('base64') }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    } catch (error) { throw failure(safeCode(error.cause?.code ?? error.code ?? error.name), 'local Bitcoin reader unavailable'); }
    let size = 0; const chunks = [];
    try {
      for await (const b of response.body ?? []) { size += b.length; if (size > 60000) throw Object.assign(Error(), { code: 'response_limit' }); chunks.push(b); }
    } catch (error) { throw failure(safeCode(error.code), error.code === 'response_limit' ? 'response too large' : 'response body interrupted', response.status); }
    let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw failure('invalid_json', 'response is not valid JSON', response.status); }
    if (!response.ok || body.error) throw failure(safeCode(body.error?.code, 'rpc_error'), 'local Bitcoin read failed', response.status);
    return body.result;
  }
  async function read(method, params) { check((await rpc('getblockchaininfo')).chain === 'regtest', 'Only regtest Bitcoin is supported by this adapter'); return rpc(method, params); }
  return {
    async height() { const n = await read('getblockcount'); check(integer(n), 'Invalid Bitcoin height'); return n; },
    async hash(height) { check(integer(height), 'Invalid Bitcoin height'); const hash = await read('getblockhash', [height]); check(hex32(hash), 'Invalid Bitcoin hash'); return hash; },
    async header(hash) { check(hex32(hash), 'Invalid Bitcoin hash'); const raw = await read('getblockheader', [hash, false]); check(typeof raw === 'string' && /^[0-9a-f]{160}$/.test(raw), 'Invalid Bitcoin header'); return raw; }
  };
}
