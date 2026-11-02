import { parentPort, workerData } from 'node:worker_threads';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createHTTPHandler } from './http.mjs';
import { PublicReadStore } from './public-read-store.mjs';
import { publicReadSettings } from './public-read-settings.mjs';
import { configurePublicIdentities } from './public-identities.mjs';
import { createPublicAPI } from './public-api.mjs';
import { Files } from './files.mjs';
import { History } from './history.mjs';
import { HeaderFiles } from './header-files.mjs';
import { BulkMints } from './bulk-mints.mjs';
import { FinancialActions } from './financial-actions.mjs';
import { Bindings } from './bindings.mjs';
import { createWeb } from './web.mjs';
import { rankingHighlights } from './public-rankings.mjs';

const settings = publicReadSettings(workerData.settings);
configurePublicIdentities(settings);
const store = new PublicReadStore(workerData.directory, { ...settings, ...workerData.storeSettings });
const files = new Files(workerData.filesDirectory), mints = {}, views = { store, mints };
// Expose only store-backed bulk methods, without constructing payment or
// sender services. The original methods preserve signed packet wire bytes.
const bulkMints = workerData.bulkReads ? { store, ...Object.fromEntries(
  ['row', 'page', 'terms', 'members'].map(name => [name, BulkMints.prototype[name]])) } : undefined;
const handler = createHTTPHandler({ intake: { store }, files, bulkMints,
  financialActions: workerData.financialActions ? new FinancialActions({ store }) : undefined, manageResponseBudget: false, readBudget: { enabled: false },
  publicAPI: workerData.api ? createPublicAPI({ views, files, settings: workerData.apiSettings }) : undefined,
  bindings: workerData.bindingsOptions ? new Bindings({ store, ...workerData.bindingsOptions, bindingCacheEntries: settings.bindingCacheEntries }) : undefined,
  headers: workerData.headerOptions ? new HeaderFiles({ history: new History(store), files, ...workerData.headerOptions, readOnly: true }) : undefined,
  web: createWeb(workerData.checkout ? { records: () => rankingHighlights(store), bulkMints } : undefined),
  operator: workerData.operator ? {} : undefined,
});

// Stores without public projections have no pending table.
let pendingQuery;
const projectionPending = () => {
  try { pendingQuery ??= store.db.prepare('SELECT 1 FROM projectionPending LIMIT 1'); } catch { return false; }
  return !!pendingQuery.get();
};

class Response extends Writable {
  constructor(port, method) {
    super({ highWaterMark: settings.streamChunkBytes });
    Object.assign(this, { port, method, statusCode: 200, headersSent: false, headers: {} });
    port.on('message', () => { const ack = this.ack; this.ack = null; ack?.(); });
  }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; return this; }
  writeHead(code, headers) { this.statusCode = code; for (const [k, v] of Object.entries(headers ?? {})) this.setHeader(k, v); this.sendHeaders(true); return this; }
  sendHeaders(explicit = false) {
    if (!this.headersSent) { this.headersSent = true; this.port.postMessage({ type: 'headers', status: this.statusCode, headers: this.headers, explicit }); }
  }
  end(chunk, encoding, callback) {
    // ServerResponse.end(bytes) supplies Content-Length automatically. Preserve
    // that header even though the bridge transports the body in smaller chunks.
    if (this.method !== 'HEAD' && !this.headersSent && chunk != null && typeof chunk !== 'function' && this.statusCode !== 304 && !('content-length' in this.headers))
      this.setHeader('Content-Length', Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined));
    return super.end(chunk, encoding, callback);
  }
  _write(chunk, encoding, done) {
    this.sendHeaders();
    if (this.method === 'HEAD' || this.statusCode === 304) { done(); return; }
    let offset = 0;
    const send = () => {
      if (offset === chunk.length) { done(); return; }
      const bytes = new Uint8Array(chunk.subarray(offset, offset + settings.streamChunkBytes)); offset += bytes.length;
      this.ack = send; this.port.postMessage({ type: 'chunk', bytes }, [bytes.buffer]);
    };
    send();
  }
  _final(done) { this.sendHeaders(); this.port.postMessage({ type: 'end' }); done(); }
  _destroy(error, done) { if (error || !this.writableFinished) this.port.postMessage({ type: 'destroy' }); done(error); }
}
parentPort.on('message', async ({ request, context, port }) => {
  const res = new Response(port, request.method), complete = finished(res);
  complete.catch(() => {}); // Observe early stream failures while the handler is still unwinding.
  // One request per worker: all reads/cache revision checks see one WAL snapshot.
  // Release it before waiting for socket backpressure on an immutable file.
  mints.document = context.document;
  try {
    // Wait out a batch's short projection window instead of answering
    // public_projection_pending; a stuck projection still answers after the bound.
    for (const until = Date.now() + settings.pendingWaitMs; projectionPending() && Date.now() < until;)
      await new Promise(resolve => setTimeout(resolve, settings.pendingPollMs));
    store.db.exec('BEGIN');
    try { await handler({ ...request, socket: { remoteAddress: '127.0.0.1' } }, res); }
    finally { store.db.exec('ROLLBACK'); }
    await complete;
    port.postMessage({ type: 'done' });
  } catch {
    // Only fixed public errors cross the thread boundary, never paths or secrets.
    res.destroy(); port.postMessage({ type: 'failed' });
  } finally { port.close(); }
});
parentPort.postMessage({ type: 'ready' });
