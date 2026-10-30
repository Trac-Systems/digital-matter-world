import { readFile } from 'node:fs/promises';
import { check } from './util.mjs';
import { publicIdentities } from '../../rules/src/trac-address.js';
const root = new URL('../public/web/', import.meta.url);
const consoleRoot = new URL('../../playground/console/', import.meta.url), tracAddress = new URL('../../rules/src/trac-address.js', import.meta.url);
const assets = new Map(['app.js', 'data.js', 'records.js', 'wallets.js', 'connect.js', 'money.js'].map(name => ['/web/' + name, new URL(name, root)]));
assets.set('/web/amount-format.js', new URL('js/amount-format.js', consoleRoot));
assets.set('/web/trac-address.js', tracAddress);
assets.set('/playground/console/js/requester-storage.js', new URL('js/requester-storage.js', consoleRoot));
assets.set('/kit/lib/tap-wallet-actions.mjs', new URL('../../kit/lib/tap-wallet-actions.mjs', import.meta.url));
assets.set('/kit/lib/wallet-funds.mjs', new URL('../../kit/lib/wallet-funds.mjs', import.meta.url));
// The pages are the playground console's own CSS, components and views. Only its data module (api.js)
// and its wallet flows (flows.js) are replaced by the public read adapter and the wallet-page links.
for (const name of ['dom', 'paged', 'spiral', 'words', 'money', 'amount-format', 'wallet-errors', 'requester-storage', 'inscribe/wallet', 'inscribe/public', 'views/world', 'views/about', 'views/table', 'views/agents', 'views/feed', 'views/results'])
  assets.set(`/web/console/js/${name}.js`, new URL(`js/${name}.js`, consoleRoot));
assets.set('/web/console/js/api.js', new URL('api.js', root));
assets.set('/web/console/js/flows.js', new URL('flows.js', root));
// dom.js imports ../../../rules/src/trac-address.js, which resolves here.
assets.set('/rules/src/trac-address.js', tracAddress);
const styles = new Map([['/web/console/console.css', ['text/css; charset=utf-8', new URL('console.css', consoleRoot)]],
  ...['fraunces-latin-wght-normal', 'atkinson-hyperlegible-next-latin-wght-normal', 'ibm-plex-mono-latin-400-normal', 'ibm-plex-mono-latin-500-normal']
    .map(name => [`/web/console/fonts/${name}.woff2`, ['font/woff2', new URL(`fonts/${name}.woff2`, consoleRoot)]])]);
const pages = /^\/(?:about|explore|feed|blocks|patterns|table|compounds|agents(?:\/trac1[a-z0-9]+)?|records(?:\/batches\/\d+)?|results(?:\/(?:mints|payments|ethereum|payouts|owed|paid|links|treasury|burn))?|block\/\d+|plot\/\d+|pattern\/(?:[a-z0-9]{1,24}|p2:(?:0|[1-9][0-9]*))|compound\/(?:[a-z0-9]{1,24}|c2:[0-9a-f]{64})|events\/\d+|mint(?:\/(?:[0-9a-f]{64}|[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*)|c2:[0-9a-f]{64}))?|link(?:\/[0-9a-f]{64})?|bind-payout(?:\/[0-9a-f]{64})?)\/?$/;
export function createWeb(checkout) {
  return { checkout, async handle(req, res, readBody) {
    const u = new URL(req.url, 'http://localhost'), path = u.pathname;
    if (path === '/' || pages.test(path)) res.setHeader('Vary', 'Accept');
    const send = (type, value) => { res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-store'); res.end(req.method === 'HEAD' ? undefined : value); };
    if (['GET', 'HEAD'].includes(req.method) && assets.has(path)) { send('text/javascript; charset=utf-8', await readFile(assets.get(path))); return true; }
    if (['GET', 'HEAD'].includes(req.method) && styles.has(path)) { const [type, file] = styles.get(path); send(type, await readFile(file)); return true; }
    if (['GET', 'HEAD'].includes(req.method) && (path === '/' || pages.test(path)) && (path === '/' || req.headers.accept?.includes('text/html'))) {
      res.setHeader('Vary', 'Accept'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self' https://mempool.space https://reader.tapscope.io; style-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      send('text/html; charset=utf-8', await readFile(new URL('index.html', root))); return true;
    }
    if (!path.startsWith('/web-api/') && path !== '/records/highlights') return false;
    check(checkout, 'web_checkout_unavailable', 503);
    let result;
    // Local rehearsals read their own indexer, never a mainnet wallet balance.
    const tapRead = /^\/web-api\/tap-reader\/(getDeployment\/[^/]+|(?:getBalance|getTransferable|getLockedBalance)\/[^/]+\/[^/]+|getObligationLockedBalance\/a\/[^/]+\/[^/]+)$/.exec(path);
    if (req.method === 'GET' && tapRead) {
      check(checkout.target.bitcoinNetwork === 'regtest' && !u.search && typeof checkout.reads?.tap === 'function', 'tap_balance_reader_unavailable', 503);
      result = { result: await checkout.reads.tap(tapRead[1]) };
    }
    else if (['GET', 'HEAD'].includes(req.method) && path === '/records/highlights') result = await checkout.records();
    else if (['GET', 'HEAD'].includes(req.method) && path === '/web-api/target') result = checkout.target;
    else {
      const m = /^\/web-api\/(mint|link)\/([0-9a-f]{64})(\/(?:prepare|lock))?$/.exec(path);
      check(m, 'not_found', 404);
      if (['GET', 'HEAD'].includes(req.method) && m[1] === 'link' && m[3] === '/lock') {
        result = await checkout.linkLock(m[2], u.searchParams.get('paymentId'));
      } else if (req.method === 'POST' && m[1] === 'link' && m[3] === '/prepare') {
        check(!req.headers.origin || req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`, 'origin_not_allowed', 403);
        check(req.headers['sec-fetch-site'] !== 'cross-site', 'origin_not_allowed', 403);
        result = await checkout.prepareLink(m[2], JSON.parse(await readBody(req, 4096)));
      } else { check(['GET', 'HEAD'].includes(req.method) && !m[3], 'method_not_allowed', 405); result = await checkout.plan(m[1], m[2], req.headers['x-mint-requester-secret']); }
    }
    send('application/json', JSON.stringify(publicIdentities(result))); return true;
  } };
}
