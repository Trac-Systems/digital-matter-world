import { hashEl, h, clear, seg, clock, fmtInt, inspect, pill } from '../dom.js';
import { bus, stream, get, store, site } from '../api.js';
import { pagedTable } from '../paged.js';
import { describe, isMe, assetName } from '../words.js';

// The live view keeps only the newest WINDOW rows; older history is read page by page from the server.
const WINDOW = 200;
// Public game events only; Lab diagnostics live on the Lab page. Categories match the public feed.
const FILTERS = [['all', 'All'], ['chain', 'Chain'], ['money', 'Money'], ['you', 'You']].filter(([id]) => !site.public || id !== 'you');
const MONEY = /^(mint_request|mint_permit|mint_complete|transfer|link|payment|financial_.*)$/;
const KIND = { claim: ['Claim', ''], find: ['Find', 'good'], header_find: ['Header find', 'good'], craft: ['Craft', 'info'], mint_request: ['Mint', 'warn'], mint_permit: ['Mint permit', 'good'], mint_complete: ['Minted', 'minted'], link: ['Link', 'info'], transfer: ['Transfer', ''], block: ['Block', 'ink'], job: ['Lab', ''], player: ['You', 'info'], bot: ['Bot', ''], payment: ['Mint', 'good'], draw: ['Draw', 'info'], discovery: ['Discovery', 'good'], receipts: ['Gateway', ''], component: ['System', ''], error: ['Problem', 'bad'] };

// Finds one agent settled for one pattern in the same counted block collapse into one row.
const groupKey = e => e.type === 'find' ? JSON.stringify([e.data?.finder ?? e.data?.winner, e.data?.asset, e.data?.findHeight ?? e.at]) : null;
export function groupFinds(events) {
  const out = [];
  for (const e of events) {
    const key = groupKey(e), last = out.at(-1);
    if (key && last?.key === key) last.events.push(e); else out.push(key ? { key, events: [e] } : e);
  }
  return out;
}
export function groupText(g) {
  const blocks = g.events.map(e => Number(e.data?.block)).filter(Number.isFinite);
  const units = g.events.reduce((sum, e) => sum + (Number(e.data?.count ?? e.data?.amount) || 0), 0);
  return `won ${fmtInt(units)} ${assetName(g.events[0].data?.asset)} in ${fmtInt(g.events.length)} blocks (${fmtInt(Math.min(...blocks))} – ${fmtInt(Math.max(...blocks))})`;
}
export const inspectGroup = g => inspect(`${fmtInt(g.events.length)} finds`, g.events);

