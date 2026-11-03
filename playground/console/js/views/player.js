import { h, clear, table, kv, pill, hashEl, fmtInt, tabs, field, input, select, panel, figures, confirmModal, cell, tipIcon, toast, inspectBtn, short } from '../dom.js';
import { get, bus, store } from '../api.js';
import { mineral, assetName, assetKind, mintRule, title, fieldName, FIELDS, PAYMENT_STATE, who, isMe } from '../words.js';
import { run, payWhenReady, requestTarget, feeTerms, linkFlow } from '../flows.js';
import { playerMintFlow as mintFlow, playerCompoundMintFlow as compoundMintFlow, savedMintRequests, savedMintIntents } from '../inscribe/flow.js';
import { tap, eth, btc, fee, splitTable, feePrice } from '../money.js';
import { pagedTable } from '../paged.js';

export function mount(root, params) {
  let tab = params.do ?? 'claim';
  let bots = [];
  const head = h('div.page-head');
  const left = h('div.stack');
  const right = h('div.stack');
  root.append(h('div.page', {}, head, h('div.grid.cols-main', {}, left, right)));
  get('/bots').then(b => { bots = b.agents ?? []; drawActions(); }).catch(() => {});

  // Panels are built once; player updates refresh the figures and reload each list's current page.
  const figuresBox = h('div'), walletBox = h('div');
  const pagers = [];
  const pagedPanel = (title, opts, panelOpts) => { const t = pagedTable(opts); pagers.push(t); return panel(title, t.el, { flush: true, ...panelOpts }); };
  let updateNameField = () => {};
  let built = false;
  const draw = () => {
    const p = store.player;
    if (!p) { clear(left, h('div.empty', {}, 'Loading your player…')); return; }
    const w = p.wallets ?? {};
    clear(head, h('div.grow', {}, h('h1', {}, 'My player'),
      h('p', {}, 'Your agent on the local networks. Mining, claiming, discovering and crafting are free; only minting on-chain and Bitmap links cost TAP.')),
      h('div.small.muted', {}, 'Trac address ', hashEl(p.address, short(p.address, 10, 6)), ' · ', h('a', { href: `https://dmtworld.tap-protocol.com/agents/${encodeURIComponent(p.address)}`, target: '_blank', rel: 'noopener' }, 'Public profile')));
    clear(figuresBox, figures([
      ['Kinds of matter', fmtInt(p.counts?.balances ?? (p.balances ?? []).filter(b => b.amount !== '0').length), 'on Trac'],
      ['Test TAP (Bitcoin)', tap(w.bitcoin?.tap).replace(' TAP', ''), 'TAP wallet', 'Mint fees are paid before the permit; your wallet then inscribes the mint.'],
      ['Test BTC', btc(w.bitcoin?.btc).replace(' BTC', ''), 'regtest'],
      ['Test ETH (Anvil)', eth(w.ethereum?.balance).replace(' ETH', ''), 'pays gas', 'Bridged TAP in this account pays mints through the escrow contract.'],
    ]));
    clear(walletBox, walletsPanel(w));
    if (!built) { built = true; clear(left, figuresBox, balancesPanel(), rightsPanel(), pendingPanel(), historyPanel(), walletBox); }
    else reloadLists();
  };
  let reloadTimer = null;
  function reloadLists() { if (reloadTimer) return; reloadTimer = setTimeout(() => { reloadTimer = null; for (const t of [...pagers, ...formPagers]) t.reload(); }, 800); }

  function balancesPanel() {
    return pagedPanel('Balances', {
      path: '/player/balances', key: 'balances', limit: 25, filters: [{ name: 'nonzero', label: 'Show', value: 'true', options: [['true', 'Held'], ['', 'All']] }],
      sorts: [['asset:asc', 'Matter'], ['amount:desc', 'Most units']],
      empty: 'No matter yet. Claim finds across history; each round is drawn when its deciding block arrives.',
      columns: [
        { key: 'name', label: 'Matter', render: b => h('span', {}, h('span.swatch', { style: { background: mineral(b.asset) } }), assetName(b.asset)) },
        { key: 'kind', label: 'Kind', render: b => { const k = assetKind(b.asset); return h('span.small.muted', {}, k === 'pattern' ? fieldName(store.pattern(b.asset)) : k); } },
        { key: 'amount', label: 'Units', num: true },
        { key: 'act', label: '', render: b => b.amount === '0' ? null : h('div.row.end', {},
          h('button.btn.sm.ghost', { onclick: () => pickTab('transfer', { asset: b.asset }) }, 'Send'),
          assetKind(b.asset) === 'compound' ? h('button.btn.sm', { onclick: () => compoundMintFlow(b.asset) }, 'Mint On-Chain')
            : h('button.btn.sm', { onclick: () => mintFlow({ asset: b.asset }) }, 'Mint On-Chain')) },
      ],
    }, { tip: 'Matter is fungible on Trac: units of one pattern can be sent or crafted in any amount.' });
  }
  function rightsPanel() {
    const counted = () => store.status?.counted;
    return pagedPanel('Mint rights', {
      path: '/player/mintRights', key: 'mintRights', limit: 25,
      filters: [{ name: 'whoMayMint', label: 'Show', value: '', options: [['', 'All slots'], ['me', 'Ready to mint'], ['finder', 'Finder window'], ['landowner', 'Bitmap holder'], ['public', 'Anyone']] }],
      sorts: [['block:desc', 'Newest block'], ['block:asc', 'Oldest block'], ['amount:desc', 'Most units'], ['finderUntil:asc', 'Finder window ends soonest']],
      empty: 'Nothing in this view. Finds you win show up here, and so do blocks anyone may mint.',
      columns: [
        { key: 'asset', label: 'Matter', render: r => h('span', {}, h('span.swatch', { style: { background: mineral(r.asset) } }), assetName(r.asset)) },
        { key: 'block', label: 'Block', num: true, render: r => h('a.mono', { href: `#/world?b=${r.block}` }, fmtInt(r.block)) },
        { key: 'amount', label: 'Units', num: true },
        { key: 'rule', label: 'Who may mint', render: r => { const rule = mintRule(r, counted()); return h('span', {}, pill(rule.label, rule.kind), tipIcon(rule.text)); } },
        { key: 'finderUntil', label: 'Finder window ends', num: true, render: r => !r.finderUntil ? h('span.faint', {}, '–') : counted() >= r.finderUntil ? h('span.faint', { 'data-tip': `Ended at block ${fmtInt(r.finderUntil)}` }, 'ended') : h('span.mono', {}, fmtInt(r.finderUntil)) },
        { key: 'go', label: '', render: r => (r.allowed || r.rightAllowed && r.reason === 'asset_unregistered' && BigInt(r.balance ?? '0') >= BigInt(r.amount)) && !r.minted && !r.pending ? h('button.btn.sm.primary', { onclick: () => mintFlow({ asset: r.asset, block: r.block, amount: r.amount }) }, 'Mint On-Chain') : null },
      ],
    }, { tip: 'During the finder’s week only the finder mints; afterwards any agent can. Bitmap holders earn 15% of every mint on their plot.' });
  }
  function pendingPanel() {
    const KIND = { awaiting_payment: 'warn', partly_paid: 'warn', paid: 'info', permit_issued: 'info', minted: 'good', waiting_payment: 'warn', complete: 'good', failed: 'bad', expired: '', refunded: '', cancelled: '' };
    const label = st => { const v = PAYMENT_STATE[st] ?? String(st ?? '–').replace(/_/g, ' '); return [v[0].toUpperCase() + v.slice(1), KIND[st] ?? 'info']; };
    return pagedPanel('Payments', {
      path: '/player/pendingPayments', key: 'pendingPayments', limit: 10,
      filters: [{ name: 'state', label: 'Show', value: '', options: [['', 'All'], ['awaiting_payment', 'Awaiting mint payment'], ['partly_paid', 'Partly paid'], ['permit_issued', 'Permit ready'], ['waiting_payment', 'Awaiting link payment']] }],
      sorts: [['id:asc', 'Request'], ['price:desc', 'Highest fee'], ['state:asc', 'State']],
      empty: 'No payments in flight. For a mint, pay first, wait for the permit, then inscribe from your wallet.',
      columns: [
        { key: 'what', label: 'For', render: r => { const t = requestTarget(r); return t.asset ? h('span', {}, h('span.swatch', { style: { background: mineral(t.asset) } }), `${assetName(t.asset)}${t.block !== null && t.block !== undefined ? ` · block ${fmtInt(t.block)}` : ''}`) : t.type; } },
        { key: 'price', label: 'Fee', num: true, render: r => h('span.mono', {}, fee(r.price, r.kind, r.unit)) },
        { key: 'kind', label: 'Paid with', render: r => r.kind === 'ethereum' ? 'Bridged TAP' : r.kind === 'tap' ? 'TAP' : cell(r.kind) },
        { key: 'state', label: 'State', render: r => { const [l, k] = label(r.state); return pill(l, k, r.reason ? String(r.reason).replace(/_/g, ' ') : undefined); } },
        { key: 'inscription', label: 'Inscription', render: r => r.inscription ? hashEl(r.inscription) : h('span.faint', {}, '–') },
        { key: 'pay', label: '', render: r => ['awaiting_payment', 'partly_paid', 'paid', 'permit_issued'].includes(r.state) ? h('button.btn.sm.primary', { onclick: () => mintFlow({ id: r.requestId ?? r.id }) }, 'Continue mint') : r.state === 'waiting_payment' ? h('button.btn.sm.primary', { onclick: () => payPending(r) }, 'Pay now') : inspectBtn('Payment', r) },
      ],
    }, { tip: 'Mint and link payments in flight. Finished ones are in Results.' });
  }
  async function payPending(r) {
    const t = requestTarget(r), type = /link/i.test(t.type) ? 'link' : 'mint';
    if (type === 'mint') { mintFlow({ id: r.requestId ?? r.id }); return; }
    if (await confirmModal({ title: 'Pay this request?', rows: [['For', t.asset ? `${assetName(t.asset)}${t.block !== null ? ` from block ${fmtInt(t.block)}` : ''}` : type], ['Fee', fee(r.price, r.kind, r.unit)], ['Paid with', r.kind === 'ethereum' ? 'bridged TAP (escrow on Anvil)' : 'test TAP wallet (payment lock)']], confirm: 'Pay' })) payWhenReady(r.id, type).catch(() => {});
  }
  const HISTORY = { claim: 'Claim', header: 'Header', discovery: 'Discovery', craft: 'Craft', mint: 'Mint', link: 'Bitmap link', bitmap: 'Test Bitmap', tx: 'Transfer', pay: 'Payment' };
  function historyPanel() {
    return pagedPanel('History', {
      path: '/player/history', key: 'history', limit: 20,
      filters: [{ name: 'type', label: 'Type', value: '', options: [['', 'All'], ...Object.entries(HISTORY)] }],
      sorts: [['sequence:desc', 'Newest first'], ['sequence:asc', 'Oldest first']],
      empty: 'Your actions will be listed here.',
      columns: [
        { key: 'type', label: 'Action', render: r => HISTORY[r.type ?? String(r.id).split('/')[0]] ?? String(r.type ?? r.id).replace(/[-_]/g, ' ') },
        { key: 'what', label: 'Detail', render: r => h('span.small.muted', {}, String(r.id ?? '').split('/').slice(1).join(' · ').replace(/-[a-z0-9]{8}$/, '')) },
        { key: 'state', label: 'State', render: r => pill(String(r.state ?? '–').replace(/_/g, ' '), /received|submitted|accepted|complete/.test(r.state) ? 'good' : /fail|reject/.test(r.state) ? 'bad' : '') },
        { key: 'i', label: '', render: r => inspectBtn('History entry', r) },
      ],
    });
  }
  function walletsPanel(w) {
    return panel('Test wallets', kv([
      ['Playground TAP wallet', hashEl(w.bitcoin?.address), 'Mint payments and inscriptions use the TAP Wallet you connect in the mint flow.'],
      ['Receives mints', hashEl(w.bitcoin?.receiver), 'Minted block inscriptions and their DMT tokens arrive here.'],
      w.bitcoin?.bitmapAddress ? ['Holds Bitmaps', hashEl(w.bitcoin.bitmapAddress)] : null,
      ['Test BTC', btc(w.bitcoin?.btc)], ['Test TAP', tap(w.bitcoin?.tap)],
      ['Ethereum account', hashEl(w.ethereum?.address)], ['Chain', w.ethereum?.chainId ? `Anvil · chain ${w.ethereum.chainId}` : null],
      ['Test ETH', eth(w.ethereum?.balance)], ['Bridged TAP token', hashEl(w.ethereum?.token)], ['Escrow contract', hashEl(w.ethereum?.escrow)],
    ]), { tip: 'Funded test wallets. Nothing here is real money.' });
  }

  // Actions
  const actionsBox = h('section.panel');
  right.append(actionsBox);
  let prefill = {};
  function pickTab(t, pre = {}) { tab = t; prefill = pre; drawActions(); actionsBox.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  // Paged lists inside the action tabs; recreated with the tab, reloaded on player updates.
  let formPagers = [];
  function formPaged(opts) { const t = pagedTable(opts); formPagers.push(t); return h('div.panel', { style: { marginTop: '4px' } }, t.el); }
  function drawActions() {
    updateNameField = () => {};
    formPagers = [];
    const body = h('div.body');
    clear(actionsBox, h('header', {}, h('h2', {}, 'Play')),
      tabs([['claim', 'Claim'], ['discover', 'Discover'], ['craft', 'Craft'], ['transfer', 'Send'], ['mint', 'Mint'], ['bitmap', 'Bitmap']], t => { tab = t; prefill = {}; drawActions(); }, tab),
      body);
    const forms = { claim: claimForm, discover: discoverForm, craft: craftForm, transfer: transferForm, mint: mintForm, bitmap: bitmapForm };
    body.append((forms[tab] ?? claimForm)());
  }

  function claimForm() {
    const blockIn = input({ class: 'mono', inputmode: 'numeric', placeholder: 'e.g. ' + (store.status?.tip ?? 2100), 'aria-label': 'Block' });
    const pats = h('div.row', {}, h('span.small.muted', {}, 'Enter any historical block to see its unfound patterns.'));
    let choices = [];
    const loadPats = async () => {
      const n = Number(blockIn.value); if (!Number.isSafeInteger(n) || n < 0) return;
      try {
        const b = await get(`/blocks/${n}`);
        // A new batch makes the cursor stale: read the list again from its first page.
        const all = async (path, key, restarts = 0) => { const rows = []; let cursor; do { let page; try { page = await get(path + '?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); } catch (e) { if (!cursor || e.message !== 'page_cursor_stale' || restarts >= 3) throw e; return all(path, key, restarts + 1); } rows.push(...(page[key] ?? [])); cursor = page.next; } while (cursor); return rows; };
        [b.matches, b.finds] = await Promise.all([all(`/blocks/${n}/matches`, 'matches'), all(`/blocks/${n}/finds`, 'finds')]);
        choices = (b.matches ?? []).filter(m => m.count > 0 && !m.finder && !m.minted && !(b.finds ?? []).some(f => f.asset === m.asset)).map(m => ({ number: m.pattern ?? m.number ?? store.pattern(m.asset)?.number, asset: m.asset ?? store.pattern(m.pattern)?.asset, count: m.count, on: true }));
        clear(pats,
          choices.length ? choices.map(c => h('label.check', {}, h('input', { type: 'checkbox', checked: true, onchange: e => { c.on = e.target.checked; } }), h('span.swatch', { style: { background: mineral(c.asset) } }), `${assetName(c.asset)} · ${fmtInt(c.count)}`))
            : h('span.small.muted', {}, 'No unfound pattern remains in this block.'));
      } catch (e) { clear(pats, h('span.small', { style: { color: 'var(--bad)' } }, e.message)); }
    };
    blockIn.addEventListener('change', loadPats);
    return h('div.form', {},
      h('p.small.muted', { style: { margin: 0 } }, 'Claim unfound patterns in any counted historical block, within your per-round budget. Each claim enters a draw decided by a later block hash; a receipt is not a win.'),
      h('div.row', {},
        h('button.btn.primary', { onclick: async () => { if (await confirmModal({ title: 'Claim historical matches?', lead: 'The kit searches your local history and excludes found or minted slots.', confirm: 'Claim' })) run('Claim', '/player/claim', {}).catch(() => {}); } }, 'Claim historical matches'),
        h('button.btn', { onclick: () => run('Send header', '/player/header', {}).catch(() => {}), 'data-tip': 'Send the current tip’s header to enter its draw for unclaimed patterns.' }, 'Send header')),
      h('div.section-label', { style: { padding: '6px 0 0' } }, 'Or choose a block'),
      h('div.two', {}, field('Block', blockIn), h('div.field', {}, h('label', {}, ' '), h('button.btn', { type: 'button', onclick: loadPats }, 'Show patterns'))),
      pats,
      h('div.row.end', {}, h('button.btn', { onclick: async () => {
        const n = Number(blockIn.value), sel = choices.filter(c => c.on && c.number !== undefined).map(c => c.number);
        if (!Number.isSafeInteger(n) || !sel.length || sel.length > (store.status?.settings?.claimsPerWindow ?? 100)) { toast({ what: 'Choose a block and patterns within your round budget', state: 'failed', ttl: 3500 }); return; }
        if (await confirmModal({ title: `Claim in block ${fmtInt(n)}?`, rows: [['Block', fmtInt(n)], ['Patterns', sel.map(x => assetName(store.pattern(x)?.asset)).join(', ')]], confirm: 'Claim' })) run('Claim', '/player/claim', { plots: [{ block: n, patterns: sel }] }).catch(() => {});
      } }, 'Claim these')));
  }

  function discoverForm() {
    let plain = store.status?.plainNames === true;
    const prefix = h('span.mono.muted', {}, plain ? '' : 'dmw');
    const name = input({ class: 'mono', placeholder: 'mypattern', 'aria-label': plain ? 'Name' : 'Name after dmw', maxlength: plain ? 32 : 29 });
    updateNameField = () => {
      plain = store.status?.plainNames === true;
      prefix.textContent = plain ? '' : 'dmw';
      name.setAttribute('aria-label', plain ? 'Name' : 'Name after dmw');
      name.maxLength = plain ? 32 : 29;
    };
    const pat = input({ class: 'mono', placeholder: 'e.g. 7{3}', 'aria-label': 'Rule' });
    const fld = select([['4:n', 'Height · match count'], ['10:n', 'Nonce · match count'], ['11:n', 'Bits (decimal) · match count'], ['11:h', 'Bits (hex) · match count'],
      ['4:n:field-value', 'Height · field value'], ['10:n:field-value', 'Nonce · field value'], ['11:n:field-value', 'Bits (decimal) · field value'], ['11:h:field-value', 'Bits (hex) · field value']]);
    const check = h('div.small.muted', {}, 'Allowed: digits, a–f, [ranges], {n,m}, ?, ^, $ and | (up to 4 branches, 64 characters, 6 literal digits).');
    const validate = () => {
      const v = pat.value.trim(), n = name.value.trim(), problems = [];
      if (!(plain ? /^[a-z0-9]{3,32}$/ : /^[a-z0-9]{2,29}$/).test(n)) problems.push(plain ? 'name: 3–32 lowercase letters or digits' : 'name: 2–29 lowercase letters or digits');
      if (!v) problems.push('rule is empty');
      else if (v.length > 64) problems.push('rule is longer than 64 characters');
      else if (!/^[0-9a-f[\]{}\-,?|^$]+$/.test(v)) problems.push('rule uses characters outside the allowed set');
      else { try { const re = new RegExp(v); if (re.test('')) problems.push('rule matches an empty value'); } catch { problems.push('rule is not a valid expression'); } }
      if ((v.split('|').length) > 4) problems.push('more than 4 branches');
      clear(check, problems.length ? h('span', { style: { color: 'var(--bad)' } }, problems.join(' · ')) : h('span', { style: { color: 'var(--good)' } }, 'Looks valid. The committee still checks rarity (at least 3 blocks in history) and duplicates.'));
      return !problems.length;
    };
    name.addEventListener('input', validate); pat.addEventListener('input', validate);
    return h('div.form', {},
      h('p.small.muted', { style: { margin: 0 } }, 'Propose a new pattern type. First commit a hidden fingerprint, then reveal it at least two blocks later, so nobody can copy it.'),
      h('div.two', {}, field('Name', h('div.row', { style: { flexWrap: 'nowrap', gap: '4px' } }, prefix, name)), field('Field', fld)),
      field('Rule', pat), check,
      h('div.row.end', {}, h('button.btn.primary', { onclick: async () => {
        if (!validate()) return;
        const [f, dt, amountMode] = fld.value.split(':'), proposal = { name: `${plain ? '' : 'dmw'}${name.value.trim()}`, pat: pat.value.trim(), fld: Number(f), dt, ...(amountMode ? { amountMode } : {}) };
        const actionId = `${proposal.name}-${Date.now().toString(36)}`;
        if (!await confirmModal({ title: 'Commit this discovery?', rows: [['Name', title(proposal.name)], ['Rule', h('code', {}, proposal.pat)], ['Field', FIELDS[proposal.fld] + (proposal.fld === 11 ? (dt === 'h' ? ' (hex)' : ' (decimal)') : '') + (amountMode === 'field-value' ? ' · field value' : ' · match count')]], lead: 'Only a fingerprint is published now. If accepted, your name goes on the periodic table and you earn 5 % of every mint fee for it.', confirm: 'Commit' })) return;
        try { await run('Discovery commit', '/player/discovery/commit', { actionId, proposal }); await store.refreshPlayer(); }
        catch { /* shown in the toast */ }
      } }, 'Commit')),
      h('div.section-label', { style: { padding: '6px 0 0' } }, 'Your commitments'),
      commitsList());
  }

  function commitsList() {
    const tip = () => store.status?.tip ?? 0;
    return formPaged({
      path: '/player/discoveries', key: 'discoveries', limit: 10,
      filters: [{ name: 'state', label: 'Show', value: '', options: [['', 'All'], ['committed', 'Committed'], ['accepted', 'On the table'], ['rejected', 'Rejected']] }],
      sorts: [['revealFrom:desc', 'Newest'], ['name:asc', 'Name']],
      empty: 'None yet.',
      columns: [
        { key: 'name', label: 'Pattern', render: c => title(c.name) },
        { key: 'pat', label: 'Rule', render: c => h('code', {}, c.pat) },
        { key: 'when', label: 'Reveal window', render: c => c.revealFrom ? h('span.mono', {}, `${fmtInt(c.revealFrom)}–${fmtInt(c.revealUntil)}`) : h('span.faint', {}, '–') },
        { key: 'state', label: 'State', render: c => c.state === 'accepted' ? pill('On the table', 'good') : c.state === 'rejected' ? pill('Rejected', 'bad', c.reason ? String(c.reason).replace(/_/g, ' ') : undefined) : c.state === 'revealed' ? pill('Revealed, being checked', 'info') : c.revealUntil && tip() > c.revealUntil ? pill('Reveal window missed', '') : pill('Committed', 'warn') },
        { key: 'act', label: '', render: c => c.state !== 'committed' || (c.revealUntil && tip() > c.revealUntil) ? null : h('button.btn.sm', {
          disabled: c.revealFrom && tip() < c.revealFrom, 'data-tip': c.revealFrom && tip() < c.revealFrom ? `Opens at block ${fmtInt(c.revealFrom)}. Mine a few blocks in the Lab.` : undefined,
          onclick: async () => { try { await run('Discovery reveal', '/player/discovery/reveal', { actionId: c.actionId }); await store.refreshPlayer(); } catch { /* toast */ } } }, 'Reveal') },
      ],
    });
  }

  function assetRows(initial) {
    const list = (store.player?.balances ?? []).filter(b => b.amount !== '0');
    const rows = [];
    const box = h('div.stack', { style: { gap: '8px' } });
    const add = (asset = initial ?? list[0]?.asset, amount = '1') => {
      const sel = select(list.map(b => [b.asset, `${assetName(b.asset)} · ${fmtInt(b.amount)} held`]), { value: asset, 'aria-label': 'Matter' });
      const amt = input({ class: 'mono', value: amount, inputmode: 'numeric', 'aria-label': 'Units', style: { width: '110px' } });
      const row = { sel, amt, el: h('div.row', { style: { flexWrap: 'nowrap' } }, sel, amt, h('button.btn.sm.ghost', { type: 'button', 'aria-label': 'Remove', onclick: () => { rows.splice(rows.indexOf(row), 1); row.el.remove(); } }, '×')) };
      rows.push(row); box.append(row.el);
    };
    if (list.length) add();
    const el = h('div', {}, box, list.length ? h('button.linkbtn', { type: 'button', onclick: () => add(), style: { marginTop: '6px' } }, '+ add matter') : h('div.small.muted', {}, 'You hold no matter yet.'));
    return {
      el,
      value() {
        const out = rows.map(r => [r.sel.value, r.amt.value.trim()]);
        for (const [a, n] of out) {
          const held = list.find(b => b.asset === a)?.amount ?? '0';
          if (!/^[1-9]\d*$/.test(n) || BigInt(n) > BigInt(held)) throw new Error(`${assetName(a)}: between 1 and ${fmtInt(held)} units`);
        }
        if (!out.length) throw new Error('add at least one kind of matter');
        return out;
      },
    };
  }
  const assetSummary = list => list.map(([a, n]) => `${fmtInt(n)} ${assetName(a)}`).join(', ');
  // Other players are picked by name; keys never appear in a form.
  function playerPicker() {
    const list = bots.filter(b => !isMe(b.address));
    const el = select(list.length ? list.map(b => [b.address, `${b.name}${b.strategy ? ` · ${b.strategy}` : ''}`]) : [['', 'No other players yet']], { 'aria-label': 'Player' });
    if (!list.length) el.disabled = true;
    return el;
  }

  function craftForm() {
    const recipe = input({ class: 'mono', value: 'fusion', 'aria-label': 'Recipe', list: 'recipes' });
    const rows = assetRows();
    return h('div.form', {},
      h('p.small.muted', { style: { margin: 0 } }, 'Combine units of patterns into a compound. Inputs are used up; the compound\'s properties and rarity follow public formulas from the inputs.'),
      field('Recipe', h('div', {}, recipe, h('datalist', { id: 'recipes' }, h('option', { value: 'fusion' })))),
      field('Inputs', rows.el),
      h('div.row.end', {}, h('button.btn.primary', { onclick: async () => {
        let inputs; try { inputs = rows.value(); } catch (e) { toast({ what: 'Check the inputs', detail: e.message, state: 'failed', ttl: 4000 }); return; }
        if (await confirmModal({ title: 'Craft a compound?', rows: [['Recipe', recipe.value], ['Used up', assetSummary(inputs)]], lead: 'Crafting is free. The inputs cannot be recovered.', confirm: 'Craft' })) run('Craft', '/player/craft', { recipe: recipe.value.trim(), inputs }).catch(() => {});
      } }, 'Craft')));
  }

  function transferForm() {
    const to = playerPicker();
    const rows = assetRows(prefill.asset);
    return h('div.form', {},
      h('p.small.muted', { style: { margin: 0 } }, 'Send matter to another agent on Trac. Paid with test TNK from your Trac account.'),
      field('To', to, 'Players on this playground, by name.'), field('Matter', rows.el),
      h('div.row.end', {}, h('button.btn.primary', { onclick: async () => {
        const dest = to.value; let assets;
        try { if (!dest) throw new Error('pick a player'); assets = rows.value(); } catch (e) { toast({ what: 'Check the transfer', detail: e.message, state: 'failed', ttl: 4000 }); return; }
        if (await confirmModal({ title: 'Send matter?', rows: [['To', who(dest)], ['Matter', assetSummary(assets)]], lead: 'A plain gift: nothing comes back.', confirm: 'Send' })) run('Transfer', '/player/transfer', { to: dest, assets }).catch(() => {});
      } }, 'Send')));
  }

  function mintForm() {
    const comp = (store.player?.balances ?? []).filter(b => b.amount !== '0' && assetKind(b.asset) === 'compound');
    return h('div.form', {},
      h('p.small.muted', { style: { margin: 0 } }, 'Pay the quote from your TAP Wallet. Making real into the official ticker uses your units up; another ticker holds them until completion or refund. After payment is final, your permit is ready. You then inscribe to your own Bitcoin address and pay your own miner fees.'),
      kv([['Who may mint a block', 'During the finder’s week only the finder mints; afterwards any agent can. Bitmap holders earn 15% of every mint on their plot.'],
        ['Fee', feePrice(store.status?.feePolicy, 'find-all')], ['Split', 'Finder 30 % · Bitmap holder 15 % (burned if unlinked) · burned 20 % · discoverer 5 % · treasury 30 %']]),
      h('div.row', {}, h('button.btn.primary', { onclick: () => mintFlow({}) }, 'Choose a block to mint')),
      savedMintIntents().length ? h('div', {}, h('h3', {}, 'Resume a quote'), ...savedMintIntents().map(intent => h('button.btn.sm', { onclick: () => mintFlow({ resumeIntent: intent }) }, `${assetName(intent.asset)} · ${intent.actionId}`))) : null,
      savedMintRequests().length ? h('div', {}, h('h3', {}, 'Resume a saved mint'), ...savedMintRequests().map(id => h('button.btn.sm', { onclick: () => mintFlow({ id }) }, short(id, 12, 6)))) : null,
      comp.length ? h('div', {}, h('div.section-label', { style: { padding: '6px 0 0' } }, 'Compounds'), h('div.row', {}, comp.map(c => h('button.btn.sm', { onclick: () => compoundMintFlow(c.asset) }, `Mint ${assetName(c.asset)}`)))) : null);
  }

  function bitmapForm() {
    const terms = feeTerms('link');
    return h('div.form', {},
      h('p.small.muted', { style: { margin: 0 } }, terms?.total === '0' ? 'Free. Link a Bitmap you hold to its plot; the link stays with the Bitmap.' : 'Link a Bitmap you hold to its plot. Bitmap holders earn 15% of every mint on their plot. During the finder’s week only the finder mints; afterwards any agent can. Paid once; the link stays with the Bitmap.'),
      terms ? h('div', {}, h('div.small', {}, h('strong', {}, `Link fee ${terms.total === '0' ? 'Free' : tap(terms.total)}`), ' · once'), splitTable(terms.split)) : null,
      h('div.section-label', { style: { padding: '6px 0 0' } }, 'Your Bitmaps'),
      formPaged({
        path: '/player/bitmaps', key: 'bitmaps', limit: 10,
        filters: [{ name: 'linked', label: 'Show', value: '', options: [['', 'All'], ['false', 'Not linked'], ['true', 'Linked']] }],
        sorts: [['height:asc', 'Block']],
        empty: 'You hold no Bitmap yet. Pick a plot on the World map to get a test Bitmap.',
        columns: [
          { key: 'height', label: 'Bitmap', num: true, render: b => h('a.mono', { href: `#/world?b=${b.height}` }, `${fmtInt(b.height)}.bitmap`) },
          { key: 'linked', label: 'Link', render: b => b.linked ? pill('Linked', 'ink') : pill('Not linked') },
          { key: 'go', label: '', render: b => b.linked ? inspectBtn('Bitmap', b) : h('button.btn.sm.primary', { onclick: async () => { if (await linkFlow(b.height)) reloadLists(); } }, terms?.total === '0' ? 'Link for free' : 'Link and pay') },
        ],
      }),
      h('div.row', {}, h('a.btn', { href: '#/world' }, 'Open the World map')));
  }

  draw(); drawActions();
  const offs = [bus.on('player', draw), bus.on('patterns', draw), bus.on('status', () => updateNameField())];
  store.refreshPlayer().catch(() => {});
  const cleanup = () => offs.forEach(f => f());
  cleanup.update = p => { if (p.do) pickTab(p.do); };
  return cleanup;
}
