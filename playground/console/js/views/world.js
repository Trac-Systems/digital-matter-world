import { h, clear, table, kv, pill, hashEl, fmtInt, inspectBtn, tipIcon, cell, confirmModal, short } from '../dom.js';
import { get, bus, store, site } from '../api.js';
import { heightToPlot, plotToHeight } from '../spiral.js';
import { mineral, assetName, mintRule, fieldName, who, isMe, title, assetHref, assetLink, agentLink, addressLink, blockLink } from '../words.js';
import { mintFlow, linkFlow, run, wallet } from '../flows.js';
import { pagedTable } from '../paged.js';

const C = {
  bg: '#EFE9DC', plain: ['#E2D9C8', '#DAD0BD'], claims: ['#C9D59A', '#BBCB88'], found: ['#A9C072', '#9DB767'],
  ring: 'rgba(31,35,40,0.55)', region: 'rgba(31,35,40,0.22)', ink: '#1F2328', mint: '#F7931A', road: 'rgba(31,35,40,0.10)', tip: '#1F2328',
};

export function mount(root, params) {
  const plots = new Map(), claims = new Map();
  const claimed = (height, p) => claims.get(height) === tip || p?.claimWindow === tip && p.claims > 0;
  let placed = false, userMoved = false;
  let tip = store.status?.tip ?? 0, selected = params.b !== undefined ? Number(params.b) : null, alive = true;
  const view = { cx: 0, cy: 0, scale: 12 };
  let sideSeq = 0;

  const canvas = h('canvas', { 'aria-label': (site.words?.worldMap ?? 'Spiral map of the local chain'), role: 'img' });
  const hover = h('div.map-hover.hidden');
  const gotoInput = h('input.input.mono', { placeholder: 'Block…', inputmode: 'numeric', 'aria-label': 'Go to block' });
  const wrap = h('div.map-wrap', {}, canvas, hover,
    h('div.map-tools', {},
      h('button.btn.sm', { onclick: () => zoom(1.4), 'aria-label': 'Zoom in' }, '+'),
      h('button.btn.sm', { onclick: () => zoom(1 / 1.4), 'aria-label': 'Zoom out' }, '−'),
      h('button.btn.sm', { onclick: fit }, 'Fit'),
      h('button.btn.sm', { onclick: () => select(tip, true), 'data-tip': 'Jump to the newest block at the frontier.' }, 'Frontier'),
      h('form.map-goto', { onsubmit: e => { e.preventDefault(); const n = Number(gotoInput.value); if (Number.isSafeInteger(n) && n >= 0 && n <= tip) select(n, true); } }, gotoInput)));

  const legend = h('div.map-legend', {},
      h('span', {}, h('i.lg', { style: { background: C.plain[0] } }), 'Plain'),
      h('span', {}, h('i.lg', { style: { background: C.claims[0] } }), 'Claims this round'),
      h('span', {}, h('i.lg', { style: { background: C.found[0], boxShadow: `inset 0 0 0 3px ${C.found[0]}, inset 0 0 0 9px #4A72C8` } }), 'Find'),
      h('span', {}, h('i', { style: { width: '8px', height: '8px', borderRadius: '50%', background: C.mint, display: 'inline-block' } }), 'Minted'),
      h('span', {}, h('i.lg', { style: { borderTop: '2px solid #1F2328', borderLeft: '2px solid #1F2328' } }), 'Bitmap linked'),
      h('span', {}, h('i', { style: { width: '14px', borderTop: `2px solid ${C.ring}`, display: 'inline-block' } }), 'Halving ring'));
  const side = h('aside.panel.blockpanel', { 'aria-live': 'polite' });
  const head = h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'World'),
    h('p', {}, (site.words?.worldIntro ?? 'The local chain laid out as land: block 0 in the centre, each block one plot along the spiral. Click a plot.'))),
    h('div.small.muted', { id: 'world-count' }));
  root.append(h('div.page', {}, head, h('div.world', {}, h('section.panel.map-panel', {}, wrap, legend), side)));
  drawSide();

  // Data
  async function load(from, to) {
    if (site.public) {
      let cursor = null, initialized = false;
      do {
        const r = await get(`/world/map?from=${from}&to=${to}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
        if (!alive) return;
        const first = Number(r.from), last = Number(r.to), frontier = Number(r.tip);
        if (![first, last, frontier].every(Number.isSafeInteger)) throw Error('Map height exceeds the canvas coordinate range');
        if (!initialized) for (let height = first; height <= last; height++) plots.set(height, {
          height, halving: Math.floor(height / 210000), region: Math.floor(height / 2016),
          found: false, linked: false, minted: false, finds: [],
        });
        initialized = true;
        for (const p of r.marks) {
          const height = Number(p.height);
          if (Number.isSafeInteger(height) && plots.has(height)) Object.assign(plots.get(height), p, { height });
        }
        tip = Math.max(Number(tip), frontier); cursor = r.next ?? null;
        paint(); updateCount();
      } while (cursor);
      return;
    }
    // The map keeps plot data, not rendered rows; each range is read in server pages of up to 200 plots.
    for (let a = from; a <= to; a += 512) {
      const b = Math.min(to, a + 511);
      let cursor = null;
      do {
        const r = await get(`/world?from=${a}&to=${b}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        for (const p of r.plots ?? []) plots.set(p.height, p);
        tip = Math.max(tip, r.tip ?? 0);
        cursor = r.next ?? null;
        paint();
        if (!alive) return;
      } while (cursor);
    }
    updateCount();
  }
  function updateCount() { const c = document.getElementById('world-count'); if (c) c.textContent = `${fmtInt(plots.size)} plots · tip ${fmtInt(tip)}`; }
  const offClaim = bus.on('event:claim', e => { const d = e.data ?? {}; if (d.window === tip) { claims.set(d.block, tip); paint(); } if (selected === d.block) drawSide(); });
  async function loadClaims() {
    const round = tip; let cursor, done = false; const seen = new Set();
    do {
      const page = await get(`/feed?type=claim&sort=sequence&order=desc&limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      if (!alive || round !== tip) return;
      for (const event of page.events ?? []) {
        const d = event.data ?? {};
        if ((d.receipt?.tip ?? d.window + 1) < round) done = true;
        if (d.window === round) claims.set(d.block, round);
      }
      cursor = page.next;
      if (cursor && seen.has(cursor)) throw Error('Repeated claim cursor');
      seen.add(cursor);
    } while (cursor && !done);
    paint();
  }
  const offFind = bus.on('event:find', e => refreshHeights([e.data?.block]));
  const offHeaderFind = bus.on('event:header_find', e => refreshHeights([e.data?.block]));
  const offPay = bus.on('event:mint_complete', e => { const b = e.data?.block; if (Number.isSafeInteger(b)) refreshHeights([b]); });
  async function loadAll() {
    try {
      const s = store.status ?? await store.refreshStatus(); tip = s.tip ?? 0;
      if (selected === null && !userMoved) fit();
      // Newest first: the frontier is where things happen.
      const limit = Math.min(tip, 40000);
      if (site.public) await load(tip - limit, tip);
      else for (let to = tip; to >= tip - limit && alive; to -= 2048) await load(Math.max(0, to - 2047, tip - limit), to);
      await loadClaims();
      if (selected !== null) { await refreshHeights([selected]); paint(); drawSide(); }
    } catch (e) { clear(side, h('div.body', {}, h('div.note.bad', {}, `The world did not load: ${e.message}`))); }
  }
  // Claimed and found plots lie anywhere on the spiral; refresh the affected heights.
  async function refreshHeights(list) {
    const hs = [...new Set(list.filter(n => Number.isSafeInteger(n) && n >= 0 && n <= tip))].slice(0, 48);
    await Promise.all(hs.map(n => get(`/world?from=${n}&to=${n}`).then(r => { for (const p of r.plots ?? []) plots.set(p.height, p); }).catch(() => {})));
    if (hs.length) paint();
    if (selected !== null && hs.includes(selected)) drawSide();
  }
  // Block events can arrive in bursts (time travel); one refresh runs at a time and covers them all.
  let busy = false, queued = [];
  const offBlock = bus.on('event:block', async e => {
    queued.push(e.data?.tip);
    if (busy) return;
    busy = true;
    try {
      while (alive) {
        const before = tip, heights = queued; queued = [];
        const s = await store.refreshStatus(); const from = Math.max(0, Math.min(before, s.tip) - 8); await load(from, s.tip);
        await refreshHeights(heights);
        await loadClaims();
        if (selected !== null) drawSide();
        if (!queued.length && store.status?.tip === s.tip) break;
      }
    } catch { /* the next block retries */ }
    busy = false;
  });
  const offDraw = bus.on('lab:draw', e => refreshHeights((e.data?.settlements ?? []).flatMap(x => (x.winners ?? []).map(w => w.block))));
  const offJob = bus.on('job-done', () => { if (selected !== null) drawSide(); });

  // Rendering
  const ctx = canvas.getContext('2d');
  let dpr = 1, W = 0, H = 0;
  const ro = new ResizeObserver(() => {
    dpr = devicePixelRatio || 1; W = wrap.clientWidth; H = wrap.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr;
    if (!placed && W && H) { placed = true; if (selected !== null) { const { x, y } = heightToPlot(selected); view.cx = x; view.cy = y; view.scale = 18; } else fit(); }
    paint();
  });
  ro.observe(wrap);
  const toScreen = (x, y) => [W / 2 + (x - view.cx) * view.scale, H / 2 - (y - view.cy) * view.scale];
  const toWorld = (sx, sy) => [view.cx + (sx - W / 2) / view.scale, view.cy - (sy - H / 2) / view.scale];
  let raf = 0;
  function paint() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const s = view.scale, [x0, y1] = toWorld(0, 0), [x1, y0] = toWorld(W, H);
    const minX = Math.floor(x0) - 1, maxX = Math.ceil(x1) + 1, minY = Math.floor(y0) - 1, maxY = Math.ceil(y1) + 1;
    const R = Math.ceil((Math.sqrt(tip + 1) + 1) / 2);
    const gap = s > 6 ? Math.min(1.5, s * 0.06) : 0;
    const visible = [];
    for (let y = Math.max(minY, -R); y <= Math.min(maxY, R); y++) {
      for (let x = Math.max(minX, -R); x <= Math.min(maxX, R); x++) {
        const n = plotToHeight(x, y); if (n > tip) continue;
        const p = plots.get(n);
        const [sx, sy] = toScreen(x - 0.5, y + 0.5);
        const alt = Math.floor(n / 2016) % 2;
        ctx.fillStyle = p?.found ? C.found[alt] : claimed(n, p) ? C.claims[alt] : C.plain[alt];
        if (!p && !claimed(n, p)) ctx.globalAlpha = 0.5;
        ctx.fillRect(sx + gap / 2, sy + gap / 2, s - gap, s - gap);
        ctx.globalAlpha = 1;
        if (p) visible.push([x, y, n, p, sx, sy]);
      }
    }
    // Halving rings and region edges: lines between neighbours that differ.
    ctx.lineWidth = Math.max(1, Math.min(2.5, s * 0.12));
    for (const [x, y, n, p, sx, sy] of visible) {
      for (const [dx, dy, ex, ey, fx, fy] of [[1, 0, s, 0, s, s], [0, -1, 0, s, s, s]]) {
        const m = plotToHeight(x + dx, y + dy); const q = plots.get(m); if (!q || m > tip) continue;
        if (q.halving !== p.halving) { ctx.strokeStyle = C.ring; }
        else if (q.region !== p.region && s > 3) { ctx.strokeStyle = C.region; }
        else continue;
        ctx.beginPath(); ctx.moveTo(sx + ex, sy + ey); ctx.lineTo(sx + fx, sy + fy); ctx.stroke();
      }
    }
    // Chain road along the spiral once plots are large enough.
    if (s >= 22) {
      ctx.strokeStyle = C.road; ctx.lineWidth = Math.max(1, s * 0.05); ctx.beginPath();
      let first = true;
      const lo = Math.max(0, Math.min(...visible.map(v => v[2])) - 1), hi = Math.max(...visible.map(v => v[2]), 0);
      for (let n = lo; n <= Math.min(hi + 1, tip); n++) { const { x, y } = heightToPlot(n); const [a, b] = toScreen(x, y); if (first) { ctx.moveTo(a, b); first = false; } else ctx.lineTo(a, b); }
      ctx.stroke();
    }
    // Marks: finds, minted hallmark, Bitmap pennant.
    const isMinted = (n, p) => p.minted === true || (Array.isArray(p.minted) && p.minted.length > 0);
    for (const [, , n, p, sx, sy] of visible) {
      const finds = p.finds ?? [];
      if (!finds.length && isMinted(n, p) && s >= 4) { ctx.fillStyle = C.mint; ctx.beginPath(); ctx.arc(sx + s * 0.78, sy + s * 0.78, Math.max(1.6, s * 0.1), 0, Math.PI * 2); ctx.fill(); }
      if (finds.length && s >= 2.5) {
        const inset = s * 0.26, f0 = finds[0];
        ctx.fillStyle = mineral(f0.asset ?? f0.pattern ?? 'x');
        ctx.fillRect(sx + inset, sy + inset, s - inset * 2, s - inset * 2);
        if (finds.length > 1 && s >= 10) { ctx.fillStyle = mineral(finds[1].asset ?? finds[1].pattern); ctx.fillRect(sx + s / 2, sy + inset, s / 2 - inset, s - inset * 2); }
        if (s >= 5) { ctx.strokeStyle = 'rgba(31,35,40,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(sx + inset + 0.5, sy + inset + 0.5, s - inset * 2 - 1, s - inset * 2 - 1); }
        if ((p.findMinted || finds.some(f => f.minted || f.inscription) || isMinted(n, p)) && s >= 5) {
          ctx.fillStyle = C.mint; ctx.beginPath(); ctx.arc(sx + s * 0.78, sy + s * 0.78, Math.max(1.6, s * 0.1), 0, Math.PI * 2); ctx.fill();
        }
      }
      if (p.linked && s >= 3) {
        ctx.strokeStyle = C.ink; ctx.lineWidth = Math.max(1, s * 0.08);
        ctx.beginPath(); ctx.moveTo(sx + s * 0.12, sy + s * 0.5); ctx.lineTo(sx + s * 0.12, sy + s * 0.12); ctx.lineTo(sx + s * 0.5, sy + s * 0.12); ctx.stroke();
      }
      if (s >= 34) {
        ctx.fillStyle = 'rgba(31,35,40,0.7)'; ctx.font = `500 ${Math.min(12, s * 0.22)}px "IBM Plex Mono", monospace`;
        ctx.fillText(String(n), sx + 3, sy + s - 4);
      }
    }
    // Frontier and selection.
    const mark = (n, w, dash) => {
      const { x, y } = heightToPlot(n), [sx, sy] = toScreen(x - 0.5, y + 0.5);
      ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = w; if (dash) ctx.setLineDash(dash);
      ctx.strokeRect(sx - w / 2, sy - w / 2, s + w, s + w); ctx.restore();
    };
    mark(tip, 1.5, [3, 2]);
    if (selected !== null) mark(selected, 2.5);
  }

  // Interaction: drag to pan, wheel or pinch to zoom, click to select.
  const pointers = new Map(); let downAt = null, pinch = null;
  wrap.addEventListener('pointerdown', e => { if (e.target.closest('.map-tools, .map-legend')) return; wrap.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.offsetX, e.offsetY]); downAt = { x: e.offsetX, y: e.offsetY, cx: view.cx, cy: view.cy, moved: false }; if (pointers.size === 2) pinch = { d: dist(), scale: view.scale }; });
  wrap.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) { hoverAt(e.offsetX, e.offsetY); return; }
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pointers.size === 2 && pinch) { view.scale = clamp(pinch.scale * dist() / pinch.d); paint(); return; }
    if (!downAt) return;
    const dx = e.offsetX - downAt.x, dy = e.offsetY - downAt.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) { downAt.moved = true; wrap.classList.add('drag'); hover.classList.add('hidden'); }
    if (downAt.moved) { userMoved = true; view.cx = downAt.cx - dx / view.scale; view.cy = downAt.cy + dy / view.scale; paint(); }
  });
  const up = e => {
    const wasClick = downAt && !downAt.moved && pointers.size === 1;
    pointers.delete(e.pointerId); wrap.classList.remove('drag');
    if (pointers.size < 2) pinch = null;
    if (wasClick) { const n = heightAt(e.offsetX, e.offsetY); if (n !== null) select(n, false); }
    if (!pointers.size) downAt = null;
  };
  wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
  wrap.addEventListener('pointerleave', () => hover.classList.add('hidden'));
  wrap.addEventListener('wheel', e => { e.preventDefault(); zoom(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY); }, { passive: false });
  function dist() { const [a, b] = [...pointers.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; }
  function clamp(s) { return Math.min(80, Math.max(0.5, s)); }
  function zoom(f, sx = W / 2, sy = H / 2) {
    userMoved = true;
    const [wx, wy] = toWorld(sx, sy); view.scale = clamp(view.scale * f);
    view.cx = wx - (sx - W / 2) / view.scale; view.cy = wy + (sy - H / 2) / view.scale; paint();
  }
  function fit() { const R = Math.ceil((Math.sqrt(tip + 1) + 1) / 2) + 1; view.cx = 0; view.cy = 0; view.scale = clamp(Math.min(W || 600, H || 500) / (2 * R + 1)); paint(); }
  function heightAt(sx, sy) { const [wx, wy] = toWorld(sx, sy), x = Math.round(wx), y = Math.round(wy); const n = plotToHeight(x, y); return n <= tip ? n : null; }
  function hoverAt(sx, sy) {
    const n = heightAt(sx, sy); if (n === null) { hover.classList.add('hidden'); return; }
    const p = plots.get(n);
    const bits = [`Block ${fmtInt(n)}`];
    if (!p && claimed(n, p)) bits.push('claims this round');
    if (p) { bits.push(p.found ? 'found' : claimed(n, p) ? 'claims this round' : 'plain'); const count = p.findCount ?? p.finds?.length; if (count) bits.push(`${count} find${count === 1 ? '' : 's'}`); if (p.minted === true || (Array.isArray(p.minted) && p.minted.length)) bits.push('minted'); if (p.linked) bits.push('Bitmap linked'); }
    hover.textContent = bits.join(' · ');
    hover.classList.remove('hidden');
    hover.style.left = `${Math.min(sx + 14, W - hover.offsetWidth - 6)}px`; hover.style.top = `${Math.max(6, sy - 30)}px`;
  }
  function select(n, center) {
    selected = n;
    if (center) { const { x, y } = heightToPlot(n); view.cx = x; view.cy = y; if (view.scale < 14) view.scale = 18; }
    history.replaceState(null, '', site.href('world', { b: n }));
    paint(); drawSide(); refreshHeights([n]);
  }

  // Block panel

  async function drawSide() {
    if (selected === null) {
      clear(side, h('header', {}, h('h2', {}, 'Pick a plot')), h('div.body', {},
        h('p.muted', { style: { marginTop: 0 } }, 'Click any plot on the map to see its header, the patterns in it, claims and the draw, and who may mint it now.'),
        h('div.row', {}, h('button.btn.sm', { onclick: () => select(tip, true) }, `Newest block ${fmtInt(tip)}`), h('button.btn.sm.ghost', { onclick: () => select(0, true) }, 'Block 0'))));
      return;
    }
    const seq = ++sideSeq, n = selected;
    if (!side.querySelector(`[data-h="${n}"]`)) clear(side, h('header', {}, h('h2', {}, `Block ${fmtInt(n)}`)), h('div.empty', {}, 'Loading…'));
    let b;
    try { b = await get(`/blocks/${n}`); } catch (e) { if (seq === sideSeq) clear(side, h('header', {}, h('h2', {}, `Block ${fmtInt(n)}`)), h('div.body', {}, h('div.note.bad', {}, e.message))); return; }
    if (seq !== sideSeq) return;
    clear(side, ...blockPanel(b));
  }
  function blockPanel(b) {
    const counted = store.status?.counted;
    const hd = b.header ?? {};
    const current = (b.claims ?? []).some(c => c.window === b.claimWindow?.window);
    const status = b.minted ? pill('Minted', 'minted') : b.found ? pill('Found', 'good') : current ? pill('Claims this round', 'info') : pill('Plain', '', 'Available for claims throughout history.');
    const out = [
      h('header', { 'data-h': b.height }, h('div.title', {}, h('h2', {}, `Block ${fmtInt(b.height)}`), status, b.link ? pill('Bitmap linked', 'ink', 'Bitmap holders earn 15% of every mint on their plot. During the finder’s week only the finder mints; afterwards any agent can.') : null),
        h('div.grow'), inspectBtn(`Block ${b.height}`, b)),
      kv([
        ['Plot', h('span.mono', {}, `x ${b.x}, y ${b.y}`)],
        ['Region', h('span.mono', {}, `${fmtInt(b.region)}`), 'Every 2,016 blocks (one difficulty period) form a region with its own landscape.'],
        ['Halving ring', h('span.mono', {}, `${fmtInt(b.halving)}`), (site.words?.halvingRing ?? 'Every 210,000 blocks form a halving ring in the world.')],
      ]),
    ];
    if (!b.link && b.height > 0) out.push(h('div.row', { style: { padding: '10px 14px', borderBottom: '1px solid var(--rule-2)' } },
      h('span.small.muted', { style: { flex: 1 } }, 'Hold this block\'s Bitmap? Link it to earn the Bitmap holder share here.'),
      site.public ? null : h('button.btn.sm.ghost', { 'data-tip': 'Test only: inscribes a real regtest Bitmap of this block to your wallet.', onclick: async () => {
        if (await confirmModal({ title: `Get a test Bitmap ${fmtInt(b.height)}.bitmap?`, lead: 'Test only: inscribes a real regtest Bitmap to your Bitcoin wallet so you can link it.', confirm: 'Inscribe' })) { try { await run('Inscribe Bitmap', '/player/bitmap', { height: b.height }); } catch { /* toast */ } }
      } }, 'Get a test Bitmap'),
      h('button.btn.sm', { onclick: async () => { if (await linkFlow(b.height)) drawSide(); } }, 'Link my Bitmap')));
    // Who may mint now.
    // Each list in the panel is paged by the server; only its current page is rendered.
    const H = b.height, small = { limit: 8 };
    // Public pages: the rows are read for the connected wallet's player, and a person without a wallet is offered one.
    const me = wallet?.player(), mayMint = r => r.allowed || r.rightAllowed && r.reason === 'asset_unregistered' && BigInt(r.balance ?? '0') >= BigInt(r.amount);
    // The v2 read lists one owner's rights only, so a public block without a player offers a wallet whenever it has a find.
    const ownerOnly = site.public && !me, offerWallet = wallet && !wallet.connected() && (b.mintRights ? b.mintRights.some(r => !r.minted) : !!b.found);
    out.push(h('div.section-label', offerWallet ? { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } } : {}, 'Who may mint it now',
      offerWallet ? h('button.btn.sm', { style: { textTransform: 'none', letterSpacing: 'normal' }, onclick: () => wallet.open() }, 'Connect wallet to mint') : null));
    // The finder window stays exclusive; linked land earns a share after minting opens.
    out.push(h('div.small.muted', { style: { padding: '0 14px 8px' } },
      'Only a settled find can be minted. During the finder’s week only the finder mints; afterwards any agent with enough units can. Bitmap holders earn 15% of every mint on their plot. Each pattern in a block is minted once.'));
    // Public reads come in the server's own order (pattern, then block); it has no other sort.
    out.push(ownerOnly ? h('div.small.muted', { style: { padding: '0 14px 10px' } }, 'Connect a wallet linked to your agent to see what you may mint here.') : pagedTable({ ...small, path: `/blocks/${H}/mintRights${me ? '?owner=' + me.agent : ''}`, key: 'mintRights', sorts: site.public ? [] : [['asset:asc', 'Pattern'], ['amount:desc', 'Most units']],
      empty: 'Nothing to mint here yet: no agent has a settled find in this block.',
      columns: [
        { key: 'asset', label: 'Pattern', render: r => h('span', {}, h('span.swatch', { style: { background: mineral(r.asset) } }), assetLink(r.asset)) },
        { key: 'amount', label: 'Units', num: true },
        { key: 'rule', label: 'May mint', render: r => {
          if (me && mayMint(r)) { const rule = mintRule(r, counted); return h('span', {}, pill('You may mint', 'good'), tipIcon(`${rule.label}. ${rule.text}`)); }
          const rule = mintRule(site.public && !me ? { ...r, allowed: false } : r, counted); return h('span', {}, pill(rule.label, rule.kind), tipIcon(rule.text));
        } },
        { key: 'act', label: '', render: r => (r.allowed || r.rightAllowed || site.public) && !r.minted && !r.pending ? h(`button.btn.sm${!wallet || me && mayMint(r) ? '.primary' : ''}`, { onclick: () => mintFlow({ asset: r.asset, block: H, amount: r.amount }) }, 'Mint On-Chain') : null },
      ] }).el);

    out.push(h('div.section-label', {}, 'Patterns in this block'));
    // Public matches are the verified submitted rows, by pattern; the v2 read takes no filter or sort.
    out.push(pagedTable({ ...small, path: `/blocks/${H}/matches${site.public ? '' : '?positive=true'}`, key: 'matches', sorts: site.public ? [] : [['number:asc', 'Pattern'], ['count:desc', 'Most units']],
      empty: 'No pattern occurs in this block.',
      columns: [
        { key: 'name', label: 'Pattern', render: m0 => { const m = normMatch(m0, b); return h('span', {}, h('span.swatch', { style: { background: mineral(m.asset) } }), assetLink(m.asset, m.name)); } },
        { key: 'field', label: 'Field', render: m0 => h('span.small', {}, normMatch(m0, b).field) },
        { key: 'count', label: 'Units', num: true, tip: 'How often the pattern matches this block\'s field. Winning the find credits that many units.' },
        { key: 'finder', label: 'Finder', render: m0 => { const m = normMatch(m0, b); return m.finder ? h('span', { class: isMe(m.finder) ? '' : 'mono' }, agentLink(m.finder)) : h('span.faint', {}, 'unfound'); } },
        { key: 'minted', label: 'Minted', render: m0 => normMatch(m0, b).minted ? pill('Minted', 'minted') : h('span.faint', {}, 'no') },
      ] }).el);

    out.push(h('div.section-label', {}, h('span', {}, 'Claims'), tipIcon('Agents claim unfound slots anywhere in counted history during each round. The hash of a later block draws the winner; speed gives no edge.')));
    out.push(pagedTable({ ...small, path: `/blocks/${H}/claims`, key: 'claims', sorts: [['agent:asc', 'Agent'], ['window:desc', 'Newest round']],
      filters: [{ name: 'header', label: 'Header sent', value: '', options: [['', 'All'], ['true', 'Header sent']] }],
      empty: 'No claims on this block.',
      columns: [
        { key: 'window', label: 'Round', num: true },
        { key: 'who', label: 'Claimed by', render: r => agentLink(r.agent ?? r.owner ?? r.claimer) },
        { key: 'patterns', label: 'Patterns', render: r => h('span', {}, (r.patterns ?? (r.pattern !== undefined ? [r.pattern] : [])).slice(0, 4).flatMap((x, i) => [i ? ', ' : '', assetLink(store.pattern(x)?.asset ?? (/^\d+$/.test(String(x)) ? 'p2:' + x : x))])) },
        { key: 'header', label: 'Header sent', render: r => r.header ? pill('Sent', 'good', 'Sent this block’s header. Unclaimed patterns are drawn among its correct header senders.') : h('span.faint', {}, '–') },
        { key: 'receipt', label: '', render: r => inspectBtn('Claim receipt', r) },
      ] }).el);
    out.push(h('div.section-label', {}, 'Draw result'));
    out.push(pagedTable({ ...small, limit: 3, path: `/blocks/${H}/draws`, key: 'draws', empty: 'No draw result for this block yet.',
      render: rows => drawTable(rows, b) }).el);

    // Header fields.
    out.push(h('div.section-label', {}, 'Header fields'));
    out.push(kv([
      ['Hash', hashEl(hd.hash ?? b.hash)],
      ['Nonce', h('span.mono', {}, fmtInt(hd.nonce)), 'Patterns on the nonce match its decimal digits.'],
      ['Difficulty bits', hd.bits !== undefined ? h('span.mono', {}, `${fmtInt(hd.bits)} · 0x${Number(hd.bits).toString(16)}`) : null, 'Patterns on bits match decimal or lowercase hex digits.'],
      ['Time', hd.time ? h('span.mono', {}, new Date(hd.time * 1000).toISOString().replace('T', ' ').slice(0, 19)) : null],
      ['Previous', (hd.prev ?? hd.previousblockhash ?? hd.prevHash) && H > 0 ? blockLink(H - 1, short(hd.prev ?? hd.previousblockhash ?? hd.prevHash, 8, 6)) : hashEl(hd.prev ?? hd.previousblockhash ?? hd.prevHash)],
      ['Merkle root', hashEl(hd.merkle ?? hd.merkleroot ?? hd.merkleRoot)],
      ['Version', hd.version !== undefined ? h('span.mono', {}, String(hd.version)) : null],
    ]));
    if (b.link) {
      out.push(h('div.section-label', {}, 'Bitmap link'));
      out.push(kv([
        b.link ? ['Bitmap holder', addressLink(b.link.holder ?? b.link.owner ?? b.link.address)] : null,
        b.link ? ['Linked at block', h('span.mono', {}, fmtInt(b.link.linkHeight ?? b.link.height))] : null,
      ]));
    }
    return out;
  }
  function normMatch(m, b) {
    const p = store.pattern(m.asset ?? m.number ?? m.pattern);
    const right = (b.mintRights ?? []).find(r => r.asset === (m.asset ?? p?.asset));
    const find = (b.finds ?? []).find(f => (f.asset && f.asset === (m.asset ?? p?.asset)) || (f.pattern !== undefined && f.pattern === (m.pattern ?? p?.number)));
    return { asset: m.asset ?? p?.asset ?? (/^\d+$/.test(String(m.pattern)) ? 'p2:' + m.pattern : m.pattern), name: p ? title(p.name) : (m.name ? title(m.name) : assetName(m.asset ?? (/^\d+$/.test(String(m.pattern)) ? 'p2:' + m.pattern : m.pattern))), field: fieldName(p ?? m), count: m.count ?? m.units,
      finder: m.finder ?? find?.finder ?? right?.finder ?? null, minted: !!(m.minted ?? find?.minted ?? right?.minted) };
  }
  function drawTable(rows, b) {
    if (!rows.length) return h('div.empty', {}, 'No draw result for this block yet.');
    // A settlement covers claims across historical plots; keep this block's winners.
    const settled = rows.filter(d => Array.isArray(d.winners));
    const list = settled.length ? settled.flatMap(d => (d.winners ?? []).filter(w => w.block === undefined || w.block === b.height).map(w => ({ ...w, window: d.window, entries: d.claims, settlement: d })))
      : rows.map(r => ({ ...r, winner: r.winner ?? r.finder, settlement: r }));
    if (settled.some(d => d.void)) return h('div.empty', {}, 'Draw void: a reorg changed the deciding block before it settled.');
    if (!list.length) return h('div.empty', {}, `No winning find in this block${settled[0]?.claims !== undefined ? ` (${fmtInt(settled[0].claims)} claim${settled[0].claims === 1 ? '' : 's'} in its round)` : ''}.`);
    return table(list, [
      { key: 'pattern', label: 'Pattern', render: r => { const p = store.pattern(r.asset ?? r.pattern); const asset = p?.asset ?? r.asset ?? (/^\d+$/.test(String(r.pattern)) ? 'p2:' + r.pattern : r.pattern); return h('span', {}, h('span.swatch', { style: { background: mineral(asset) } }), assetLink(asset, p ? title(p.name) : undefined)); } },
      { key: 'count', label: 'Units won', num: true, render: r => h('span.mono', {}, fmtInt(r.count ?? r.amount ?? '')) },
      { key: 'winner', label: 'Winner', render: r => r.winner ? h('strong', {}, agentLink(r.winner)) : h('span.faint', {}, 'nobody') },
      { key: 'window', label: 'Claim round', num: true, tip: 'The round in which these historical slots were claimed.', render: r => r.window !== undefined ? blockLink(r.window) : h('span.faint', {}, '–') },
      { key: 'i', label: '', sortable: false, render: r => inspectBtn('Draw', r.settlement) },
    ], { sortable: false });
  }


  loadAll();
  const offWallet = wallet?.on(() => drawSide()) ?? (() => {});
  const cleanup = () => { alive = false; offWallet(); ro.disconnect(); offBlock(); offDraw(); offJob(); offPay(); offClaim(); offFind(); offHeaderFind(); cancelAnimationFrame(raf); };
  cleanup.update = p => { if (p.b !== undefined && Number(p.b) !== selected) select(Number(p.b), true); };
  return cleanup;
}
