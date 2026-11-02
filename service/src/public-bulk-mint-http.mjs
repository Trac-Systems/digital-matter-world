import { check } from './util.mjs';
import { publicMintClientIP } from './public-mint-admission.mjs';

export async function handlePublicBulkMintHTTP(req, res, readBody, bulk) {
  const url = new URL(req.url, 'http://localhost'), path = url.pathname.replace(/^\/web-api\//, '/');
  if (!path.startsWith('/public-mints/bulk/')) return false;
  check(bulk, 'public_bulk_unavailable', 503);
  check(!url.search, 'public_bulk_query');
  const secret = req.headers['x-mint-requester-secret'];
  let result;
  if (req.method === 'POST') {
    check(!req.headers.origin || req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`, 'origin_not_allowed', 403);
    check(req.headers['sec-fetch-site'] !== 'cross-site', 'origin_not_allowed', 403);
    let input;
    try { input = JSON.parse(await readBody(req, bulk.resources.publicBulkInputBytes)); }
    catch (error) { if (error instanceof SyntaxError) check(false, 'public_bulk_json'); throw error; }
    if (path === '/public-mints/bulk/quote') result = await bulk.quote(input);
    else if (path === '/public-mints/bulk/start') result = await bulk.start(input, { requesterSecret: secret, clientIP: publicMintClientIP(req) });
    else {
      const match = /^\/public-mints\/bulk\/([0-9a-f]{64})\/(payment|inscriptions)$/.exec(path);
      check(match, 'not_found', 404); result = await bulk[match[2]](match[1], input, secret);
    }
  } else {
    check(['GET', 'HEAD'].includes(req.method), 'method_not_allowed', 405);
    if (path === '/public-mints/bulk/limits') result = { blocks: bulk.resources.publicBulkMintBlocks };
    else {
      const match = /^\/public-mints\/bulk\/([0-9a-f]{64})$/.exec(path);
      check(match, 'not_found', 404); result = bulk.status(match[1], secret);
    }
  }
  const bytes = JSON.stringify(result);
  check(Buffer.byteLength(bytes) <= bulk.resources.publicBulkResponseBytes, 'public_bulk_response_bytes', 413);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'X-Mint-Requester-Secret');
  res.end(req.method === 'HEAD' ? undefined : bytes);
  return true;
}
