// Editor's Picks: hand-written pattern cards from the picks file, each with what can be done with it right now.
import { h, clear, pill, figures, kv, tierBadge } from './console/js/dom.js';
import { get, store, site } from './console/js/api.js';
import { agentLink, blockLink, mineral, assetName } from './console/js/words.js';
import { PICKS_URL, NOW_PILLS, readPicks, pickNow } from './picks-data.js';

// A card reads its live state once, when it first comes into view; at most two block reads run at once
// (token reads share the site's own queue and cache).
const BLOCK_READS = 2, queue = [];
let reading = 0;
async function slot(read) {
  while (reading >= BLOCK_READS) await new Promise(resolve => queue.push(resolve));
  reading++;
  try { return await read(); } finally { reading--; queue.shift()?.(); }
}

export function mount(root) {
  let stopped = false;
  const observers = [], intro = h('p', {}, 'Patterns worth making real on Bitcoin, picked by hand: what each one is good for, and what you can do with it right now.');
  const list = h('div.grid.cols-2.picks'), updated = h('p.small.faint', { hidden: true }), stats = h('div.picks-stats', { hidden: true }), tierNote = h('p.small.muted.picks-note', { hidden: true });
  root.append(h('div.page.picks-page', {}, h('div.page-head', {}, h('div.grow', {}, h('h1', {}, "Editor's Picks"), intro, updated)), stats, tierNote, list));
  clear(list, h('div.empty', {}, 'Loading…'));
  fetch(PICKS_URL, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(r => { if (!r.ok) throw Error('picks_unavailable'); return r.json(); })
    .then(raw => {
      if (stopped) return;
      const doc = readPicks(raw);
      if (doc.intro) intro.textContent = doc.intro;
      if (doc.updated) { updated.textContent = 'Updated ' + new Date(doc.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); updated.hidden = false; }
      // The editor's figures over all of Bitcoin's history, in the site's figure tiles.
      if (doc.stats.length) { clear(stats, figures(doc.stats.map(f => [f.label, f.value])), doc.statsNote ? h('p.small.faint', {}, doc.statsNote) : null); stats.hidden = false; }
      if (doc.tierNote) { tierNote.textContent = doc.tierNote; tierNote.hidden = false; }
      if (!doc.picks.length) { clear(list, h('div.empty.span-all', {}, 'No picks yet. Check back soon.')); return; }
      clear(list, ...doc.picks.map(pick => card(pick, observe, doc.tierNote)));
    })
    .catch(() => { if (!stopped) clear(list, h('div.note.bad.span-all', {}, 'The picks did not load. Reload the page to try again.')); });
  function observe(el, load) {
    if (typeof IntersectionObserver !== 'function') { load(); return; }
    const seen = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { seen.disconnect(); if (!stopped) load(); } }, { rootMargin: '200px 0px' });
    seen.observe(el); observers.push(seen);
  }
  return () => { stopped = true; for (const o of observers) o.disconnect(); };
}

// One pick: its best utility first, then why, its points and facts, what is possible now, and its links.
export function card(pick, observe = (el, load) => load(), tierNote = '') {
  // The catalog in memory is its first page; the token read tells whether a pattern exists at all.
  const pattern = pick.asset ? store.pattern(pick.asset) : null;
  const now = h('div.pick-now', { hidden: true }), links = h('div.pick-links');
  const el = h('section.panel.pick', { 'data-kind': pick.kind },
    h('header', {}, h('h2', {}, pick.emoji ? h('span.emoji', { 'aria-hidden': 'true' }, pick.emoji) : h('span.swatch', { style: { background: mineral(pick.asset ?? pick.name) } }), h('span', {}, pick.title)),
      h('div.grow'), pick.kind === 'meme' ? pill('Meme pick', 'info') : null, pick.tier ? h('span.tier', { 'data-tip': tierNote || `Rarity tier ${pick.tier} of 5. Higher tiers are rarer.` }, `T${pick.tier}`) : pattern?.tier ? tierBadge(pattern.tier) : null),
    h('div.body', {},
      pick.utility ? h('div.pick-use', {}, h('div.k', {}, 'Best utility'), h('div.v', {}, pick.utility)) : null,
      pick.tagline ? h('p.muted', {}, pick.tagline) : null,
      pick.why ? h('p', {}, pick.why) : null,
      pick.points.length ? h('ul.pick-points', {}, pick.points.map(p => h('li', {}, p.lead ? h('strong', {}, p.lead) : null, p.lead && p.text ? ' ' : null, p.text))) : null,
      pick.facts.length ? figures(pick.facts.map(f => [f.label, f.value])) : null,
      now, links));
  const drawLinks = (exists, discoverer) => {
    clear(links, exists ? h('a', { href: site.href('table', { p: pick.asset }) }, 'Pattern page') : null,
      exists && discoverer ? h('span', {}, 'Discovered by ', agentLink(discoverer)) : null,
      pick.blocks.length ? h('span', {}, pick.blocks.length === 1 ? 'Block ' : 'Blocks ', join(pick.blocks.map(b => blockLink(b)))) : null,
      pick.related.length ? h('span', {}, 'Related ', join(pick.related.map(r => h('a', { href: site.href('table', { p: r.asset }) }, r.name || assetName(r.asset))))) : null);
    links.hidden = !links.firstChild;
  };
  drawLinks(!!pattern, pattern?.discoverer);
  if (pick.asset) observe(el, () => live(pick, now, drawLinks, pattern));
  return el;
}
const join = items => items.flatMap((item, i) => i ? [', ', item] : [item]);

// The live part: token, then the first highlighted block. A failed read leaves its line out; with no line, no live part.
// A pattern the gateway does not know gets no links and no further read.
async function live(pick, el, drawLinks, pattern) {
  const block = pick.blocks[0];
  let failed = false;
  const token = await site.token(pick.asset).catch(() => { failed = true; return null; });
  if (!el.isConnected) return;
  drawLinks(!!token || failed, pattern?.discoverer ?? token?.discoverer);
  if (!token && !failed) return;
  const state = block === undefined ? null : await slot(() => get(`/public-mints/${encodeURIComponent(pick.asset)}/${block}`)).catch(() => null);
  const now = pickNow(pick, { token, block: state, tip: store.status?.counted });
  const line = (kind, part, ...actions) => [part.state ? h('span.row', { style: { gap: '8px' } }, pill(...NOW_PILLS[kind][part.state])) : null, h('span', {}, part.text), actions.length ? h('span.row', {}, ...actions.filter(Boolean)) : null];
  const button = (href, label, kind = '') => h(`a.btn.sm${kind ? '.' + kind : ''}`, { href }, label);
  const rows = [
    now.token ? ['Token', h('div.pick-line', {}, ...line('token', now.token, now.token.href ? button(now.token.href, now.token.who === 'anyone' ? 'Create the token' : 'Token page', now.token.who === 'anyone' ? 'primary' : '') : null))] : null,
    now.mint ? ['Mint', h('div.pick-line', {}, ...line('mint', now.mint, now.mint.state === 'public' ? button(now.mint.href, `Mint block ${Number(block).toLocaleString('en-US')}`, 'primary') : null,
      button(now.mintAll, 'All public blocks', now.mint.state === 'public' ? 'ghost' : '')))] : null,
    now.claim ? ['With an agent', h('div.pick-line', {}, h('span', {}, now.claim.text), h('span.row', {}, button(now.claim.href, 'Claim with an agent', 'ghost')))] : null,
  ].filter(Boolean);
  if (!rows.length || !el.isConnected) return;
  clear(el, h('div.k', {}, 'Right now'), kv(rows));
  el.hidden = false;
}
