// A bulk mint order's payment page (/mint/bulk/<order>), in the site shell like a single mint request:
// the same step indicator, next step, fee table and request panel. One TAP Wallet approval pays every
// fee of the order and sets aside the Bitcoin for its mint inscriptions; the server sends the mints.
import { TapWalletBulkMint, TapWalletPublicBulkMint, bulkPaymentPlan } from './bulk-wallet.js';
import { bulkApi, api, get } from './console/js/api.js';
import { h, clear, kv, hashEl, pill, confirmModal, fmtInt, input, field, panel, table, stepper } from './console/js/dom.js';
import { tap } from './console/js/money.js';
import { walletError, windowShort, payWithin, bitcoinTip, creditedAmount, knownReason, PAY_SOON } from './console/js/wallet-errors.js';
import { refundStatus } from './console/js/inscribe/public.js';
import { requesterSecret, rememberRequester, rememberOrder, requesterHeaders } from './console/js/requester-storage.js';
import { assetLink, assetName, addressLink, agentLink, blockLink, setEthereumChain } from './console/js/words.js';
import { tickers } from './console/js/tickers.js';

const PAGE = 25;
const sats = n => `${fmtInt(n)} sats`;
const roleName = role => String(role).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const plural = (n, one) => `${fmtInt(n)} ${one}${n === 1 ? '' : 's'}`;
// The order's state in plain words, for the state pill.
export const BULK_STATE = { reserving: ['reserving blocks', 'info'], awaiting_payment: ['waiting for wallet payment', 'warn'], confirming_payment: ['payment sent, confirming', 'info'], partly_paid: ['partly paid', 'bad'],
  paid: ['payment confirmed', 'info'], permit_pending: ['permits being prepared', 'info'], permit_issued: ['permits ready', 'info'], minting: ['being minted', 'info'],
  partly_minted: ['being minted', 'info'], minted: ['minted', 'good'], needs_attention: ['needs attention', 'bad'], releasing: ['releasing blocks', 'warn'],
  expired: ['expired', 'bad'], credited: ['expired, paid late', 'warn'] };
const STOPPED = ['partly_paid', 'needs_attention', 'releasing', 'expired', 'credited'];
const paidStates = ['paid', 'permit_pending', 'permit_issued', 'minting', 'partly_minted', 'minted'];

// Where the order is, in one sentence for the next-step callout: [text, callout kind].
export function bulkProgress(status, localState) {
  const n = status.count, ready = status.permit?.readyCount ?? 0, minted = status.progress?.minted ?? 0, sender = status.mintSender;
  if (status.state === 'minted') return [`Minted ${minted} of ${n}. The tokens are in your TAP Wallet.`, 'good'];
  // A credited order has its own callout with the credit and what to do with it.
  if (creditedAmount(status)) return null;
  if (status.creditReferences?.length) return ['Your payment arrived after this order expired. It becomes a fee credit once Bitcoin confirms it; nothing else to do. Do not pay again.', 'info'];
  if (status.state === 'partly_paid') return ['Only part of the payment arrived. This order cannot be paid again or mint only some of its blocks; it is held for recovery.', 'bad'];
  if (status.state === 'needs_attention') return ['This order needs the operator’s attention. Blocks with a permit stay held for you.', 'bad'];
  if (['releasing', 'expired'].includes(status.state)) return ['This order expired before it was paid, so nothing was paid. Its blocks are released for a new order.', 'warn'];
  if (sender?.state === 'fee_wait') return ['Waiting for Bitcoin network fees to fall to the rate you approved. Nothing more to pay.', 'info'];
  if (sender?.sentBatches > 0) return [`Mint sent. Waiting for Bitcoin to confirm it: minted ${minted} of ${n}. Nothing else to do.`, 'info'];
  if (['permit_issued', 'minting', 'partly_minted'].includes(status.state)) return [`Permits ready ${ready} of ${n}. Our server is sending the mint.`, 'info'];
  if (status.state === 'permit_pending') return [`Payment seen on Bitcoin. Permits ready ${ready} of ${n}; the mint goes out automatically.`, 'info'];
  if (status.state === 'paid') return ['Payment seen on Bitcoin. The permits come with the next batch; the mint goes out automatically.', 'info'];
  // A payment reported before the deadline holds the order until Bitcoin confirms it (newer gateways).
  if (status.state === 'confirming_payment') {
    const by = /^(0|[1-9][0-9]*)$/.test(String(status.paymentTiming?.confirmByBlock ?? '')) ? Number(status.paymentTiming.confirmByBlock).toLocaleString('en-US') : null;
    return [`Payment sent in time — waiting for Bitcoin. Your mint continues once it confirms${by ? ` (by block ${by})` : ''}. Nothing to do; do not pay again.`, 'info'];
  }
  if (localState === 'payment_pending') return ['TAP Wallet returned no receipt for the last attempt. Retry only if TAP Wallet shows no sent payment for this order; Bitcoin is checked before another attempt.', 'warn'];
  if (localState === 'payment_submitted') return ['Paid. It is counted once Bitcoin confirms it, and the mint goes out automatically. You can close this page.', 'good'];
  if (status.state === 'reserving' || status.state === 'awaiting_payment' && !status.payable) return ['Your blocks are being reserved on Trac. The Pay button appears here by itself, usually within a minute.', 'busy'];
  return null;
}
// One block of the order, in plain words.
function memberState(member, status) {
  if (member.state === 'minted') return ['minted', 'good'];
  if (member.state === 'released') return ['released', ''];
  if (member.state === 'issued') return status.mintSender?.totalBatches > 0 && status.mintSender.sentBatches >= status.mintSender.totalBatches ? ['mint sent', 'info'] : ['permit ready', 'info'];
  if (member.state === 'reserved') return paidStates.includes(status.state) ? ['paid', 'info'] : ['reserved', ''];
  return ['reserving', ''];
}
// Payment → permits → mint → minted, like a single request's "Your mint".
function mintSteps(status, localState) {
  const n = status.count, ready = status.permit?.readyCount ?? 0, minted = status.progress?.minted ?? 0, sender = status.mintSender ?? {};
  const now = text => h('span', {}, h('strong', {}, 'Now: '), text), done = text => h('span', {}, h('strong', {}, 'Done: '), text);
  const paid = paidStates.includes(status.state), sent = sender.sentBatches > 0, allSent = sent && sender.sentBatches >= sender.totalBatches;
  return kv([
    ['Payment', paid ? done('payment seen on Bitcoin.') : localState === 'payment_submitted' || status.state === 'confirming_payment' ? now('waiting for your payment to confirm on Bitcoin.') : 'One payment from TAP Wallet for every block.'],
    ['Permits', ready >= n ? done(`permits ready ${ready} of ${n}.`) : paid ? now(`permits ready ${ready} of ${n}.`) : 'After the payment confirms.'],
    ['Mint', allSent ? done('mint sent.') : sent ? now(`sending the mint (part ${sender.sentBatches} of ${sender.totalBatches}).`) : sender.state === 'fee_wait' ? now('waiting for Bitcoin network fees to fall.') : 'Sent by our server when the permits are ready.'],
    ['Minted', minted >= n ? done(`minted ${minted} of ${n}.`) : sent ? now(`minted ${minted} of ${n}.`) : 'When Bitcoin confirms the mint.'],
  ]);
}

