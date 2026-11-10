import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { DashboardState, dashboardCheck, dashboardError } from './dashboard-state.mjs';

const hash = value => createHash('sha256').update(value).digest();
const equal = (value, expected) => typeof value === 'string' && value.length <= 128 && timingSafeEqual(hash(value), expected);
const cookiePrefix = 'dmw_dashboard_';
const files = new Map([
  ['/local/agent.js', ['agent.js', 'text/javascript']], ['/local/flag.js', ['flag.js', 'text/javascript']],
  ['/minter', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/login.js', ['login.js', 'text/javascript']], ['/wallet.js', ['wallet.js', 'text/javascript']],
  ['/console.css', ['console.css', 'text/css']],
  ...['fraunces-latin-wght-normal', 'atkinson-hyperlegible-next-latin-wght-normal', 'ibm-plex-mono-latin-400-normal', 'ibm-plex-mono-latin-500-normal'].map(name =>
    ['/fonts/' + name + '.woff2', ['fonts/' + name + '.woff2', 'font/woff2']]),
]);
async function body(req, limit = 1500000) {
  dashboardCheck(req.headers['content-type']?.split(';')[0] === 'application/json', 'json_required', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; dashboardCheck(size <= limit, 'body_limit', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks)); } catch { dashboardCheck(false, 'invalid_json'); }
  dashboardCheck(value && typeof value === 'object' && !Array.isArray(value), 'invalid_json');
  return value;
}

async function proxy(req, res, url, upstream) {
  const headers = { accept: req.headers.accept ?? '*/*' };
  const requester = req.headers['x-mint-requester-secret'];
  // A public mint request or public bulk order is read and paid with the secret of the browser that started it.
  if (/^\/(?:web-api\/)?mint\/[0-9a-f]{64}$/.test(url.pathname) || req.method === 'POST' && url.pathname === '/mint/payment' ||
    /^\/web-api\/public-mints\/bulk\/(?:start|[0-9a-f]{64}(?:\/(?:payment|inscriptions))?)$/.test(url.pathname)) {
    if (typeof requester === 'string' && /^[0-9a-f]{64}$/.test(requester)) headers['x-mint-requester-secret'] = requester;
  }
  const init = { method: req.method, redirect: 'manual', headers, signal: AbortSignal.timeout(url.pathname.startsWith('/events') ? 3600000 : 30000) };
  if (req.method === 'POST') { init.body = JSON.stringify(await body(req)); headers['content-type'] = 'application/json'; }
  // /me is this dashboard's own page; the site's shell renders it.
  const response = await fetch(new URL(url.pathname === '/me' ? '/' : url.pathname + url.search, upstream), init);
  const type = response.headers.get('content-type') ?? 'application/octet-stream';
  res.statusCode = response.status; res.setHeader('Content-Type', type);
  const retry = response.headers.get('retry-after'); if (retry) res.setHeader('Retry-After', retry);
  if (type.startsWith('text/html')) {
    const html = (await response.text()).replace('<script type="module" src="/web/app.js"></script>', '<script src="/local/flag.js"></script><script type="module" src="/web/app.js"></script>');
    res.end(html); return;
  }
  if (!response.body) { res.end(); return; }
  const stream = Readable.fromWeb(response.body);
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}

