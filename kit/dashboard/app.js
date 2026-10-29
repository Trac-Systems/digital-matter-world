import { TapWalletMint } from './wallet.js';

const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const append = (parent, ...nodes) => { parent.append(...nodes.filter(Boolean)); return parent; };
const button = (label, action) => { const node = el('button', label, 'btn'); node.type = 'button'; node.addEventListener('click', () => attempt(action)); return node; };
async function api(path, body) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error === 'login_required' ? 'Open the private link printed by your local dashboard.' : result.error);
  return result;
}
// Keep uncertain payment markers and signed reveals on the owner's machine,
// independent of the free HTTP port chosen at the next dashboard start.
class LocalWalletJournal {
  constructor() { this.owner = crypto.randomUUID(); }
  async get(key) { return (await api('/api/wallet?key=' + encodeURIComponent(key))).value; }
  put(key, value) { return api('/api/wallet', { key, value, owner: this.owner }); }
  async lock(key, action) {
    await api('/api/wallet-lock', { key, owner: this.owner });
    try { return await action(); } finally { await api('/api/wallet-lock', { key, owner: this.owner, release: true }); }
  }
}
const root = document.getElementById('app'), page = el('div', undefined, 'page');
const note = el('p', '', 'note'); note.role = 'status'; note.setAttribute('aria-live', 'polite');
const payout = el('p', '', 'mono'), owner = el('p', '', 'small muted');
const rows = el('tbody'), requests = el('div', undefined, 'stack'), payment = el('div', undefined, 'stack');
const table = el('table'), head = el('tr');
for (const label of ['Pattern', 'Block', 'Units / balance', 'Eligibility / state', '']) head.append(el('th', label));
append(table, append(el('thead'), head), rows);
let info, cursor, next, busy = false, activeId, wallet, timer, requestOffset = 0;
const paymentDrafts = new Map();
const mintAll = button('Mint all', async () => { await api('/api/mint-all', {}); note.textContent = 'Preparing eligible claimed blocks one by one. Approve each payment in your wallet.'; await refresh(); });
const refreshButton = button('Refresh', () => refresh());
const first = button('First', async () => { cursor = undefined; await refreshClaims(); });
const more = button('Next', async () => { cursor = next; await refreshClaims(); });
append(page, append(el('div', undefined, 'page-head'), el('h1', 'Claimed blocks you may mint')),
  el('p', "During the finder's week only the finder mints; afterwards the Bitmap holder (if linked before the find) or any agent holding enough units. Units can be sent with transfer. Minting spends units and pays to your bound TAP wallet. You approve the TAP payment and Bitcoin inscription fees in TAP Wallet."), owner, payout,
  append(el('div', undefined, 'row'), mintAll, refreshButton), note,
  table, append(el('div', undefined, 'row'), first, more), el('h2', 'Open requests'), requests, payment);
