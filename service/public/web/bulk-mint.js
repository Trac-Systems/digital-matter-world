// A bulk mint order's payment page (/mint/bulk/<order>), in the site shell like a single mint request:
// the same step indicator, next step, fee table and request panel. One TAP Wallet approval pays every
// fee of the order and sets aside the Bitcoin for its mint inscriptions; the server sends the mints.
import { TapWalletBulkMint, bulkPaymentPlan } from './bulk-wallet.js';
import { bulkApi, api } from './console/js/api.js';
import { h, clear, kv, hashEl, pill, confirmModal, fmtInt, input, field, panel, table, stepper } from './console/js/dom.js';
import { tap } from './console/js/money.js';
import { walletError, windowShort, payWithin, bitcoinTip, creditedAmount } from './console/js/wallet-errors.js';
import { assetLink, addressLink, agentLink, blockLink, setEthereumChain } from './console/js/words.js';

const PAGE = 25;
const sats = n => `${fmtInt(n)} sats`;
const roleName = role => String(role).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const plural = (n, one) => `${fmtInt(n)} ${one}${n === 1 ? '' : 's'}`;
// The order's state in plain words, for the state pill.
export const BULK_STATE = { reserving: ['reserving blocks', 'info'], awaiting_payment: ['waiting for wallet payment', 'warn'], partly_paid: ['partly paid', 'bad'],
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
    ['Payment', paid ? done('payment seen on Bitcoin.') : localState === 'payment_submitted' ? now('waiting for your payment to confirm on Bitcoin.') : 'One payment from TAP Wallet for every block.'],
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
