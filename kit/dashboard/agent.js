// "My agent": the local dashboard's one extra page inside the site. It uses the
// console's own components; payment and inscription continue on the site's
// /mint/<request> page with the header's TAP Wallet / MetaMask connection.
import { h, clear, panel, table, hashEl, pill, toast, figures, short } from '/web/console/js/dom.js';
import { assetName, mineral } from '/web/console/js/words.js';
// Request states before the wallet can pay: the row shows a spinner until Pay appears (the list refreshes every 15 s).
const BEFORE_PAY = ['requested', 'authorizing', 'reserving', 'enrolling', 'awaiting_payment', 'partly_paid'];
const PAY_SOON = 'Your request is being recorded on the network. The Pay button appears here by itself, usually within one Bitcoin block (about 10 minutes).';

async function api(path, body) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({ error: 'request_failed' }));
  if (!response.ok) throw Error(result.error === 'login_required' ? 'Open the private link printed by your local dashboard.' : result.error ?? 'request_failed');
  return result;
}
const words = value => String(value ?? '').replace(/_/g, ' ');
const localPath = href => { try { const url = new URL(href, location.href); return url.pathname + url.search; } catch { return null; } };
const STATE_KIND = { awaiting_payment: 'warn', partly_paid: 'warn', permit_issued: 'info', paid: 'info', minted: 'good', expired: 'bad', failed: 'bad' };
const matter = (asset, name) => h('span.nowrap', {}, h('span.swatch', { style: { background: mineral(asset) } }), h('a', { href: '/pattern/' + asset }, name ?? assetName(asset)));
const go = path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); };