// The site mounts this for /mint/bulk/<order>; cleanup stops polling without touching the journal.
export function mountBulkMint(root, { orderId, network, reads = bulkApi, wallet, refreshMs = 5000 } = {}) {
  if (!/^[0-9a-f]{64}$/.test(orderId ?? '')) throw Error('invalid_bulk_order');
  const progress = h('div'), lead = h('div.section-gap'), body = h('div.stack'), side = h('div.stack');
  const actions = h('div.row.actions'), extra = h('div.extra'), note = h('div.callout', { role: 'status', 'aria-live': 'polite' });
  const say = (text, kind = '') => { note.className = 'callout' + (kind ? ' ' + kind : ''); clear(note, text); };
  const heading = h('h1', {}, 'Mint blocks'), intro = h('p.lead-text', {}, 'Loading the order…');
  clear(root, h('div.page', {}, h('div.page-head', {}, heading), intro, h('div.flow', {}, progress, h('div.grid.cols-main', {},
    h('div.stack', {}, h('section.panel.next-step', {}, h('header', {}, h('h2', {}, 'Next step')), h('div.body', {}, lead, note, actions, extra)), body), side))));
  let stopped = false, timer, busy = false, localState, reported = false, offset = 0, paymentDraft = '', plan, status, tip = null;
  // The agent dashboard shows this page too; shortWindow: the wallet refused a payment with fewer than 2 blocks left.
  const agentHere = globalThis.DMW_LOCAL_AGENT === true;
  let shortWindow = false;
  const attempt = async (fn, clicked) => {
    if (busy || stopped) return; busy = true;
    for (const button of root.querySelectorAll('.next-step button, .paged button')) button.disabled = true;
    clicked?.classList.add('busy');
    say('Working…', 'busy');
    try { await fn(); if (!stopped && note.textContent === 'Working…') say(''); }
    catch (error) {
      if (stopped) return;
      // Too little time left: the page itself explains it and offers a fresh order.
      if (windowShort(error) && status) { shortWindow = true; say(''); await refresh().catch(() => {}); }
      else say(walletError(error), 'bad');
    }
    finally { busy = false; clicked?.classList.remove('busy'); if (note.classList.contains('busy')) note.className = 'callout info'; for (const button of root.querySelectorAll('.next-step button, .paged button')) button.disabled = false; }
  };
  const button = (label, fn, kind = '') => h(`button.btn${kind === 'primary' ? '.primary.cta' : kind === 'quiet' ? '.ghost' : ''}`, { onclick: event => attempt(fn, event.currentTarget) }, label);
  // The confirmation lists exactly what this one approval pays; the set-aside's return is explained on the page.
  const confirmRows = terms => [
    ...(terms.groups.length <= 6 ? terms.groups.map((g, i) => [groupRoles(i), tap(g.amount)]) : [['Fees', `${tap(terms.payableFeeAtoms)} to ${fmtInt(terms.groups.length)} recipients`]]),
    ['Total', tap(terms.payableFeeAtoms)], ['Blocks', fmtInt(terms.members.length)], ['Bitcoin for the mint inscriptions', sats(terms.mintFunding.satoshis)]];
  // A fee group's role names, from the fee manifest (one group can collect several roles of several blocks).
  const groupRoles = i => [...new Set(plan.feeManifest.flatMap(m => m.shares.filter(s => s.group === i).map(s => roleName(s.role))))].join(' + ') || 'Fee';
  async function pay(retry) {
    wallet.provider = globalThis.tapprotocol; await wallet.connect();
    const fresh = await wallet.plan(orderId), n = fresh.status.count;
    if (!await confirmModal(retry
      ? { title: 'Retry the payment?', lead: 'TAP Wallet returned no receipt for the last attempt. Retry only if TAP Wallet shows no sent payment for this order. Bitcoin is checked before another attempt.', rows: confirmRows(fresh.terms), confirm: 'Retry payment' }
      : { title: `Pay and mint ${plural(n, 'block')}?`, lead: `TAP Wallet asks once: the same payment pays the fees of all ${plural(n, 'block')} and sets aside the Bitcoin for their mint inscriptions, and our server sends the mint when the permits are ready. Only this order is approved.`, rows: confirmRows(fresh.terms), confirm: 'Pay and mint' })) return;
    const result = await wallet.pay(orderId, { retry }); localState = result.localState; reported = localState === 'payment_submitted';
    await refresh();
  }
  async function refresh() {
    const [nextStatus, response, memberPage] = await Promise.all([reads.status(orderId), reads.terms(orderId), reads.members(orderId, { offset, limit: PAGE })]);
    if (stopped) return;
    const nextPlan = bulkPaymentPlan(orderId, nextStatus, response, network);
    if (memberPage.orderId !== orderId) throw Error('Bulk member page mismatch');
    status = nextStatus; plan = nextPlan;
    tip = status.state === 'awaiting_payment' && status.payable ? await bitcoinTip(network) : null;
    if (stopped) return;
    // Redisplay saved receipt on reload, including a report whose HTTP reply was
    // lost. Connecting is unnecessary for this read-only recovery.
    if (wallet.journal) {
      const record = await wallet.journal.get(`${network}/${plan.terms.payer}/bulk/${orderId}`);
      if (record?.payment?.termsHash === status.termsHash) {
        localState = record.payment.state === 'submitted' ? 'payment_submitted' : 'payment_pending';
        if (record.payment.state === 'submitted' && !reported) {
          try { await wallet.report(orderId, record.payment); reported = true; } catch { /* retry only the saved report on the next read */ }
        }
      }
    }
    if (stopped) return;
    draw(memberPage);
  }
  function draw(memberPage) {
    const t = plan.terms, n = status.count, state = status.state, failed = STOPPED.includes(state);
    heading.textContent = `Mint ${plural(n, 'block')} · ${status.ticker}`;
    clear(intro, `Pay once for ${plural(n, 'block')} of `, assetLink(status.asset), '. TAP Wallet asks once: the same payment pays every fee of this order and sets aside the Bitcoin for its mint inscriptions, and our server sends the mint when the permits are ready.');
    // Steps as on a single request: reserve → pay → permits → mint sent → minted.
    const sent = status.mintSender?.sentBatches > 0;
    const at = state === 'minted' ? 5 : ['minting', 'partly_minted'].includes(state) && sent ? 4 : ['permit_issued', 'minting', 'partly_minted'].includes(state) ? 3
      : ['paid', 'permit_pending'].includes(state) || failed && status.payment?.state === 'paid' ? 2 : state === 'reserving' ? 0 : 1;
    clear(progress, stepper(['Reserve', 'Pay', 'Permits', 'Mint sent', 'Minted'], at, { failed }));
    const awaiting = state === 'awaiting_payment' && localState !== 'payment_submitted';
    const told = bulkProgress(status, localState), credit = creditedAmount(status);
    const until = status.payBy?.untilBlock, left = tip !== null && /^(0|[1-9][0-9]*)$/.test(String(until ?? '')) ? Number(until) - Number(tip) : null;
    // Fewer than 2 blocks left: the wallet does not start a payment; the page offers a fresh order instead.
    const tooLate = awaiting && status.payable && localState !== 'payment_pending' && (shortWindow || left !== null && left < 2);
    const owner = typeof t.owner === 'string' && t.owner.startsWith('trac1') ? t.owner : null;
    clear(lead, awaiting && status.payable ? h('div', {}, h('div.small.muted', {}, 'Remaining to pay'), h('div.price', {}, tap(t.payableFeeAtoms)),
        tooLate ? null : h('div.small.muted', { style: { marginTop: '4px' } }, payWithin(until, tip))) : null,
      tooLate ? h('div.callout.warn', {}, h('strong', {}, 'Too little time is left to pay. '),
        'Fewer than 2 Bitcoin blocks (about 20 minutes) remain, and a payment that confirms after this order expires only becomes a fee credit. Your wallet does not start it; nothing was paid. ',
        agentHere ? 'Once it expires, its blocks are released: press Mint several in My agent again for a fresh order.' : 'Once it expires, its blocks are released and the agent that made it can start a fresh order.') : null,
      credit ? h('div.callout.warn', {}, h('strong', {}, 'Your payment arrived after this order expired. '), 'It became a fee credit of ', h('strong.nowrap', {}, tap(credit)), '. Its blocks are released. ',
        agentHere ? 'Your agent can use the credit for the fees of a new mint.'
          : ['It belongs to the agent that made this order', owner ? [', ', agentLink(owner)] : null, '. That agent uses it for a new mint from its own dashboard, under My agent.']) : null,
      told ? h(`div.callout.${told[1]}`, {}, told[0]) : null);
    const fees = awaiting && status.payable ? table(t.groups.map((g, i) => ({ ...g, i })), [
      { key: 'role', label: 'Fee', render: g => groupRoles(g.i) },
      { key: 'amount', label: 'Amount', num: true, render: g => h('span.mono', {}, tap(g.amount)) },
      { key: 'to', label: 'Paid to', render: g => addressLink(g.to) },
    ], { sortable: false }) : null;
    if (fees && t.groups.length > 1) fees.querySelector('tbody').append(h('tr.total', {}, h('td', {}, 'Total'), h('td.num', {}, h('span.mono', {}, tap(t.payableFeeAtoms))), h('td')));
    const waived = BigInt(t.grossFeeAtoms) - BigInt(t.payableFeeAtoms);
    const waivedRoles = [...new Set(plan.feeManifest.flatMap(m => m.shares.filter(s => s.payable === '0').map(s => String(s.role).replace(/_/g, ' '))))].join(', ');
    const feeNote = fees && waived > 0n ? h('p.small.muted', { style: { margin: '10px 14px' } }, `The fees of these blocks come to ${tap(t.grossFeeAtoms)}. ${tap(waived.toString())} of it${waivedRoles ? ` (${waivedRoles})` : ''} is not charged to you, so you pay ${tap(t.payableFeeAtoms)}.`) : null;
    clear(body, fees ? panel('Remaining fees', [fees, feeNote], { flush: true }) : null,
      failed ? null : panel('Your mint', mintSteps(status, localState), { flush: true }),
      panel(`Blocks in this order`, members(memberPage), { flush: true }));
    const [stateText, kind] = BULK_STATE[state] ?? [String(state).replace(/_/g, ' '), ''];
    clear(side, panel('Order', kv([['Order', hashEl(orderId)], ['State', pill(stateText, kind)],
      credit ? ['Fee credit', h('span', {}, h('span.mono', {}, tap(credit)), status.creditsCount > 1 ? h('div.small.muted', {}, `In ${fmtInt(status.creditsCount)} credits`) : null)] : null,
      ['Pattern', assetLink(status.asset)],
      ['Ticker', h('span.mono', {}, status.ticker)], ['Receiver', addressLink(status.receiver)], status.payer !== status.receiver ? ['Paid from', addressLink(status.payer)] : null,
      ['Blocks', fmtInt(n)], ['Units', fmtInt(status.totalAmount)],
      awaiting && until != null ? ['Pay by', h('span', {}, 'block ', blockLink(until))] : null,
      status.payment?.reference ? ['Payment', hashEl(status.payment.reference)] : null,
      ['Bitcoin for the mint inscriptions', h('span', {}, sats(t.mintFunding.satoshis), h('div.small.muted', {}, 'Returned to you after the mint, minus the Bitcoin network fees and the 546 sats per block that stay with the inscriptions.'))]]), { flush: true }));
    const next = [], rest = [];
    // A credited or unpaid expiry, or too little time left: the next step is a fresh order from My agent.
    const again = h('a.btn.primary.cta', { href: '/me?' + new URLSearchParams({ pattern: status.asset }) }, credit ? 'Use it for a new mint' : 'Mint again from My agent');
    if (agentHere && (credit || ['expired', 'credited'].includes(state) && !status.creditReferences?.length || tooLate)) next.push(again);
    if (agentHere && credit) next.push(h('a.btn.ghost', { href: '/me#fee-credits' }, 'Your fee credits'));
    if (status.payable && state === 'awaiting_payment' && localState !== 'payment_submitted' && !tooLate)
      next.push(localState === 'payment_pending' ? button('Check and retry this payment', () => pay(true), 'primary') : button(`Pay and mint ${plural(n, 'block')}`, () => pay(false), 'primary'));
    next.push(button('Refresh', refresh, 'quiet'));
    // A payment made outside this page is reported by its redeem inscription; the gateway verifies it on Bitcoin.
    if (awaiting && !status.payment?.reference) {
      const paymentId = input({ value: paymentDraft, placeholder: 'Transaction ID followed by i0', 'aria-label': 'Payment inscription ID', oninput: event => { paymentDraft = event.target.value; } });
      rest.push(h('div.row', { style: { alignItems: 'flex-end' } }, h('div', { style: { flex: '1 1 260px' } }, field('Already paid? Report the redeem inscription ID shown by your wallet', paymentId)), button('Report payment', async () => {
        const value = paymentId.value.trim();
        if (!/^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(value)) throw Error('Enter the redeem inscription ID, including i0. A funding transaction ID is not an inscription ID.');
        await reads.payment({ orderId, paymentId: value, commitTxid: null, revealTxid: null });
        await refresh(); say('Reported. The payment counts once it is found on Bitcoin.', 'good');
      })));
    }
    clear(actions, ...next); clear(extra, ...rest);
  }
  // The order's blocks, 25 per page like other lists.
  function members(memberPage) {
    const rows = memberPage.members, from = offset + (rows.length ? 1 : 0), to = offset + rows.length;
    const list = table(rows, [
      { key: 'block', label: 'Block', render: m => blockLink(m.block) },
      { key: 'amount', label: 'Units', num: true },
      { key: 'state', label: 'State', render: m => { const [text, kind] = memberState(m, status); return pill(text, kind); } },
      { key: 'inscription', label: 'Inscription', render: m => m.inscription ? hashEl(m.inscription) : null },
    ], { sortable: false, empty: 'No blocks.' });
    if (memberPage.count <= PAGE && offset === 0) return list;
    const page = (label, to) => button(label, async () => { offset = to; await refresh(); });
    const prev = page('‹ Prev', Math.max(0, offset - PAGE)), more = page('Next ›', memberPage.next ?? offset);
    prev.className = more.className = 'btn sm ghost'; prev.disabled = offset === 0; more.disabled = memberPage.next === null;
    return h('div.paged', {}, list, h('div.pager-foot', {}, h('span.small.muted', {}, `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(memberPage.count)}`), h('div.grow'), prev, more));
  }
  async function tick() {
    try { if (!busy) await refresh(); } catch (error) { if (!stopped) say(walletError(error), 'bad'); }
    if (!stopped && status?.state !== 'minted') timer = setTimeout(tick, refreshMs);
  }
  void (async () => {
    try {
      if (!network) {
        const target = await api('/web-api/target', { wire: true });
        setEthereumChain(target.ethereum?.chainId);
        network = target.bitcoinNetwork;
      }
      if (!['mainnet', 'regtest'].includes(network)) throw Error('Invalid Bitcoin network');
      wallet ??= new TapWalletBulkMint({ network, readStatus: reads.status, readTerms: reads.terms, reportPayment: reads.payment });
    } catch (error) { if (!stopped) say(walletError(error), 'bad'); return; }
    await tick();
  })();
  return () => { stopped = true; clearTimeout(timer); };
}

