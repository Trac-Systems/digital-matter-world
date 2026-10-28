import { DatabaseSync } from 'node:sqlite';
import { heightKey, check } from './util.mjs';
import { rules } from './rules.mjs';

// A public-only read handle to the gateway's already verified canonical chain.
// Opening it never starts a source client, catch-up job or seed rebuild.
export class LocalHeaders {
  constructor(filename) {
    this.db = new DatabaseSync(filename, { readOnly: true }); this.verifiedLocal = true;
    this.query = this.db.prepare('SELECT value FROM records WHERE space=? AND id=?');
  }
  get(space, id) { const r = this.query.get(space, id); return r ? JSON.parse(r.value) : null; }
  tip() { const height = this.get('meta', 'headerHeight'); check(height != null, 'header_history_unavailable', 503); rules.decimalV2(height); return { height, hash: this.blockHash(height) }; }
  blockHash(height) { const tip = this.get('meta', 'headerHeight'); check(tip != null && rules.compareUint(rules.decimalV2(height), rules.decimalV2(tip)) <= 0, 'header_missing', 404); const row = this.get('headers', heightKey(height)); check(row, 'header_missing', 404); return row.hash; }
  header(hash) { const row = this.get('headerObjects', hash); check(row && rules.parseHeader(row.raw).hash === hash, 'header_missing', 404); return row.raw; }
  snapshot(fn) { this.db.exec('BEGIN'); try { return fn(); } finally { this.db.exec('ROLLBACK'); } }
  close() { this.db.close(); }
}
export function localHeaderHandler(headers, { pageRows = 10, cacheSeconds = 5 } = {}) {
  check(headers?.verifiedLocal === true && Number.isSafeInteger(pageRows) && pageRows > 0 && Number.isSafeInteger(cacheSeconds) && cacheSeconds >= 0, 'verified_local_headers_required');
  return (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      const result = headers.snapshot(() => {
        let match;
        const ordinal = value => {
          rules.uintV2(value); if (typeof headers.tip().height === 'string') return value;
          const n = Number(value); check(Number.isSafeInteger(n), 'header_missing', 404); return n;
        };
        if (req.url === '/api/blocks/tip/height') return headers.tip().height;
        if ((match = /^\/api\/block-height\/(0|[1-9][0-9]*)$/.exec(req.url))) return headers.blockHash(ordinal(match[1]));
        if ((match = /^\/api\/block\/([0-9a-f]{64})\/header$/.exec(req.url))) return headers.header(match[1]);
        if ((match = /^\/api\/blocks\/(0|[1-9][0-9]*)$/.exec(req.url))) {
          let h = BigInt(match[1]); const decimal = typeof headers.tip().height === 'string';
          const rows = []; for (; h >= 0n && rows.length < pageRows; h--) {
            const id = headers.blockHash(ordinal(String(h))), header = rules.parseHeader(headers.header(id)); rows.push({ id, height: decimal ? String(h) : Number(h), timestamp: header.time });
          }
          return rows;
        }
        throw Object.assign(Error('not_found'), { status: 404 });
      });
      const json = Array.isArray(result), bytes = Buffer.from(json ? JSON.stringify(result) : String(result)), etag = '"' + rules.hash(bytes) + '"';
      res.setHeader('Content-Type', json ? 'application/json' : 'text/plain'); res.setHeader('Cache-Control', `public, max-age=${cacheSeconds}, must-revalidate`);
      res.setHeader('ETag', etag); res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
      res.setHeader('Content-Length', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) { res.writeHead(error.status ?? 503).end('Verified headers unavailable'); }
  };
}
