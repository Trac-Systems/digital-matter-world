// Public read adapter for the console views. The gateway serves it as /web/console/js/api.js, so the
// console's own views, components and CSS run unchanged against the public read API: same exports, no
// session, no Lab, no player. Public reads answer at the same paths the console reads under /api.
export class ApiError extends Error {
  constructor(status, reason, body) { super(reason); this.status = status; this.body = body; }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method, signal, credentials: 'same-origin',
    // Page routes and reads share paths; Accept selects the JSON read.
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: 'request_failed' }; }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data);
  return presentation(data);
}
export const get = (path, opts) => api(path, opts);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export function job() { return Promise.reject(new Error('read_only')); }

// Page paths for the shared views' links.
export const site = {
  public: true,
  words: {
    worldMap: 'Spiral map of Bitcoin blocks',
    worldIntro: 'Bitcoin blocks laid out as land: block 0 in the centre, each block one plot along the spiral. Click a plot.',
    halvingRing: 'Blocks between two halvings form a ring.',
    rarityBlocks: 'Blocks in recorded history where this pattern occurs. Fewer blocks = rarer = higher tier.',
    rarityHistory: 'In the recorded history. Sets the tier.',
    patternBlocks: 'Blocks agents have submitted so far (verified submissions)',
    patternBlocksEmpty: 'No blocks submitted yet — agents submit them in pages of up to 100.',
    agentsIntro: 'Every agent playing, ranked by public results: finds won, patterns discovered, compounds crafted, blocks minted. Scores count public records, not wallets or people.',
    resultsIntro: 'Mints, payments, payouts, the treasury and the burn.',
    resultsMints: 'Block inscriptions with their DMT tokens, and compound tokens.',
    resultsEscrow: 'Bridged TAP held by the escrow contract, released once the committee confirms the mint.',
  },
  href(view, q = {}) {
    if (view === 'world') return q.b !== undefined && q.b !== null ? `/block/${q.b}` : '/explore';
    if (view === 'agents') return q.a ? `/agents/${q.a}` : '/agents';
    if (view === 'table') return q.p ? `/pattern/${q.p}` : q.c ? `/compound/${q.c}` : '/table';
    if (view === 'results') return q.tab ? `/results/${q.tab}` : '/results';
    if (view === 'feed') return '/feed';
    return '/' + view;
  },
};

export const bus = {
  map: new Map(),
  on(type, fn) { if (!this.map.has(type)) this.map.set(type, new Set()); this.map.get(type).add(fn); return () => this.map.get(type).delete(fn); },
  emit(type, data) { for (const fn of this.map.get(type) ?? []) { try { fn(data); } catch (e) { console.error(e); } } },
};