// Mint several, on the agent dashboard: blocks picked on a list (My agent's claimed blocks, the public
// blocks on Mint) become one order of one pattern and ticker. The agent prices it (/api/bulk/quote), the
// confirmation shows the one total, the agent signs it (/api/bulk/request) and the order page above takes
// the one TAP Wallet payment. An agent without bulk orders answers 404: severalReady() is then false and
// the lists show no picking. The public site uses public orders instead (below).
export const SEVERAL_MAX = 64; // BULK_LIMITS.members: the most blocks one order holds.
const SKIPPED = { block_pending: 'already being minted', already_minted: 'already minted', insufficient_units: 'your agent holds too few units',
  mint_right_unavailable: 'not open to your agent yet', find_missing: 'not found yet', zero_occurrences: 'no units in this block',
  deployment_unavailable: 'this ticker cannot take it', bulk_funding_limit: 'too much Bitcoin for one order', bulk_byte_limit: 'did not fit into this order' };
const SEVERAL_ERRORS = { bulk_disabled: 'Minting several at once is paused right now. Mint the blocks one at a time.',
  bulk_sender_unavailable: 'Minting several at once is not available right now. Try again in a few minutes.',
  financial_admission_fenced: 'The world is catching up with Bitcoin. Try again in a minute.',
  financial_snapshot_changed: 'A new batch arrived while pricing the order. Try again.',
  bulk_order_capacity: 'Your agent has as many open orders as it may. Pay or finish an open order first.',
  bulk_funding_limit: 'These blocks need more Bitcoin set aside than one order allows. Pick fewer blocks.',
  bulk_no_eligible_members: 'None of the picked blocks can be minted right now.', bulk_zero_payable: 'None of the picked blocks can be minted right now.',
  financial_capacity_reserved: 'This ticker has too few units left for these blocks. Pick fewer blocks.',
  financial_generation_capacity_reserved: 'This ticker has too few units left for these blocks. Pick fewer blocks.',
  bulk_member_conflict: 'Some of the picked blocks were just taken by another mint. Pick again.',
  dashboard_stopping: 'Your agent is stopping. Try again once it runs again.' };
