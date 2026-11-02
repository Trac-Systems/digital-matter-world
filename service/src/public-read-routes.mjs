import { staticWebRequest } from './web.mjs';

// /list may recursively read its source. Never sneak a live source into a
// worker merely because the outer route is a list (including encoded URLs).
function liveSource(input, liveRights, depth = 0) {
  if (depth > 3) return false; // The API rejects deeper sources itself.
  const url = new URL(input, 'http://127.0.0.1'), path = url.pathname.replace(/\/$/, '');
  if (path === '/status' || /^\/mint\/[0-9a-f]{64}$/.test(path) || liveRights && path === '/mint-rights') return true;
  return path === '/list' && url.searchParams.has('source') && liveSource(url.searchParams.get('source'), liveRights, depth + 1);
}
export function publicWorkerRoute(req, { version2, publicAPI, liveRights, bindings, headers, checkout, operator, bulkReads, financialActions }) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  if (staticWebRequest(req)) return true;
  const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname;
  if (bulkReads && /^\/(?:web-api\/)?mint\/bulk\/[0-9a-f]{64}\/(terms|members)$/.test(path) && (!path.startsWith('/web-api/') || checkout)) return true;
  if (financialActions && req.method === 'GET' && /^\/financial\/action\/[0-9a-f]{64}$/.test(req.url)) return true;
  if (operator && ['/operator', '/operator.js'].includes(path)) return true;
  if (headers && path.startsWith('/headers/')) return version2 || req.url !== '/headers/manifest.json';
  if (checkout && version2 && path === '/records/highlights') return true;
  if (req.method === 'GET' && path.startsWith('/receipt-renewals/')) return true;
  if (bindings && (req.method === 'GET' && (/^\/bind-payout\/[0-9a-f]{64}$/.test(req.url) || req.url === '/bind-payout.js') ||
    req.url.startsWith('/payout-bindings/') || /^\/wallets\/[^/?#]{1,100}$/.test(req.url))) return true;
  if (version2 && publicAPI?.handles(req.url) && !liveSource(req.url, liveRights)) return true;
  // Files.serve's immutable paths also work before the v2 projection format.
  let name; try { name = decodeURIComponent(path).slice(1); } catch { return false; }
  return /^(blocks|receipts)\/.+\.(json|bin)$/.test(name) || /^(patterns|records)\/.+-[0-9a-f]{64}\.json$/.test(name) || name === 'latest.json';
}
