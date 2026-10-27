import { h, clear, kv, pill, hashEl, fmtInt, panel, field, input, select, confirmModal, seg, inspectBtn, clock, toast } from '../dom.js';
import { bus, store, stream } from '../api.js';
import { run } from '../flows.js';
import { tap, tapText, tapAtoms } from '../money.js';
import { plainError, jobName, describe } from '../words.js';
import { pagedTable } from '../paged.js';

const SPEEDS = [[1500, '1.5 s'], [2000, '2 s'], [5000, '5 s'], [10000, '10 s'], [15000, '15 s'], [30000, '30 s'], [60000, '1 min'], [600000, '10 min']];
// The current interval is always an option, so Apply never changes it by accident.
const speedOptions = ms => { const list = SPEEDS.map(([v, l]) => [String(v), l]); if (ms && !SPEEDS.some(([v]) => v === ms)) list.push([String(ms), secs(ms)]); return list.sort((a, b) => a[0] - b[0]); };
const secs = ms => ms < 60000 ? `${Math.round(ms / 100) / 10} s` : `${Math.round(ms / 6000) / 10} min`;
const READY = /^(ready|running|ok|up|healthy|live)$/i;

export function mount(root) {
  const band = h('div.lab-band', {}, h('strong', {}, 'Lab'), h('span', {}, 'Testing controls for the local networks. Nothing here exists in the real game.'));
  const operator = h('div.row', {}, h('a.linkbtn', { href: 'http://127.0.0.1:58910/operator', target: '_blank', rel: 'noopener' }, 'Operator status'));
  let payoutPlan;
  operator.append(h('button.btn', { onclick: async () => { const result = await run('Preview payouts', '/operator/payouts', { dryRun: true }); payoutPlan = result?.result?.planId ?? result?.planId; } }, 'Preview payouts'),
    h('button.btn', { onclick: () => { if (payoutPlan) run('Run payouts', '/operator/payouts', { dryRun: false, planId: payoutPlan }).catch(() => {}); else toast({ what: 'Preview payouts first', state: 'failed' }); } }, 'Run payouts'));
  root.append(operator);
  const grid = h('div.grid.cols-3');
  const jobsBox = h('div');
  const healthBox = h('div');
  const botsBox = h('div');
  const diagBox = h('div');
  root.append(band, h('div.page', {}, grid,
    h('div.grid.cols-2', { style: { marginTop: '16px' } },
      panel('Component health', healthBox, { flush: true, tip: 'Every local service the playground started.' }),
      panel('Recent lab and player jobs', jobsBox, { flush: true, tip: 'Jobs run one at a time. A failed job is never retried automatically.' })),
    h('div.grid.cols-2', { style: { marginTop: '16px' } },
      panel('Bots', botsBox, { flush: true, tip: 'Bot players on this playground and their last error, if any.' }),
      panel('Lab diagnostics', diagBox, { flush: true, tip: 'Local events: jobs, bot steps, components. Not part of the public game feed.' })),
    h('div.grid.cols-2', { style: { marginTop: '16px' } }, walletsPanel())));

  const draw = () => {
    const s = store.status ?? {};
    const typing = grid.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);
    if (typing) { drawHealth(s); return; }
    clear(grid, chainPanel(s), timePanel(s), worldPanel(s));
    drawHealth(s);
  };

  function chainPanel(s) {
    const enabled = !!s.mining?.enabled;
    const speed = select(speedOptions(s.mining?.intervalMs), { value: String(s.mining?.intervalMs ?? 10000), 'aria-label': 'Auto-mine interval' });
    return panel('Blocks', h('div.ctl', {},
      kv([['Tip', h('span.mono', {}, fmtInt(s.tip))], ['Counted', h('span.mono', {}, fmtInt(s.counted)), 'Counted advances when a block is accepted; no extra confirmation depth is required.'], ['Last batch', s.batch ? h('span.mono', {}, `#${fmtInt(s.batch.n)} to ${fmtInt(s.batch.to)}`) : null]]),
      h('div.field', {}, h('label', {}, 'Mine now'), h('div.row', {}, [1, 10, 100].map(n => h('button.btn', { onclick: () => run(`Mine ${n}`, '/mine', { count: n }).catch(() => {}) }, `+${n}`)))),
      h('div.field', {}, h('label', {}, 'Auto-mine'), h('div.row', {},
        seg([['on', 'On'], ['off', 'Paused']], enabled ? 'on' : 'off', v => run(v === 'on' ? 'Start auto-mine' : 'Pause auto-mine', '/mining', { enabled: v === 'on', intervalMs: Number(speed.value) }).catch(() => {})),
        h('span.small.muted', {}, 'every'), h('div', { style: { width: '100px' } }, speed),
        h('button.btn.sm', { onclick: () => run('Auto-mine speed', '/mining', { enabled, intervalMs: Number(speed.value) }).catch(() => {}) }, 'Apply')))));
  }

  function timePanel(s) {
    const custom = input({ class: 'mono', inputmode: 'numeric', placeholder: 'blocks', 'aria-label': 'Blocks to jump', style: { width: '110px' } });
    const depth = select([1, 2, 3, 4, 5, 6, 7].map(n => [String(n), `${n} block${n === 1 ? '' : 's'}`]), { value: '1', 'aria-label': 'Reorg depth' });
    const travel = async n => {
      if (!Number.isSafeInteger(n) || n < 1 || n > 10000) { toast({ what: 'Between 1 and 10,000 blocks', state: 'failed', ttl: 3000 }); return; }
      if (n >= 100 && !await confirmModal({ title: `Jump ${fmtInt(n)} blocks ahead?`, lead: 'Real regtest blocks are mined and the gateway drains its batches. Finder windows and deadlines pass on the way. This takes a while.', rows: [['From tip', fmtInt(s.tip)], ['To tip', fmtInt((s.tip ?? 0) + n)]], confirm: 'Jump' })) return;
      run(`Time travel ${fmtInt(n)}`, '/time-travel', { blocks: n }).catch(() => {});
    };
    return panel('Time', h('div.ctl', {},
      h('div.field', {}, h('label', {}, 'Time travel'), h('div.row', {},
        h('button.btn', { onclick: () => travel(144), 'data-tip': 'About one day of blocks.' }, '1 day'),
        h('button.btn', { onclick: () => travel(1008), 'data-tip': 'The finder window: after it, Bitmap holders or anyone may mint.' }, '1,008 · finder window'),
        h('button.btn', { onclick: () => travel(2016), 'data-tip': 'One difficulty period: a new region of land.' }, '2,016 · region')),
        h('form.row', { onsubmit: e => { e.preventDefault(); travel(Number(custom.value)); } }, custom, h('button.btn.sm', { type: 'submit' }, 'Jump'))),
      h('div.field', {}, h('label', {}, 'Reorg'), h('div.row', {}, h('div', { style: { width: '130px' } }, depth),
        h('button.btn.danger', { onclick: async () => {
          const d = Number(depth.value);
          if (await confirmModal({ title: `Reorg the last ${d} block${d === 1 ? '' : 's'}?`, lead: 'Regtest replaces the newest blocks with a heavier branch. Claim windows and draws that depend on them are voided until they settle again.', rows: [['Tip now', fmtInt(s.tip)], ['Depth', String(d)]], confirm: 'Reorg', danger: true })) run(`Reorg ${d}`, '/reorg', { depth: d }).catch(() => {});
        } }, 'Reorg')), h('div.hint', {}, 'Depth 1–7. Settled draws stay final.'))));
  }

  function worldPanel(s) {
    const B = s.feePolicy?.baseFee ?? '', unit = s.feePolicy?.unit;
    const fee = input({ class: 'mono', value: tapText(B, unit), inputmode: 'decimal', 'aria-label': 'Base fee in TAP', style: { width: '160px' } });
    const count = input({ class: 'mono', value: String(s.bots?.count ?? 12), inputmode: 'numeric', 'aria-label': 'Bot count', style: { width: '80px' } });
    const speed = select(speedOptions(s.bots?.intervalMs), { value: String(s.bots?.intervalMs ?? 15000), 'aria-label': 'Bot speed' });
    return panel('Economy and bots', h('div.ctl', {},
      h('div.field', {}, h('label', {}, 'Base fee B (TAP)'), h('form.row', { onsubmit: async e => {
        e.preventDefault();
        // The decimal TAP text is what gets posted; atoms are only used for the preview below.
        const text = fee.value.trim(), atoms = tapAtoms(text, unit);
        if (!atoms || !BigInt(atoms)) { toast({ what: 'Enter a positive amount of TAP, e.g. 22.6', state: 'failed', ttl: 3500 }); return; }
        const x = n => tap((BigInt(atoms) * n).toString(), unit);
        if (await confirmModal({ title: 'Change the base fee?', lead: 'Effective immediately for new quotes. Quotes already signed keep their old B.', rows: [['Now', tap(B, unit)], ['New', tap(atoms, unit)], ['Mint, tier 1 / tier 5', `${x(1n)} / ${x(100n)}`], ['Bitmap link', x(20n)]], confirm: 'Change B' })) run('Change base fee', '/fee', { baseFee: text }).catch(() => {});
      } }, fee, h('span.small.muted', {}, 'TAP'), h('button.btn.sm', { type: 'submit' }, 'Set')),
        h('div.hint', {}, `Now ${tap(B, unit)}. B is the operator's TAP rate for about $1; every price is a multiple of it.`)),
      h('div.field', {}, h('label', {}, 'Bots'), h('div.row', {},
        count, h('span.small.muted', {}, 'acting every'), h('div', { style: { width: '100px' } }, speed),
        h('button.btn.sm', { onclick: () => {
          const n = Number(count.value); if (!Number.isSafeInteger(n) || n < 0 || n > 100) { toast({ what: 'Bots: 0 to 100', state: 'failed', ttl: 3000 }); return; }
          run('Bot settings', '/bots', { count: n, intervalMs: Number(speed.value) }).catch(() => {});
        } }, 'Apply')),
        h('div.row', {}, seg([['run', 'Running'], ['pause', 'Paused']], s.bots?.paused ? 'pause' : 'run', v => run(v === 'pause' ? 'Pause bots' : 'Resume bots', '/bots', { paused: v === 'pause' }).catch(() => {})),
          h('button.btn.sm', { onclick: () => run('Bot step', '/bots/step', {}).catch(() => {}), 'data-tip': 'One bot tick, even while paused: every bot claims, then at most one transfer, craft, discovery or mint.' }, 'One step'),
          h('button.btn.sm.ghost', { onclick: () => run('Clear bot errors', '/bots', { resetErrors: true }).catch(() => {}) }, 'Clear errors'),
          h('a.linkbtn', { href: '#/lab', onclick: e => { e.preventDefault(); botsBox.scrollIntoView({ behavior: 'smooth' }); } }, 'See bots')))));
  }
  // External wallets are read from the extension itself; addresses are never pasted.
  function walletsPanel() {
    const found = { bitcoin: null, ethereum: null };
    const out = h('div');
    const draw = () => clear(out, kv([
      ['TAP wallet (regtest)', found.bitcoin ?? h('button.btn.sm', { onclick: connectTap }, 'Connect TAP wallet')],
      ['MetaMask (Anvil)', found.ethereum ?? h('button.btn.sm', { onclick: connectEth }, 'Connect MetaMask')],
    ]), h('div.row.end', { style: { padding: '8px 0 0' } }, h('button.btn.primary', { disabled: !found.bitcoin && !found.ethereum, onclick: fund }, 'Fund connected wallets')));
    const missing = name => toast({ what: `${name} not found`, detail: 'Install or enable it in this browser, then try again. Setup: playground/WALLETS.md.', state: 'failed', ttl: 6000 });
    async function connectTap() {
      if (!window.tapprotocol?.requestAccounts) { missing('TAP wallet extension'); return; }
      try { const [a] = await window.tapprotocol.requestAccounts(); if (!/^bcrt1/.test(a ?? '')) throw new Error('switch the TAP wallet to regtest'); found.bitcoin = a; draw(); }
      catch (e) { toast({ what: 'TAP wallet', detail: e.message, state: 'failed', ttl: 5000 }); }
    }
    async function connectEth() {
      if (!window.ethereum?.request) { missing('MetaMask'); return; }
      try { const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' }); found.ethereum = a; draw(); }
      catch (e) { toast({ what: 'MetaMask', detail: e.message, state: 'failed', ttl: 5000 }); }
    }
    async function fund() {
      const body = {}, rows = [];
      if (found.bitcoin) { body.bitcoin = found.bitcoin; rows.push(['TAP wallet', found.bitcoin]); }
      if (found.ethereum) { body.ethereum = found.ethereum; rows.push(['MetaMask', found.ethereum]); }
      if (await confirmModal({ title: 'Fund the connected test wallets?', rows, lead: 'Bitcoin: 1 regtest BTC and 10,000 TAP. Ethereum: 10 test ETH and 10,000 bridged TAP. Once per address pair; test funds only.', confirm: 'Fund' })) run('Fund test wallets', '/wallets/fund', body).catch(() => {});
    }
    draw();
    return panel('External test wallets', h('div.form', {},
      h('p.small.muted', { style: { margin: 0 } }, 'To pay from the TAP wallet extension or MetaMask instead of the built-in test wallets, connect them here and fund them with test money.'), out),
      { tip: 'Use fresh test accounts. Funding is idempotent for the same address pair.' });
  }


  function drawHealth(s) {
    const comps = s.components ?? [];
    clear(healthBox, comps.length ? h('div.health-grid', {}, comps.map(c => h('div', { 'data-tip': [c.url, c.pid ? `pid ${c.pid}` : null, c.detail ?? c.error].filter(Boolean).join('\n') || c.state },
      h('span', { class: `dot ${READY.test(String(c.state)) ? 'good' : /start|wait|sync/i.test(String(c.state)) ? 'warn' : 'bad'}` }), h('span.nm', {}, c.name), h('span.small.muted', {}, c.state))))
      : h('div.empty', {}, 'No components reported.'),
      h('div.row', { style: { padding: '8px 14px' } }, h('span.small.muted', {}, `Playground ${s.state ?? '–'} · network ${s.network ?? '–'} · history ${s.history?.kind ?? '–'}${s.history?.seedBlocks ? `, ${fmtInt(s.history.seedBlocks)} seeded blocks` : ''} · live feed ${stream.state}`), h('div', { style: { flex: 1 } }), inspectBtn('Status', s)));
  }
  const jobsTable = pagedTable({
    path: '/jobs', key: 'jobs', limit: 15,
    filters: [{ name: 'state', label: 'Show', value: '', options: [['', 'All'], ['failed', 'Failed'], ['running', 'Running']] }],
    sorts: [['created:desc', 'Newest first'], ['created:asc', 'Oldest first']],
    empty: 'No jobs yet.',
    columns: [
      { key: 'created', label: 'Started', render: j => h('span.mono.muted', {}, clock(j.created)) },
      { key: 'type', label: 'Job', render: j => jobName(j.type) },
      { key: 'state', label: 'State', render: j => pill(j.state, j.state === 'complete' ? 'good' : j.state === 'failed' ? 'bad' : 'warn') },
      { key: 'out', label: 'Outcome', render: j => j.state === 'failed' ? h('span.small', { style: { color: 'var(--bad)' } }, plainError(j.error)) : j.result?.tip !== undefined ? h('span.small.mono', {}, `tip ${fmtInt(j.result.tip)}`) : '' },
      { key: 'i', label: '', render: j => inspectBtn(jobName(j.type), j) },
    ],
  });
  clear(jobsBox, jobsTable.el);
  const botsTable = pagedTable({
    path: '/bots', key: 'agents', limit: 10,
    filters: [{ name: 'state', label: 'Show', value: '', options: [['', 'All'], ['error', 'With errors'], ['ready', 'Ready']] }],
    sorts: [['name:asc', 'Name'], ['strategy:asc', 'Strategy']],
    empty: 'No bots running.',
    columns: [
      { key: 'name', label: 'Bot', render: b => b.name },
      { key: 'strategy', label: 'Strategy', render: b => b.strategy ?? '–' },
      { key: 'address', label: 'Trac address', render: b => hashEl(b.address) },
      { key: 'state', label: 'State', render: b => b.error ? pill('error', 'bad', plainError(b.error)) : pill(b.state ?? 'ready', 'good') },
      { key: 'i', label: '', render: b => inspectBtn(b.name ?? 'Bot', b) },
    ],
  });
  clear(botsBox, botsTable.el);
  const diagTable = pagedTable({
    path: '/lab/feed', key: 'events', limit: 15,
    sorts: [['sequence:desc', 'Newest first'], ['sequence:asc', 'Oldest first']],
    empty: 'No diagnostic events yet.',
    columns: [
      { key: 'at', label: 'Time', render: e => h('span.mono.muted', {}, clock(e.at)) },
      { key: 'type', label: 'Kind', render: e => pill(e.type, e.data?.state === 'failed' || e.data?.error ? 'bad' : '') },
      { key: 'text', label: 'What happened', render: e => { const d = describe(e); return `${d.actor && d.actor !== 'World' && d.actor !== 'Lab' ? `${d.actor}: ` : ''}${d.text}`; } },
      { key: 'i', label: '', render: e => inspectBtn(`Lab event ${e.sequence ?? ''}`, e) },
    ],
  });
  clear(diagBox, diagTable.el);
  let diagTimer = null;
  const reloadDiag = () => { if (diagTimer) return; diagTimer = setTimeout(() => { diagTimer = null; diagTable.reload(); }, 1500); };
  let jobsTimer = null;
  const reloadJobs = () => { if (jobsTimer) return; jobsTimer = setTimeout(() => { jobsTimer = null; jobsTable.reload(); }, 1000); };
  const offs = [
    bus.on('status', draw),
    bus.on('lab:job', reloadJobs),
    bus.on('lab', reloadDiag),
    bus.on('lab:bot', () => botsTable.reload()),
  ];
  draw();
  store.refreshStatus().catch(() => {});
  return () => offs.forEach(f => f());
}