export function mount(el) {
  let stopped = false, cursor, next, offset = 0, busy = false;
  // One status callout under the title: busy while loading or signing, red on failure.
  const note = h('div.callout', { role: 'status', 'aria-live': 'polite' });
  const say = (text, kind = 'info') => { note.className = 'callout ' + kind; note.textContent = text; };
  const profile = h('div.stack', { style: { gap: '10px' } }), claims = h('div.public-mints'), requests = h('div.public-mints'), pager = h('div.pager-foot');
  let page = 1, mintable = null, open = null, more = { claims: false, requests: false }, info = null;
  const act = async (label, fn) => {
    if (busy) return; busy = true; if (label) say(label, 'busy');
    try { await fn(); if (label && note.textContent === label) clear(note); } catch (error) { say(words(error.message), 'bad'); } finally { busy = false; }
  };
  // The clicked button and a toast both show progress; a mint takes seconds.
  const mint = (row, button) => act('', async () => {
    const label = `${row.name ?? row.asset} · block ${row.block}`;
    const status = toast({ what: 'Minting ' + label, detail: 'Your agent is signing the mint request…', state: 'queued' });
    const idle = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Signing…'; button.classList.add('busy'); }
    say(`Minting ${label}: your agent is signing the mint request…`, 'busy');
    let result;
    try { result = await api('/api/mint', { asset: row.asset, block: row.block }); }
    catch (error) { status.set({ state: 'failed', detail: words(error.message) }); if (button) { button.disabled = false; button.textContent = idle; button.classList.remove('busy'); } throw error; }
    if (result.requestId) { status.set({ state: 'complete', detail: 'Request ready. Pay and inscribe with your wallet.' }); go('/mint/' + result.requestId); return; }
    status.set({ state: 'complete', detail: words(result.state ?? 'Request saved; it appears under Open requests.') });
    if (result.deploymentLink) { say('This pattern needs its first token deployment before it can be minted. Opening the deployment page.'); go(localPath(result.deploymentLink)); return; }
    say(words(result.state ?? 'Request is being prepared. It appears under Open requests.'));
    await load();
  });
  // Summary tiles: who the agent is, where its payouts go, and what waits on the pages shown below.
  const drawProfile = () => info && clear(profile,
    figures([
      ['Agent', h('a.mono', { href: '/agents/' + info.address, style: { fontSize: '15px' } }, short(info.address))],
      ['Payout TAP wallet', info.payoutAddress ? hashEl(info.payoutAddress) : pill('not bound', 'bad')],
      ['Ready to mint', mintable ?? '–', more.claims ? 'on this page; more on the next' : null],
      ['Open requests', open ?? '–', more.requests ? 'on this page; older ones follow' : null],
    ]),
    info.payoutAddress ? null : h('div.callout.bad', {}, 'No payout TAP wallet bound yet. Ask your agent to bind one before minting.'),
    h('p.muted', { style: { margin: 0 } }, 'Mint requests are signed here by your agent. You pay and inscribe on the request page with the wallet connected in the header (TAP Wallet, or MetaMask for bridged TAP).'));
  const drawClaims = data => {
    next = data.next; mintable = data.claims.filter(r => r.canMint).length; more.claims = !!next; drawProfile();
    clear(claims, data.claims.length ? table(data.claims, [
      { key: 'name', label: 'Block', render: r => h('div', {}, matter(r.asset, r.name), h('div.small.muted', {}, 'block ', h('a.mono', { href: '/block/' + r.block }, String(r.block)))) },
      { key: 'count', label: 'Units / balance', num: true, render: r => h('div', {}, h('span.mono', {}, `${r.count} / ${r.balance}`), r.balanceCurrent ? null : h('div.small.faint', {}, 'unverified')) },
      { key: 'state', label: 'Who may mint', render: r => h('div', {}, pill(words(r.eligibility ?? r.state), r.canMint ? 'good' : r.reason ? 'warn' : ''), r.reason ? h('div.small.muted', {}, r.reason === 'insufficient_balance' ? `Needs ${r.count} units, you hold ${r.balance}` : words(r.reason)) : null) },
      { key: 'action', label: '', render: r => r.canMint ? h('button.btn.sm.primary', { onclick: event => mint(r, event.currentTarget) }, 'Mint')
        : r.requestId ? h('a.btn.sm.ghost', { href: '/mint/' + r.requestId }, 'Open request')
        : r.deploymentLink ? h('a.btn.sm.ghost', { href: localPath(r.deploymentLink) }, 'Deploy pattern') : null },
    ], { sortable: false }) : h('div.empty', {}, next ? 'Nothing mintable on this page. Try the next page.' : 'No claimed blocks your agent may mint right now.'));
    clear(pager, h('span.pager-total', {}, `Page ${page}`),
      h('button.btn.sm.ghost', { disabled: !cursor, onclick: () => { cursor = undefined; page = 1; act('Loading…', loadClaims); } }, 'First page'),
      h('button.btn.sm.ghost', { disabled: !next, onclick: () => { cursor = next; page++; act('Loading…', loadClaims); } }, 'Next page'));
  };
  const requestPager = h('div.pager-foot');
  // Open requests: ten per page, newest first, with the page's range and Newest / Older buttons.
  const drawRequests = data => {
    open = data.requests.length; more.requests = data.next !== null; drawProfile();
    clear(requests, data.requests.length ? table(data.requests, [
      { key: 'asset', label: 'Pattern', render: r => matter(r.asset) }, { key: 'block', label: 'Block', num: true, render: r => r.block === undefined || r.block === null ? '—' : h('a.mono', { href: '/block/' + r.block }, String(r.block)) },
      { key: 'state', label: 'State', render: r => pill(words(r.state), STATE_KIND[r.state] ?? '') },
      { key: 'action', label: '', render: r => ['unknown', 'authorizing'].includes(r.state) && r.block !== undefined
        ? h('button.btn.sm', { onclick: event => mint(r, event.currentTarget) }, 'Resume')
        // Same conditions as the request page: Pay and mint with a set-aside; Inscribe only while the server is not sending.
        : h(!r.payable && BEFORE_PAY.includes(r.state) ? 'a.btn.sm.busy' : 'a.btn.sm', { href: '/mint/' + r.requestId, title: !r.payable && BEFORE_PAY.includes(r.state) ? PAY_SOON : null }, r.state === 'permit_issued' ? (!r.mintSender || ['needs_user', 'returning', 'returned'].includes(r.mintSender.state) ? 'Inscribe' : 'Open')
          : r.payable ? (r.mintFunding ? 'Pay and mint' : 'Pay') : BEFORE_PAY.includes(r.state) ? 'Preparing…' : 'Open') },
    ], { sortable: false }) : h('div.empty', {}, offset ? 'No more open requests.' : 'No open mint requests. Press Mint on a claimed block to start one.'));
    clear(requestPager, h('span.pager-total', {}, data.requests.length ? `${offset + 1}–${offset + data.requests.length}` : ''),
      h('button.btn.sm.ghost', { disabled: !offset, onclick: () => { offset = 0; act('Loading…', loadRequests); } }, 'Newest'),
      h('button.btn.sm.ghost', { disabled: data.next === null, onclick: () => { offset = data.next; act('Loading…', loadRequests); } }, 'Older requests'));
  };
  let linkOffset = 0;
  const links = h('div'), linkPager = h('div.pager-foot');
  const drawLinks = data => {
    clear(links, data.links.length ? table(data.links, [
      { key: 'block', label: 'Bitmap', render: r => r.block !== null ? h('a', { href: '/block/' + r.block }, `${r.block}.bitmap`) : '—' },
      { key: 'state', label: 'State', render: r => pill(words(r.state), r.state === 'linked' || r.state === 'accepted' ? 'good' : r.payable ? 'warn' : '') },
      { key: 'action', label: '', render: r => !r.payable && BEFORE_PAY.includes(r.state) ? h('a.btn.sm.busy', { href: r.paymentLink, title: PAY_SOON }, 'Preparing…') : h('a.btn.sm', { href: r.paymentLink }, r.payable ? 'Pay' : 'Open') },
    ], { sortable: false }) : h('div.empty', {}, linkOffset ? 'No more link requests.' : 'No Bitmap link requests yet.'));
    clear(linkPager, h('span.pager-total', {}, data.links.length ? `${linkOffset + 1}–${linkOffset + data.links.length}` : ''),
      h('button.btn.sm.ghost', { disabled: !linkOffset, onclick: () => { linkOffset = 0; act('Loading…', loadLinks); } }, 'Newest'),
      h('button.btn.sm.ghost', { disabled: data.next === null, onclick: () => { linkOffset = data.next; act('Loading…', loadLinks); } }, 'Older links'));
  };
  async function loadLinks() {
    const data = await api('/api/links?' + new URLSearchParams({ offset: String(linkOffset), limit: '10' })); if (!stopped) drawLinks(data);
  }
  async function loadRequests() {
    const data = await api('/api/requests?' + new URLSearchParams({ offset: String(offset), limit: '10' })); if (!stopped) drawRequests(data);
  }
  async function loadClaims() {
    let data;
    try { data = await api('/api/claims?' + new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}) })); }
    catch (error) { if (cursor && /cursor_stale/.test(error.message)) { cursor = undefined; page = 1; return loadClaims(); } throw error; }
    if (!stopped) drawClaims(data);
  }
  async function load() {
    info = await api('/api/info'); if (stopped) return; drawProfile();
    await loadClaims(); await loadRequests(); await loadLinks();
  }
  clear(el, h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'My agent'), h('p', {}, 'Your agent’s claimed blocks, with one click to mint. Everything else on this dashboard is the live site.'))),
    h('div.stack', {}, note, profile,
      panel('Claimed blocks you may mint', h('div', {}, h('p.muted', { style: { margin: 0, padding: '10px 14px', borderBottom: '1px solid var(--rule-2)' } },
        'During the finder’s week only the finder mints; afterwards any agent can. Bitmap holders earn 15% of every mint on their plot. Minting requires enough units. Unclaimed blocks after their week are public: see ', h('a', { href: '/mint' }, 'Mint'), '.'), claims, pager), { flush: true }),
      h('div.grid.cols-main', {},
        panel('Open requests', h('div', {}, requests, requestPager), { flush: true }),
        panel('Bitmap links', h('div', {}, h('p.muted', { style: { margin: 0, padding: '10px 14px', borderBottom: '1px solid var(--rule-2)' } }, 'Earn the Bitmap holder share for a block you hold as a .bitmap. ',
          h('a.btn.sm.primary', { href: '/link#bitmap' }, 'Link a Bitmap')), links, linkPager), { flush: true })))));
  act('Loading your agent…', load).then(() => { if (!stopped && note.textContent === 'Loading your agent…') clear(note); });
  const timer = setInterval(() => { if (!busy && !document.hidden) load().catch(() => {}); }, 15000);
  return () => { stopped = true; clearInterval(timer); };
}