const reasonCode = value => /^[a-z][a-z0-9_]{0,60}$/.test(String(value ?? '')) ? String(value) : 'unknown';
const severalWords = error => error.status === 404 || error.status === 405 ? 'Your agent needs an update to mint several blocks at once. Mint them one at a time, or update your agent.'
  : error.message === 'login_required' ? 'Open the private link printed by your local dashboard.'
  : SEVERAL_ERRORS[error.message] ?? `The order could not be prepared (${reasonCode(error.message)}). Nothing was signed or paid; try again.`;
async function local(path, body) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(String(data?.error ?? 'request_failed')), { status: response.status });
  return data;
}
let ready = null;
// Whether this page runs on an agent dashboard whose agent makes bulk orders (asked once per page load).
export function severalReady() {
  if (globalThis.DMW_LOCAL_AGENT !== true) return Promise.resolve(false);
  return ready ??= local('/api/bulk?offset=0&limit=1').then(() => true, error => error.status !== 404 && error.status !== 405);
}
// The ticker deployment the order mints into: the chosen one, else the pattern's official ticker.
async function officialDeployment(asset) {
  const id = value => /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(value ?? '') ? value : null;
  const rows = await tickers(asset).catch(() => null), official = rows?.find(r => r.ordinal === '1' || r.ordinal === 1);
  if (id(official?.deploymentId)) return official.deploymentId;
  const s = await get('/mint/deployment-state/' + asset).catch(() => null);
  return id(s?.entry?.id) ?? id(s?.deploymentId) ?? id(s?.deployment?.inscription) ?? id(s?.deployment?.id) ?? id(s?.inscription);
}
const blockList = rows => rows.slice(0, 6).map(r => fmtInt(r.block)).join(', ') + (rows.length > 6 ? ` and ${fmtInt(rows.length - 6)} more` : '');
// Price the picked blocks, show the one total, then sign the order and open its payment page (go).
// Resolves false when the player cancels; throws an Error worded for people.
export async function startSeveral({ asset, deployment = null, blocks, go, notify = () => {} }) {
  const name = assetName(asset);
  try {
    notify('Pricing the order…');
    deployment ??= await officialDeployment(asset);
    if (!deployment) throw Object.assign(Error('This pattern’s token is not deployed yet. Deploy it first; then its blocks can be minted.'), { worded: true });
    const actionId = 'pick-' + (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
    const quote = await local('/api/bulk/quote', { actionId, asset, deployment, blocks: blocks.map(String) });
    const left = [...quote.skipped ?? [], ...quote.deferred ?? []];
    const reasons = Object.entries(left.reduce((m, r) => ((m[r.reason] ??= []).push(r), m), {}))
      .map(([reason, rows]) => [`Not in this order: ${SKIPPED[reason] ?? `could not be added (${reasonCode(reason)})`}`, h('span.mono', {}, blockList(rows))]);
    notify('');
    if (!quote.terms) {
      await confirmModal({ title: 'None of these blocks can be minted now', lead: 'Nothing was signed or paid.', rows: reasons, confirm: 'OK' });
      return false;
    }
    const t = quote.terms, n = t.members.length;
    if (!await confirmModal({ title: `Mint ${plural(n, 'block')} of ${name}?`,
      lead: `One order, one payment. Your agent signs the order now; on the next page TAP Wallet asks once: it pays the fees of all ${plural(n, 'block')} and sets aside the Bitcoin for their mint inscriptions. Nothing is paid before you approve there.`,
      rows: [['Pattern', name], ['Ticker', h('span.mono', {}, t.ticker)], ['Blocks', `${fmtInt(n)} · ${blockList(t.members)}`], ['Units', fmtInt(t.totalAmount)],
        ['Fees, total', h('strong.mono', {}, tap(t.payableFeeAtoms))], ['Bitcoin for the mint inscriptions', h('span.mono', {}, sats(t.mintFunding.satoshis))], ...reasons],
      confirm: `Sign the order for ${plural(n, 'block')}` })) return false;
    notify('Your agent is signing the order…');
    const status = await local('/api/bulk/request', { actionId, quoteId: quote.quoteId, maxPayableFeeAtoms: t.payableFeeAtoms, maxSetAsideSats: t.mintFunding.satoshis });
    const orderId = /^[0-9a-f]{64}$/.test(status?.orderId ?? '') ? status.orderId : quote.orderId;
    notify('');
    go('/mint/bulk/' + orderId);
    return true;
  } catch (error) { notify(''); throw error.worded ? error : Error(severalWords(error)); }
}
// The picks of one list: blocks of one pattern and ticker, at most SEVERAL_MAX. A row is { asset, block }.
// check(row) is the row's checkbox; bar is the line above the list with the count, the pick buttons and
// Mint; fill() returns more rows for "Pick up to 64" (later pages), or is left out.
// max is the most blocks one order holds; start prices, confirms and starts the order (startSeveral on the
// agent dashboard, startPublicSeveral on the site), hint is the line under the bar.
export function severalPicker({ go, fill, ticker = () => null, label = 'Pick blocks below', max = SEVERAL_MAX, start = startSeveral,
  hint = `Up to ${max} blocks of one pattern in one order: you see the total before anything is signed, and TAP Wallet pays it with one approval.` }) {
  const picked = new Map(); let group = null, busy = false;
  const key = r => r.asset + '/' + r.block, groupOf = r => r.asset + '|' + (ticker(r.asset) ?? '');
  const room = () => max - picked.size;
  const boxes = new Set();
  const add = row => { if (picked.has(key(row)) || !room() || group && groupOf(row) !== group) return false; group ??= groupOf(row); picked.set(key(row), row); return true; };
  const remove = row => { picked.delete(key(row)); if (!picked.size) group = null; };
  const count = h('span.small.muted'), note = h('div.callout', { role: 'status', 'aria-live': 'polite', hidden: true });
  const say = (text, kind = '') => { note.hidden = !text; note.className = 'callout' + (kind ? ' ' + kind : ''); note.textContent = text; };
  let pageRows = [];
  const pagePick = h('button.btn.sm.ghost', { type: 'button', onclick: () => { for (const r of pageRows) add(r); draw(); } }, 'Pick this page');
  const fillPick = h('button.btn.sm.ghost', { type: 'button', onclick: async () => {
    if (busy) return; busy = true; draw(); say('Reading more blocks…', 'busy');
    try { for (const r of await fill(room(), group)) add(r); say(''); }
    catch { say('Could not read more blocks. Pick them on the pages below.', 'bad'); }
    finally { busy = false; draw(); }
  } }, `Pick up to ${max}`);
  const clearPick = h('button.btn.sm.ghost', { type: 'button', onclick: () => { picked.clear(); group = null; say(''); draw(); } }, 'Clear');
  const mint = h('button.btn.sm.primary', { type: 'button', onclick: async () => {
    if (busy || !picked.size) return; busy = true; draw();
    const rows = [...picked.values()], first = rows[0];
    try { if (await start({ asset: first.asset, deployment: ticker(first.asset), blocks: rows.map(r => r.block).sort((a, b) => Number(a) - Number(b)), go, notify: text => say(text, 'busy') })) { picked.clear(); group = null; } }
    catch (error) { say(error.message, 'bad'); }
    finally { busy = false; draw(); }
  } });
  const bar = h('div.several-bar', { style: { padding: '10px 14px', borderBottom: '1px solid var(--rule-2)' } }, h('div.row', {}, h('strong', {}, 'Mint several'), count, h('div.grow'), pagePick, fill ? fillPick : null, clearPick, mint),
    h('div.small.muted', { style: { marginTop: '6px' } }, hint), note);
  function draw() {
    const n = picked.size, first = picked.values().next().value;
    clear(count, n ? [`${fmtInt(n)} of up to ${max} picked · `, h('span', {}, assetName(first.asset))] : label);
    mint.textContent = n ? `Mint ${plural(n, 'block')}` : 'Mint picked blocks';
    mint.disabled = busy || !n; mint.classList.toggle('busy', busy && n > 0);
    pagePick.disabled = busy || !room() || !pageRows.some(r => !picked.has(key(r)) && (!group || groupOf(r) === group));
    fillPick.disabled = busy || !room() || !n && !pageRows.length; clearPick.hidden = !n;
    for (const box of boxes) if (box.isConnected) box.sync(); else boxes.delete(box);
  }
  // Each list draw hands its pickable rows over; Pick this page takes them in order.
  const page = rows => { pageRows = rows; draw(); };
  const check = row => {
    const input = h('input', { type: 'checkbox', 'aria-label': `Pick block ${row.block}`,
      onchange: e => { if (e.target.checked && !add(row)) e.target.checked = false; else if (!e.target.checked) remove(row); draw(); } });
    const box = h('label.check', { title: '' }, input);
    box.sync = () => { input.checked = picked.has(key(row)); const other = !!group && groupOf(row) !== group;
      input.disabled = !input.checked && (busy || other || !room()); box.title = other ? 'One order holds blocks of one pattern and ticker.' : !input.checked && !room() ? `One order holds up to ${max} blocks.` : ''; };
    box.sync(); boxes.add(box); return box;
  };
  draw();
  return { bar, check, page, picked, has: row => picked.has(key(row)), clear: () => { picked.clear(); group = null; say(''); draw(); } };
}

// Public bulk orders: on the site, anyone mints several public blocks with TAP Wallet alone, no agent.
// The server quotes the picked blocks (/public-mints/bulk/quote), starts one order of ordinary public
// requests (/start, with this browser's requester secret) and the order page takes one TAP Wallet payment.
// Nothing is reserved: the first confirmed payment wins each block, and a block someone else paid first is
// refunded. A server without these orders answers the limit read with an error: the site then shows no picking.
async function publicCall(path, body, secret) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: { accept: 'application/json', ...(secret ? { 'X-Mint-Requester-Secret': secret } : requesterHeaders(path)), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(reasonCode(data?.error)), { status: response.status });
  return data;
}
export const publicBulkApi = {
  limits: () => publicCall('/web-api/public-mints/bulk/limits'),
  quote: input => publicCall('/web-api/public-mints/bulk/quote', input),
  start: (input, secret) => publicCall('/web-api/public-mints/bulk/start', input, secret),
  status: id => publicCall('/web-api/public-mints/bulk/' + id),
  payment: (id, paymentId) => publicCall(`/web-api/public-mints/bulk/${id}/payment`, { paymentId }),
};
let publicLimit = null;
// The most blocks one public order holds, from the server (asked once per page load); null: no public orders.
export function publicSeveralLimit() {
  return publicLimit ??= publicBulkApi.limits().then(v => Number.isSafeInteger(v?.blocks) && v.blocks >= 2 ? v.blocks : null, () => null);
}
const PUBLIC_ERRORS = { public_bulk_unavailable: 'Minting several at once is not available right now. Mint the blocks one at a time.',
  public_bulk_payment_version: 'Minting several at once is not available right now. Mint the blocks one at a time.',
  public_bulk_sender_unavailable: 'Minting several at once is paused right now. Try again in a few minutes, or mint the blocks one at a time.',
  public_bulk_capacity: 'This ticker has too few units left for these blocks. Pick fewer blocks.',
  public_bulk_payment_bytes: 'These blocks do not fit into one payment. Pick fewer blocks.', public_bulk_input_bytes: 'These blocks do not fit into one order. Pick fewer blocks.',
  public_bulk_deployment_pending: 'This pattern’s token is still being registered. Try again in a few minutes.',
  public_bulk_quote_changed: 'A new batch arrived while pricing the order. Try again.', financial_snapshot_changed: 'A new batch arrived while pricing the order. Try again.',
  fee_quote_expired: 'The price expired while you were deciding. Press Mint again for a fresh one.',
  public_bulk_conflict: 'This order was already started with other blocks. Pick the blocks again.',
  public_bulk_members: 'Too many open mints are running right now. Try again in a few minutes.', mint_capacity: 'Too many open mints are running right now. Try again in a few minutes.',
  public_mint_payer_capacity: 'This TAP Wallet has as many open mint requests as it may. Pay or let them expire first.',
  public_mint_ip_capacity: 'Too many open mint requests come from your connection. Pay or let them expire first.',
  public_mint_start_rate: 'Too many mint requests in a short time. Wait a minute and try again.',
  public_bulk_not_found: 'This order is not known to the server.', public_mint_requester_required: 'Open this order in the browser where you started it.' };
