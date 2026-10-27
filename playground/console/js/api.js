// The login link printed by the playground sets an HttpOnly session cookie; the page never sees a token.
export class ApiError extends Error {
  constructor(status, reason, body) { super(reason); this.status = status; this.body = body; }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method, signal,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) {
    if (res.status === 401) bus.emit('unauthorized');
    if (data?.error === 'playground_not_ready') bus.emit('not-ready');
    throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data);
  }
  return data;
}
export const get = (path, opts) => api(path, opts);
// Shared views link through `site`: hash routes here; the public pages map the same views to their page paths.
export const site = { public: false, href: (view, q) => `#/${view}${q ? `?${new URLSearchParams(q)}` : ''}` };
export const post = (path, body = {}) => api(path, { method: 'POST', body });

// Event bus shared by views.
export const bus = {
  map: new Map(),
  on(type, fn) { if (!this.map.has(type)) this.map.set(type, new Set()); this.map.get(type).add(fn); return () => this.map.get(type).delete(fn); },
  emit(type, data) { for (const fn of this.map.get(type) ?? []) { try { fn(data); } catch (e) { console.error(e); } } },
};

// Jobs: resolved from SSE job events, with polling as a fallback.
const waiting = new Map();
bus.on('lab', e => {
  if (e.type !== 'job' || !e.data?.id) return;
  const w = waiting.get(e.data.id);
  if (w) w.update(e.data);
});
export function job(promise, { onUpdate } = {}) {
  return promise.then(started => new Promise((resolve, reject) => {
    if (!started?.id) { resolve(started); return; }
    let finished = false, timer;
    const update = j => {
      if (finished) return;
      onUpdate?.(j);
      if (j.state === 'complete' || j.state === 'failed') {
        finished = true; waiting.delete(started.id); clearTimeout(timer);
        bus.emit('job-done', j);
        j.state === 'complete' ? resolve(j) : reject(Object.assign(new Error(j.error ?? 'failed'), { job: j }));
      }
    };
    waiting.set(started.id, { update });
    update(started);
    const poll = async delay => {
      timer = setTimeout(async () => {
        if (finished) return;
        try { update(await get(`/jobs/${started.id}`)); } catch { /* the next poll retries */ }
        if (!finished) poll(Math.min(delay * 1.5, 5000));
      }, delay);
    };
    poll(1200);
  }));
}

// SSE over fetch. Each stream starts from the newest page of its feed, then follows the stream after that
// sequence; it keeps at most `max` events. Public game events go to `event`/`event:TYPE`, Lab diagnostics to
// `lab`/`lab:TYPE`.
function makeStream({ path, feed, topic }) {
  return {
    state: 'idle', events: [], seen: new Set(), max: 200, ctrl: null, retry: 1000, last: null,
    start() {
      if (this.ctrl) return;
      this.ctrl = new AbortController();
      this.run(this.ctrl.signal);
    },
    stop() { this.ctrl?.abort(); this.ctrl = null; this.set('idle'); },
    set(s) { this.state = s; bus.emit(`${topic}-stream`, s); },
    async seed() {
      try {
        const r = await get(`${feed}?limit=200`);
        const rows = (r.events ?? []).slice().reverse();
        for (const e of rows) this.add(e, false);
        if (rows.length) this.last = String(rows.at(-1).sequence);
      } catch { /* new events still arrive */ }
    },
    async run(signal) {
      // If the newest page cannot be read, the stream still starts with new events only.
      await this.seed();
      while (!signal.aborted) {
        try {
          this.set('connecting');
          const res = await fetch(path, { signal, credentials: 'same-origin', headers: { Accept: 'text/event-stream', ...(this.last ? { 'Last-Event-ID': this.last } : {}) } });
          if (res.status === 401) { bus.emit('unauthorized'); this.set('error'); return; }
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          this.set('live'); this.retry = 1000;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            let i;
            while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
              const chunk = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
              this.parse(chunk);
            }
          }
          throw new Error('stream closed');
        } catch (e) {
          if (signal.aborted) return;
          this.set('retrying');
          await new Promise(r => setTimeout(r, this.retry));
          this.retry = Math.min(this.retry * 2, 15000);
        }
      }
    },
    parse(chunk) {
      let id = null, data = '';
      for (const line of chunk.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const c = line.indexOf(':'), field = c === -1 ? line : line.slice(0, c), value = c === -1 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'id') id = value; else if (field === 'data') data += (data ? '\n' : '') + value;
      }
      if (!data) return;
      let e; try { e = JSON.parse(data); } catch { return; }
      if (id) this.last = id;
      this.add(e, true);
    },
    add(e, emit) {
      const key = `${e.sequence}:${e.id ?? e.at}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.events.push(e);
      if (this.events.length > this.max) for (const old of this.events.splice(0, this.events.length - this.max)) this.seen.delete(`${old.sequence}:${old.id ?? old.at}`);
      if (!emit) return;
      bus.emit(topic, e);
      bus.emit(`${topic}:${e.type}`, e);
    },
  };
}
export const stream = makeStream({ path: '/api/events', feed: '/feed', topic: 'event' });
export const labStream = makeStream({ path: '/api/lab/events', feed: '/lab/feed', topic: 'lab' });

// Small shared cache refreshed on block and job events.
export const store = {
  status: null, patterns: null, player: null, bots: null,
  async refreshBots() { const b = await get('/bots'); this.bots = b.agents ?? []; bus.emit('bots', b); return b; },
  // Public status (tip, fees, units) merged with the Lab status (mining, bots, components, player).
  async refreshStatus() {
    const [pub, lab] = await Promise.allSettled([get('/status'), get('/lab/status')]);
    if (pub.status === 'rejected' && lab.status === 'rejected') throw pub.reason;
    const p = pub.status === 'fulfilled' ? pub.value : {}, l = lab.status === 'fulfilled' ? lab.value : {};
    this.status = { ...l, ...p, mining: l.mining ?? p.mining, bots: l.bots ?? p.bots, components: l.components ?? p.components, player: l.player ?? p.player, state: l.state ?? p.state, units: p.units ?? l.units };
    bus.emit('status', this.status); return this.status;
  },
  async refreshPatterns() { this.patterns = await get('/patterns?limit=200'); bus.emit('patterns', this.patterns); return this.patterns; },
  async refreshPlayer() { this.player = await get('/player'); bus.emit('player', this.player); return this.player; },
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
  // Throttle, not debounce: a long burst of events still refreshes every ~0.6 s.
  if (refreshSoon.t) return;
  refreshSoon.t = setTimeout(async () => {
    const set = pending; pending = null; refreshSoon.t = null;
    await Promise.allSettled([
      set.has('status') && store.refreshStatus(),
      set.has('patterns') && store.refreshPatterns(),
      set.has('player') && store.refreshPlayer(),
    ].filter(Boolean));
  }, 600);
}
bus.on('event', e => {
  if (e.type === 'block') refreshSoon(['status', 'player']);
  if (/^(find|mint_complete|mint_request|mint_permit|craft|transfer|link|discovery)$/.test(e.type)) refreshSoon(['player']);
  if (e.type === 'discovery' && e.data?.state === 'accepted') refreshSoon(['patterns']);
});
bus.on('lab', e => {
  if (e.type === 'component' || e.type === 'block') refreshSoon(['status']);
  if (e.type === 'player' || e.type === 'payment') refreshSoon(['player']);
  if (e.type === 'job' && (e.data?.state === 'complete' || e.data?.state === 'failed')) refreshSoon(['status', 'player', 'patterns']);
});