root.append(page);
async function attempt(action) {
  if (busy) return; busy = true;
  for (const node of page.querySelectorAll('button')) node.disabled = true;
  try { await action(); }
  catch (error) { note.textContent = error.message; }
  finally { busy = false; for (const node of page.querySelectorAll('button')) node.disabled = node.dataset.disabled === 'true'; }
}
function disabled(node, value) { node.dataset.disabled = String(value); node.disabled = value || busy; }
function externalLink(label, href) {
  const link = el('a', label, 'btn');
  const url = new URL(href); if (!['http:', 'https:'].includes(url.protocol)) throw Error('Invalid payment link');
  link.href = url.href; link.target = '_blank'; link.rel = 'noreferrer noopener'; return link;
}
async function mint(row) {
  note.textContent = 'Signing your mint request…';
  const result = await api('/api/mint', { asset: row.asset, block: row.block });
  if (result.requestId) { activeId = result.requestId; await refreshPayment(); note.textContent = 'Request saved. Review the payment below.'; }
  else if (result.deploymentLink) {
    payment.replaceChildren(el('p', 'This pattern needs its first token deployment. Complete it on the payment page, then press Mint again.'), externalLink('Deploy pattern', result.deploymentLink));
    note.textContent = 'Token deployment is required before a mint request can be signed.';
  } else note.textContent = result.state ?? 'Request is still being prepared. Refresh to check.';
  await refreshClaims(); await refreshRequests();
}
async function refreshClaims() {
  let data;
  try { data = await api('/api/claims?' + new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}) })); }
  catch (error) { if (cursor && ['page_cursor_stale', 'claimed_cursor_stale'].includes(error.message)) { cursor = undefined; return refreshClaims(); } throw error; }
  rows.replaceChildren(); next = data.next;
  for (const row of data.claims) {
    const tr = el('tr'), action = el('td');
    const reason = row.reason === 'insufficient_balance' ? `Not mintable: insufficient units (need ${row.count}, balance ${row.balance})` : row.reason?.replaceAll('_', ' ');
    const state = el('td', [row.eligibility, row.state.replaceAll('_', ' '), reason].filter(Boolean).join(' · '));
    state.title = [row.findHeight != null ? 'Found at ' + row.findHeight : null, row.finderUntil != null ? 'Finder week ends at counted height ' + row.finderUntil : null].filter(Boolean).join(' · ');
    if (row.canMint) { const mintButton = button('Mint', () => mint(row)); disabled(mintButton, !info.payoutAddress); action.append(mintButton); }
    else if (!row.minted && row.requestId) action.append(button('Open request', async () => { activeId = row.requestId; await refreshPayment(); }));
    else if (row.deploymentLink) action.append(externalLink('Deploy pattern', row.deploymentLink));
    append(tr, el('td', row.name), el('td', row.block, 'num'), el('td', `${row.count} / ${row.balance}${row.balanceCurrent ? '' : ' (unverified)'}`, 'num'), state, action); rows.append(tr);
  }
  if (!data.claims.length) { const td = el('td', data.next ? 'No eligible claimed blocks on this page. Continue to the next page.' : 'No eligible claimed blocks on this page.'); td.colSpan = 5; rows.append(append(el('tr'), td)); }
  disabled(more, !next); disabled(first, !cursor);
}
async function refreshRequests() {
  const data = await api('/api/requests?' + new URLSearchParams({ offset: String(requestOffset), limit: '25' }));
  requests.replaceChildren();
  if (data.batch) requests.append(el('p', `Mint all: ${data.batch.state} · ${data.batch.completed} prepared · ${data.batch.failed} failed${data.batch.error ? ' · ' + data.batch.error : ''}`));
  for (const error of data.batch?.errors ?? []) requests.append(el('p', `${error.asset} / ${error.block}: ${error.error}`, 'small'));
  for (const row of data.batch?.deploymentNeeded ?? []) requests.append(append(el('div', undefined, 'row'), el('span', `${row.asset} · block ${row.block} · ${row.state.replaceAll('_', ' ')}`), row.deploymentLink ? externalLink('Deploy pattern', row.deploymentLink) : null));
  for (const row of data.requests) requests.append(append(el('div', undefined, 'row'), el('span', `${row.asset} · block ${row.block ?? '—'} · ${row.state.replaceAll('_', ' ')}`),
    button('Open request', async () => { activeId = row.requestId; await refreshPayment(); }),
    ['unknown', 'authorizing'].includes(row.state) && row.block !== undefined ? button('Resume request', () => mint(row)) : null));
  if (requestOffset) requests.append(button('Newest requests', async () => { requestOffset = 0; await refreshRequests(); }));
  if (data.next !== null) requests.append(button('More requests', async () => { requestOffset = data.next; await refreshRequests(); }));
}
const reportedPayments = new Set();
async function refreshPayment() {
  if (!activeId) return;
  const status = await wallet.status(activeId);
  // A wallet payment is reported by its redeem inscription, found on Bitcoin.
  if (['awaiting_payment', 'partly_paid'].includes(status.state) && status.payBy?.rail === 'tap' && !reportedPayments.has(activeId)) {
    const id = activeId, paymentId = await wallet.paymentInscription(id, status.payer ?? status.receiver).catch(() => null);
    if (paymentId) {
      try { await api('/api/payment', { id, paymentId }); reportedPayments.add(id); }
      catch (error) { if (/financial_transition_pending/.test(error.message)) reportedPayments.add(id); }
      if (reportedPayments.has(id)) note.textContent = 'Your payment was found on Bitcoin and reported. The permit follows with the next batch.';
    }
  }
  payment.replaceChildren(el('h2', 'Mint payment'), el('p', activeId, 'mono'), el('p', 'State: ' + status.state.replaceAll('_', ' ')), el('p', 'Receiver: ' + status.receiver, 'mono'));
  for (const item of status.missing) payment.append(el('p', `${item.role}: ${formatTap(item.amount)} TAP → ${item.to}`));
  if (!globalThis.tapprotocol) {
    if (status.localWalletProgress) payment.append(el('p', 'This request has saved local wallet progress. Reconnect TAP Wallet here to resume it.'));
    else payment.append(el('p', 'TAP Wallet is not available on this local page. You can finish this request on the site.'), externalLink('Open payment page', status.paymentLink));
  }
  if (globalThis.tapprotocol && status.payable && ['awaiting_payment', 'partly_paid'].includes(status.state)) payment.append(button('Pay missing items', async () => {
    if (!confirm('Pay the remaining quoted fees from your bound TAP wallet?\n' + status.missing.map(item => `${item.role}: ${formatTap(item.amount)} TAP`).join('\n'))) return;
    wallet.provider = globalThis.tapprotocol; await wallet.connect();
    let result = await wallet.pay(activeId);
    if (result.retryable && confirm('TAP Wallet returned no receipt for the last attempt.\nRetry only if your wallet shows no sent payment for this request.')) result = await wallet.pay(activeId, { retry: true });
    note.textContent = result.message ?? 'Payment submitted. Waiting for confirmation.'; await refreshPayment();
  }));
  if (globalThis.tapprotocol && status.state === 'permit_issued') payment.append(button('Inscribe mint', async () => {
    wallet.provider = globalThis.tapprotocol; await wallet.connect();
    const result = await wallet.inscribe(activeId, { maxFeeSats: '1000000', confirm: async terms => confirm(`${terms.resume ? 'Resume' : 'Inscribe'} this mint?\nMiner fees: ${terms.feeSats} sat\nPostage: ${terms.postage} sat\nReceiver: ${terms.receiver}`) });
    if (result.state === 'broadcast') await api('/api/payment', { id: activeId, inscription: result.inscriptionId });
    await refreshPayment(); await refreshClaims();
  }));
  if (!['permit_issued', 'minted'].includes(status.state)) {
    const receipt = el('input'); receipt.value = paymentDrafts.get(activeId) ?? ''; receipt.addEventListener('input', () => paymentDrafts.set(activeId, receipt.value)); receipt.placeholder = 'Redeem inscription ID (…i0)'; receipt.setAttribute('aria-label', 'Payment inscription ID');
    payment.append(append(el('div', undefined, 'row'), receipt, button('Report existing payment', async () => { await api('/api/payment', { id: activeId, paymentId: receipt.value.trim() }); await refreshPayment(); })));
  }
}
function formatTap(value) { const n = BigInt(value), unit = 10n ** 18n; return `${n / unit}.${(n % unit).toString().padStart(18, '0')}`.replace(/\.?0+$/, ''); }
async function refresh() {
  info = await api('/api/info'); owner.textContent = info.address;
  payout.textContent = info.payoutAddress ? 'Payout TAP address: ' + info.payoutAddress : 'Bind a TAP payout wallet with bind_payout_wallet before minting. ' + info.payoutError;
  disabled(mintAll, !info.payoutAddress || info.batch?.state === 'running');
  wallet ??= new TapWalletMint({ network: info.bitcoinNetwork, journal: new LocalWalletJournal(), readStatus: id => api('/api/requests/' + id),
    readPaymentPlan: id => api('/api/requests/' + id + '/plan'), notify: text => { note.textContent = text; } });
  await refreshClaims(); await refreshRequests(); await refreshPayment();
}
function poll() { timer = setTimeout(async () => { if (!busy) await attempt(refresh); poll(); }, 5000); }
window.addEventListener('pagehide', () => clearTimeout(timer));
await attempt(refresh); poll();
