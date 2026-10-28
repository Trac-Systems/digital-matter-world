// Public pages: the playground console's shell, views and components over the public read API.
// The views, CSS and components are the console's own files; only ./console/js/api.js and flows.js are
// the public stand-ins (see service/src/web.mjs).
import { h, clear, installTooltips, fmtInt, logo, inspect, panel, table, autoColumns, labelFor } from './console/js/dom.js';
import { get, bus, stream, store } from './console/js/api.js';
import { tap, feePolicyTip } from './console/js/money.js';
import { pagedTable } from './console/js/paged.js';
import { route } from './data.js';
import { moneyPage } from './money.js';
import { walletControl } from './connect.js';

const VIEWS = {
  about: { label: 'About', href: '/about', load: () => import('./console/js/views/about.js') },
  world: { label: 'World', href: '/explore', load: () => import('./console/js/views/world.js') },
  table: { label: 'Periodic table', short: 'Table', href: '/table', load: () => import('./console/js/views/table.js') },
  agents: { label: 'Agents', href: '/agents', load: () => import('./console/js/views/agents.js') },
  feed: { label: 'Live feed', short: 'Feed', href: '/feed', load: () => import('./console/js/views/feed.js') },
  results: { label: 'Results', href: '/results', load: () => import('./console/js/views/results.js') },
  records: { label: 'Records', href: '/records', load: () => import('./records.js') },
  money: { label: 'Mint On-Chain', short: 'Mint', href: '/mint', sep: true, load: async () => ({ mount: (root, page) => moneyPage(root, page, navigate) }) },
};
const app = document.getElementById('app');
let cleanup = null, current = null, mainEl, navEl, stripEl, connEl;
let routeSequence = 0;

installTooltips();
boot();

// Each page address names one view and what it shows.
function resolve(path) {
  if (path.replace(/\/$/, '') === '/about') return { id: 'about', params: {} };
  const page = route(path);
  switch (page.kind) {
    case 'home': return { id: 'world', params: {} };
    case 'block': return { id: 'world', params: { b: page.height } };
    case 'table': return { id: 'table', params: {}, anchor: path.replace(/\/$/, '') === '/compounds' ? 'compounds' : null };
    case 'pattern': return { id: 'table', params: { p: page.asset } };
    case 'compound': return { id: 'table', params: { c: page.asset } };
    case 'agents': return { id: 'agents', params: {} };
    case 'agent': return { id: 'agents', params: { a: page.address } };
    case 'feed': return { id: 'feed', params: {} };
    case 'event': return { id: 'feed', params: { e: page.n } };
    case 'results': return { id: 'results', params: { tab: page.collection } };
    case 'records': return { id: 'records', params: {} };
    case 'batch': return { id: 'records', params: { batch: page.n } };
    case 'money': return { id: 'money', params: page };
    default: return { id: null, params: {} };
  }
}

async function boot() {
  navEl = h('nav.nav', { 'aria-label': 'Sections' });
  connEl = h('div.conn', {}, h('span.dot'), h('span.label', {}, 'Connecting'));
  stripEl = h('div.strip', { 'aria-label': 'World status' });
  mainEl = h('main', { id: 'main' });
  for (const [id, r] of Object.entries(VIEWS)) {
    if (r.sep) navEl.append(h('span.sep'));
    navEl.append(h('a', { href: r.href, 'data-route': id }, h('span.hide-phone', {}, r.label), h('span', { class: 'show-phone', style: { display: 'none' } }, r.short ?? r.label)));
  }
  clear(app, h('div.app', {},
    h('header.topbar', {}, h('a.brand', { href: '/', style: { textDecoration: 'none' } }, logo(), h('span.name', {}, 'Digital Matter World')), navEl, h('div.spacer'), connEl, walletControl()),
    stripEl, mainEl));
  phoneLabels();
  bus.on('event-stream', drawConn); drawConn(stream.state);
  bus.on('status', drawStrip);
  stream.start();
  const ready = Promise.allSettled([store.refreshStatus(), store.refreshPatterns()]);
  // About can show its current-price placeholders while the live reads load.
  if (resolve(pageAddress(new URL(location.href)).pathname).id !== 'about') await ready;
  document.addEventListener('click', follow);
  addEventListener('popstate', show);
  addEventListener('hashchange', show);
  show();
  setInterval(() => { if (!document.hidden) store.refreshStatus().catch(() => {}); }, 15000);
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
  connEl.setAttribute('data-tip', 'Public events appear here as they are published. Reconnects by itself.');
}
function drawStrip(s) {
  if (!s) return;
  const cell = (k, v, tip) => h('div.cell', tip ? { 'data-tip': tip } : {}, h('div.k', {}, k), h('div.v', {}, v));
  clear(stripEl,
    cell('Tip', fmtInt(s.tip), 'Newest Bitcoin block the gateway has seen.'),
    cell('Counted', fmtInt(s.counted), 'Blocks the Trac contract has counted. Finder windows and refunds run on counted blocks.'),
    cell('Batch', s.batch ? `#${fmtInt(s.batch.n)} → ${fmtInt(s.batch.to)}` : '–', 'Last committee batch applied on Trac and the counted block it covers.'),
    cell('Base price', tap(s.feePolicy?.baseFee, s.feePolicy?.unit), feePolicyTip(s.feePolicy)));
}

