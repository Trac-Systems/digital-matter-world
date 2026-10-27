import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { endpoint, readPrivateJSON } from '../service/prod/config.mjs';
import { HttpSource, jsonRpc } from '../service/prod/http.mjs';
import { need } from './target.mjs';
import { rules } from '../service/src/rules.mjs';

// Public header reads from the SAME Core used by the gateway. No generic RPC,
// provider URL, authentication material, wallet method or proxy path escapes.
export function headerHandler(core) {
  return async (req, res) => {
    try {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const path = req.url;
      let value, match, json = false;
      if (path === '/api/blocks/tip/height') {
        value = await core('getblockcount'); need(Number.isSafeInteger(value) && value >= 0, 'height');
      } else if ((match = /^\/api\/block-height\/(0|[1-9][0-9]{0,6})$/.exec(path))) {
        value = await core('getblockhash', [Number(match[1])]); need(/^[0-9a-f]{64}$/.test(value), 'hash');
      } else if ((match = /^\/api\/block\/([0-9a-f]{64})\/header$/.exec(path))) {
        value = await core('getblockheader', [match[1], false]);
        need(/^[0-9a-f]{160}$/.test(value) && rules.parseHeader(value).hash === match[1], 'header');
      } else if ((match = /^\/api\/blocks\/(0|[1-9][0-9]{0,6})$/.exec(path))) {
        value = []; json = true;
        for (let h = Number(match[1]); h >= 0 && value.length < 10; h--) {
          const id = await core('getblockhash', [h]); need(/^[0-9a-f]{64}$/.test(id), 'hash');
          const header = await core('getblockheader', [id, true]);
          need(Number.isSafeInteger(header.time), 'time'); value.push({ id, height: h, timestamp: header.time });
        }
      } else { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': json ? 'application/json' : 'text/plain', 'cache-control': 'public, max-age=5', 'access-control-allow-origin': '*' });
      res.end(json ? JSON.stringify(value) : String(value));
    } catch { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('Header source unavailable'); }
  };
}
async function main(filename) {
  const c = await readPrivateJSON(filename);
  need(c.listen?.host === '127.0.0.1' && Number.isSafeInteger(c.listen.port) && c.listen.port >= 1024 && c.listen.port <= 65535, 'header_listener');
  const source = new HttpSource({ ...await endpoint(c.bitcoin), requestsPerSecond: 10, maxQueue: 32, retries: 0 });
  const server = createServer(headerHandler(jsonRpc(source)));
  server.maxConnections = 32; server.headersTimeout = 5000; server.requestTimeout = 10000;
  await new Promise((done, fail) => { server.once('error', fail); server.listen(c.listen.port, c.listen.host, done); });
  const close = () => { server.closeAllConnections(); server.close(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]).catch(() => {
  console.error('STOP: header source needs an owned configuration and a reachable Bitcoin source.'); process.exitCode = 1;
});