export function mount(root) {
  let filter = 'all', paused = false, mode = 'live', retained = null, history = null;
  const pendingCount = h('span');
  const rowsEl = h('tbody');
  const bar = h('div.row');
  const pauseBtn = h('button.btn.sm', { onclick: () => { paused = !paused; drawBar(); if (!paused) redraw(); } });
  const liveFoot = h('div.pager-foot');
  const livePanel = h('section.panel', {}, h('div.tablewrap.feed-window', {}, h('table.t', {},
      h('thead', {}, h('tr', {}, h('th', { style: { width: '92px' } }, 'Time'), h('th', { style: { width: '96px' } }, 'Kind'), h('th', { style: { width: '170px' } }, 'Who'), h('th', {}, 'What happened'), h('th.num', { style: { width: '90px' } }, 'Block'), h('th', { style: { width: '64px' } }, ''))),
      rowsEl)), liveFoot);
  const historyPanel = h('section.panel.hidden');
  root.append(h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'Live feed'), h('p', {}, 'Public game events from every agent, block by block: claims, finds, header finds, discoveries, crafts, mints, links and transfers.')), bar),
    livePanel, historyPanel));
  const query = () => filter === 'chain' || filter === 'money' ? `?category=${filter}` : filter === 'you' && store.status?.player?.address ? `?actor=${store.status.player.address}` : '';
  function showHistory() {
    history = pagedTable({
      path: () => `/feed${query()}`, key: 'events', limit: 50,
      group: rows => groupFinds(rows).map(r => r.events?.length === 1 ? r.events[0] : r),
      sorts: [['sequence:desc', 'Newest first'], ['sequence:asc', 'Oldest first']],
      empty: 'No retained events in this view.',
      columns: [
        { key: 'at', label: 'Time', render: r => h('span.mono.muted', {}, clock((r.events?.[0] ?? r).at)) },
        { key: 'kind', label: 'Kind', render: r => { const e = r.events?.[0] ?? r, [k, kind] = KIND[e.type] ?? [e.type, '']; return pill(k, kind); } },
        { key: 'who', label: 'Who', render: r => describe(r.events?.[0] ?? r).actor },
        { key: 'text', label: 'What happened', render: r => r.events ? groupText(r) : describe(r).text },
        { key: 'block', label: 'Block', num: true, render: r => { if (r.events) return ''; const b = describe(r).block; return b !== null && b !== undefined ? h('a.mono', { href: site.href('world', { b }) }, fmtInt(b)) : ''; } },
        { key: 'i', label: '', render: r => h('button.linkbtn', { onclick: () => r.events ? inspectGroup(r) : inspect(`Event ${r.sequence ?? ''}`, r) }, 'Inspect') },
      ],
    });
    clear(historyPanel, history.el);
  }
  async function countRetained() {
    try { const r = await get('/feed?limit=1'); retained = Number.isSafeInteger(r.total) ? r.total : null; } catch { retained = null; }
    drawLiveFoot();
  }
  // After a restart the public index backfills; say so rather than look out of date.
  function indexLag() {
    const p = store.status?.publicIndex;
    return typeof p?.caughtUp === 'boolean' ? h(`span.pill.${p.caughtUp ? 'good' : 'warn'}`, { 'data-tip': `Publications ${fmtInt(p.processedObservation)} / ${fmtInt(p.latestObservation)}; accepted batches ${fmtInt(p.processedBatch)} / ${fmtInt(p.latestBatch)}. Chain progress is separate.` },
      p.caughtUp ? `Index caught up · counted block ${fmtInt(p.indexedHeight)}` : `Index catching up · ${fmtInt(p.observationLag)} publications, ${fmtInt(p.batchLag)} batches behind`) : null;
  }
  function drawLiveFoot() {
    clear(liveFoot, h('span.small.muted', {}, `Newest ${fmtInt(rowsEl.querySelectorAll('tr.feed-row, tr.blockrow').length)} events${retained !== null ? ` · ${fmtInt(retained)} on the server` : ''}`), indexLag(),
      h('div.grow'), h('button.btn.sm.ghost', { onclick: () => setMode('history') }, 'Older events ›'));
  }
  function setMode(m) {
    mode = m;
    livePanel.classList.toggle('hidden', m !== 'live');
    historyPanel.classList.toggle('hidden', m !== 'history');
    if (m === 'history') showHistory(); else redraw();
    drawBar();
  }

  const match = e => {
    if (filter === 'all') return true;
    const d = e.data ?? {};
    if (filter === 'you') return [d.agent, d.owner, d.finder, d.winner, d.from, d.to, d.actor].some(isMe);
    if (filter === 'money') return MONEY.test(e.type);
    if (filter === 'chain') return !MONEY.test(e.type);
    return true;
  };
  let missed = 0;
  function row(e) {
    const { actor, text, block } = describe(e);
    const d = e.data ?? {}, address = d.actor ?? d.agent ?? d.owner ?? d.finder ?? d.winner ?? d.from ?? d.firstMaker ?? d.discoverer;
    const [k, kind] = KIND[e.type] ?? [e.type, ''];
    const failed = e.data?.state === 'failed' || e.type === 'error' || (e.type === 'bot' && !!e.data?.error);
    return h('tr.feed-row', {},
      h('td.mono.muted', {}, clock(e.at)),
      h('td', {}, pill(e.type === 'job' && failed ? 'Failed' : k, failed ? 'bad' : kind)),
      h('td', { class: actor === 'You' ? '' : 'mono small' }, address?.startsWith('trac1') ? hashEl(address, actor) : actor === 'You' ? h('strong', {}, 'You') : actor),
      h('td', { style: failed ? { color: 'var(--bad)' } : {} }, text),
      h('td.num', {}, block !== null && block !== undefined ? h('a.mono', { href: site.href('world', { b: block }) }, fmtInt(block)) : ''),
      h('td', {}, h('button.linkbtn', { onclick: () => inspect(`Event ${e.sequence ?? ''}`, e) }, 'Inspect')));
  }
  // A block event is the separator: everything above it happened after that block.
  function blockRow(e) {
    const { text, block } = describe(e);
    return h('tr.blockrow', {}, h('td.mono', {}, clock(e.at)), h('td', { colSpan: 3 }, text),
      h('td.num', {}, block !== null && block !== undefined ? h('a.mono', { href: site.href('world', { b: block }) }, fmtInt(block)) : ''),
      h('td', {}, h('button.linkbtn', { onclick: () => inspect(`Event ${e.sequence ?? ''}`, e) }, 'Inspect')));
  }
  function groupRow(g) {
    const tr = row(g.events[0]);
    tr._group = g;
    if (g.events.length === 1) return tr;
    tr.children[3].textContent = groupText(g);
    clear(tr.children[4]);
    clear(tr.children[5], h('button.linkbtn', { onclick: () => inspectGroup(g) }, 'Inspect'));
    return tr;
  }
  function add(e) {
    if (!match(e)) return;
    const key = groupKey(e), top = rowsEl.firstChild;
    if (key && top?._group?.key === key) { top._group.events.push(e); top.replaceWith(groupRow(top._group)); return; }
    rowsEl.prepend(e.type === 'block' ? blockRow(e) : key ? groupRow({ key, events: [e] }) : row(e));
    while (rowsEl.children.length > WINDOW) rowsEl.lastChild.remove();
  }
  function redraw() {
    clear(rowsEl); missed = 0;
    const list = stream.events.filter(match);
    for (const e of list) add(e);
    if (!rowsEl.children.length) rowsEl.append(h('tr', {}, h('td', { colSpan: 6 }, h('div.empty', {}, stream.state === 'live' ? (site.public ? 'Waiting for the next event.' : 'Waiting for the next event. Mine a block in the Lab to see one.') : 'Connecting to the live feed…'))));
    drawBar(); drawLiveFoot();
  }
  function drawBar() {
    clear(bar, seg([['live', 'Live'], ['history', 'History']], mode, setMode),
      seg(FILTERS, filter, f => { filter = f; if (mode === 'history') history.reset(); else redraw(); }),
      mode === 'live' ? pauseBtn : null, mode === 'live' && missed ? pendingCount : null);
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    pendingCount.textContent = missed ? `${missed} new` : '';
    pendingCount.className = 'small muted';
  }
  const off = bus.on('event', e => {
    if (paused) { if (match(e)) { missed++; drawBar(); } return; }
    if (rowsEl.querySelector('.empty')) clear(rowsEl);
    add(e);
    if (mode === 'live') drawLiveFoot();
  });
  const off2 = bus.on('event-stream', () => { if (!rowsEl.querySelector('tr.feed-row')) redraw(); });
  const off3 = bus.on('status', drawLiveFoot);
  redraw(); countRetained();
  return () => { off(); off2(); off3(); };
}