// Links between pages stay in this page: the address changes and the matching view opens.
function follow(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.('a[href]');
  if (!a || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || !resolve(pageAddress(url).pathname).id) return;
  e.preventDefault();
  navigate(url.pathname + url.search + url.hash);
}
function navigate(path) {
  if (new URL(path, location.href).href !== location.href) history.pushState(null, '', path);
  show();
}

// Shared console links name views in the fragment; public links also have paths.
function pageAddress(url) { return url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url; }
async function show() {
  const sequence = ++routeSequence;
  const address = pageAddress(new URL(location.href));
  const { id, params, anchor } = resolve(address.pathname);
  const q = new URLSearchParams(address.search);
  for (const a of navEl.querySelectorAll('a')) a.classList.toggle('on', a.dataset.route === id);
  if (id && id !== 'money' && current === id && typeof cleanup?.update === 'function' && !anchor) { cleanup.update(params); afterMount(id, params); return; }
  cleanup?.(); cleanup = null; current = id;
  scrollTo(0, 0);
  if (!id) { clear(mainEl, h('div.page', {}, h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: '/' }, 'Open the World map')))))); document.title = 'Digital Matter World'; return; }
  document.title = `${VIEWS[id].label} · Digital Matter World`;
  clear(mainEl, h('div.page', {}, h('div.empty', {}, 'Loading…')));
  try {
    if (id === 'world' && q.has('collection')) { cleanup = collection(q.get('collection'), q.get('key') ?? 'items'); return; }
    const mod = await VIEWS[id].load();
    if (sequence !== routeSequence) return;
    clear(mainEl);
    const mounted = mod.mount(mainEl, params);
    cleanup = typeof mounted === 'function' ? mounted : null;
    if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }));
    afterMount(id, params);
  } catch (e) {
    if (sequence !== routeSequence) return;
    console.error(e);
    clear(mainEl, h('div.page', {}, h('div.note.bad', {}, `This screen failed to load: ${e.message}`)));
  }
}
// An event address opens the live feed with that event in the Inspect drawer.
async function afterMount(id, params) {
  if (id !== 'feed' || params.e === undefined) return;
  try { inspect(`Event ${params.e}`, await get(`/events/${params.e}`)); }
  catch (e) { inspect(`Event ${params.e}`, { error: e.message }); }
}
// Any public collection, one server page at a time (the address names its read route).
function collection(path, key) {
  if (!/^\/(?:list\?|patterns|compounds|blocks|agents|events|results|records|receipts|finds|feed)/.test(path) || path.includes('..')) {
    clear(mainEl, h('div.page', {}, h('div.note.bad', {}, 'This collection is not a public list.'))); return null;
  }
  const labels = { inscriptionFee: 'Bitcoin inscription fee', inscriptionFeeSats: 'Bitcoin inscription fee (sats)', inscriptionFeeAddress: 'Bitcoin inscription fee address' };
  const list = pagedTable({ path, key, limit: 25, render: rows => table(rows, [...autoColumns(rows).map(c => ({ ...c, label: Object.hasOwn(labels, c.key) ? labels[c.key] : c.label })), { key: '_i', label: '', render: r => h('button.linkbtn', { onclick: () => inspect(key, r) }, 'Inspect') }], { sortable: false }) });
  clear(mainEl, h('div.page', {}, h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'Public collection'), h('p.mono', {}, path))), panel(labelFor(key), list.el, { flush: true })));
  return null;
}