// Words for a server reason; the picked-blocks quote fails as a whole when one block is no longer public.
const publicWords = (error, during = 'The order could not be started') => error.status === 404 && error.message === 'not_found' ? PUBLIC_ERRORS.public_bulk_unavailable
  : PUBLIC_ERRORS[error.message] ?? (knownReason(error.message) ? `One of the picked blocks cannot be minted now: ${knownReason(error.message).replace(/^./, c => c.toLowerCase())} Refresh the list and pick again.` : null)
  ?? `${during} (${reasonCode(error.message)}). Nothing was paid; try again.`;
const randomHex = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
const atoms = value => /^(0|[1-9][0-9]*)$/.test(String(value ?? '')) ? String(value) : null;
// Price the picked public blocks for the connected TAP Wallet (payer() connects it and checks 1-TX transfers),
// show the one total, start the order and open its page (go). Resolves false when the player cancels.
export async function startPublicSeveral({ asset, deployment = null, blocks, go, notify = () => {}, payer }) {
  const name = assetName(asset);
  try {
    const tapAddress = await payer(notify);
    notify('Pricing the order…');
    const input = { asset, blocks: blocks.map(String), tapAddress, ...(deployment ? { deployment } : {}) };
    const quote = await publicBulkApi.quote(input);
    const members = Array.isArray(quote?.members) ? quote.members : [];
    if (quote?.publicBulk !== true || quote.payer !== tapAddress || members.length !== blocks.length || !atoms(quote.payableAmount)
      || !members.every((m, i) => String(m.block) === input.blocks[i]))
      throw Object.assign(Error('The price does not match the picked blocks. Refresh the list and try again.'), { worded: true });
    const n = members.length, sats = Number(quote.mintFundingEstimate?.satoshis);
    const units = members.reduce((sum, m) => sum + BigInt(atoms(m.amount) ?? '0'), 0n);
    notify('');
    if (!await confirmModal({ title: `Mint ${plural(n, 'block')} of ${name}?`,
      lead: `Nothing is reserved. On the next page TAP Wallet asks once: one payment pays the fees of all ${plural(n, 'block')} and sets aside the Bitcoin for their mint inscriptions; our server then sends each mint. If someone else pays for a block first, its TAP is refunded to you automatically and its unused Bitcoin comes back to you.`,
      rows: [['Pattern', name], ['Blocks', `${fmtInt(n)} · ${blockList(members)}`], units > 0n ? ['Units', fmtInt(units.toString())] : null,
        ['Fees, total', h('strong.mono', {}, tap(quote.payableAmount))], Number.isSafeInteger(sats) ? ['Bitcoin for the mint inscriptions', h('span.mono', {}, `${fmtInt(sats)} sats`)] : null,
        ['Receiver', hashEl(tapAddress)]], confirm: 'Continue to payment' })) return false;
    notify('Starting the order…');
    // The nonce and secret make a retry of a lost answer return the same order, never a second one.
    const nonce = randomHex(), secret = randomHex();
    const started = await publicBulkApi.start({ ...input, nonce }, secret).catch(error => error instanceof TypeError ? publicBulkApi.start({ ...input, nonce }, secret) : Promise.reject(error));
    if (started?.publicBulk !== true || !/^[0-9a-f]{64}$/.test(started.orderId ?? '')) throw Object.assign(Error('The order is not valid. Refresh and try again.'), { worded: true });
    rememberRequester({ publicBulk: true, orderId: started.orderId, requesterSecret: started.requesterSecret ?? secret });
    rememberOrder({ orderId: started.orderId, asset, blocks: n });
    notify('');
    go('/mint/bulk/' + started.orderId);
    return true;
  } catch (error) {
    notify('');
    if (error.worded || error.code === 4001 || !error.status && !/^[a-z][a-z0-9_]{0,80}$/.test(error.message)) throw error.code === 4001 ? Error('Wallet request cancelled. You can retry.') : error;
    throw Error(publicWords(error));
  }
}
// Whether /mint/bulk/<id> is a public order: this browser started it, or the server knows it as one.
export async function isPublicBulkOrder(id) {
  if (requesterSecret(id)) return true;
  return publicBulkApi.status(id).then(s => s?.publicBulk === true, () => false);
}
export const PUBLIC_BULK_STATE = { registering: ['being recorded', 'info'], awaiting_payment: ['waiting for your payment', 'warn'], confirming: ['payment sent', 'info'],
  scanning: ['payment sent', 'info'], minting: ['being minted', 'info'], minted: ['minted', 'good'], completed_with_refunds: ['minted · some refunded', 'good'],
  refundable: ['someone else paid first · refund coming', 'warn'], refunded: ['someone else paid first · refunded', 'warn'], partly_paid: ['partly paid', 'bad'],
  completed_partial: ['partly minted', 'warn'], expired: ['expired · nothing paid', 'bad'], unavailable: ['blocks taken · nothing paid', 'bad'] };
