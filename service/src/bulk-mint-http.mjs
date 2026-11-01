import { check } from './util.mjs';

// Bulk packets keep their own caps and wire identities. In particular, never
// run signed packets through the legacy public address conversion.
export async function handleBulkMintHTTP(req, res, readBody, bulk) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/web-api\//, '/');
  const internal = path.startsWith('/internal/mint-sender/bulk');
  if (!path.startsWith('/mint/bulk/') && !internal) return false;
  check(bulk, 'bulk_unavailable', 503);
  const { BULK_LIMITS: limits } = await import('../../rules/src/bulk-mint.js');
  const read = async cap => {
    try { return JSON.parse(await readBody(req, cap)); }
    catch (error) { if (error instanceof SyntaxError) check(false, 'bulk_json'); throw error; }
  };
  const query = keys => {
    const names = [...url.searchParams.keys()];
    check(names.every(k => keys.includes(k)) && new Set(names).size === names.length, 'bulk_page');
  };
  const integer = (key, fallback) => {
    const value = url.searchParams.get(key);
    check(value === null || /^(0|[1-9][0-9]{0,9})$/.test(value), 'bulk_page');
    return value === null ? fallback : Number(value);
  };
  let result, status = 200;
  if (internal) {
    check(bulk.senderView?.authorized(req.headers.authorization), 'not_found', 404);
    check(req.method === 'GET', 'not_found', 404);
    const match = /^\/internal\/mint-sender\/bulk(?:\/([0-9a-f]{64}))?$/.exec(path);
    check(match, 'not_found', 404);
    query(match[1] ? [] : ['after', 'limit']);
    result = match[1] ? await bulk.senderItem(match[1]) : await bulk.senderPage({
      after: url.searchParams.get('after') ?? '', limit: integer('limit', 50) });
  } else if (req.method === 'POST' && !req.url.startsWith('/web-api/')) {
    query([]);
    const method = path.slice('/mint/bulk/'.length);
    check(['quote', 'request', 'payment', 'finish'].includes(method), 'not_found', 404);
    const input = await read(method === 'quote' ? limits.quoteInputBytes : limits.requestBytes);
    const old = method === 'request' && input?.terms ? await bulk.existingRequest?.(input) : null;
    const complete = method === 'finish' ? await bulk.finishedReport?.(input) : false;
    result = await bulk[method](input);
    status = method === 'quote' || old || complete ? 200 : 202;
  } else {
    check(['GET', 'HEAD'].includes(req.method), 'not_found', 404);
    const match = /^\/mint\/bulk\/([0-9a-f]{64})(?:\/(terms|members|permit))?$/.exec(path);
    check(match, 'not_found', 404);
    const method = match[2] ?? 'status';
    query(['members', 'permit'].includes(method) ? ['offset', 'limit'] : []);
    const page = { offset: integer('offset', 0), limit: integer('limit', method === 'permit' ? limits.permitPage : limits.members) };
    result = await bulk[method](match[1], page);
  }
  const bytes = JSON.stringify(result);
  check(Buffer.byteLength(bytes) <= limits.permitBytes, 'bulk_response_bytes', 413);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  res.end(req.method === 'HEAD' ? undefined : bytes); return true;
}
