import { h, clear, table, kv, pill, hashEl, fmtInt, tabs, panel, figures, cell, inspectBtn, labelFor } from '../dom.js';
import { get, bus, site } from '../api.js';
import { mineral, assetName, who, assetLink, agentLink, blockLink, inscriptionLink, txLink, addressLink, requestLink } from '../words.js';
import { tap, bridged, fee } from '../money.js';
import { pagedTable } from '../paged.js';

const TABS = [
  ['mints', 'Minted on Bitcoin', (site.words?.resultsMints ?? 'What ord-tap indexed on Bitcoin regtest: block inscriptions with their DMT tokens, and compound tokens.')],
  ['payments', 'TAP payments', 'Player-paid fee items on Bitcoin. Each item must be final before the committee issues the mint permit.'],
  ['ethereum', 'Ethereum escrow', 'Player-funded bridged TAP deposits. The payer or a recipient submits the signed release and pays gas; the player also pays to inscribe on Bitcoin.'],
  ['payouts', 'Payment recipients', 'Public payment records by recipient. Indexed transactions show what was paid.'],
  ['owed', 'Unsettled records', 'Public records still awaiting payout. Older deploy holders accrue their equal share from the burn here.'],
  ['links', 'Bitmap links', 'Paid Bitmap links. A link stays with the Bitmap for good.'],
];
// The public pages also list payouts already sent to bound payout wallets.
if (site.public) TABS.splice(5, 0, ['paid', 'Paid payouts', 'Payouts sent to beneficiaries, including the Bitcoin holders of older deployments.']);
const AMOUNT_KEYS = /amount|price|fee|total|treasury|burn|share|paid|balance|released|held|accrued|owed|^tap$|erc20|supply/i;