const LOST = { someone_paid_first: 'someone else paid first', claimed_first: 'its finder claimed it first', public_payment_incomplete: 'your payment did not cover it', already_minted: 'already minted' };
const refundTotal = m => (m.refunds ?? []).reduce((sum, r) => sum + (r.fees ?? []).reduce((n, f) => n + BigInt(atoms(f?.amount) ?? '0'), 0n), 0n);
const refunded = m => (m.refunds ?? []).length > 0 && m.refunds.every(r => ['refund_sent', 'refund_confirmed'].includes(r.refundDelivery?.state));
// One block of a public order, in plain words.
function publicMemberState(m, status) {
  const lost = LOST[m.refunds?.[0]?.reason ?? m.reason] ?? null;
  if (m.state === 'minted') return ['minted', 'good'];
  if (m.refunds?.length) return [`${lost ?? 'not minted'} · ${refunded(m) ? 'refunded' : 'refund coming'}`, 'warn'];
  if (m.state === 'someone_paid_first') return ['someone else paid first · refund coming', 'warn'];
  if (m.state === 'permit_issued') return [txidLike(m.mintSender?.revealTxid) || m.sentInscription ? 'mint sent' : 'minting', 'info'];
  if (['paid', 'payment_confirmed'].includes(m.state)) return ['paid · permit next', 'info'];
  if (m.state === 'confirming_payment' || m.state === 'scanning' || m.paymentIds?.length || m.payment?.length) return ['paid · confirming', 'info'];
  if (m.state === 'awaiting_payment') return ['expired', 'unavailable', 'partly_paid', 'completed_partial'].includes(status.state) ? ['not paid', ''] : ['waiting for payment', 'warn'];
  if (['registering', 'enrolling', 'requested'].includes(m.state)) return ['being recorded', ''];
  return [knownReason(m.state) ? 'cannot be minted now' : String(m.state ?? '–').replace(/_/g, ' '), ''];
}
const txidLike = v => /^[0-9a-f]{64}$/.test(v ?? '');
// A refund's delivery in a narrow cell: the sent transaction shortened (refundStatus words otherwise).
const refundWords = r => ['refund_sent', 'refund_confirmed'].includes(r?.refundDelivery?.state) && txidLike(r.refundDelivery.revealTxid)
  ? h('span', {}, 'Sent back: ', h('a.mono', { href: 'https://mempool.space/tx/' + r.refundDelivery.revealTxid, target: '_blank', rel: 'noreferrer noopener' }, r.refundDelivery.revealTxid.slice(0, 12) + '…')) : refundStatus(r);
const FINAL = ['minted', 'refunded', 'expired', 'unavailable', 'completed_partial'];

