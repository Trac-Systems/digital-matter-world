// Short-lived 503s while the gateway catches up after a batch; reads retry them.
const PASSING = new Set(['public_projection_pending', 'request_pending', 'read_not_ready', 'read_snapshot_changed', 'service_busy']);
export async function api(path, body, signal) {
  for (let attempt = 0; ; attempt++) {
    try { return await apiOnce(path, body, signal); }
    catch (error) {
      if (body !== undefined || error.status !== 503 || !PASSING.has(error.message) || attempt >= 5 || signal?.aborted) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
async function apiOnce(path, body, signal) {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', signal, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json();
  if (!r.ok) throw Object.assign(Error(/^[a-z][a-z0-9_]{0,80}$/.test(value.error) ? value.error : 'request_failed'), { status: r.status });
  return value;
}
export const enc = encodeURIComponent;
// The console's cursor contract: one current page, opaque cursors, reset on any
// filter/order change, and discard stale replies. Never concatenate pages.
export class Pager {
  constructor(path, key, { limit = 25, fetcher = api, params = {} } = {}) {
    Object.assign(this, { path, key, limit, fetcher, params }); this.cursors = [null]; this.at = 0; this.sequence = 0;
  }
  reset(params = this.params) { this.params = params; this.cursors = [null]; this.at = 0; this.sequence++; }
  async load() {
    const sequence = ++this.sequence, u = new URL(this.path, 'http://localhost');
    for (const [k, v] of Object.entries(this.params)) if (v !== '') u.searchParams.set(k, v);
    u.searchParams.set('limit', String(this.limit));
    if (this.cursors[this.at]) u.searchParams.set('cursor', this.cursors[this.at]);
    const source = u.pathname + u.search, value = await this.fetcher(source);
    if (sequence !== this.sequence) return null;
    const rows = value[this.key] ?? value.items;
    if (!Array.isArray(rows) || rows.length > this.limit || value.total !== null && !Number.isSafeInteger(value.total)) throw Error('invalid_page');
    this.cursors[this.at + 1] = value.next ?? value.nextCursor ?? null; this.cursors.length = this.at + 2;
    return { ...value, rows, source };
  }
}
export const resultKinds = ['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links'];
export const catalogColumns = ['asset', 'number', 'name', 'tier', 'rarity', 'supply', 'madeReal', 'minted', 'discoverer'];
export function route(path) {
  const p = path.replace(/\/$/, '') || '/';
  let m;
  if ((m = /^\/mint\/([pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*))$/.exec(p))) return { kind: 'money', type: 'mint', id: m[1] };
  if ((m = /^\/(mint|link|bind-payout)(?:\/([0-9a-f]{64}))?$/.exec(p))) return { kind: 'money', type: m[1], id: m[2] };
  if ((m = /^\/(?:block|plot)\/(\d+)$/.exec(p))) return { kind: 'block', height: Number(m[1]) };
  if ((m = /^\/(pattern|compound)\/([a-z0-9]{1,24}|[pc]2:[0-9a-f]+)$/.exec(p))) return { kind: m[1], asset: m[2] };
  if ((m = /^\/agents\/(trac1[a-z0-9]+)$/.exec(p))) return { kind: 'agent', address: m[1] };
  if ((m = /^\/records\/batches\/(\d+)$/.exec(p))) return { kind: 'batch', n: m[1] };
  if ((m = /^\/events\/(\d+)$/.exec(p))) return { kind: 'event', n: m[1] };
  if (p === '/' || p === '/explore' || p === '/blocks') return { kind: 'home' };
  if (['/table', '/patterns', '/compounds'].includes(p)) return { kind: 'table' };
  if (p === '/agents') return { kind: 'agents' };
  if (p === '/feed') return { kind: 'feed' };
  if (p === '/records') return { kind: 'records' };
  if ((m = /^\/results(?:\/([a-z]+))?$/.exec(p))) return { kind: 'results', collection: m[1] };
  return { kind: 'missing' };
}
