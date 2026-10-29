import { h, clear, table, pill, hashEl, fmtInt, panel, figures, inspectBtn, clock, short, input } from '../dom.js';
import { get, bus, store, site } from '../api.js';
import { pagedTable } from '../paged.js';
import { mineral, assetName, title, isMe, describe, fieldName } from '../words.js';
import { tap } from '../money.js';
import { groupKey, groupFinds, groupText, inspectGroup } from './feed.js';

// What each bot strategy goes after, in plain words.
const HUNTS = { prospector: 'Claims finds across history and mints what it wins.', discoverer: 'Searches history for new pattern types and proposes them.', crafter: 'Combines pattern units into compounds.' };

// Public events identify participants in these fields (transfers affect both ends).
export function affectsAgent(event, address) {
  if (!address) return false;
  const d = event?.data ?? {};
  return [d.actor, d.agent, d.owner, d.address, d.finder, d.winner, d.discoverer, d.firstMaker, d.from, d.to, d.request?.owner].includes(address);
}

// One refresh after a burst, with at most one refresh in flight. No profile polling.
export function watchAgentEvents({ address, refreshProfile, refreshLeaderboard, events = bus, delay = 400 }) {
  let timer, running = false, stopped = false, profile = false, board = false;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, delay); };
  async function flush() {
    timer = null;
    if (stopped || running) return;
    const p = profile, b = board;
    profile = board = false;
    running = true;
    try { await Promise.allSettled([p && refreshProfile(), b && refreshLeaderboard()].filter(Boolean)); }
    finally { running = false; if (!stopped && (profile || board)) schedule(); }
  }
  const off = events.on('event', e => {
    profile ||= affectsAgent(e, address());
    board ||= /^(find|header_find|discovery|craft|transfer|mint(?:_.*)?)$/.test(e.type);
    if (profile || board) schedule();
  });
  return () => { stopped = true; clearTimeout(timer); off(); };
}