// The site mounts this for /mint/bulk/<order> when it is a public order; cleanup stops polling.
export function mountPublicBulkMint(root, { orderId, network, reads = publicBulkApi, wallet, refreshMs = 5000 } = {}) {
  if (!/^[0-9a-f]{64}$/.test(orderId ?? '')) throw Error('invalid_bulk_order');
  const progress = h('div'), lead = h('div.section-gap'), body = h('div.stack'), side = h('div.stack');
  const actions = h('div.row.actions'), extra = h('div.extra'), note = h('div.callout', { role: 'status', 'aria-live': 'polite' });
  const say = (text, kind = '') => { note.className = 'callout' + (kind ? ' ' + kind : ''); clear(note, text); };
  const heading = h('h1', {}, 'Mint blocks'), intro = h('p.lead-text', {}, 'Loading the order…');
  clear(root, h('div.page', {}, h('div.page-head', {}, heading), intro, h('div.flow', {}, progress, h('div.grid.cols-main', {},
    h('div.stack', {}, h('section.panel.next-step', {}, h('header', {}, h('h2', {}, 'Next step')), h('div.body', {}, lead, note, actions, extra)), body), side))));
  let stopped = false, timer, busy = false, localState = null, paymentDraft = '', status, tip = null, shortWindow = false, reporting = false;
  const attempt = async (fn, clicked) => {
    if (busy || stopped) return; busy = true;
    for (const b of root.querySelectorAll('.next-step button')) b.disabled = true;
    clicked?.classList.add('busy'); say('Working…', 'busy');
    try { await fn(); if (!stopped && note.textContent === 'Working…') say(''); }
    catch (error) {
      if (stopped) return;
      if (windowShort(error) && status) { shortWindow = true; say(''); await refresh().catch(() => {}); }
      else say(error.code === 4001 ? 'Wallet request cancelled. You can retry.' : error.status ? publicWords(error, 'The order could not be read') : walletError(error), error.code === 4001 ? 'warn' : 'bad');
    }
    finally { busy = false; clicked?.classList.remove('busy'); if (note.classList.contains('busy')) note.className = 'callout info'; for (const b of root.querySelectorAll('.next-step button')) b.disabled = false; }
  };
  const button = (label, fn, kind = '') => h(`button.btn${kind === 'primary' ? '.primary.cta' : kind === 'quiet' ? '.ghost' : ''}`, { onclick: event => attempt(fn, event.currentTarget) }, label);
  async function pay(retry) {
    wallet.provider = globalThis.tapprotocol; await wallet.connect();
    const fresh = await wallet.plan(orderId), n = fresh.status.counts.total;
    const rows = [['Fees, total', tap(fresh.status.payableAmount)], ['Blocks', fmtInt(n)], ['Bitcoin for the mint inscriptions', sats(fresh.status.mintFundingSatoshis)]];
    if (!await confirmModal(retry
      ? { title: 'Retry the payment?', lead: 'TAP Wallet returned no receipt for the last attempt. Retry only if TAP Wallet shows no sent payment for this order. Bitcoin is checked before another attempt.', rows, confirm: 'Retry payment' }
      : { title: `Pay and mint ${plural(n, 'block')}?`, lead: `TAP Wallet asks once: the same payment pays the fees of all ${plural(n, 'block')} and sets aside the Bitcoin for their mint inscriptions. Our server then sends each mint. If someone else pays for a block first, its TAP is refunded to you automatically.`, rows, confirm: 'Pay and mint' })) return;
    const result = await wallet.pay(orderId, { retry }); localState = result.localState;
    await refresh();
  }
  async function refresh() {
    const next = await reads.status(orderId);
    if (stopped) return;
    if (next?.publicBulk !== true || next.orderId !== orderId) throw Error('The order could not be read. Refresh the page.');
    status = next;
    const secret = requesterSecret(orderId);
    // Each block's own request page opens with the same secret.
    if (secret) for (const m of status.members ?? []) if (/^[0-9a-f]{64}$/.test(m.requestId ?? '') && !requesterSecret(m.requestId)) { try { rememberRequester({ publicMint: true, requestId: m.requestId, requesterSecret: secret }); } catch { break; } }
    tip = status.state === 'awaiting_payment' && status.payable ? await bitcoinTip(network) : null;
    // This browser's saved payment: shown on reload, and reported again if its report was lost.
    const saved = status.payer ? await wallet.saved(orderId, status.payer).catch(() => null) : null;
    if (saved) localState = saved.state === 'submitted' ? 'payment_submitted' : 'payment_pending';
    if (saved?.state === 'submitted' && !status.paymentIds?.length && !reporting) {
      reporting = true;
      void wallet.report(orderId, saved).then(r => { if (r.reported && !stopped && !busy) return refresh(); }).catch(() => {}).finally(() => { reporting = false; });
    }
    if (stopped) return;
    draw();
  }
  function draw() {
    const c = status.counts ?? { total: 0, minted: 0, minting: 0, refundable: 0, unpaid: 0 }, n = c.total, state = status.state, members = status.members ?? [];
    const authorized = !status.requesterRequired, asset = status.asset;
    heading.textContent = asset ? `Mint ${plural(n, 'block')} · ${assetName(asset)}` : `Mint ${plural(n, 'block')}`;
    clear(intro, `Pay once for ${plural(n, 'block')}`, asset ? [' of ', assetLink(asset)] : null, '. Nothing is reserved: the first confirmed payment for a block wins it. TAP Wallet asks once; our server then sends each mint. If someone else pays for a block first, its TAP is refunded to you automatically.');
    intro.hidden = FINAL.includes(state) || state === 'completed_with_refunds';
    const lostAll = ['refundable', 'refunded'].includes(state), stoppedUnpaid = ['expired', 'unavailable'].includes(state);
    const paidStage = ['confirming', 'scanning', 'minting', 'partly_paid', 'completed_partial'].includes(state) || localState === 'payment_submitted';
    const [steps, at] = stoppedUnpaid ? [['Order', state === 'expired' ? 'Expired' : 'Blocks taken'], 1]
      : lostAll ? [['You: sign & pay', 'Someone else paid first', 'Refunded'], state === 'refunded' ? 3 : 2]
      : [['You: sign & pay', 'Automatic: permits & mints', 'Minted'], ['minted', 'completed_with_refunds'].includes(state) ? 3 : paidStage ? 1 : 0];
    clear(progress, stepper(steps, at, { failed: stoppedUnpaid }));
    const awaiting = state === 'awaiting_payment' && status.payable && localState !== 'payment_submitted';
    const until = status.payBy?.untilBlock, left = tip !== null && atoms(until) ? Number(until) - Number(tip) : null;
    const tooLate = awaiting && localState !== 'payment_pending' && (shortWindow || left !== null && left < 2);
    const back = r => r > 0 ? h('strong.nowrap', {}, tap(r.toString())) : null;
    const refundSum = members.reduce((sum, m) => sum + refundTotal(m), 0n), lostCount = members.filter(m => m.refunds?.length || m.state === 'someone_paid_first').length;
    const line = (kind, title, ...detail) => h('div.callout.' + kind, {}, h('strong', {}, title), ...detail);
    const refundLine = lostCount ? [` Someone else paid first for ${plural(lostCount, 'block')}; `, refundSum > 0n ? ['its TAP (', back(refundSum), ') is'] : 'its TAP is', ` ${members.every(m => !m.refunds?.length || refunded(m)) ? 'refunded' : 'being refunded'} to you automatically, with the unused Bitcoin.`] : null;
    const outcome = !authorized ? line('info', 'Open this order in the browser where you started it. ', `There you can pay it and follow each block. Minted ${fmtInt(c.minted)} of ${fmtInt(n)} so far.`)
      : state === 'minted' ? line('good', `Minted ${fmtInt(n)} of ${fmtInt(n)}. `, 'Your tokens are in your TAP Wallet.')
      : state === 'completed_with_refunds' ? line('good', `Minted ${fmtInt(c.minted)} of ${fmtInt(n)}. `, 'Your tokens are in your TAP Wallet.', refundLine, ' Nothing to do.')
      : lostAll ? line('warn', 'Someone else paid first for every block of this order. ', 'Your TAP', refundSum > 0n ? [' (', back(refundSum), ')'] : null, state === 'refunded' ? ' was refunded to you, with the unused Bitcoin.' : ' is being refunded to you automatically, with the unused Bitcoin. Nothing to do.')
      : state === 'completed_partial' ? line('warn', `Minted ${fmtInt(c.minted)} of ${fmtInt(n)}. `, `Your payment did not reach ${plural(c.unpaid, 'block')}, so nothing was minted for ${c.unpaid === 1 ? 'it' : 'them'}.`, refundLine)
      : state === 'partly_paid' ? line('bad', 'Your payment covered only part of this order. ', `The paid blocks continue by themselves; ${plural(c.unpaid, 'block')} were not paid and are not minted. This order cannot be paid again.`)
      : state === 'minting' ? line('info', 'Payment confirmed. ', `Minted ${fmtInt(c.minted)} of ${fmtInt(n)}; our server sends the rest by itself. Nothing to do; you can close this page.`, refundLine)
      : ['confirming', 'scanning'].includes(state) ? line('info', 'Payment sent — waiting for Bitcoin. ', 'Each block’s mint continues once it confirms, usually within about 10 minutes. Nothing to do; do not pay again.',
        status.retryReason ? h('div.small', {}, 'Checking the payment takes longer than usual; this page keeps checking.') : null)
      : state === 'expired' ? line('bad', 'This order expired before it was paid. ', 'Nothing was paid. Pick the blocks again on Mint for a fresh order.')
      : state === 'unavailable' ? line('bad', 'Some blocks of this order can no longer be minted. ', 'Another mint took them first. Nothing was paid; pick the blocks again on Mint.')
      : localState === 'payment_submitted' ? line('info', 'Your payment is sent. ', 'It counts once Bitcoin confirms it, usually within about 10 minutes; then the rest happens by itself. Nothing to do; do not pay again.')
      : localState === 'payment_pending' && state === 'awaiting_payment' ? line('warn', 'TAP Wallet returned no receipt for the last attempt. ', 'Retry only if TAP Wallet shows no sent payment for this order; Bitcoin is checked before another attempt.')
      : tooLate ? line('warn', 'Too little time is left to pay. ', 'Fewer than 2 Bitcoin blocks (about 20 minutes) remain. Your wallet does not start the payment; nothing was paid. Once it expires, pick the blocks again on Mint.')
      : awaiting ? line('warn', 'Needs your payment. ', payWithin(until, tip) ?? '', ' TAP Wallet asks once; your permits and mints then follow by themselves.')
      : ['registering', 'awaiting_payment'].includes(state) ? h('div.callout.busy', {}, PAY_SOON)
      : line('info', `This order is ${String(state).replace(/_/g, ' ')}. `, 'This page updates by itself.');
    clear(lead, outcome, awaiting && !tooLate && localState !== 'payment_pending' ? h('div', {}, h('div.small.muted', {}, 'Remaining to pay'), h('div.price', {}, tap(status.payableAmount))) : null);
    clear(body, authorized ? panel('Blocks in this order', blocksTable(members), { flush: true }) : null);
    const [stateText, kind] = PUBLIC_BULK_STATE[state] ?? [String(state).replace(/_/g, ' '), ''];
    clear(side, panel('Order', kv([['Order', hashEl(orderId)], ['State', pill(stateText, kind)], asset ? ['Pattern', assetLink(asset)] : null,
      ['Blocks', fmtInt(n)], c.minted ? ['Minted', `${fmtInt(c.minted)} of ${fmtInt(n)}`] : null, status.receiver ? ['Receiver', addressLink(status.receiver)] : null,
      atoms(status.payableAmount) ? ['Fees, total', h('span.mono', {}, tap(status.payableAmount))] : null,
      awaiting && atoms(until) ? ['Pay by', h('span', {}, 'block ', blockLink(until))] : null,
      status.paymentIds?.length ? ['Payment', hashEl(status.paymentIds[0])] : null,
      refundSum > 0n ? ['Refunded to you', h('span.mono', {}, tap(refundSum.toString()))] : null,
      atoms(status.mintFundingSatoshis) ? ['Bitcoin for the mint inscriptions', h('span', {}, sats(status.mintFundingSatoshis), h('div.small.muted', {}, 'Returned to you after the mints, minus the Bitcoin network fees and the 546 sats per block that stay with the inscriptions.'))] : null]), { flush: true }));
    const next = [];
    if (status.payable && awaiting && !tooLate) next.push(localState === 'payment_pending' ? button('Check and retry this payment', () => pay(true), 'primary') : button(`Pay and mint ${plural(n, 'block')}`, () => pay(false), 'primary'));
    if (asset && (stoppedUnpaid || tooLate)) next.push(h('a.btn.primary.cta', { href: '/mint?' + new URLSearchParams({ asset }) + '#mint' }, 'Pick blocks again'));
    next.push(button('Refresh', refresh, 'quiet'));
    const rest = [];
    // A payment made outside this page is reported by its redeem inscription; the server checks it on Bitcoin.
    if (authorized && state === 'awaiting_payment' && !status.paymentIds?.length && localState !== 'payment_submitted') {
      const paymentId = input({ value: paymentDraft, placeholder: 'Transaction ID followed by i0', 'aria-label': 'Payment inscription ID', oninput: event => { paymentDraft = event.target.value; } });
      rest.push(h('div.row', { style: { alignItems: 'flex-end' } }, h('div', { style: { flex: '1 1 260px' } }, field('Already paid? Report the redeem inscription ID shown by your wallet', paymentId)), button('Report payment', async () => {
        const value = paymentId.value.trim();
        if (!/^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(value)) throw Error('Enter the redeem inscription ID, including i0. A funding transaction ID is not an inscription ID.');
        await reads.payment(orderId, value); await refresh();
      })));
    }
    clear(actions, ...next); clear(extra, ...rest);
  }
  function blocksTable(members) {
    return table(members, [
      { key: 'block', label: 'Block', render: m => blockLink(m.block) },
      { key: 'amount', label: 'Units', num: true, render: m => atoms(m.amount) ? fmtInt(m.amount) : '–' },
      { key: 'state', label: 'State', render: m => { const [text, kind] = publicMemberState(m, status); return pill(text, kind); } },
      { key: 'refund', label: 'Refund', render: m => m.refunds?.length ? h('span', {}, h('span.mono', {}, tap(refundTotal(m).toString())), h('div.small.muted', {}, m.refunds.flatMap((r, i) => [i ? ' · ' : '', refundWords(r)]))) : null },
      { key: 'request', label: '', render: m => /^[0-9a-f]{64}$/.test(m.requestId ?? '') ? h('a.btn.sm.ghost', { href: '/mint/' + m.requestId }, m.inscription ? 'Inscription' : 'Details') : null },
    ], { sortable: false, empty: 'No blocks.' });
  }
  async function tick() {
    try { if (!busy) await refresh(); } catch (error) { if (!stopped) say(error.status ? publicWords(error, 'The order could not be read') : walletError(error), 'bad'); }
    if (!stopped && !FINAL.includes(status?.state)) timer = setTimeout(tick, refreshMs);
  }
  void (async () => {
    try {
      if (!network) {
        const target = await api('/web-api/target', { wire: true });
        setEthereumChain(target.ethereum?.chainId);
        network = target.bitcoinNetwork;
      }
      if (!['mainnet', 'regtest'].includes(network)) throw Error('Invalid Bitcoin network');
      wallet ??= new TapWalletPublicBulkMint({ network, readStatus: reads.status, reportPayment: reads.payment });
    } catch (error) { if (!stopped) say(walletError(error), 'bad'); return; }
    await tick();
  })();
  return () => { stopped = true; clearTimeout(timer); };
}
