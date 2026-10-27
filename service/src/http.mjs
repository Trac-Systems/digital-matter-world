import { redactedError } from './error-log.mjs';
import { publicIdentities, TRAC_ADDRESS_ERROR } from '../../rules/src/trac-address.js';
import { createServer } from 'node:http';
import { check, hash } from './util.mjs';
import { Limiter } from './limiter.mjs';
import { rules } from './rules.mjs';
import { readFile } from 'node:fs/promises';
import { createWeb } from './web.mjs';
async function body(req, maxBytes) {
  check(!req.headers['content-length'] || Number(req.headers['content-length']) <= maxBytes, 'body_limit', 413);
  check((req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'content_type', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; check(size <= maxBytes, 'body_limit', 413); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function serve({ intake, files, headers, mints, links, publicAPI, bindings, operator, evidence, web = createWeb(), host = '127.0.0.1', port = 0, maxInFlight = 1024 }) {
  check(host === '127.0.0.1', 'local_listener_required'); let inFlight = 0;
  const unauthenticated = new Limiter({ capacity: 1024, burst: 1200, perSecond: 1000 });
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (inFlight >= maxInFlight) { res.writeHead(503, { 'Retry-After': '1' }); res.end(); return; } inFlight++;
    try {
      if (req.method === 'POST') check(unauthenticated.take(req.socket.remoteAddress), 'request_rate', 429);
      if (evidence && req.method === 'POST' && req.url === '/operator-evidence') {
        const result = await evidence(JSON.parse(await body(req, 4096)));
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(result)); return;
      }
      if (await web.handle(req, res, body)) return;
      if (headers && await headers.serve(req, res)) return;
      if (operator && ['GET', 'HEAD'].includes(req.method) && ['/operator', '/operator.js', '/operator/status', '/operator/deployments'].includes(req.url)) {
        res.setHeader('Cache-Control', 'no-store');
        if (['/operator/status', '/operator/deployments'].includes(req.url)) { res.setHeader('Content-Type', 'application/json'); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(publicIdentities(await (req.url.endsWith('deployments') ? operator.deployments() : operator.status())))); }
        else { res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(req.method === 'HEAD' ? undefined : await readFile(new URL('../public/' + (req.url.endsWith('.js') ? 'operator.js' : 'operator.html'), import.meta.url))); }
        return;
      }
      if (bindings && req.method === 'GET' && /^\/bind-payout\/[0-9a-f]{64}$/.test(req.url)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.end(await readFile(new URL('../public/bind-payout.html', import.meta.url))); return;
      }
      if (bindings && req.method === 'GET' && req.url === '/bind-payout.js') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(await readFile(new URL('../public/bind-payout.js', import.meta.url))); return;
      }
      if (bindings && ['GET', 'HEAD'].includes(req.method) && req.url.startsWith('/payout-bindings/')) {
        const result = bindings.read(req.url); res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result)); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && publicAPI?.handles(req.url)) {
        const bytes = Buffer.from(JSON.stringify(await publicAPI.read(req.url))), etag = '"' + hash(bytes) + '"';
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=1, must-revalidate'); res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
        res.setHeader('Content-Length', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && await files.serve(req, res)) return;
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ ok: !intake.store.failed, unit: rules.TAP_UNIT, tip: intake.head?.tip ?? null, pending: intake.store.count('dedupe'), observations: intake.store.count('observations'), latest: intake.store.get('meta', 'latest'), worker: intake.store.get('meta', 'workerStatus') })); return; }
      let result;
      if (req.method === 'POST' && req.url === '/moves') result = await intake.accept(await body(req, rules.MOVE_DEFAULTS.maxBytes));
      else if (bindings && req.method === 'POST' && req.url === '/payout-bindings/request') result = await bindings.request(JSON.parse(await body(req, 4096)));
      else if (bindings && req.method === 'POST' && req.url === '/payout-bindings/complete') result = await bindings.complete(JSON.parse(await body(req, 4096)));
      else if (links && req.method === 'POST' && req.url === '/link/request') {
        const input = JSON.parse(await body(req, 4096));
        result = !input.paymentHash && web.checkout ? await web.checkout.enrollLink(input) : await links.request(input);
      }
      else if (links && req.method === 'POST' && req.url === '/link/payment') result = await links.payment(JSON.parse(await body(req, 4096)));
      else if (operator?.provisioner && req.method === 'GET' && /^\/mint\/deployment\/[0-9a-z]{1,24}$/.test(req.url)) {
        const asset = req.url.split('/').at(-1), definition = (intake.store.get('meta', 'patterns') ?? []).find(p => rules.patternAsset(p) === asset) ?? intake.store.get('types', asset);
        check(definition, 'asset_unknown'); result = await operator.provisioner.request(asset, definition);
      }
      else if (operator?.provisioner && req.method === 'POST' && req.url === '/mint/deployment') {
        const input = JSON.parse(await body(req, 4096)); result = await operator.provisioner.submit(input.asset, input);
      }
      else if (mints && req.method === 'POST' && req.url === '/mint/quote') result = await mints.quote(JSON.parse(await body(req, 4096)));
      else if (mints && req.method === 'POST' && req.url === '/mint/request') result = await mints.request(JSON.parse(await body(req, 8192)));
      else if (mints && req.method === 'POST' && req.url === '/mint/payment') result = await mints.payment(JSON.parse(await body(req, 4096)));
      else if (mints && req.method === 'GET' && /^\/mint\/[0-9a-f]{64}$/.test(req.url)) result = mints.public(req.url.slice(6));
      else { res.statusCode = 404; res.end('{"error":"not_found"}'); return; }
      res.end(JSON.stringify(req.url === '/moves' ? result : publicIdentities(result)));
    } catch (error) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.statusCode = error.status ?? 400;
        if (res.statusCode === 429 || res.statusCode === 503) res.setHeader('Retry-After', '1');
        // Arbitrary upstream error strings may contain private endpoint details.
        const code = error.code === 'trac_address_required' ? TRAC_ADDRESS_ERROR : /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'request_failed';
        if (code === 'request_failed') console.error('http_request_failed', JSON.stringify(redactedError(error)));
        res.end(JSON.stringify({ error: code, ...(error.code === 'trac_address_required' ? { code: error.code } : {}) }));
      } else res.destroy();
    } finally { inFlight--; }
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.timeout = 15000; server.maxConnections = 1200; server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, async close() { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } };
}
