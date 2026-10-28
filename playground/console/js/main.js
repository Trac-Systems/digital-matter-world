import { h, clear, installTooltips, fmtInt, short, pill, hashEl, logo } from './dom.js';
import { get, bus, stream, labStream, store } from './api.js';
import { tap, feePolicyTip } from './money.js';

const ROUTES = {
  world: { label: 'World', load: () => import('./views/world.js') },
  about: { label: 'About', load: () => import('./views/about.js') },
  table: { label: 'Periodic table', short: 'Table', load: () => import('./views/table.js') },
  player: { label: 'My player', short: 'Player', load: () => import('./views/player.js') },
  agents: { label: 'Agents', load: () => import('./views/agents.js') },
  feed: { label: 'Live feed', short: 'Feed', load: () => import('./views/feed.js') },
  results: { label: 'Results', load: () => import('./views/results.js') },
  lab: { label: 'Lab', load: () => import('./views/lab.js'), lab: true },
};
const app = document.getElementById('app');
let cleanup = null, current = null, mainEl, navEl, stripEl, connEl;
let routeSequence = 0;

installTooltips();
let booted = false;
bus.on('unauthorized', () => { if (booted) { booted = false; stream.stop(); labStream.stop(); gate(true); } });
start();

async function start() {
  try { await get('/status'); boot(); } catch { gate(false); }
}

// Without a session cookie the console can only explain how to get one.
function gate(expired) {
  routeSequence++;
  cleanup?.(); cleanup = null; current = null;
  document.body.classList.remove('in-lab');
  clear(app, h('div.gate', {},
    h('div.brand', { style: { marginBottom: '18px', fontSize: '24px' } }, logo(), 'Digital Matter World'),
    h('section.panel', {}, h('header', {}, h('h2', {}, expired ? 'Please open a new login link' : 'Open the link printed by the playground')),
      h('div.body', {},
        h('p', { style: { margin: 0 } }, expired
          ? 'This browser was signed out, for example because the playground was wiped and restarted.'
          : 'When the playground starts, it prints one login link. Open that link in this browser and the console opens by itself.'),
        h('p.muted', { style: { margin: 0 } }, 'To print the link again, run this in the digital-matter-world folder:'),
        h('code', { style: { display: 'block', padding: '8px 10px' } }, 'node playground/run.mjs link'),
        h('div.row', {}, h('button.btn', { onclick: () => location.reload() }, 'I opened it, try again'))))));
}