export function mount(root, params) {
  let selected = params.a ?? null, q = '';
  const board = h('div');
  const profile = h('div.stack');
  const search = input({ type: 'search', placeholder: 'Search trac1… address', 'aria-label': 'Search agents', style: { width: '220px', height: '30px' } });
  root.append(h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'Agents'),
      h('p', {}, (site.words?.agentsIntro ?? 'Every agent playing on this network, ranked by public results: finds won, patterns discovered, compounds crafted, blocks minted. Scores count public records, not wallets or people.')))),
    h('div.grid.cols-main', {}, board, profile)));

  const me = () => store.status?.player?.address ?? store.player?.address;
  const nameOf = key => {
    if (isMe(key)) return h('strong', {}, 'You');
    const bot = (store.bots ?? []).find(b => b.address === key);
    return bot ? h('span', {}, bot.name, h('span.muted.small', {}, ` · ${bot.strategy}`)) : hashEl(key);
  };
  const leaderboard = pagedTable({
    path: () => `/agents${q ? `?q=${encodeURIComponent(q)}` : ''}`, key: 'agents', limit: 20,
    sorts: [['finds:desc', 'Most finds'], ['discoveries:desc', 'Most discoveries'], ['crafts:desc', 'Most crafts'], ['mints:desc', 'Most mints'], ['address:asc', 'Address']],
    empty: 'No agent has public results yet.',
    render: (rows, { offset }) => table(rows.map((r, i) => ({ ...r, rank: offset + i + 1 })), [
      { key: 'rank', label: '#', num: true },
      { key: 'address', label: 'Agent', render: r => nameOf(r.address) },
      { key: 'finds', label: 'Finds', num: true, tip: 'Finds won in draws.' },
      { key: 'discoveries', label: 'Discoveries', num: true, tip: 'Pattern types accepted onto the periodic table.' },
      { key: 'crafts', label: 'Crafts', num: true },
      { key: 'mints', label: 'Mints', num: true, tip: 'Mints completed on Bitcoin.' },
    ], { sortable: false, onRow: r => pick(r.address), selected: r => r.address === selected || (!selected && isMe(r.address)) }),
  });
  let searchTimer;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { q = search.value.trim(); leaderboard.reset(); }, 300); });
  clear(board, panel('Leaderboard', leaderboard.el, { flush: true, actions: search }));

  function pick(key) {
    selected = key;
    history.replaceState(null, '', site.href('agents', { a: key }));
    leaderboard.reload();
    drawProfile();
  }

  let seq = 0, disposed = false, currentProfile = null;
  async function drawProfile() {
    if (disposed) return;
    currentProfile = null;
    const s = ++seq;
    const key = selected ?? me();
    if (!key) { clear(profile, panel('Agent', h('p.muted', { style: { margin: 0 } }, 'Pick an agent on the left.'))); return; }
    const mine = isMe(key);
    clear(profile, panel('Agent', h('div.empty', {}, 'Loading…')));
    let p;
    try { p = await get(`/agents/${key}?limit=1`); } catch (e) { if (s === seq) clear(profile, panel('Agent', h('div.note.bad', { role: 'alert' }, `This profile did not load (${e.message}). `, h('button.btn.sm', { onclick: drawProfile }, 'Retry')))); return; }
    if (s !== seq) return;
    const bot = (store.bots ?? []).find(b => b.address === key);
    const reloads = [];
    const track = list => { reloads.push(list.reload); return list.el; };
    const summary = h('div'), refreshError = h('div.note.bad', { hidden: true, role: 'alert' });
    function drawSummary(p) {
      const scores = p.scores ?? p;
      clear(summary, h('section.panel', {},
        h('header', {}, h('h2', {}, mine ? 'You' : bot ? bot.name : 'Agent'), bot ? pill(bot.strategy, 'info') : null, mine ? pill('your agent', 'ink') : null, h('div.grow'), inspectBtn('Agent profile', p)),
        h('div.body', {}, h('div.small.muted', { style: { marginBottom: '10px' } }, 'Trac address ', hashEl(key, short(key, 10, 6))),
          figures([['Finds', fmtInt(scores.finds ?? 0)], ['Discoveries', fmtInt(scores.discoveries ?? 0)], ['Crafts', fmtInt(scores.crafts ?? 0)], ['Mints', fmtInt(scores.mints ?? 0)]]),
          bot ? h('div', { style: { marginTop: '10px' } }, h('div.small', {}, h('strong', {}, 'Hunts: '), HUNTS[bot.strategy] ?? bot.strategy),
            bot.lastAction ? h('div.small.muted', {}, `Last action: ${String(bot.lastAction.action ?? '').replace(/[/_-]/g, ' ')} at block ${fmtInt(bot.lastAction.tip)}`) : null,
            bot.error ? h('div.small', { style: { color: 'var(--bad)' } }, `Stopped: ${bot.error}`) : null) : null)));
    }
    drawSummary(p);
    const sections = [refreshError, summary];
    if (mine) sections.push(huntingNow(key, track));
    sections.push(
      panel('Wallet balances', track(pagedTable({
        path: `/agents/${key}/balances?nonzero=true`, key: 'balances', limit: 10,
        sorts: [['asset:asc', 'Matter'], ['amount:desc', 'Most units']],
        empty: 'No spendable matter yet.',
        columns: [
          { key: 'asset', label: 'Matter', render: balanceName },
          { key: 'amount', label: 'Units on Trac', num: true },
        ],
      })), { flush: true, tip: 'Spendable pattern and compound units held by this agent on Trac.' }),
      panel('Discoveries', discoveries(key, mine, track), { flush: true, tip: 'Accepted and revealed pattern types. Sealed proposals stay hidden until they are revealed.' }),
      panel('Recent actions', track(pagedTable({
        path: `/agents/${key}/history`, key: 'history', limit: 50,
        // Same grouping as the feed: one row per finder, matter and settlement.
        group: rows => groupFinds(rows).map(r => r.events?.length === 1 ? r.events[0] : r),
        joins: (a, b) => !!groupKey(a) && groupKey(a) === groupKey(b),
        sorts: [['sequence:desc', 'Newest first'], ['sequence:asc', 'Oldest first']],
        filters: [{ name: 'category', label: 'Show', value: '', options: [['', 'All'], ['chain', 'Chain'], ['money', 'Money']] }],
        empty: 'No public actions yet.',
        columns: [
          { key: 'at', label: 'Time', render: r => { const e = r.events?.[0] ?? r; return h('span.mono.muted', {}, e.at ? clock(e.at) : '–'); } },
          { key: 'text', label: 'What happened', render: r => r.events ? groupText(r) : describe(r).text },
          { key: 'block', label: 'Block', num: true, render: r => { if (r.events) return ''; const b = describe(r).block; return b !== null && b !== undefined ? h('a.mono', { href: site.href('world', { b }) }, fmtInt(b)) : ''; } },
          { key: 'i', label: '', render: r => r.events ? h('button.linkbtn', { onclick: () => inspectGroup(r) }, 'Inspect') : inspectBtn('Event', r) },
        ],
      })), { flush: true }),
      panel('Compounds first made', track(pagedTable({
        path: `/compounds?firstMaker=${key}`, key: 'compounds', limit: 5, sorts: [['supply:desc', 'Most units'], ['name:asc', 'Name']],
        empty: 'None yet.',
        columns: [
          { key: 'id', label: 'Compound', render: c => h('span', {}, h('span.swatch', { style: { background: mineral(c.id) } }), assetName(c.id)) },
          { key: 'supply', label: 'Units on Trac', num: true },
          { key: 'madeReal', label: 'Made real', num: true },
        ],
      })), { flush: true, tip: 'The first maker earns 30 % of every mint fee for that compound type.' }),
      panel('Blocks made real', track(pagedTable({
        path: `/results/mints?owner=${key}&state=minted`, key: 'mints', limit: 5, sorts: [['block:desc', 'Block'], ['price:desc', 'Highest fee']],
        empty: 'Nothing minted yet.',
        columns: [
          { key: 'asset', label: 'Matter', render: r => h('span', {}, h('span.swatch', { style: { background: mineral(r.asset) } }), assetName(r.asset)) },
          { key: 'block', label: 'Block', num: true, render: r => r.block !== undefined && r.block !== null ? h('a.mono', { href: site.href('world', { b: r.block }) }, fmtInt(r.block)) : h('span.faint', {}, 'compound') },
          { key: 'amount', label: 'Tokens', num: true },
          { key: 'price', label: 'Paid', num: true, render: r => h('span.mono', {}, tap(r.price, r.unit)) },
          { key: 'inscription', label: 'Inscription', render: r => r.inscription ? h('span', {}, h('span.pill.minted', { style: { marginRight: '6px' } }, 'on-chain'), hashEl(r.inscription)) : h('span.faint', {}, '–') },
        ],
      })), { flush: true }));
    if (site.public) sections.push(panel('Payout wallets', track(payoutWallets(key)), { flush: true, tip: 'Wallets this agent bound for its payouts. Replacements apply to future quotes.' }));
    clear(profile, ...sections);
    currentProfile = { key, async reload() {
      const summaryRead = get(`/agents/${key}?limit=1`).then(next => {
        if (s !== seq) return;
        drawSummary(next); refreshError.hidden = true;
      }, e => {
        if (s !== seq) return;
        clear(refreshError, `This profile could not refresh (${e.message}). `, h('button.btn.sm', { onclick: refreshProfile }, 'Retry'));
        refreshError.hidden = false;
      });
      await Promise.allSettled([summaryRead, ...reloads.map(load => load())]);
    } };
  }

  function refreshProfile() {
    if (disposed) return;
    return currentProfile?.key === (selected ?? me()) ? currentProfile.reload() : drawProfile();
  }

  // Resolve only the visible page's missing names, never download the whole catalog.
  const names = new Map();
  function balanceName({ asset }) {
    const text = h('span', {}, assetName(asset));
    if (!store.pattern(asset) && !store.compound(asset)) {
      const kind = /^p\d+$/.test(asset) ? 'patterns' : 'compounds';
      if (!names.has(asset)) names.set(asset, get(`/${kind}?asset=${encodeURIComponent(asset)}&limit=1`).then(r => {
        const row = r[kind]?.[0];
        return row?.name ? (kind === 'patterns' ? title(row.name) : row.name.replace(/\bdmw([a-z0-9]+)/g, (_, n) => title(n))) : asset;
      }).catch(() => { names.delete(asset); return asset; }));
      names.get(asset).then(name => { if (!disposed) text.textContent = name; });
    }
    return h('span', {}, h('span.swatch', { style: { background: mineral(asset) } }), text);
  }

  // Public discoveries; another agent's sealed proposals appear only as a count and the block they open at.
  function discoveries(key, mine, track) {
    const sealedLine = h('div.body.small.muted');
    const loadSealed = () => get(`/agents/${key}/discoveries?state=sealed&limit=1&sort=opensAt&order=asc`).then(r => {
      const rows = r.discoveries ?? [], n = r.total ?? rows.length;
      clear(sealedLine, n ? `${fmtInt(n)} sealed discover${n === 1 ? 'y' : 'ies'}, ${n === 1 ? 'opens' : 'next opens'} at block ${fmtInt(rows[0]?.opensAt)}${mine ? ' (contents under Hunting now)' : ''}` : 'No sealed discoveries.');
    }).catch(() => clear(sealedLine, ''));
    loadSealed(); track({ el: sealedLine, reload: loadSealed });
    const list = pagedTable({
      path: `/agents/${key}/discoveries?state=accepted`, key: 'discoveries', limit: 5, sorts: [['name:asc', 'Name']],
      empty: 'No accepted discoveries yet.',
      columns: [
        { key: 'name', label: 'Pattern', render: d => h('a', { href: site.href('table', { p: d.asset }) }, h('span.swatch', { style: { background: mineral(d.asset) } }), title(d.name)) },
        { key: 'pat', label: 'Rule', render: d => h('code', {}, d.pat) },
        { key: 'fld', label: 'Field', render: d => h('span.small', {}, fieldName(d)) },
        { key: 'tier', label: 'Tier', num: true },
      ],
    });
    return h('div', {}, sealedLine, track(list));
  }

  // Bound payout wallet per rail, from the public binding records.
  function payoutWallets(key) {
    const box = h('div', {}, h('div.empty', {}, 'Loading…'));
    async function load() {
      const rows = await Promise.all(['tap', 'ethereum'].map(rail => get(`/payout-bindings/${key}/${rail}`)
        .then(r => ({ rail, binding: r.binding }), () => ({ rail, error: true }))));
      clear(box,
        rows.some(r => r.error) ? h('div.note.bad', { role: 'alert' }, 'Some payout wallets could not be loaded. ',
          h('button.btn.sm', { onclick: e => { e.currentTarget.disabled = true; load(); } }, 'Retry')) : null,
        table(rows, [
          { key: 'rail', label: 'Paid with', render: r => r.rail === 'ethereum' ? 'Bridged TAP' : 'TAP' },
          { key: 'address', label: 'Wallet', render: r => r.error ? h('span.muted', {}, 'Unavailable') : r.binding ? hashEl(r.binding.request?.address) : h('span.faint', {}, 'none bound') },
          { key: 'acceptedAt', label: 'Bound', render: r => r.binding?.acceptedAt ? h('span.mono.muted', {}, new Date(r.binding.acceptedAt).toLocaleString()) : '' },
          { key: 'i', label: '', render: r => r.binding ? inspectBtn('Payout binding', r.binding) : '' },
        ], { sortable: false }));
    }
    load();
    return { el: box, reload: load };
  }

  // Your own open hunts: recent claims with the block whose hash draws them, and your sealed proposals.
  function huntingNow(key, track) {
    const counted = () => store.status?.counted ?? 0;
    const claims = pagedTable({
      path: `/agents/${key}/history?type=claim`, key: 'history', limit: 5, sorts: [['sequence:desc', 'Newest first']],
      empty: 'No claims yet. Claim historical matches from My player.',
      columns: [
        { key: 'block', label: 'Block', num: true, render: e => h('a.mono', { href: site.href('world', { b: e.data?.block }) }, fmtInt(e.data?.block)) },
        { key: 'patterns', label: 'Patterns', render: e => (e.data?.patterns ?? []).slice(0, 4).map(x => assetName(store.pattern(x)?.asset ?? x)).join(', ') || '–' },
        { key: 'draw', label: 'Drawn by block', num: true, tip: 'The first block after the round closes decides its draw. Check the public result for credited finds.', render: e => e.data?.window !== undefined ? h('span.mono', {}, fmtInt(e.data.window + 2)) : '–' },
        { key: 'state', label: 'State', render: e => e.data?.window === undefined ? '–' : counted() >= e.data.window + 2 ? pill('Check result', '') : pill('Waiting for the draw', 'warn') },
      ],
    });
    const sealed = pagedTable({
      path: '/player/discoveries?state=committed', key: 'discoveries', limit: 5, sorts: [['revealFrom:asc', 'Opens first']],
      empty: 'No sealed proposals.',
      columns: [
        { key: 'name', label: 'Pattern', render: d => title(d.name) },
        { key: 'pat', label: 'Rule', render: d => h('code', {}, d.pat) },
        { key: 'when', label: 'Reveal window', render: d => d.revealFrom ? h('span.mono', {}, `${fmtInt(d.revealFrom)}–${fmtInt(d.revealUntil)}`) : '–' },
      ],
    });
    return h('section.panel', {}, h('header', {}, h('h2', {}, 'Hunting now'), pill('only you see this', 'ink')),
      h('div.section-label', {}, 'Your recent claims'), track(claims),
      h('div.section-label', {}, 'Your sealed discoveries'), track(sealed));
  }

  drawProfile();
  if (!store.bots) store.refreshBots().then(() => { if (!disposed) { leaderboard.reload(); drawProfile(); } }).catch(() => {});
  const stopRefresh = watchAgentEvents({ address: () => selected ?? me(), refreshProfile, refreshLeaderboard: leaderboard.reload });
  const cleanup = () => { disposed = true; seq++; clearTimeout(searchTimer); stopRefresh(); };
  cleanup.update = p => { if (p.a && p.a !== selected) pick(p.a); };
  return cleanup;
}