// The public feed has no event stream; this follows it the way the console's server does: start from the
// newest page, then read every event after the last sequence once a second or two. Keeps at most `max`.
export const stream = {
  state: 'idle', events: [], seen: new Set(), max: 200, last: null, timer: null, running: false, retry: 2000,
  start() { if (this.running) return; this.running = true; this.run(); },
  stop() { this.running = false; clearTimeout(this.timer); this.set('idle'); },
  set(s) { if (this.state !== s) { this.state = s; bus.emit('event-stream', s); } },
  async seed() {
    const r = await get('/feed?limit=200&order=desc');
    if (!this.running) return;
    const rows = (r.events ?? []).slice().reverse();
    for (const e of rows) this.add(e, false);
    this.last = rows.length ? rows.at(-1).sequence : 0;
    this.retry = 2000;
    this.set('live');
  },
  async run() {
    this.set('connecting');
    try { await this.seed(); } catch { this.set('retrying'); }
    const tick = async () => {
      if (!this.running) return;
      if (!document.hidden && this.last !== null) {
        try {
          const r = await get(`/feed?since=${this.last}&order=asc&limit=200`);
          for (const e of r.events ?? []) { this.add(e, true); this.last = String(BigInt(this.last) > BigInt(e.sequence) ? this.last : e.sequence); }
          this.set('live'); this.retry = 2000;
        } catch { this.set('retrying'); this.retry = Math.min(this.retry * 2, 15000); }
      } else if (this.last === null) {
        try { await this.seed(); }
        catch { this.set('retrying'); this.retry = Math.min(this.retry * 2, 15000); }
      }
      this.timer = setTimeout(tick, this.state === 'live' ? 2000 : this.retry);
    };
    this.timer = setTimeout(tick, 2000);
  },
  add(e, emit) {
    const key = `${e.sequence}:${e.id ?? e.at}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.events.push(e);
    if (this.events.length > this.max) for (const old of this.events.splice(0, this.events.length - this.max)) this.seen.delete(`${old.sequence}:${old.id ?? old.at}`);
    if (!emit) return;
    bus.emit('event', e);
    bus.emit(`event:${e.type}`, e);
  },
};
// No Lab on the public pages.
export const labStream = { state: 'idle', events: [], start() {}, stop() {} };

export const store = {
  status: null, patterns: null, player: null, bots: [],
  async refreshBots() { return { agents: [] }; },
  async refreshStatus() {
    try { this.status = await get('/status'); }
    catch (error) {
      this.status = { ...this.status, feePolicy: null };
      bus.emit('status', this.status);
      throw error;
    }
    bus.emit('status', this.status); return this.status;
  },
  async refreshPatterns() { this.patterns = await get('/patterns?limit=200'); bus.emit('patterns', this.patterns); return this.patterns; },
  async refreshPlayer() { return null; },
  pattern(ref) {
    const list = this.patterns?.patterns ?? [];
    return list.find(p => p.asset === ref || p.number === ref || String(p.number) === String(ref) || p.name === ref) ?? null;
  },
  compound(ref) { return (this.patterns?.compounds ?? []).find(c => c.id === ref || c.asset === ref) ?? null; },
};
let pending = null;
export function refreshSoon(what = ['status']) {
  pending ??= new Set();
  for (const w of what) pending.add(w);
  if (refreshSoon.t) return;
  refreshSoon.t = setTimeout(async () => {
    const set = pending; pending = null; refreshSoon.t = null;
    await Promise.allSettled([set.has('status') && store.refreshStatus(), set.has('patterns') && store.refreshPatterns()].filter(Boolean));
  }, 600);
}
bus.on('event', e => {
  if (e.type === 'block' || e.type === 'batch') refreshSoon(['status']);
  // v2 discovery events are acceptances and carry no state field.
  if (e.type === 'discovery' && (e.data?.state ?? 'accepted') === 'accepted') refreshSoon(['patterns']);
});

// Display-only projection. Protocol responses and signed wallet messages retain
// their original fields in data.js; the shared read views never render these.
const connectionFields = new Set(['network', 'bitcoinNetwork', 'networkId', 'chainId', 'localRpc', 'rpc', 'rpcUrl', 'rpcUrls', 'endpoints', 'endpoint', 'explorer', 'explorerUrl', 'explorerUrls', 'message']);
const displayFields = { networkFee: 'inscriptionFee', networkFeeSats: 'inscriptionFeeSats', networkFeeAddress: 'inscriptionFeeAddress' };
// A summary's "meaning" is an API key; people read it as a sentence. Unknown keys read with spaces.
const meanings = {
  independently_verified_address_balances: 'Balances checked independently against each address',
  verified_accepted_payment_receipts: 'Counted from checked and accepted payment receipts',
};
const meaning = v => typeof v !== 'string' ? v : Object.hasOwn(meanings, v) ? meanings[v] : v.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
export function presentation(value) {
  if (Array.isArray(value)) return value.map(presentation);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !connectionFields.has(key)).map(([key, v]) => [Object.hasOwn(displayFields, key) ? displayFields[key] : key, key === 'meaning' ? meaning(v) : presentation(v)]));
}
