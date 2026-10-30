import { redactedError } from './error-log.mjs';
import { publicIdentities, TRAC_ADDRESS_ERROR } from '../../rules/src/trac-address.js';
import { createServer } from 'node:http';
import { check, hash } from './util.mjs';
import { Limiter } from './limiter.mjs';
import { rules } from './rules.mjs';
import { readFile } from 'node:fs/promises';
import { createWeb } from './web.mjs';
import { KIT_VERSION, KIT_DOWNLOAD_URL, KIT_UPGRADE_CODE, KIT_UPGRADE_MESSAGE } from '../../rules/src/kit-release.js';
import { AccountAvailability } from './account-availability.mjs';
import { accountKey } from '../../contract/account-tree.js';
import { financialAsset } from '../../rules/src/financial-mint.js';
import { deploymentAssetId } from './mint-assets.mjs';
import { responseBudget } from './response-budget.mjs';
import { publicMintClientIP } from './public-mint-admission.mjs';
async function body(req, maxBytes) {
  check(!req.headers['content-length'] || Number(req.headers['content-length']) <= maxBytes, 'body_limit', 413);
  check((req.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'content_type', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; check(size <= maxBytes, 'body_limit', 413); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function serve({ listener, intake, files, headers, mints, links, financialActions, custody, publicAPI, bindings, submittedBitmaps, operator, evidence, web = createWeb(), host = '127.0.0.1', port = 0, responseTimeoutMs = 2000, maxInFlight = rules.RESOURCE_PROFILE.httpInFlight, maxConnections = rules.RESOURCE_PROFILE.httpConnections, requestTimeoutMs = rules.RESOURCE_PROFILE.requestTimeoutMs, bitmapSubmitBytes = 4096, headerTimeoutMs = rules.RESOURCE_PROFILE.httpHeaderTimeoutMs, socketTimeoutMs = rules.RESOURCE_PROFILE.httpSocketTimeoutMs, keepAliveMs = rules.RESOURCE_PROFILE.httpKeepAliveMs, rateCapacity = rules.RESOURCE_PROFILE.httpRateCapacity, rateBurst = rules.RESOURCE_PROFILE.httpRateBurst, ratePerSecond = rules.RESOURCE_PROFILE.httpRatePerSecond }) {
  check(Number.isSafeInteger(responseTimeoutMs) && responseTimeoutMs > 0 && responseTimeoutMs <= 2000, 'response_timeout');
  check(Number.isSafeInteger(bitmapSubmitBytes) && bitmapSubmitBytes > 0, 'bitmap_submit_bytes');
  check(host === '127.0.0.1', 'local_listener_required'); let inFlight = 0;
  const unauthenticated = new Limiter({ capacity: rateCapacity, burst: rateBurst, perSecond: ratePerSecond });
  const handler = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (inFlight >= maxInFlight) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: 'service_busy', retryable: true })); return;
    } inFlight++;
    const finishBudget = ['GET', 'HEAD'].includes(req.method) || req.url.startsWith('/mint/') ? responseBudget(req, res, responseTimeoutMs) : () => {};
    try {
      if (req.method === 'POST') check(unauthenticated.take(req.socket.remoteAddress), 'request_rate', 429);
      if (evidence && req.method === 'POST' && req.url === '/operator-evidence') {
        const result = await evidence(JSON.parse(await body(req, evidence.requestBytes ?? 4096)));
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(result)); return;
      }
      if (await web.handle(req, res, body)) return;
      if (headers && await headers.serve(req, res)) return;
      const operatorURL = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && operatorURL.pathname === '/internal/mint-sender/requests') {
        check(mints?.mintSender && mints.mintSender.authorized(req.headers.authorization), 'not_found', 404);
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(mints.mintSender.page(mints, operatorURL.searchParams))); return;
      }
      if (mints?.public && ['GET', 'HEAD'].includes(req.method) && /^\/mint\/[0-9a-f]{64}$/.test(req.url)) {
        const result = mints.public(req.url.slice(6), req.headers['x-mint-requester-secret']);
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Vary', 'Accept, X-Mint-Requester-Secret');
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(publicIdentities(result))); return;
      }
      if (req.method === 'GET' && (operatorURL.pathname === '/internal/mint-sender/refunds' || /^\/internal\/mint-sender\/refunds\/[0-9a-f]{64}$/.test(operatorURL.pathname) || operatorURL.pathname === '/internal/mint-sender/status')) {
        check(mints?.mintSender && mints.mintSender.authorized(req.headers.authorization), 'not_found', 404);
        const view = mints.mintSender;
        const result = operatorURL.pathname.endsWith('/status') ? view.status() : operatorURL.pathname === '/internal/mint-sender/refunds' ?
          view.refundPage(mints, operatorURL.searchParams) : view.refundRecord(mints, operatorURL.pathname.split('/').at(-1));
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(result)); return;
      }
      if (mints?.publicMints && ['GET', 'HEAD'].includes(req.method) &&
          (operatorURL.pathname.startsWith('/public-mints') || operatorURL.pathname === '/mint-rights' && rules.publicMintActive(mints.document, intake.store.get('meta', 'ruleState')?.counted ?? '0'))) {
        const path = decodeURIComponent(operatorURL.pathname), detail = /^\/public-mints\/([^/]+)\/(0|[1-9][0-9]*)$/.exec(path);
        let result = path === '/public-mints/refunds' ? mints.publicMints.refunds(operatorURL.searchParams, req.headers['x-mint-requester-secret']) : detail ? mints.publicMints.state(detail[1], detail[2]) :
          ['/public-mints', '/mint-rights'].includes(path) ? mints.publicMints.list(operatorURL.searchParams) : null;
        if (result && path === '/public-mints/refunds' && mints.mintSender) result = { ...result, rows: result.rows.map(r => mints.mintSender.decorateRefund(r)) };
        check(result, 'not_found', 404); res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result)); return;
      }
      if (req.method === 'GET' && operatorURL.pathname.startsWith('/receipt-renewals/')) {
        const match = /^\/receipt-renewals\/([0-9a-f]{64})\/(0|[1-9][0-9]*)$/.exec(operatorURL.pathname);
        check(match && !operatorURL.search, 'renewal_proof_key');
        const descriptor = intake.store.get('receiptRenewalProofs', `${match[1]}/${match[2]}`);
        check(descriptor, 'renewal_proof_unavailable', 404);
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(descriptor)); return;
      }
      if (req.method === 'GET' && operatorURL.pathname.startsWith('/account-proof/')) {
        const [, , owner, asset, ...extra] = operatorURL.pathname.split('/');
        check(!extra.length && /^[0-9a-f]{64}$/.test(owner) && financialAsset(asset), 'account_proof_key');
        const context = intake.rulesContext?.(); check(context?.ready && context.settings, 'ruleset_not_ready', 503);
        const account = intake.store.get('accountRecords', 'ar/' + owner); check(account, 'account_not_found', 404);
        const proof = new AccountAvailability(intake.store).prove(account.root, [accountKey('balance', asset)]);
        const bytes = JSON.stringify({ owner, asset, ...account, proof });
        check(Buffer.byteLength(bytes) <= context.settings.values.proofBytes, 'account_proof_budget', 413);
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(bytes); return;
      }
      if (req.method === 'POST' && operatorURL.pathname === '/craft-preview') {
        const context = intake.rulesContext?.(); check(context?.ready && context.settings, 'ruleset_not_ready', 503);
        const p = JSON.parse(await body(req, context.settings.values.moveBytes));
        check(rules.exactKeys(p, ['recipe', 'inputs', 'snapshot']), 'craft_payload');
        const proof = rules.craftPreviewProof({ snapshot: intake.store.get('meta', 'ruleState').namedSnapshot,
          get: id => intake.store.get('namedNodes', id), recipe: p.recipe, inputs: p.inputs, anchor: p.snapshot, settings: context.settings, executionHeight: context.counted });
        check(proof.root === context.acceptedRoot, 'named_record_root');
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(proof)); return;
      }
      if (req.method === 'GET' && operatorURL.pathname.startsWith('/named-record/')) {
        const key = operatorURL.pathname.slice('/named-record/'.length);
        check(/^(commit\/[0-9a-f]{64}\/[0-9a-f]{64}|compound\/(assets|tiers|maker)\/c2:[0-9a-f]{64})$/.test(key), 'named_record_key');
        const context = intake.rulesContext?.(); check(context?.ready && context.settings, 'ruleset_not_ready', 503);
        const state = intake.store.get('meta', 'ruleState');
        const proof = rules.proveNamedRecord({ snapshot: state.namedSnapshot, get: id => intake.store.get('namedNodes', id), key, settings: context.settings });
        check(proof.root === context.acceptedRoot, 'named_record_root');
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(proof)); return;
      }
      if (operator && ['GET', 'HEAD'].includes(req.method) && ['/operator', '/operator.js', '/operator/status', '/operator/deployments'].includes(operatorURL.pathname)) {
        res.setHeader('Cache-Control', 'no-store');
        if (['/operator/status', '/operator/deployments'].includes(operatorURL.pathname)) {
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'HEAD') res.end();
          else {
            const deployments = operatorURL.pathname.endsWith('deployments');
            let result = await (deployments ? operator.deployments(operatorURL.searchParams) : operator.status());
            if (!deployments && mints?.mintSender) result = { ...result, mintSender: mints.mintSender.status() };
            res.end(JSON.stringify(publicIdentities(result)));
          }
        }
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
      if (bindings && ['GET', 'HEAD'].includes(req.method) && /^\/wallets\/[^/?#]{1,100}$/.test(req.url)) {
        const result = publicIdentities(bindings.wallets(req.url.slice(9))); res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(result)); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && publicAPI?.handles(req.url)) {
        const cached = await publicAPI.response?.(req.url), bytes = cached?.bytes ?? Buffer.from(JSON.stringify(await publicAPI.read(req.url))), etag = cached?.etag ?? '"' + hash(bytes) + '"';
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=1, must-revalidate'); res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
        res.setHeader('Content-Length', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && await files.serve(req, res)) return;
      res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ ok: !intake.store.failed, ready: !intake.store.failed && (intake.rulesContext?.()?.ready ?? !!intake.head), unit: rules.TAP_UNIT, tip: intake.head?.tip ?? null, pending: intake.store.get('meta', 'ruleState')?.batchVersion === 2 ? intake.store.countUint('dedupe') : intake.store.count('dedupe'), observations: intake.store.get('meta', 'ruleState')?.batchVersion === 2 ? intake.store.countUint('observations') : intake.store.count('observations'), latest: intake.store.get('meta', 'latest'), worker: intake.store.get('meta', 'workerStatus') })); return; }
      let result;
      if (req.method === 'POST' && req.url === '/moves') result = await intake.accept(await body(req, intake.rulesContext?.()?.settings ? rules.SETTINGS_CAPABILITIES.moveBytes : rules.MOVE_DEFAULTS.maxBytes));
      else if (submittedBitmaps && req.method === 'POST' && req.url === '/bitmaps/submit') result = await submittedBitmaps.submit(JSON.parse(await body(req, bitmapSubmitBytes)));
      else if (bindings && req.method === 'POST' && req.url === '/payout-bindings/request') result = await bindings.request(JSON.parse(await body(req, 4096)));
      else if (bindings && req.method === 'POST' && req.url === '/payout-bindings/complete') result = await bindings.complete(JSON.parse(await body(req, 4096)));
      else if (links && req.method === 'POST' && req.url === '/link/request') {
        const input = JSON.parse(await body(req, intake.settings?.document?.values.moveBytes ?? 4096));
        result = input.request?.v !== 2 && !input.paymentHash && web.checkout ? await web.checkout.enrollLink(input) : await links.request(input);
      }
      else if (links?.quote && req.method === 'POST' && req.url === '/link/quote') result = await links.quote(JSON.parse(await body(req, intake.settings?.document?.values.moveBytes ?? 4096)));
      else if (links?.public && req.method === 'GET' && /^\/link-status\/[0-9a-f]{64}$/.test(req.url)) result = await links.public(req.url.split('/').at(-1));
      else if (links && req.method === 'POST' && req.url === '/link/payment') result = await links.payment(JSON.parse(await body(req, intake.settings?.document?.values.moveBytes ?? 4096)));
      else if (operator?.provisioner && req.method === 'GET' && /^\/mint\/deployment-state\/[^/?#]+$/.test(req.url)) {
        const asset = decodeURIComponent(req.url.split('/').at(-1)); check(deploymentAssetId(asset), 'deployment_asset');
        result = await operator.provisioner.state(asset);
      }
      else if (operator?.provisioner && req.method === 'GET' && /^\/mint\/deployment\/[^/?#]+$/.test(req.url)) {
        const asset = decodeURIComponent(req.url.split('/').at(-1)); check(deploymentAssetId(asset), 'deployment_asset');
        result = await operator.provisioner.request(asset);
      }
      else if (operator?.provisioner && req.method === 'POST' && req.url === '/mint/deployment') {
        const input = JSON.parse(await body(req, 4096)); check(deploymentAssetId(input.asset), 'deployment_asset');
        result = input.phase === undefined && input.inscription === undefined ? await operator.provisioner.request(input.asset) : await operator.provisioner.submit(input.asset, input);
      }
      else if (mints?.publicMints && req.method === 'POST' && ['/public-mints/quote', '/public-mints/start'].includes(req.url)) {
        result = await mints.publicMints.quote(JSON.parse(await body(req, mints.document.values.moveBytes)), req.url.endsWith('/start'), { clientIP: publicMintClientIP(req), requesterSecret: req.headers['x-mint-requester-secret'] });
        if (req.url.endsWith('/quote') && mints.mintSender) result = mints.mintSender.estimate(result);
      }
      else if (mints && req.method === 'POST' && req.url === '/mint/quote') result = await mints.quote(JSON.parse(await body(req, intake.settings?.document?.values.moveBytes ?? 4096)));
      else if (mints && req.method === 'POST' && req.url === '/mint/request') result = await mints.request(JSON.parse(await body(req, intake.settings?.document?.values.moveBytes ?? 8192)));
      else if (mints && req.method === 'POST' && req.url === '/mint/payment') result = await mints.payment(JSON.parse(await body(req, intake.settings?.document?.values.moveBytes ?? 4096)), req.headers['x-mint-requester-secret']);
      else if (mints?.refund && req.method === 'POST' && req.url === '/mint/refund') result = await mints.refund(JSON.parse(await body(req, intake.settings.document.values.moveBytes)));
      else if (financialActions && req.method === 'POST' && req.url === '/financial/action') result = await financialActions.submit(JSON.parse(await body(req, intake.settings.document.values.moveBytes)));
      else if (financialActions && req.method === 'GET' && /^\/financial\/action\/[0-9a-f]{64}$/.test(req.url)) result = financialActions.status(req.url.split('/').at(-1));
      else if (custody && req.method === 'POST' && req.url === '/financial/custody/payment') result = await custody.payment(JSON.parse(await body(req, intake.settings.document.values.moveBytes)));
      else if (custody && req.method === 'GET' && /^\/financial\/custody\/[0-9a-f]{64}$/.test(req.url)) result = await custody.status(req.url.split('/').at(-1));
      else if (mints && req.method === 'GET' && /^\/mint\/[0-9a-f]{64}$/.test(req.url)) result = mints.public(req.url.slice(6));
      else { res.statusCode = 404; res.end('{"error":"not_found"}'); return; }
      res.end(JSON.stringify(req.url === '/moves' ? result : publicIdentities(result)));
    } catch (error) {
      if (res.writableEnded) return;
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        res.statusCode = error.retryable === true ? 503 : error.status ?? 400;
        if (res.statusCode === 429 || res.statusCode === 503) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((error.retryAfterMs ?? 1000) / 1000))));
        // Arbitrary upstream error strings may contain private endpoint details.
        const code = error.code === 'trac_address_required' ? TRAC_ADDRESS_ERROR : /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'request_failed';
        if (code === 'request_failed') console.error('http_request_failed', JSON.stringify(redactedError(error)));
        res.end(JSON.stringify({ error: code, ...(code === 'someone_paid_first' ? error.publicRefund : {}), ...([429, 503].includes(res.statusCode) ? { retryable: true } : {}), ...(code === 'upgrade_required' ? {
          code: KIT_UPGRADE_CODE, message: KIT_UPGRADE_MESSAGE, upgrade: { version: KIT_VERSION, url: KIT_DOWNLOAD_URL }
        } : error.code === 'trac_address_required' ? { code: error.code } : {}) }));
      } else res.destroy();
    } finally { finishBudget(); inFlight--; }
  };
  const server = listener?.server ?? createServer(handler);
  server.headersTimeout = Math.min(headerTimeoutMs, requestTimeoutMs); server.requestTimeout = requestTimeoutMs; server.timeout = socketTimeoutMs; server.maxConnections = maxConnections; server.keepAliveTimeout = keepAliveMs;
  if (listener) { listener.install(handler); return listener; }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, async close() { const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped; } };
}
