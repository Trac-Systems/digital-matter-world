// Records: built from the console's components (panels, figures, paged tables) over public reads.
import { h, clear, kv, pill, hashEl, fmtInt, panel, figures, inspectBtn, tierBadge, short } from './console/js/dom.js';
import { get, site } from './console/js/api.js';
import { pagedTable } from './console/js/paged.js';
import { mineral, assetName, title, fieldName, rememberCompound, compoundName } from './console/js/words.js';

export function mount(root, params = {}) {
  const top = h('div'), batch = h('div');
  root.append(h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'Records'),
      h('p', {}, 'Rarest finds today (UTC), over the last seven days, and ever. Rarity uses each pattern’s recorded history. The top compound has the highest tier; ties go to the higher generation, then the newest.'))),
    batch, top, h('div', { style: { height: '16px' } }),
    h('div.grid.cols-2', {},
      panel('Rarest pattern types', pagedTable({
        path: '/patterns', key: 'patterns', limit: 10, sorts: [['rarity:asc', 'Rarest first'], ['rarity:desc', 'Most common']],
        empty: 'No patterns yet.',
        columns: [
          { key: 'name', label: 'Pattern', render: p => h('a', { href: site.href('table', { p: p.asset }) }, h('span.swatch', { style: { background: mineral(p.asset ?? p.number) } }), title(p.name)) },
          { key: 'fld', label: 'Field', render: p => h('span.small', {}, fieldName(p)) },
          { key: 'tier', label: 'Tier', render: p => tierBadge(p.tier) },
          { key: 'rarity', label: 'Blocks', num: true, tip: 'Blocks in recorded history where this pattern occurs. Fewer blocks = rarer = higher tier.' },
          { key: 'madeReal', label: 'Made real', num: true },
        ],
      }).el, { flush: true }),
      panel('Compound records', pagedTable({
        path: '/compounds', key: 'compounds', limit: 10, sorts: [['tier:desc', 'Highest tier'], ['supply:desc', 'Most units'], ['madeReal:desc', 'Most made real']],
        empty: 'No compound crafted yet.',
        columns: [
          { key: 'id', label: 'Compound', render: c => h('a', { href: site.href('table', { c: c.id }) }, h('span.swatch', { style: { background: mineral(c.id) } }), assetName(rememberCompound(c).id)) },
          { key: 'tier', label: 'Tier', render: c => tierBadge(c.tier) },
          { key: 'generation', label: 'Generation', num: true, render: c => h('span.mono', {}, c.properties?.generation ?? '–') },
          { key: 'supply', label: 'Units on Trac', num: true },
          { key: 'madeReal', label: 'Made real', num: true },
        ],
      }).el, { flush: true }),
      panel('Top discoverers', pagedTable({
        path: '/agents', key: 'agents', limit: 10, sorts: [['discoveries:desc', 'Most discoveries'], ['finds:desc', 'Most finds']],
        empty: 'No agent has public results yet.',
        columns: [
          { key: 'address', label: 'Agent', render: r => h('a.mono', { href: site.href('agents', { a: r.address }) }, short(r.address)) },
          { key: 'discoveries', label: 'Discoveries', num: true },
          { key: 'finds', label: 'Finds', num: true },
        ],
      }).el, { flush: true }),
      panel('Public finds', pagedTable({
        path: '/finds', key: 'finds', limit: 10, sorts: [['findHeight:desc', 'Newest'], ['count:desc', 'Most units']],
        empty: 'No finds yet.',
        columns: [
          { key: 'asset', label: 'Pattern', render: f => h('span', {}, h('span.swatch', { style: { background: mineral(f.asset) } }), assetName(f.asset)) },
          { key: 'block', label: 'Block', num: true, render: f => h('a.mono', { href: site.href('world', { b: f.block }) }, fmtInt(f.block)) },
          { key: 'count', label: 'Units', num: true },
          { key: 'finder', label: 'Finder', render: f => h('a.mono', { href: site.href('agents', { a: f.finder }) }, short(f.finder)) },
          { key: 'minted', label: 'Minted', render: f => f.minted ? pill('Minted', 'minted') : h('span.faint', {}, 'no') },
        ],
      }).el, { flush: true }),
      panel('Accepted batches', pagedTable({
        path: '/records/batches', key: 'batches', limit: 10,
        empty: 'No accepted batch yet.',
        columns: [
          { key: 'n', label: 'Batch', num: true, render: b => h('a.mono', { href: `/records/batches/${b.n}` }, `#${fmtInt(b.n)}`) },
          { key: 'to', label: 'Counted blocks', num: true, render: b => h('span.mono', {}, b.from === b.to ? fmtInt(b.to) : `${fmtInt(b.from)}–${fmtInt(b.to)}`) },
          { key: 'root', label: 'Root', render: b => hashEl(b.root) },
        ],
      }).el, { flush: true }),
      panel('Receipts', pagedTable({
        path: '/receipts', key: 'receipts', limit: 10,
        empty: 'No receipts yet.',
        columns: [
          { key: 'height', label: 'Tip', num: true, render: r => h('a.mono', { href: site.href('world', { b: r.height }) }, fmtInt(r.height)) },
          { key: 'count', label: 'Moves', num: true, render: r => h('span.mono', {}, fmtInt(r.seal?.count)) },
          { key: 'hash', label: 'Sealed hash', render: r => hashEl(r.seal?.hash) },
          { key: 'i', label: '', render: r => inspectBtn('Receipt', r) },
        ],
      }).el, { flush: true, tip: 'Gateway seals over the moves it accepted at each tip.' }))));

  get('/records/highlights').then(r => {
    const find = f => f ? [assetName(f.asset), `block ${fmtInt(f.block)} · ${fmtInt(f.rarity?.numerator)} of ${fmtInt(f.rarity?.denominator)} blocks`] : ['–', 'none yet'];
    const c = r.highestTierCompound;
    clear(top, figures([
      ['Rarest find today', ...find(r.rarestFinds?.today)],
      ['Rarest find this week', ...find(r.rarestFinds?.week)],
      ['Rarest find ever', ...find(r.rarestFinds?.ever)],
      ['Highest-tier compound', c ? h('a', { href: site.href('table', { c: c.asset }) }, compoundName({ ...c, id: c.asset })) : '–',
        c ? `tier ${c.tier ?? '–'} · generation ${c.generation ?? '–'}` : 'none yet'],
    ]));
  }).catch(e => clear(top, h('div.note.bad', {}, `Records did not load: ${e.message}`)));

  // A batch address shows that batch's evidence above the records.
  const showBatch = async n => {
    if (n === undefined) { clear(batch); return; }
    clear(batch, panel(`Batch #${fmtInt(n)}`, h('div.empty', {}, 'Loading…')));
    try {
      const r = await get(`/records/batches/${n}`), b = r.batch ?? r;
      clear(batch, h('section.panel', { style: { marginBottom: '16px' } },
        h('header', {}, h('h2', {}, `Batch #${fmtInt(b.n)}`), h('div.grow'), inspectBtn(`Batch ${b.n}`, r)),
        kv([
          ['Counted blocks', h('span.mono', {}, b.from === b.to ? fmtInt(b.to) : `${fmtInt(b.from)}–${fmtInt(b.to)}`)],
          ['Root', hashEl(b.root)],
          ['Operations', h('span.mono', {}, fmtInt(r.counts?.ops ?? b.ops?.length))],
          ['Deadline', b.deadline !== undefined ? h('span.mono', {}, fmtInt(b.deadline)) : null],
        ])));
    } catch (e) { clear(batch, h('div.note.bad', { style: { marginBottom: '16px' } }, `This batch did not load (${e.message}).`)); }
  };
  showBatch(params.batch);
  const cleanup = () => {};
  cleanup.update = p => showBatch(p.batch);
  return cleanup;
}
