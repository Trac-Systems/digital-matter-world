// Public read adapter for the console views. The gateway serves it as /web/console/js/api.js, so the
// console's own views, components and CSS run unchanged against the public read API: same exports, no
// session, no Lab, no player. Public reads answer at the same paths the console reads under /api.
export class ApiError extends Error {
  constructor(status, reason, body) { super(reason); this.status = status; this.body = body; }
}

// Short-lived 503s while the gateway catches up after a batch; reads retry them.
const PASSING = new Set(['public_projection_pending', 'request_pending', 'read_not_ready', 'read_snapshot_changed', 'service_busy']);
export async function api(path, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await apiOnce(path, options); }
    catch (error) {
      if ((options.method ?? 'GET') !== 'GET' || error.status !== 503 || !PASSING.has(error.message) || attempt >= 5 || options.signal?.aborted) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
async function apiOnce(path, { method = 'GET', body, signal, wire = false } = {}) {
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
  return wire ? data : presentation(data);
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
    game: { label: 'Play the game on Playbay', href: 'https://playbay.games/games/b37d6395-50bd-4a6c-bf8f-f2f7124010a0' },
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
  // A pattern's or compound's token on Bitcoin: { step: 'deployed' | 'confirming' | 'inflight' | 'inscribed' | 'none', label, kind, inflight,
  // tick (the deployed ticker, which can differ from the name), chosen (a compound's ticker chosen before deploy), deployer (who may deploy until when) }, or null when
  // the gateway does not know the asset. Read-only; pages ask only for what is on screen.
  token(asset) {
    if (!/^(?:[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/.test(asset ?? '')) return Promise.resolve(null);
    const hit = tokens.get(asset);
    if (hit && Date.now() - hit.at < TOKEN_MS) return hit.value;
    const value = slot(() => get('/mint/deployment-state/' + asset)).then(tokenStep, error => {
      if (error.message === 'asset_unknown' || error.message === 'deployment_asset') return null;
      tokens.delete(asset); throw error;
    });
    tokens.delete(asset); tokens.set(asset, { at: Date.now(), value });
    for (const old of tokens.keys()) { if (tokens.size <= TOKEN_KEEP) break; tokens.delete(old); }
    return value;
  },
  // The deployment page: inscribe the pattern, deploy its token, then mint. `owner` fills in the agent.
  deployHref: (asset, owner) => '/mint/' + asset + (/^trac1[a-z0-9]+$/.test(owner ?? '') ? '?' + new URLSearchParams({ owner }) : ''),
};
// Answers are kept a minute (at most 200 patterns) and at most four reads run at once.
const TOKEN_MS = 60000, TOKEN_KEEP = 200, TOKEN_READS = 4, tokens = new Map(), queue = [];
let reading = 0;
async function slot(read) {
  while (reading >= TOKEN_READS) await new Promise(resolve => queue.push(resolve));
  reading++;
  try { return await read(); } finally { reading--; queue.shift()?.(); }
}
// 'inflight': a wallet-sent inscription the gateway saw on Bitcoin (words.js INFLIGHT_TEXT).
const TOKEN_STEPS = { deployed: ['Token deployed', 'minted'], confirming: ['Token being confirmed', 'info'], inflight: ['Inscription sent — waiting for Bitcoin confirmation', 'info'], inscribed: ['Pattern inscribed — deploy token next', 'info'], none: ['Token not deployed', 'warn'] };
const JOB_STATES = new Set(['not_started', 'queued', 'awaiting_ticker', 'awaiting_player_deploy', 'inscribed', 'deploying', 'confirming']);
function tokenStep(job) {
  const step = job?.state === 'registered' ? 'deployed' : !JOB_STATES.has(job?.state) ? null
    : job.state === 'confirming' && job.entry ? 'confirming' : job.inflight ? 'inflight' : job.elementId ? 'inscribed' : 'none';
  return step && { step, label: TOKEN_STEPS[step][0], kind: TOKEN_STEPS[step][1], tick: step === 'deployed' ? job.entry?.tick ?? null : null,
    ...(step === 'inflight' ? { inflight: job.inflight } : {}),
    // A compound's ticker chosen by its first maker, before it is deployed (null: not chosen yet).
    ...(job.kind === 'compound' && step !== 'deployed' ? { chosen: job.chosenTicker?.tick ?? null } : {}),
    deployer: step === 'deployed' ? null : job.deployer ?? null };
}

export const bus = {
  map: new Map(),
  on(type, fn) { if (!this.map.has(type)) this.map.set(type, new Set()); this.map.get(type).add(fn); return () => this.map.get(type).delete(fn); },
  emit(type, data) { for (const fn of this.map.get(type) ?? []) { try { fn(data); } catch (e) { console.error(e); } } },
};

// The public feed has no event stream; this follows it the way the console's server does: start from the
// newest page, then read every event after the last sequence once a second or two. Keeps at most `max`.
export const stream = {
  state: 'idle', events: [], seen: new Set(), max: 2000, rows: 100, last: null, timer: null, running: false, retry: 2000,
  start() { if (this.running) return; this.running = true; this.run(); },
  stop() { this.running = false; clearTimeout(this.timer); this.set('idle'); },
  set(s) { if (this.state !== s) { this.state = s; bus.emit('event-stream', s); } },
  async seed() {
    // The server caps a page well below `max`. Follow its cursor until the feed shows `rows` rows:
    // a settled batch of finds is one row on the page however many events it holds.
    const got = [], key = e => e.type === 'find' ? JSON.stringify([e.data?.finder ?? e.data?.winner, e.data?.asset, e.data?.findHeight ?? e.at]) : null;
    const rows = () => got.filter((e, i) => !key(e) || key(e) !== key(got[i - 1] ?? {})).length;
    for (let r = null; got.length < this.max && rows() < this.rows && (!r || r.next);) {
      r = await get(`/feed?limit=200&order=desc${r?.next ? `&cursor=${encodeURIComponent(r.next)}` : ''}`);
      if (!this.running) return;
      got.push(...(r.events ?? []));
    }
    const seeded = got.slice(0, this.max).reverse();
    for (const e of seeded) this.add(e, false);
    this.last = seeded.length ? seeded.at(-1).sequence : 0;
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
    return list.find(p => p.asset === ref || p.legacy?.asset === ref || p.number === ref || String(p.number) === String(ref) || p.name === ref) ?? null;
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

// Bulk commitments are wire objects: presentation renaming must never touch them.
const bulkId = id => { if (!/^[0-9a-f]{64}$/.test(id ?? '')) throw Error('invalid_bulk_order'); return id; };
export const bulkApi = {
  status: id => api('/web-api/mint/bulk/' + bulkId(id), { wire: true }),
  terms: id => api('/web-api/mint/bulk/' + bulkId(id) + '/terms', { wire: true }),
  members: (id, { offset = 0, limit = 64 } = {}) => api('/mint/bulk/' + bulkId(id) + '/members?' + new URLSearchParams({ offset, limit }), { wire: true }),
  permit: (id, { offset = 0, limit = 16 } = {}) => api('/mint/bulk/' + bulkId(id) + '/permit?' + new URLSearchParams({ offset, limit }), { wire: true }),
  payment: report => api('/mint/bulk/payment', { method: 'POST', body: report, wire: true })
};