export async function serveDashboard(context, { port = 0, state = new DashboardState(context), control } = {}) {
  dashboardCheck(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'invalid_port');
  const token = randomBytes(32).toString('base64url');
  const session = state.session ? state.session(() => randomBytes(32).toString('base64url')) : randomBytes(32).toString('base64url');
  let tokenHash = hash(token), origin, cookieName;
  const sessionHash = hash(session);
  let upstream = null;
  try { upstream = new URL(state.agent?.paymentOrigin); if (!['https:', 'http:'].includes(upstream.protocol)) upstream = null; } catch { upstream = null; }
  const server = createServer(async (req, res) => {
    // No access log: neither login credentials nor private browser recovery
    // records may be copied into a terminal or gateway log.
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' chrome-extension: moz-extension:; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://mempool.space https://reader.tapscope.io; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (value, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    try {
      dashboardCheck(req.headers.host === new URL(origin).host && req.socket.remoteAddress === '127.0.0.1', 'local_only', 403);
      dashboardCheck(req.url.startsWith('/') && !req.url.startsWith('//'), 'invalid_route');
      const url = new URL(req.url, origin), path = url.pathname;
      // The local CLI authenticates independently of the browser session.
      // Reserve the whole namespace so it can never reach the site proxy.
      if (path.startsWith('/control/')) {
        dashboardCheck(control, 'not_found', 404);
        await control.handle(req, res); return;
      }
      dashboardCheck(['GET', 'POST'].includes(req.method), 'method_not_allowed', 405);
      if (req.method === 'POST') dashboardCheck(req.headers.origin === origin && !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']), 'origin_required', 403);
      if (req.method === 'GET' && path === '/login' && !url.search) {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Digital Matter World · Local dashboard</title><p id="status">Opening your private dashboard…</p><script type="module" src="/login.js"></script></html>'); return;
      }
      if (req.method === 'POST' && path === '/login') {
        const value = await body(req);
        dashboardCheck(Object.keys(value).length === 1 && tokenHash && equal(value.token, tokenHash), 'login_invalid', 401);
        tokenHash = null;
        res.setHeader('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
        json({ authenticated: true }); return;
      }
      if (!(req.method === 'GET' && path === '/login.js' && !url.search)) {
        const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(cookieName + '='));
        dashboardCheck(cookies.length === 1 && equal(cookies[0].slice(cookieName.length + 1), sessionHash), 'login_required', 401);
        dashboardCheck(req.headers['sec-fetch-site'] !== 'cross-site', 'origin_required', 403);
      }
      if (req.method === 'GET' && files.has(path) && !url.search) {
        const [file, type] = files.get(path);
        const bytes = await readFile(new URL('../dashboard/' + file, import.meta.url));
        res.setHeader('Content-Type', type); res.end(bytes); return;
      }
      const keys = allowed => dashboardCheck([...url.searchParams.keys()].every(k => allowed.includes(k) && url.searchParams.getAll(k).length === 1), 'invalid_query');
      if (req.method === 'GET' && path === '/api/info') { keys([]); json(await state.info()); return; }
      if (req.method === 'GET' && path === '/api/claims') {
        keys(['cursor', 'myFindsCursor', 'limit', 'asset', 'deployment']);
        json(await state.claims({ cursor: url.searchParams.get('cursor') ?? undefined, myFindsCursor: url.searchParams.get('myFindsCursor') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 25), asset: url.searchParams.get('asset') ?? undefined, deployment: url.searchParams.get('deployment') ?? undefined })); return;
      }
      if (req.method === 'GET' && path === '/api/patterns') { keys([]); json(await state.patterns()); return; }
      if (req.method === 'GET' && path === '/api/requests') {
        keys(['offset', 'limit']); json(await state.requests({ offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 25) })); return;
      }
      if (req.method === 'GET' && path === '/api/credits') {
        keys(['cursor', 'limit', 'request']); json(await state.credits({ cursor: url.searchParams.get('cursor') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? 25), request: url.searchParams.get('request') ?? undefined })); return;
      }
      if (req.method === 'POST' && ['/api/credits/use', '/api/credits/transfer'].includes(path)) {
        keys([]); const value = await body(req);
        json(await (path === '/api/credits/use' ? state.useCredit(value) : state.transferCredit(value))); return;
      }
      if (req.method === 'GET' && path === '/api/links') {
        keys(['offset', 'limit']); json(await state.links({ offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 10) })); return;
      }
      if (path === '/api/link-bulk') {
        if (req.method === 'POST') { keys([]); json(await state.linkBulk(await body(req))); return; }
        keys(['offset', 'limit']); json(state.bulkLinks.jobs.list({ offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 10) })); return;
      }
      // The page asks for the agent's own unlinked Bitmaps; this agent has no such list yet (a quiet 404 hides the picker).
      if (req.method === 'GET' && path === '/api/link-bulk/candidates') { json({ error: 'not_available' }, 404); return; }
      const linkJob = /^\/api\/link-bulk\/([a-zA-Z0-9._-]+)(\/cancel)?$/.exec(path);
      if (linkJob && req.method === 'GET' && !linkJob[2]) {
        keys(['offset', 'limit']); json(state.bulkLinks.jobs.detail(linkJob[1], { offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 25) })); return;
      }
      if (linkJob?.[2] && req.method === 'POST') {
        keys([]); dashboardCheck(!state.closed, 'dashboard_stopping', 503);
        const value = !req.headers['transfer-encoding'] && !Number(req.headers['content-length'] ?? 0) ? {} : await body(req);
        dashboardCheck(!Object.keys(value).length, 'invalid_cancel');
        json(state.bulkLinks.jobs.cancel(linkJob[1])); return;
      }
      if (req.method === 'GET' && path === '/api/bulk') {
        keys(['offset', 'limit']); json(await state.bulkOrders({ offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 25) })); return;
      }
      const bulk = /^\/api\/bulk\/([0-9a-f]{64})(?:\/(terms|members|permit))?$/.exec(path);
      if (req.method === 'GET' && bulk) {
        keys(['members', 'permit'].includes(bulk[2]) ? ['offset', 'limit'] : []);
        json(await (bulk[2] === 'terms' ? state.bulkTerms(bulk[1]) : bulk[2] ? state.bulkPage(bulk[1], bulk[2], {
          offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? (bulk[2] === 'permit' ? 16 : 64))
        }) : state.bulkStatus(bulk[1]))); return;
      }
      if (req.method === 'POST' && ['/api/bulk/quote', '/api/bulk/request', '/api/bulk/payment'].includes(path)) {
        keys([]); const { BULK_LIMITS } = await import('../../rules/src/bulk-mint.js');
        const value = await body(req, path === '/api/bulk/quote' ? BULK_LIMITS.quoteInputBytes : BULK_LIMITS.requestBytes);
        json(await (path === '/api/bulk/quote' ? state.bulkQuote(value) : path === '/api/bulk/request' ? state.bulkRequest(value) : state.bulkPayment(value))); return;
      }
      const mint = /^\/api\/requests\/([0-9a-f]{64})(\/plan)?$/.exec(path);
      if (req.method === 'GET' && mint) { keys([]); json(await (mint[2] ? state.plan(mint[1]) : state.status(mint[1]))); return; }
      if (req.method === 'GET' && path === '/api/tickers') { keys(['asset', 'after', 'limit']); json(await state.service.assetTickers(url.searchParams.get('asset'), {
        ...(url.searchParams.has('after') ? { after: url.searchParams.get('after') } : {}), ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}) })); return; }
      if (req.method === 'POST' && path === '/api/ticker-payment') { keys([]); json(await state.service.tickerPayment(await body(req))); return; }
      if (req.method === 'POST' && path === '/api/deploy-ticker') {
        keys([]); const value = await body(req); dashboardCheck(value && Object.keys(value).every(k => ['asset', 'ticker', 'retry'].includes(k)), 'invalid_ticker_request');
        json(await state.service.deployTicker({ ...value, receiver: await state.payout() })); return;
      }
      if (req.method === 'POST' && path === '/api/compound-ticker') { keys([]); json(await state.chooseCompoundTicker(await body(req))); return; }
      if (req.method === 'GET' && path === '/api/units') { keys([]); json(await state.units()); return; }
      if (req.method === 'GET' && path === '/api/sends') { keys([]); json(await state.sends()); return; }
      if (req.method === 'GET' && path === '/api/tnk') { keys([]); json(await state.tnk()); return; }
      if (req.method === 'GET' && path === '/api/tnk-sends') { keys([]); json(await state.tnkSends()); return; }
      if (req.method === 'GET' && path === '/api/craft') { keys([]); json(await state.craft()); return; }
      if (req.method === 'GET' && path === '/api/wallet') { keys(['key']); json({ value: state.walletGet(url.searchParams.get('key')) }); return; }
      if (req.method === 'POST' && ['/api/mint', '/api/mint-all', '/api/link', '/api/payment', '/api/wallet', '/api/wallet-lock', '/api/send-review', '/api/send', '/api/send-retry', '/api/send-resign', '/api/tnk-review', '/api/tnk-send', '/api/tnk-retry', '/api/craft-preview', '/api/craft', '/api/craft-retry', '/api/craft-refine', '/api/mint-compound'].includes(path)) {
        keys([]); const value = await body(req);
        if (path === '/api/mint') json(await state.mint(value));
        if (path === '/api/mint-compound') json(await state.mintCompound(value));
        if (path === '/api/link') json(await state.link(value));
        if (path === '/api/mint-all') json(state.mintAll(value), 202);
        if (path === '/api/payment') json(await state.payment(value));
        if (path === '/api/wallet') json(state.walletPut(value));
        if (path === '/api/wallet-lock') json(state.walletLock(value));
        // Send units on Trac: review signs nothing; send, retry and re-sign
        // save each transfer action ID before the transfer action runs.
        if (path === '/api/send-review') json(await state.review(value));
        if (path === '/api/send') json(await state.send(value), 202);
        if (path === '/api/send-retry') json(await state.retrySend(value), 202);
        if (path === '/api/send-resign') json(await state.resignSend(value), 202);
        // TNK (network gas): review signs nothing; send and retry save and
        // reuse one action ID per send.
        if (path === '/api/tnk-review') json(await state.tnkReview(value));
        if (path === '/api/tnk-send') json(await state.tnkSend(value), 202);
        if (path === '/api/tnk-retry') json(await state.tnkRetry(value), 202);
        // Craft: the preview signs nothing; craft, retry and refine save each
        // action ID before the kit's craft or refine action runs.
        if (path === '/api/craft-preview') json(await state.craftPreview(value));
        if (path === '/api/craft') json(await state.craftStart(value), 202);
        if (path === '/api/craft-retry') json(await state.craftRetry(value), 202);
        if (path === '/api/craft-refine') json(await state.craftRefine(value), 202);
        return;
      }
      dashboardCheck(upstream && !path.startsWith('/api/') && !path.startsWith('/local/'), 'not_found', 404);
      // Every other address is the live site: its pages, reads, wallet connect
      // and payment flow. Only the HTML shell gains the local "My agent" page.
      await proxy(req, res, url, upstream); return;
    } catch (error) {
      // Opt-in local diagnostics: the owner's terminal only, never the page.
      if (process.env.DMW_DASHBOARD_DEBUG === '1') process.stderr.write(`dashboard ${req.method} ${req.url.split('?')[0]}: ${String(error?.stack ?? error).slice(0, 2000)}\n`);
      if (!res.headersSent) json({ error: dashboardError(error), ...(error.code === 'link_job_running' ? { job: error.job } : {}) }, [400, 401, 403, 404, 409, 413, 415, 429, 502, 503].includes(error.status) ? error.status : 500);
      else res.end();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  state.activate();
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { await state.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  cookieName = cookiePrefix + server.address().port;
  let closing;
  return { origin, loginLink: `${origin}/login#${token}`, state,
    close() { return closing ??= (async () => { const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await control?.close(); await state.close(); await stopped; })(); } };
}
