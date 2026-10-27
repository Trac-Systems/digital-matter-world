#!/usr/bin/env node
// Additional gateway web listener over the running playground. It never starts,
// stops or resets a chain, supervisor, wallet or consensus gateway.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA, json, check, PORTS } from './common.mjs';
import { localReads } from '../service/local/reads.mjs';
import { Store } from '../service/src/store.mjs';
import { serve } from '../service/src/http.mjs';
import { createWeb } from '../service/src/web.mjs';
import { WebCheckout } from '../service/src/web-checkout.mjs';
import { jsonRequest } from '../service/src/http-client.mjs';

export async function startWeb({ port = 58911 } = {}) {
  const manifest = await json(join(DATA, 'manifest.json')); check(manifest.state === 'ready', 'playground_not_ready');
  const config = await json(join(manifest.directory, 'gateway.json')); check(config.mode === 'regtest', 'regtest_required');
  const upstream = `http://127.0.0.1:${PORTS.gateway}`;
  const request = async (path, body) => {
    const r = await jsonRequest(upstream + path, { publicQuery: true, timeout: 60000, method: body === undefined ? 'GET' : 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw Object.assign(Error(r.value.error ?? 'gateway_failed'), { status: r.status }); return r.value;
  };
  const reads = await localReads({ ...config, local: { ...config.local, readerId: 'web' } });
  const intents = await Store.open(join(manifest.directory, 'web-checkout'));
  const checkout = new WebCheckout({ store: reads.store, intents, config, reads, post: request });
  const readPath = /^\/(?:status|world|blocks|patterns|table|compounds|finds|receipts|mint-rights|agents|events|feed|results|list|records\/batches|mint\/[0-9a-f]{64})(?:[/?]|$)/;
  const bindings = { read: path => reads.bindings.read(path), request: b => request('/payout-bindings/request', b), complete: b => request('/payout-bindings/complete', b) };
  const methods = type => ({ request: b => request('/' + type + '/request', b), payment: b => request('/' + type + '/payment', b) });
  const http = await serve({ web: createWeb(checkout), port, intake: { store: reads.store }, bindings,
    mints: { ...methods('mint'), quote: b => request('/mint/quote', b) }, links: methods('link'),
    publicAPI: { handles: path => readPath.test(path), read: path => request(path) },
    files: { async serve(req, res) {
      if (!(req.url === '/latest.json' || /^\/(blocks|receipts|records)\/[a-zA-Z0-9/_.-]+\.(json|bin)$/.test(req.url)) || req.url.includes('..')) return false;
      const r = await fetch(upstream + req.url); res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : Buffer.from(await r.arrayBuffer())); return true;
    } } });
  return { ...http, async close() { await http.close(); reads.close(); await intents.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const web = await startWeb({ port: Number(process.env.DMW_WEB_PORT ?? 58911) });
  console.log(`Gateway pages: ${web.url}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => web.close().then(() => process.exit(0)));
}