async function boot() {
  if (booted) return;
  booted = true;
  navEl = h('nav.nav', { 'aria-label': 'Sections' });
  connEl = h('div.conn', {}, h('span.dot'), h('span.label', {}, 'Connecting'));
  stripEl = h('div.strip', { 'aria-label': 'Chain status' });
  mainEl = h('main', { id: 'main' });
  for (const [id, r] of Object.entries(ROUTES)) {
    if (r.lab) navEl.append(h('span.sep'));
    navEl.append(h(`a${r.lab ? '.lab' : ''}`, { href: `#/${id}`, 'data-route': id }, h('span.hide-phone', {}, r.label), h('span', { class: 'show-phone', style: { display: 'none' } }, r.short ?? r.label)));
  }
  clear(app, h('div.app', {},
    h('header.topbar', {}, h('div.brand', {}, logo(), h('span.name', {}, 'Digital Matter World'), h('span.sub', {}, 'Local playground')), navEl, h('div.spacer'), connEl),
    stripEl, mainEl));
  phoneLabels();
  stream.start(); labStream.start();
  bus.on('event-stream', drawConn); drawConn(stream.state);
  bus.on('status', drawStrip);
  const ready = Promise.allSettled([store.refreshStatus(), store.refreshPatterns(), store.refreshPlayer(), store.refreshBots()]);
  if (location.hash.split('?')[0] !== '#/about') await ready;
  addEventListener('hashchange', route);
  route();
  setInterval(() => store.refreshStatus().catch(() => {}), 15000);
}
function phoneLabels() {
  const mq = matchMedia('(max-width: 640px)');
  const apply = () => { for (const a of navEl.querySelectorAll('a')) { a.children[0].style.display = mq.matches ? 'none' : ''; a.children[1].style.display = mq.matches ? '' : 'none'; } };
  mq.addEventListener('change', apply); apply();
}
function drawConn(s) {
  const map = { live: ['good', 'Live'], connecting: ['warn', 'Connecting'], retrying: ['warn', 'Reconnecting'], error: ['bad', 'Disconnected'], idle: ['', 'Offline'] };
  const [k, l] = map[s] ?? map.idle;
  clear(connEl, h(`span.dot${k ? '.' + k : ''}`), h('span.label', {}, `Live feed: ${l}`));
  connEl.setAttribute('data-tip', 'Events stream from the playground as they happen. Reconnects by itself.');
}
function drawStrip(s) {
  if (!s) return;
  const bad = (s.components ?? []).filter(c => !['ready', 'running', 'ok', 'up', 'healthy'].includes(String(c.state).toLowerCase()));
  const cell = (k, v, tip) => h('div.cell', tip ? { 'data-tip': tip } : {}, h('div.k', {}, k), h('div.v', {}, v));
  clear(stripEl,
    cell('Tip', fmtInt(s.tip), 'Newest block on the local Bitcoin regtest chain.'),
    cell('Counted', fmtInt(s.counted), 'Blocks the Trac contract has counted. Finder windows and refunds run on counted blocks.'),
    cell('Batch', s.batch ? `#${fmtInt(s.batch.n)} → ${fmtInt(s.batch.to)}` : '–', 'Last committee batch applied on Trac and the counted block it covers.'),
    cell('Mining', s.mining?.enabled ? `every ${secs(s.mining.intervalMs)}` : 'paused', 'Automatic block making. Change it in the Lab.'),
    cell('Base price', tap(s.feePolicy?.baseFee, s.feePolicy?.unit), feePolicyTip(s.feePolicy)),
    cell('Bots', s.bots ? `${fmtInt(s.bots.count)}${s.bots.paused ? ' · paused' : ` · every ${secs(s.bots.intervalMs)}`}` : '–', 'Bot agents playing alongside you.'),
    cell('Components', bad.length ? h('span', { style: { color: 'var(--bad)' } }, `${bad.length} not ready`) : `${(s.components ?? []).length} ready`, bad.length ? bad.map(c => `${c.name}: ${c.state}`).join('\n') : 'Every local service is answering.'),
    cell('You', s.player?.address ? hashEl(s.player.address, short(s.player.address, 6, 4)) : '–', 'Your player key on the local Trac network.'));
}
export const secs = ms => !ms ? '–' : ms < 60000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms / 6000) / 10} min`;

// While the stack starts (or restarts), show its components and retry by itself.
let waitTimer = null;
function waiting() {
  if (waitTimer) return;
  routeSequence++;
  cleanup?.(); cleanup = null; current = null;
  const box = h('div');
  clear(mainEl, h('div.page', {}, h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'The playground is starting'),
    h('p', {}, 'The local networks are coming up. This page continues by itself when everything is ready.'))), box));
  const tick = async () => {
    let s = null;
    try { s = await store.refreshStatus(); } catch { /* still starting */ }
    if (s?.state === 'ready') { waitTimer = null; await Promise.allSettled([store.refreshPatterns(), store.refreshPlayer()]); route(); return; }
    const comps = s?.components ?? [];
    clear(box, h('section.panel', {}, h('header', {}, h('h2', {}, `State: ${s?.state ?? 'not answering'}`)),
      comps.length ? h('div.flush', {}, h('div.tablewrap', {}, h('table.t', {}, h('tbody', {}, comps.map(c => h('tr', {}, h('td', {}, c.name), h('td', {}, pill(c.state, /ready/i.test(c.state) ? 'good' : 'warn')))))))) : h('div.empty', {}, 'Waiting for the control API…')));
    waitTimer = setTimeout(tick, 3000);
  };
  waitTimer = setTimeout(tick, 0);
}
bus.on('not-ready', () => { if (mainEl) waiting(); });
bus.on('status', s => { if (mainEl && s && s.state !== 'ready') waiting(); });

async function route() {
  if (store.status && store.status.state !== 'ready') { waiting(); return; }
  if (waitTimer) return;
  const sequence = ++routeSequence;
  const [path, query] = (location.hash.replace(/^#\/?/, '') || 'world').split('?');
  const id = ROUTES[path] ? path : 'world';
  const params = Object.fromEntries(new URLSearchParams(query ?? ''));
  for (const a of navEl.querySelectorAll('a')) a.classList.toggle('on', a.dataset.route === id);
  document.body.classList.toggle('in-lab', id === 'lab');
  if (current === id && typeof cleanup?.update === 'function') { cleanup.update(params); return; }
  cleanup?.(); cleanup = null; current = id;
  clear(mainEl, h('div.page', {}, h('div.empty', {}, 'Loading…')));
  try {
    const mod = await ROUTES[id].load();
    if (sequence !== routeSequence) return;
    clear(mainEl);
    const mounted = mod.mount(mainEl, params);
    cleanup = typeof mounted === 'function' ? mounted : null;
  } catch (e) {
    if (sequence !== routeSequence) return;
    console.error(e);
    clear(mainEl, h('div.page', {}, h('div.note.bad', {}, `This screen failed to load: ${e.message}`)));
  }
}
export function go(path) { location.hash = `#/${path}`; }
