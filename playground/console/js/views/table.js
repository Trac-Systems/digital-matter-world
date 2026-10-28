import { h, clear, table, kv, pill, hashEl, fmtInt, seg, inspectBtn, tierBadge, cell, panel } from '../dom.js';
import { get, bus, store, site } from '../api.js';
import { mineral, title, symbol, fieldName, FIELDS, who, assetName } from '../words.js';
import { compoundMintFlow } from '../flows.js';
import { pagedTable } from '../paged.js';
import { feePrice } from '../money.js';

export function mount(root, params = {}) {
  let mode = 'grid', pick = null, pickC = null, selectionSeq = 0;
  const body = h('div');
  const detail = h('div');
  const head = h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'Periodic table of patterns'),
    h('p', {}, 'Every pattern type that counts as matter. Names of discoverers stay on the table; minted units are engraved for good.')),
    h('div', { id: 'pt-mode' }));
  root.append(h('div.page', {}, head, h('div.grid.cols-main', {}, body, detail)));

  // Patterns and compounds come from their paged routes; only the current page is rendered.
  const TIERS = [['', 'All tiers'], ['1', 'Tier 1'], ['2', 'Tier 2'], ['3', 'Tier 3'], ['4', 'Tier 4'], ['5', 'Tier 5']];
  const PATTERN_SORTS = [['number:asc', 'Number'], ['rarity:asc', 'Rarest first'], ['tier:desc', 'Highest tier'], ['supply:desc', 'Most units'], ['minted:desc', 'Most minted'], ['name:asc', 'Name']];
  let pager = null, compoundsPager = null;
  const draw = () => {
    clear(document.getElementById('pt-mode'), seg([['grid', 'Table'], ['list', 'List']], mode, m => { mode = m; draw(); }));
    pager = mode === 'grid' ? pagedTable({
      path: '/patterns', key: 'patterns', limit: 60, sorts: PATTERN_SORTS, filters: [{ name: 'tier', label: 'Tier', value: '', options: TIERS }],
      empty: 'No patterns in this view.',
      render: rows => h('div.ptable', { style: { padding: '12px 14px' } }, [4, 10, 11].map(fld => ({ fld, items: rows.filter(p => p.fld === fld) })).map(g => h('section.pgroup', {},
        h('h3', {}, `${FIELDS[g.fld]}`, h('span.small.muted', { style: { fontWeight: 400 } }, g.fld === 4 ? 'digits of the block height' : g.fld === 10 ? 'digits of the nonce' : 'the difficulty bits, decimal or hex')),
        h('div.pgrid', {}, g.items.map(tile), blanks(g.items.length))))),
    }) : pagedTable({
      path: '/patterns', key: 'patterns', limit: 25, sorts: PATTERN_SORTS, filters: [{ name: 'tier', label: 'Tier', value: '', options: TIERS }],
      onRow: p => choose(p, null), selected: p => pick && p.number === pick.number,
      columns: [
        { key: 'number', label: '#', num: true },
        { key: 'name', label: 'Pattern', render: p => h('span', {}, h('span.swatch', { style: { background: mineral(p.asset ?? p.number) } }), title(p.name)) },
        { key: 'pat', label: 'Rule', render: p => h('code', {}, p.pat) },
        { key: 'fld', label: 'Field', render: p => h('span.small', {}, fieldName(p)) },
        { key: 'tier', label: 'Tier', render: p => tierBadge(p.tier) },
        { key: 'rarity', label: 'Blocks', num: true, tip: (site.words?.rarityBlocks ?? 'Blocks in local history where this pattern occurs. Fewer blocks = rarer = higher tier.') },
        { key: 'discoverer', label: 'Discoverer', render: p => p.discoverer ? hashEl(p.discoverer, who(p.discoverer)) : h('span.faint', {}, 'seed') },
        { key: 'supply', label: 'Units on Trac', num: true, render: p => h('span.mono', {}, fmtInt(supplyOf(p))) },
        { key: 'minted', label: 'Minted', num: true, render: p => h('span.mono', {}, fmtInt(mintedOf(p))), tip: 'Blocks of this pattern already minted on Bitcoin.' },
      ],
    });
    compoundsPager = compounds();
    clear(body, panel(mode === 'grid' ? 'Patterns' : 'All patterns', pager.el, { flush: true }), compoundsPager.el);
    drawDetail();
  };
  const supplyOf = p => p.supply ?? p.trac ?? p.units ?? p.balance ?? null;
  const mintedOf = p => p.minted ?? p.mintedBlocks ?? p.real ?? null;
  // The public pages keep the picked pattern or compound in their address.
  const choose = (p, c) => { selectionSeq++; pick = p; pickC = c; if (site.public) history.replaceState(null, '', site.href('table', p ? { p: p.asset } : c ? { c: c.id } : undefined)); drawDetail(); };
  function tile(p) {
    const on = pick && pick.number === p.number;
    return h('button.el', { type: 'button', onclick: () => choose(p, null), style: on ? { outline: '2px solid #1F2328', outlineOffset: '-1px' } : {},
      'data-tip': `${title(p.name)} · ${fieldName(p)}\nRule ${p.pat}\n${fmtInt(p.rarity)} blocks · tier ${p.tier}` },
      h('div.top', {}, h('span', {}, String(p.number)), tierBadge(p.tier)),
      h('div.sym', {}, h('i', { style: { background: mineral(p.asset ?? p.number) } }), symbol(p.name)),
      h('div', {}, h('div.nm', {}, title(p.name)), h('div.pat', {}, p.pat)),
      h('div.foot', {}, h('span', {}, fmtInt(p.rarity)), h('span', {}, p.discoverer ? hashEl(p.discoverer, who(p.discoverer)) : 'seed')),
      Number(mintedOf(p)) > 0 ? h('span.hmk', { 'aria-label': 'minted' }) : null);
  }
  function blanks(n) {
    return Array.from({ length: n ? 2 : 6 }, () => h('div.el.blank', { 'data-tip': site.public ? 'Undiscovered.' : 'Undiscovered. Propose a new pattern from My player → Discover.' },
      h('div.top', {}, h('span', {}, '?'), ''), h('div.sym', {}, ''), h('div', {}, h('div.nm.faint', {}, 'Undiscovered')), h('div.foot', {}, '')));
  }
  function compounds() {
    const t = pagedTable({
      path: '/compounds', key: 'compounds', limit: 10,
      sorts: [['supply:desc', 'Most units'], ['tier:desc', 'Highest tier'], ['name:asc', 'Name']],
      filters: [{ name: 'tier', label: 'Tier', value: '', options: TIERS }],
      empty: site.public ? 'No compound crafted yet.' : 'No compound crafted yet. Craft one from My player → Craft.',
      ...(site.public ? { onRow: c => choose(null, c), selected: c => pickC && c.id === pickC.id } : {}),
      columns: [
        { key: 'id', label: 'Compound', render: c => h('span', {}, h('span.swatch', { style: { background: mineral(c.id ?? c.asset) } }), assetName(c.id ?? c.asset)) },
        { key: 'tier', label: 'Tier', render: c => tierBadge(c.tier) },
        { key: 'mass', label: 'Mass', num: true, render: c => h('span.mono', {}, fmtInt(c.mass ?? c.properties?.mass)) },
        { key: 'firstMaker', label: 'First maker', render: c => c.firstMaker ? hashEl(c.firstMaker, who(c.firstMaker)) : h('span.faint', {}, '–') },
        { key: 'supply', label: 'Units on Trac', num: true, render: c => h('span.mono', {}, fmtInt(c.supply ?? c.units)) },
        { key: 'token', label: 'On Bitcoin', render: c => c.token || c.deployed ? pill('Token deployed', 'minted') : h('span.faint', {}, 'not yet') },
        { key: 'act', label: '', render: c => h('button.btn.sm', { onclick: () => compoundMintFlow(c.id ?? c.asset) }, 'Mint On-Chain') },
      ],
    });
    return { el: h('div', { style: { marginTop: '18px' } }, panel('Compounds', t.el, { flush: true, id: 'compounds', tip: 'Crafted from pattern units. Any compound type can be made real as its own TAP token.' })), reload: t.reload };
  }
  let rowsSeq = 0;
  async function drawDetail() {
    if (pickC) { clear(detail, compoundPanel(pickC)); return; }
    if (!pick) {
      clear(detail, panel('Pattern', h('p.muted', { style: { margin: 0 } }, 'Pick a pattern to see its rule, rarity, discoverer and every block where it occurs.')));
      return;
    }
    const p = pick, seq = ++rowsSeq;
    const blocks = h('div', {}, h('div.empty', {}, 'Loading blocks…'));
    clear(detail, h('section.panel', {},
      h('header', {}, h('span.swatch', { style: { background: mineral(p.asset ?? p.number), width: '14px', height: '14px' } }), h('h2', {}, title(p.name)), tierBadge(p.tier), h('div.grow'), inspectBtn(p.name, p)),
      kv([
        ['Rule', h('code', {}, p.pat), 'TAP\'s regular-expression form, matched against one header field. Each match is one unit.'],
        ['Field', fieldName(p)],
        ['Blocks with it', h('span.mono', {}, fmtInt(p.rarity)), (p.countMeaning === 'verified_submitted_blocks' ? 'Verified submitted blocks; more matches may exist.' : site.words?.rarityHistory ?? 'In the local history. Sets the tier.')],
        ['Tier', `${p.tier} of 5 · price ${feePrice(store.status?.feePolicy, 'find', p.tier)}`],
        ['Discoverer', p.discoverer ? hashEl(p.discoverer, who(p.discoverer)) : 'Seed pattern'],
        ['Units on Trac', h('span.mono', {}, fmtInt(supplyOf(p)))],
        ['Blocks minted', h('span.mono', {}, fmtInt(mintedOf(p)))],
      ]),
      h('div.section-label', {}, site.words?.patternBlocks ?? 'Blocks where it occurs'), blocks));
    if (seq !== rowsSeq) return;
    clear(blocks, pagedTable({
      path: `/patterns/${p.asset}/${p.asset.startsWith('p2:') ? 'claimed-blocks' : 'blocks'}`, key: 'rows', limit: 25,
      sorts: [['block:desc', 'Newest block'], ['block:asc', 'Oldest block'], ...(p.asset.startsWith('p2:') ? [] : [['count:desc', 'Most units']])],
      filters: [{ name: 'found', label: 'Found', value: '', options: [['', 'All'], ['true', 'Found'], ['false', 'Unfound']] },
        { name: 'minted', label: 'Minted', value: '', options: [['', 'All'], ['true', 'Minted'], ['false', 'Not minted']] }],
      empty: filters => Object.values(filters).every(v => v === '') && site.words?.patternBlocksEmpty || 'No blocks in this view.',
      columns: [
        { key: 'block', label: 'Block', num: true, render: r => h('a.mono', { href: site.href('world', { b: r.block }) }, fmtInt(r.block)) },
        { key: 'count', label: 'Units', num: true },
        { key: 'found', label: 'Found', render: r => cell(r.found) },
        { key: 'finder', label: 'Finder', render: r => r.finder ? hashEl(r.finder, who(r.finder)) : h('span.faint', {}, '–') },
        { key: 'minted', label: 'Minted', render: r => r.minted ? pill('Minted', 'minted') : h('span.faint', {}, 'no') },
        { key: 'link', label: 'Bitmap', render: r => r.link ? pill('linked', 'ink') : h('span.faint', {}, '–') },
      ],
    }).el);
  }
  function compoundPanel(c) {
    const id = c.id ?? c.asset;
    return h('section.panel', {},
      h('header', {}, h('span.swatch', { style: { background: mineral(id), width: '14px', height: '14px' } }), h('h2', {}, assetName(id)), tierBadge(c.tier), h('div.grow'), inspectBtn(assetName(id), c)),
      kv([
        ['Recipe', c.recipe ? title(c.recipe) : null],
        ['Inputs', (c.inputs ?? []).map(([a, n]) => `${fmtInt(n)} ${assetName(a)}`).join(' + ') || null],
        ['Mass', h('span.mono', {}, fmtInt(c.mass ?? c.properties?.mass))],
        ['First maker', c.firstMaker ? hashEl(c.firstMaker, who(c.firstMaker)) : null],
        ['Units on Trac', h('span.mono', {}, fmtInt(c.supply ?? c.units))],
        ['Made real', h('span.mono', {}, fmtInt(c.madeReal))],
        ['On Bitcoin', c.token || c.deployed ? pill('Token deployed', 'minted') : h('span.faint', {}, 'not yet')],
      ]),
      h('div.row', { style: { padding: '10px 14px' } }, h('button.btn.sm.primary', { onclick: () => compoundMintFlow(id) }, 'Mint On-Chain')));
  }
  // A pattern or compound named in the address opens beside the table.
  async function open(asset, compound) {
    const seq = ++selectionSeq, key = compound ? 'compounds' : 'patterns', label = compound ? 'Compound' : 'Pattern';
    clear(detail, panel(label, h('div.empty', {}, 'Loading…')));
    try {
      const found = (compound ? store.compound(asset) : store.pattern(asset)) ?? (await get(`/${key}?asset=${encodeURIComponent(asset)}&limit=1`))?.[key]?.[0];
      if (seq !== selectionSeq) return;
      if (found) { pick = compound ? null : found; pickC = compound ? found : null; drawDetail(); }
      else clear(detail, panel(label, h('div.note', { role: 'alert' }, `${label} ${asset} was not found.`)));
    } catch (e) {
      if (seq !== selectionSeq) return;
      clear(detail, panel(label, h('div.note.bad', { role: 'alert' }, `${label} ${asset} could not be loaded (${e.message}). `,
        h('button.btn.sm', { onclick: () => open(asset, compound) }, 'Retry'))));
    }
  }
  draw();
  if (params.p || params.c) open(params.p ?? params.c, !params.p);
  const off = bus.on('patterns', () => { pager?.reload(); compoundsPager?.reload(); });
  return () => { selectionSeq++; off(); };
}