export function mount(root, params = {}) {
  let tab = TABS.some(t => t[0] === params.tab) ? params.tab : 'mints', data = null, seq = 0;
  const top = h('div');
  const body = h('div');
  root.append(h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'Results'), h('p', {}, (site.words?.resultsIntro ?? 'What actually happened on the local chains: mints on Bitcoin regtest, escrow on Anvil, payouts, the treasury and the burn.'))),
      h('button.btn.sm', { onclick: load }, 'Refresh')),
    top, h('div', { style: { height: '16px' } }), body));

  async function load() {
    const s = ++seq;
    try { const d = await get('/results'); if (s === seq) { data = d; draw(); } }
    catch (e) { if (s === seq) clear(body, h('div.note.bad', {}, `Results did not load: ${e.message}`)); }
  }
  function sum(obj) {
    if (!obj || typeof obj !== 'object') return obj ?? null;
    for (const k of ['total', 'amount', 'tap', 'balance']) if (obj[k] !== undefined && typeof obj[k] !== 'object') return obj[k];
    return null;
  }
  const count = id => data?.counts?.[id] ?? data?.pages?.[id]?.total ?? (data?.[id] ?? []).length;
  let pager = null, pagerTab = null, focus = ['treasury', 'burn'].includes(params.tab) ? params.tab : null;
  function draw() {
    const d = data ?? {};
    clear(top, figures([
      ['Minted on Bitcoin', fmtInt(count('mints')), 'inscriptions'],
      ['Treasury', tapOr(sum(d.treasury)), 'TAP on Bitcoin', 'The quoted treasury share, including backing for older-deploy liabilities.'],
      ['Burned', tapOr(sum(d.burn)), 'TAP on Bitcoin', 'Burn shares plus unlinked Bitmap shares, less any older-deploy share.'],
      ['Escrow on Ethereum', fmtInt(count('ethereum')), 'payments'],
      ['Payouts', fmtInt(count('payouts')), 'ledger entries'],
    ]));
    const meta = TABS.find(t => t[0] === tab);
    // The tab's table pages on the server; a summary refresh only reloads its current page.
    if (pagerTab !== tab) { pager = tableFor(tab); pagerTab = tab; } else pager.reload();
    clear(body, h('section.panel', {},
      tabs(TABS.map(([id, l]) => [id, `${l} · ${fmtInt(count(id))}`]), t => {
        tab = t;
        history.replaceState(null, '', site.href('results', { tab }));
        draw();
      }, tab),
      h('div.body.small.muted', {}, meta[2]),
      h('div.flush', {}, pager.el)),
      h('div.grid.cols-2', { style: { marginTop: '16px' } },
        panel('Treasury', totals(d.treasury, 'treasury'), { tip: 'Totals from released payments.', id: 'treasury' }),
        panel('Burn', totals(d.burn, 'burn'), { id: 'burn' }),
        panel('Outstanding supply', totals(d.outstandingSupply, 'outstandingSupply'))));
    if (focus && data) { document.getElementById(focus)?.scrollIntoView({ block: 'start' }); focus = null; }
  }
  const tapOr = v => v === null || v === undefined ? '–' : /^\d+$/.test(String(v)) ? tap(v, data?.unit).replace(' TAP', '') : String(v);
  // Burn amounts are per rail; treasury lists its addresses and holdings.
  const TOTAL_LABELS = { burn: { tap: 'TAP burned', ethereum: 'Bridged TAP burned' }, outstandingSupply: { ethereum: 'Bridged TAP supply now' }, treasury: { tap: 'TAP received', erc20: 'Bridged TAP held', bitcoin: 'Bitcoin address', ethereum: 'Ethereum address' } };
  function totals(obj, ctx) {
    if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) return h('div.empty', {}, 'Nothing yet.');
    const bridgedKey = k => k === 'erc20' || (['burn', 'outstandingSupply'].includes(ctx) && k === 'ethereum');
    const fmt = (k, v) => bridgedKey(k) ? h('span.mono', {}, bridged(v)) : AMOUNT_KEYS.test(k) ? h('span.mono', {}, tap(v, unit())) : cell(v);
    // The treasury's own wallets link to their explorers like every other address.
    const value = (k, v) => ctx === 'treasury' && ['bitcoin', 'ethereum'].includes(k) && typeof v === 'string' ? addressLink(v) : typeof v === 'string' && /^\d+$/.test(v) && v.length < 40 ? fmt(k, v) : cell(v);
    // Paging metadata of nested lists is not a total; it stays in Inspect.
    return h('div', {}, kv(Object.entries(obj).filter(([k]) => k !== 'pages' && k !== 'counts').map(([k, v]) => [TOTAL_LABELS[ctx]?.[k] ?? labelFor(k), value(k, v)])), h('div.row', { style: { padding: '6px 10px' } }, inspectBtn('Totals', obj)));
  }
  const unit = () => data?.unit;
  const STATE = s => pill(String(s ?? '–').replace(/_/g, ' '), s === 'minted' || s === 'complete' || s === 'released' ? 'good' : /fail|cancel/.test(String(s)) ? 'bad' : /refund/.test(String(s)) ? '' : 'warn');
  const matter = r => r.asset ? h('span', {}, h('span.swatch', { style: { background: mineral(r.asset) } }), assetLink(r.asset)) : h('span.faint', {}, '–');
  const ROLE = { of: 'finder', bn: 'burn', lo: 'Bitmap holder', tr: 'treasury' };
  const KNOWN = {
    mints: [
      { key: 'asset', label: 'Matter', render: matter, sort: r => r.asset },
      { key: 'block', label: 'Block', num: true, render: r => r.block !== undefined && r.block !== null ? blockLink(r.block) : h('span.faint', {}, 'compound'), sort: r => r.block },
      { key: 'amount', label: 'Tokens', num: true },
      { key: 'kind', label: 'Paid with', render: r => r.kind === 'ethereum' ? 'Bridged TAP' : 'TAP' },
      { key: 'price', label: 'Fee', num: true, render: r => h('span.mono', {}, fee(r.price, r.kind, r.unit)) },
      { key: 'state', label: 'State', render: r => STATE(r.state) },
      { key: 'inscription', label: 'Inscription', render: r => r.inscription ? h('span', {}, h('span.pill.minted', { style: { marginRight: '6px' } }, 'on-chain'), inscriptionLink(r.inscription)) : h('span.faint', {}, '–'), sortable: false },
      { key: 'receiver', label: 'Owner', render: r => addressLink(r.receiver), sortable: false },
    ],
    payments: [
      { key: 'blck', label: 'Bitcoin block', num: true, render: r => blockLink(r.consumed?.blck ?? r.block), sort: r => r.consumed?.blck },
      { key: 'action', label: 'Action', render: r => r.consumed?.action === 'claim' ? 'Released' : r.consumed?.action === 'refund' ? 'Refunded' : cell(r.consumed?.action ?? r.action) },
      { key: 'total', label: 'Total', num: true, render: r => h('span.mono', {}, tap(r.consumed?.total ?? r.consumed?.amt ?? r.amount ?? r.total, unit())) },
      { key: 'split', label: 'Split', sortable: false, render: r => h('span.small', {}, [...(r.consumed?.target ? [`${tap(r.consumed.amt, unit())} treasury`] : []), ...(!r.consumed && r.role ? [`${tap(r.amount, unit())} ${r.role}`] : []), ...(r.consumed?.al ?? []).map(a => `${tap(a.amt, unit())} ${ROLE[a.rl] ?? a.rl}`)].join(' · ')) },
      { key: 'tx', label: 'Transaction', render: r => txLink('bitcoin', r.consumed?.tx ?? r.reference), sortable: false },
    ],
    payouts: [
      { key: 'beneficiary', label: 'Paid to', render: r => addressLink(r.beneficiary ?? r.to), sortable: false },
      { key: 'accrued', label: 'Earned', num: true, render: r => h('span.mono', {}, tap(r.accrued, unit())) },
      { key: 'paid', label: 'Paid out', num: true, render: r => h('span.mono', {}, tap(r.paid, unit())) },
      { key: 'owed', label: 'Still owed', num: true, render: r => h('span.mono', {}, tap(r.owed, unit()) + (r.legacyDeploy ? ` · ${r.eligible ? 'ready for payout' : 'payout from ' + tap(r.payoutMinAtoms, unit())}` : '')) },
    ],
    owed: [
      { key: 'role', label: 'For', render: r => ({ discoverer: 'Discoverer', landowner: 'Bitmap holder', legacyDeploy: 'Older deploy holder', deployer: 'Ticker deployer' }[r.role] ?? cell(r.role)) },
      { key: 'amount', label: 'Amount', num: true, render: r => h('span.mono', {}, tap(r.amount, unit())) },
      { key: 'to', label: 'Paid to', render: r => addressLink(r.to), sortable: false },
      { key: 'inscription', label: 'From mint', render: r => inscriptionLink(r.inscription), sortable: false },
    ],
    paid: [
      { key: 'role', label: 'For', render: r => ({ discoverer: 'Discoverer', landowner: 'Bitmap holder', legacyDeploy: 'Older deploy holder', deployer: 'Ticker deployer' }[r.role] ?? cell(r.role)) },
      { key: 'amount', label: 'Amount', num: true, render: r => h('span.mono', {}, tap(r.amount, unit())) },
      { key: 'agent', label: 'Agent', render: r => addressLink(r.agent ?? r.beneficiary), sortable: false },
      { key: 'address', label: 'Paid to', render: r => addressLink(r.address ?? r.to), sortable: false },
      { key: 'state', label: 'State', render: r => (r.state === 'paid' || r.evidence === 'independently_verified_settlement') ? pill('paid', 'good') : STATE(r.state) },
    ],
    links: [
      { key: 'block', label: 'Bitmap', num: true, render: r => blockLink(r.block, `${fmtInt(r.block)}.bitmap`) },
      { key: 'linkHeight', label: 'Linked at block', num: true, render: r => blockLink(r.linkHeight) },
    ],
    ethereum: [
      { key: 'requestId', label: 'Request', render: r => requestLink('mint', r.requestId ?? r.id), sortable: false },
      { key: 'amount', label: 'Held', num: true, render: r => h('span.mono', {}, tap(r.deposit?.amount ?? r.amount, r.unit)) },
      { key: 'status', label: 'Escrow', render: r => { const st = { 0: 'empty', 1: 'held', 2: 'released', 3: 'refunded' }[r.deposit?.status ?? r.status] ?? r.deposit?.status ?? r.status; return STATE(st === 'held' ? 'held' : st === 'released' ? 'released' : st); } },
      { key: 'split', label: 'Split on release', sortable: false, render: r => { const d = r.deposit?.split ?? r.split ?? {}; return h('span.small', {}, [['finder', d.finderAmount], ['discoverer', d.discovererAmount], ['Bitmap holder', d.landownerAmount], ['burn', d.burnAmount], ['treasury', d.treasuryAmount]].filter(([, v]) => v && v !== '0').map(([k, v]) => `${tap(v, r.unit)} ${k}`).join(' · ')); } },
      { key: 'confirmations', label: 'Confirmations', num: true },
      { key: 'payer', label: 'Payer', render: r => addressLink(r.payer ?? r.deposit?.payer), sortable: false },
    ],
  };
  const EMPTY = {
    mints: site.public ? 'Nothing minted yet.' : 'Nothing minted yet. Use Mint On-Chain from My player or a block on the map.',
    payments: 'No TAP payments yet.', ethereum: 'No escrow payments yet. Choose "Bridged TAP on Ethereum" when minting.',
    owed: 'Nothing owed right now.', paid: 'No payouts sent yet.', payouts: 'No payouts yet. They follow mints of discovered patterns and Ethereum payments for linked blocks.',
    links: 'No Bitmap links yet.',
  };
  const CONTROLS = {
    mints: { sorts: [['id:desc', 'Newest'], ['block:desc', 'Block'], ['price:desc', 'Highest fee'], ['asset:asc', 'Matter']], filters: [{ name: 'kind', label: 'Paid with', value: '', options: [['', 'Both'], ['tap', 'TAP'], ['ethereum', 'Bridged TAP']] }, { name: 'state', label: 'State', value: '', options: [['', 'All'], ['awaiting_payment', 'Awaiting payment'], ['partly_paid', 'Partly paid'], ['permit_issued', 'Permit ready'], ['minted', 'Minted'], ['expired', 'Expired']] }] },
    payments: { sorts: [['block:desc', 'Newest'], ['total:desc', 'Largest']], filters: [{ name: 'action', label: 'Action', value: '', options: [['', 'All'], ['claim', 'Released'], ['refund', 'Refunded']] }] },
    ethereum: { sorts: [['id:desc', 'Newest'], ['amount:desc', 'Largest']], filters: [] },
    payouts: { sorts: [['owed:desc', 'Most owed'], ['accrued:desc', 'Most earned'], ['beneficiary:asc', 'Recipient']], filters: [] },
    owed: { sorts: [['amount:desc', 'Largest'], ['role:asc', 'Role']], filters: [{ name: 'role', label: 'For', value: '', options: [['', 'All'], ['discoverer', 'Discoverer'], ['landowner', 'Bitmap holder']] }] },
    paid: { sorts: [], filters: [] },
    links: { sorts: [['block:desc', 'Block'], ['linkHeight:desc', 'Newest link']], filters: [] },
  };
  // The public pages open each mint request with its wallet payment and receipt.
  const RECEIPT = { mints: 'mint' };
  function tableFor(id) {
    return pagedTable({
      path: `/results/${id}`, key: id, limit: 25, empty: EMPTY[id], ...CONTROLS[id],
      columns: [...KNOWN[id], { key: '_i', label: '', render: r => site.public && RECEIPT[id] && r.id ? h('span.row', {}, h('a.linkbtn', { href: `/${RECEIPT[id]}/${r.id}` }, 'Payment and receipt'), inspectBtn(labelFor(id), r)) : inspectBtn(labelFor(id), r) }],
    });
  }
  load();
  const offs = [bus.on('event:mint_complete', load), bus.on('lab:payment', load), bus.on('job-done', load)];
  return () => offs.forEach(f => f());
}
