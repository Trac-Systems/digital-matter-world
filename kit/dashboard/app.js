import { TapWalletMint, TapWalletBulkMint, tapWalletCapabilities } from './wallet.js';
const formatUnits = n => String(n ?? '–').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// A pattern or compound by its name; its key only ever as a short "#…".
const assetLabel = row => row.name ?? (/^c2:[0-9a-f]{64}$/.test(row.asset ?? '') ? 'Compound #' + row.asset.slice(3, 11) : /^p2:(0|[1-9][0-9]*)$/.test(row.asset ?? '') ? 'Pattern #' + row.asset.slice(3) : row.asset);

// One approval (TAP Wallet 1.0.49): the payment sets aside Bitcoin and the gateway sends the mint; same words as the site.
const PAY_SOON = 'Your request is being recorded on Trac. Nothing to do yet: the Pay button appears here by itself, usually within a minute.';
const REPORTED = 'Your payment was found on Bitcoin and reported. It counts once Bitcoin confirms it; nothing else to do.';
const PAID_ONCE = 'Paid. Your mint goes out automatically when the permit arrives. You can close this page.';
const NEEDS_USER = 'Bitcoin fees rose above the Bitcoin your payment set aside, so our server cannot send your mint. Inscribe it from your TAP Wallet; the Bitcoin set aside is sent back to you.';
const SENDER_STATES = ['waiting_funding', 'funded', 'sending', 'sent', 'minted', 'needs_user', 'returning', 'returned'], SENDER_STOPPED = ['needs_user', 'returning', 'returned'];
const txid = value => /^[0-9a-f]{64}$/.test(value ?? '') ? value : null;
function senderWords(status, ms) {
  if (status.state === 'minted' || ms.state === 'minted') return 'Minted.';
  if (txid(ms.revealTxid)) return 'Mint sent. Waiting for Bitcoin to confirm the mint.';
  if (ms.state === 'sending') return 'Permit issued. Our server is sending your mint inscription.';
  if (status.state === 'permit_issued') return 'Permit issued. Your mint goes out shortly.';
  if (ms.state === 'funded' || !['awaiting_payment', 'partly_paid'].includes(status.state)) return 'Payment confirmed. Waiting for the permit (next batch).';
  return 'Waiting for your payment to confirm on Bitcoin.';
}
function txLink(label, value) { const link = el('a', label, 'mono'); link.href = 'https://mempool.space/tx/' + value; link.target = '_blank'; link.rel = 'noreferrer noopener'; return link; }
// Every pattern, compound, block, agent and request links to its page on the site (served through this dashboard).
const pageLink = (label, href, className) => { const link = el('a', label, className); link.href = href; return link; };
const assetLink = row => pageLink(assetLabel(row), (/^c2:[0-9a-f]{64}$/.test(row.asset ?? '') ? '/compound/' : '/pattern/') + row.asset);
const blockLink = block => block === undefined || block === null ? '—' : pageLink(String(block), '/block/' + block, 'mono');
// A Bitcoin address opens on the explorer the transaction links use; regtest addresses stay text.
const EXPLORER = { mainnet: 'https://mempool.space', testnet: 'https://mempool.space/testnet', signet: 'https://mempool.space/signet' };
const addressLink = address => { const base = EXPLORER[info?.bitcoinNetwork]; if (!base || !address) return document.createTextNode(address ?? '–'); const link = pageLink(address, `${base}/address/${address}`, 'mono'); link.target = '_blank'; link.rel = 'noreferrer noopener'; return link; };
// "<name> · block <n> · <state>" with the name and block linked.
const assetLine = (row, ...rest) => append(el('span'), assetLink(row), ' · block ', blockLink(row.block), ...rest.map(text => ' · ' + text));

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
const payout = el('p', '', 'mono'), owner = el('p', undefined, 'small muted');
const rows = el('tbody'), requests = el('div', undefined, 'stack'), payment = el('div', undefined, 'stack'), bulkOrders = el('div', undefined, 'stack');
const table = el('table'), head = el('tr');
for (const label of ['Pattern', 'Block', 'Units / balance', 'Eligibility / state', '']) head.append(el('th', label));
append(table, append(el('thead'), head), rows);
const mintState = state => ({ public: 'Public', claimed: 'Claimed', already_minted: 'Minted', minted: 'Minted', paid: 'Payment confirmed', permit_issued: 'Being minted', confirming_payment: 'Payment sent, confirming' })[state] ?? state.replaceAll('_', ' ');
const mintReason = reason => ({ public_minted: 'This block was already taken by a public TAP Wallet mint.', claimed_first: 'An agent claimed this block before your payment was confirmed. Your payment is refunded.' })[reason] ?? reason?.replaceAll('_', ' ');
let info, cursor, next, busy = false, activeId, wallet, bulkWallet, timer, requestOffset = 0;
const paymentDrafts = new Map();
const mintAll = button('Mint all', async () => { await api('/api/mint-all', {}); note.textContent = 'Preparing bulk orders with up to 64 blocks each. Review and approve each order separately in your wallet.'; await refresh(); });
const refreshButton = button('Refresh', () => refresh());
const first = button('First', async () => { cursor = undefined; await refreshClaims(); });
const more = button('Next', async () => { cursor = next; await refreshClaims(); });
append(page, append(el('div', undefined, 'page-head'), el('h1', 'Claimed blocks you may mint')),
  el('p', "During the finder's week only the finder mints; afterwards any agent can. Bitmap holders earn 15% of every mint on their plot. Minting requires enough units. Units can be sent with transfer. Minting spends units and pays to your bound TAP wallet. You approve the TAP payment and Bitcoin inscription fees in TAP Wallet."), owner, payout,
  append(el('div', undefined, 'row'), mintAll, refreshButton), note,
  table, append(el('div', undefined, 'row'), first, more), el('h2', 'Bulk orders'), bulkOrders, el('h2', 'Open single requests'), requests, payment);
root.append(page);
async function attempt(action) {
  if (busy) return; busy = true;
  for (const node of page.querySelectorAll('button')) node.disabled = true;
  try { await action(); }
  catch (error) { note.textContent = mintReason(error.message); }
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
    const reason = row.reason === 'insufficient_balance' ? `Not mintable: insufficient units (need ${formatUnits(row.count)}, balance ${formatUnits(row.balance)})` : mintReason(row.reason);
    // Own finds show how long the finder window stays open, not only in the hover title.
    const deadline = row.role !== 'finder' || row.minted || row.blocksLeft == null ? null
      : row.finderExpired ? 'finder window ended' : `finder window: ${row.blocksLeft} blocks left${row.endsSoon ? ', ends soon' : ''}`;
    const state = el('td', [row.eligibility, mintState(row.state), reason, deadline].filter(Boolean).join(' · '));
    state.title = [row.findHeight != null ? 'Found at ' + row.findHeight : null, row.finderUntil != null ? 'Finder week ends at counted height ' + row.finderUntil : null].filter(Boolean).join(' · ');
    if (row.canMint) { const mintButton = button('Mint', () => mint(row)); disabled(mintButton, !info.payoutAddress); action.append(mintButton); }
    else if (!row.minted && row.requestId) action.append(button('Open request', async () => { activeId = row.requestId; await refreshPayment(); }));
    else if (row.deploymentLink) action.append(externalLink('Deploy pattern', row.deploymentLink));
    append(tr, append(el('td'), assetLink(row)), append(el('td', undefined, 'num'), blockLink(row.block)), el('td', `${formatUnits(row.count)} / ${formatUnits(row.balance)}${row.balanceCurrent ? '' : ' (unverified)'}`, 'num'), state, action); rows.append(tr);
  }
  if (!data.claims.length) { const td = el('td', data.next ? 'No eligible claimed blocks on this page. Continue to the next page.' : 'No eligible claimed blocks on this page.'); td.colSpan = 5; rows.append(append(el('tr'), td)); }
  disabled(more, !next); disabled(first, !cursor);
}
async function refreshRequests() {
  const data = await api('/api/requests?' + new URLSearchParams({ offset: String(requestOffset), limit: '25' }));
  requests.replaceChildren();
  if (data.batch) requests.append(el('p', `Mint all: ${data.batch.state} · ${data.batch.completed} prepared · ${data.batch.failed} failed${data.batch.error ? ' · ' + data.batch.error : ''}`));
  for (const error of data.batch?.errors ?? []) requests.append(append(el('p', undefined, 'small'), assetLink(error), ' / ', blockLink(error.block), `: ${error.error}`));
  for (const row of data.batch?.deploymentNeeded ?? []) requests.append(append(el('div', undefined, 'row'), assetLine(row, mintState(row.state)), row.deploymentLink ? externalLink('Deploy pattern', row.deploymentLink) : null));
  for (const row of data.requests) requests.append(append(el('div', undefined, 'row'), assetLine(row, mintState(row.state)),
    button('Open request', async () => { activeId = row.requestId; await refreshPayment(); }),
    ['unknown', 'authorizing'].includes(row.state) && row.block !== undefined ? button('Resume request', () => mint(row)) : null));
  if (requestOffset) requests.append(button('Newest requests', async () => { requestOffset = 0; await refreshRequests(); }));
  if (data.next !== null) requests.append(button('More requests', async () => { requestOffset = data.next; await refreshRequests(); }));
}
const bulkReports = new Set();
async function refreshBulkOrders() {
  const data = await api('/api/bulk'); bulkOrders.replaceChildren();
  if (data.planner?.state === 'waiting_slots') bulkOrders.append(el('p', 'Up to 24 bulk orders can be open at once. Later orders prepare as earlier ones finish.'));
  for (const row of data.orders) {
    const box = el('section', undefined, 'panel'), q = row.quote, status = row.status;
    box.append(el('h3', q?.terms ? `${q.terms.members.length} blocks · ${q.terms.ticker}` : 'Preparing bulk order'));
    if (q?.terms) {
      box.append(el('p', 'Accepted blocks: ' + q.terms.members.map(m => m.block).join(', ')),
        el('p', `Gross fee: ${formatTap(q.terms.grossFeeAtoms)} TAP · Payable: ${formatTap(q.terms.payableFeeAtoms)} TAP · Bitcoin set aside: ${q.terms.mintFunding.satoshis} sats`));
    }
    for (const [key, label] of [['skipped', 'Skipped'], ['deferred', 'Deferred to a later order']]) if (q?.[key]?.length)
      box.append(el('p', label + ': ' + q[key].map(m => `${m.block} (${m.reason.replaceAll('_', ' ')})`).join(', ')));
    if (row.error) box.append(el('p', row.error, 'note'));
    if (status) {
      const saved = await bulkWallet.journal.get(`${info.bitcoinNetwork}/${status.payer}/bulk/${row.orderId}`);
      const localPayment = saved?.payment?.termsHash === status.termsHash ? saved.payment : null;
      if (localPayment?.state === 'submitted' && !bulkReports.has(row.orderId)) {
        try { await bulkWallet.report(row.orderId, localPayment); bulkReports.add(row.orderId); } catch { /* keep receipt and retry reporting */ }
      }
      if (localPayment?.state === 'submitted' && status.payment?.state === 'unseen') box.append(el('p', 'Wallet payment sent. Waiting for confirmed TAP transfers; you can close this page.'));
      if (localPayment?.state === 'sending') box.append(el('p', 'Wallet result uncertain. Inspect TAP Wallet before explicitly retrying this order.'));
      const p = status.progress, permit = status.permit, sender = status.mintSender;
      box.append(el('p', `Payment: ${status.payment?.state ?? status.state} · Permits: ${permit?.readyCount ?? 0}/${status.count} · Reveal batches sent: ${sender?.sentBatches ?? 0}/${sender?.totalBatches ?? 0}`),
        el('p', `Confirmed mints: ${p?.minted ?? 0}/${status.count} · Released: ${p?.released ?? 0} · Unresolved: ${p?.unresolved ?? status.count}`));
      if (sender?.state === 'fee_wait') box.append(el('p', 'Waiting for Bitcoin fees to fit the signed allowance. No additional payment is requested.'));
      if (status.creditReferences?.length) box.append(el('p', 'Payment recovery is owed; it has not been refunded.'));
      if (status.state === 'reserving') box.append(el('p', 'The reservation is being accepted. Payment becomes available here after acceptance.'));
      if (status.state !== 'minted' && sender?.sentBatches) box.append(el('p', 'Inscription transactions were sent. Waiting for confirmed TAP mints and final accounting.'));
      box.append(button('Show member progress', async () => {
        const members = await api(`/api/bulk/${row.orderId}/members?offset=0&limit=64`);
        detail.replaceChildren(...members.members.map(m => el('p', `Block ${m.block}: ${m.state}${m.inscription ? ' · ' + m.inscription : ''}${m.reason ? ' · ' + m.reason : ''}`)));
      }));
      if (status.payable && status.state === 'awaiting_payment' && localPayment?.state !== 'submitted') box.append(button(localPayment?.state === 'sending' ? 'Check and retry this payment' : `Pay and mint ${status.count} blocks`, async () => {
        bulkWallet.provider = globalThis.tapprotocol; await bulkWallet.connect();
        const fresh = await bulkWallet.plan(row.orderId);
        const retry = localPayment?.state === 'sending';
        if (!confirm(retry ? 'Retry only if TAP Wallet shows no sent payment for this exact order. Bitcoin will also be checked.' : `Pay and mint ${fresh.status.count} blocks?\nPayable fee: ${formatTap(fresh.terms.payableFeeAtoms)} TAP\nBitcoin set aside: ${fresh.terms.mintFunding.satoshis} sats\nThis approval covers only this order.`)) return;
        const result = await bulkWallet.pay(row.orderId, { retry });
        note.textContent = result.localState === 'payment_submitted' ? 'Payment sent. Waiting for verified TAP transfers; minting follows automatically. You can close this page.' : 'Payment outcome is uncertain. Keep this order and inspect TAP Wallet before retrying.';
        await refreshBulkOrders();
      }));
    }
    if (row.error && q?.terms && !row.prepared) box.append(button('Resume saved order', async () => {
      await api('/api/bulk/request', { actionId: row.actionId, quoteId: q.quoteId, maxPayableFeeAtoms: q.terms.payableFeeAtoms, maxSetAsideSats: q.terms.mintFunding.satoshis });
      await refreshBulkOrders();
    }));
    const detail = el('div', undefined, 'stack'); box.append(detail); bulkOrders.append(box);
  }
  if (!data.orders.length) bulkOrders.append(el('p', 'Mint all prepares orders here. Each order has its own wallet approval.'));
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
      if (reportedPayments.has(id)) note.textContent = REPORTED;
    }
  }
  // The reported-payment note belongs to an open request: once it ends, the request's own line says what happened.
  if (!['awaiting_payment', 'partly_paid', 'confirming_payment'].includes(status.state) && note.textContent === REPORTED) note.textContent = '';
  payment.replaceChildren(el('h2', 'Mint payment'), append(el('p'), pageLink(activeId, '/mint/' + activeId, 'mono')), el('p', 'State: ' + mintState(status.state)), append(el('p', 'Receiver: ', 'mono'), addressLink(status.receiver)));
  const credited = status.state === 'expired' && status.reason === 'credited' && /^[1-9][0-9]*$/.test(status.creditedAmount ?? '') ? status.creditedAmount : null;
  // A payment reported in time holds the request until Bitcoin confirms it (paymentTiming); late_payment_minting is an older name.
  const confirmBy = /^(0|[1-9][0-9]*)$/.test(String(status.paymentTiming?.confirmByBlock ?? '')) ? Number(status.paymentTiming.confirmByBlock).toLocaleString('en-US') : null;
  if (!['paid', 'permit_issued', 'minted'].includes(status.state) && (['confirming_payment', 'late_payment_minting'].includes(status.state) || status.paymentTiming?.held === true && ['awaiting_payment', 'partly_paid'].includes(status.state) || status.latePayment?.completes === true))
    payment.append(el('p', `Payment sent in time — waiting for Bitcoin. Your mint continues once it confirms${confirmBy ? ` (by block ${confirmBy})` : ''}. Nothing to do; do not pay again.`));
  else if (credited) payment.append(el('p', `Paid too late: this request expired before Bitcoin confirmed your payment, so it became a fee credit of ${formatTap(credited)} TAP. Use it for a new mint under My agent → Fee credits.`));
  else if (status.state === 'expired' && (status.reason === 'credit_pending' || ['pending', 'queued'].includes(status.creditRecovery?.state))) payment.append(el('p', 'This request expired before Bitcoin confirmed your payment. Your payment is being turned into a fee credit; it shows under My agent → Fee credits once it is ready. Do not pay again.'));
  else if (status.state === 'expired' && (status.inflight?.phase === 'payment' || reportedPayments.has(activeId) || status.latePayment?.seen === true)) payment.append(el('p', 'This request expired while your payment was still waiting for Bitcoin. Once it confirms, it becomes a fee credit for a new mint. Do not pay again.'));
  else if (status.state === 'expired') payment.append(el('p', 'This request expired before it was paid. Nothing was paid; mint the block again for a fresh request.'));
  for (const item of status.missing) payment.append(append(el('p', `${item.role}: ${formatTap(item.amount)} TAP → `), addressLink(item.to)));
  const funding = status.payBy?.rail === 'tap' && Number.isSafeInteger(status.mintFunding?.satoshis) ? status.mintFunding : null;
  const ms = SENDER_STATES.includes(status.mintSender?.state) ? status.mintSender : null, senderStopped = SENDER_STOPPED.includes(ms?.state);
  if (funding) payment.append(el('p', `Bitcoin set aside for the mint inscription: ${funding.satoshis} sats`));
  if (ms && !senderStopped) {
    if (ms.state !== 'waiting_funding' && status.state !== 'minted' && !txid(ms.revealTxid)) payment.append(el('p', PAID_ONCE));
    payment.append(append(el('p', 'Mint: ' + senderWords(status, ms) + ' '), txid(ms.commitTxid) ? txLink('Commit', ms.commitTxid) : null, txid(ms.commitTxid) && txid(ms.revealTxid) ? document.createTextNode(' · ') : null, txid(ms.revealTxid) ? txLink('Reveal', ms.revealTxid) : null));
  }
  if (ms && senderStopped && status.state === 'permit_issued') payment.append(el('p', NEEDS_USER));
  if (!globalThis.tapprotocol) {
    if (status.localWalletProgress) payment.append(el('p', 'This request has saved local wallet progress. Reconnect TAP Wallet here to resume it.'));
    else payment.append(el('p', 'TAP Wallet is not available on this local page. You can finish this request on the site.'), externalLink('Open payment page', status.paymentLink));
  }
  if (!status.payable && ['requested', 'authorizing', 'reserving', 'enrolling', 'awaiting_payment', 'partly_paid'].includes(status.state)) payment.append(el('p', PAY_SOON));
  if (globalThis.tapprotocol && status.payable && ['awaiting_payment', 'partly_paid'].includes(status.state)) payment.append(button(funding ? 'Pay and mint' : 'Pay missing items', async () => {
    // TAP Wallet 1.0.49 or newer, checked before the confirmation and any other wallet call.
    await tapWalletCapabilities(globalThis.tapprotocol);
    if (!confirm((funding ? 'Pay and mint? TAP Wallet asks once.\n' : '') + 'Pay the remaining quoted fees from your bound TAP wallet?\n' + status.missing.map(item => `${item.role}: ${formatTap(item.amount)} TAP`).join('\n')
      + (funding ? `\nBitcoin set aside for the mint inscription: ${funding.satoshis} sats` : ''))) return;
    wallet.provider = globalThis.tapprotocol; await wallet.connect();
    let result = await wallet.pay(activeId);
    if (result.retryable && confirm('TAP Wallet returned no receipt for the last attempt.\nRetry only if your wallet shows no sent payment for this request.')) result = await wallet.pay(activeId, { retry: true });
    note.textContent = result.message ?? (result.mintFunded ? PAID_ONCE : 'Payment submitted. Waiting for confirmation.'); await refreshPayment();
  }));
  // With a set-aside the gateway sends the mint; Inscribe mint stays the fallback when it cannot (or never had one).
  if (globalThis.tapprotocol && status.state === 'permit_issued' && (!ms || senderStopped)) payment.append(button('Inscribe mint', async () => {
    await tapWalletCapabilities(globalThis.tapprotocol);
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
  info = await api('/api/info'); owner.replaceChildren(pageLink(info.address, '/agents/' + info.address));
  if (info.payoutAddress) payout.replaceChildren('Payout TAP address: ', addressLink(info.payoutAddress));
  else payout.textContent = 'Bind a TAP payout wallet with bind_payout_wallet before minting. ' + info.payoutError;
  disabled(mintAll, !info.payoutAddress || info.batch?.state === 'running');
  wallet ??= new TapWalletMint({ network: info.bitcoinNetwork, journal: new LocalWalletJournal(), readStatus: id => api('/api/requests/' + id),
    readPaymentPlan: id => api('/api/requests/' + id + '/plan'), notify: text => { note.textContent = text; } });
  bulkWallet ??= new TapWalletBulkMint({ network: info.bitcoinNetwork, journal: new LocalWalletJournal(), readStatus: id => api('/api/bulk/' + id),
    readTerms: id => api('/api/bulk/' + id + '/terms'), reportPayment: report => api('/api/bulk/payment', report) });
  await refreshClaims(); await refreshRequests(); await refreshBulkOrders(); await refreshPayment();
}
function poll() { timer = setTimeout(async () => { if (!busy) await attempt(refresh); poll(); }, 5000); }
window.addEventListener('pagehide', () => clearTimeout(timer));
await attempt(refresh); poll();
