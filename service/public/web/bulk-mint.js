import { TapWalletBulkMint, bulkPaymentPlan } from './bulk-wallet.js';
import { bulkApi, api } from './console/js/api.js';

const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const tap = value => { const n = BigInt(value), tail = (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return String(n / 10n ** 18n) + (tail ? '.' + tail : ''); };

export function bulkProgress(status, localState) {
  if (status.state === 'minted') return 'Every member has a verified confirmed mint and completed accounting.';
  if (status.creditReferences?.length) return 'Payment recovery is owed. This is not a refund confirmation.';
  if (status.mintSender?.state === 'fee_wait') return 'Waiting for Bitcoin fees to fit the signed allowance. No second payment is requested.';
  if (status.mintSender?.sentBatches > 0) return 'Inscription transactions were sent. Waiting for Bitcoin confirmation, TAP indexing and member completion.';
  if (['permit_issued', 'minting', 'partly_minted'].includes(status.state)) return 'Permits are issued. The server is sending the saved mint transactions.';
  if (status.state === 'permit_pending') return `Payment is verified. Recovering member signatures (${status.permit?.readyCount ?? 0}/${status.count}).`;
  if (status.state === 'paid') return 'The full TAP payment is verified. Waiting for the mint permits.';
  if (status.state === 'partly_paid') return 'Only part of the payment succeeded. This order cannot be paid again or mint a subset.';
  if (status.state === 'needs_attention') return 'This order needs attention. Issued members remain held for recovery.';
  if (['releasing', 'expired'].includes(status.state)) return 'Unissued members are being released or have expired. A payment may still need recovery.';
  if (localState === 'payment_pending') return 'The wallet result is uncertain. Keep this order and inspect TAP Wallet before explicitly retrying.';
  if (localState === 'payment_submitted') return 'Payment sent. Waiting for confirmed successful TAP transfers. You can close this page.';
  if (status.state === 'reserving') return 'The reservation is being accepted. Payment will become available here after acceptance.';
  return 'Review this order and approve its one wallet payment when ready.';
}

// The gateway serves this module as the entry point for /mint/bulk/:id. It can
// also be mounted by a site router; cleanup stops polling without touching the journal.
export function mountBulkMint(root, { orderId, network, reads = bulkApi, wallet, refreshMs = 5000 } = {}) {
  if (!/^[0-9a-f]{64}$/.test(orderId ?? '')) throw Error('invalid_bulk_order');
  wallet ??= new TapWalletBulkMint({ network, readStatus: reads.status, readTerms: reads.terms, reportPayment: reads.payment });
  let stopped = false, timer, busy = false, localState, reported = false, offset = 0;
  const page = node('main', undefined, 'page'), heading = node('h1', 'Bulk mint order'), message = node('p', 'Loading accepted order…', 'note'), summary = node('section', undefined, 'panel'), members = node('section', undefined, 'panel');
  message.role = 'status'; message.setAttribute('aria-live', 'polite');
  page.append(heading, node('p', orderId, 'mono'), message, summary, members); root.replaceChildren(page);
  const action = (label, fn) => {
    const button = node('button', label, 'btn'); button.type = 'button';
    button.addEventListener('click', async () => {
      if (busy || stopped) return; busy = true; button.disabled = true;
      try { await fn(); } catch (error) { message.textContent = error.message; }
      finally { busy = false; button.disabled = false; }
    }); return button;
  };
  async function pay(retry = false) {
    wallet.provider = globalThis.tapprotocol; await wallet.connect();
    const fresh = await wallet.plan(orderId);
    if (retry) {
      if (!confirm('Retry only if TAP Wallet shows no sent payment for this exact order. Bitcoin will also be checked before another attempt.')) return;
    } else if (!confirm(`Pay and mint ${fresh.status.count} blocks?\nPayable TAP: ${tap(fresh.terms.payableFeeAtoms)}\nBitcoin set aside: ${fresh.terms.mintFunding.satoshis} sats\nOnly this order is approved.`)) return;
    const result = await wallet.pay(orderId, { retry }); localState = result.localState; reported = localState === 'payment_submitted';
    await refresh();
  }
  async function refresh() {
    const [status, response, memberPage] = await Promise.all([reads.status(orderId), reads.terms(orderId), reads.members(orderId, { offset, limit: 64 })]);
    if (stopped) return;
    const plan = bulkPaymentPlan(orderId, status, response, network);
    if (memberPage.orderId !== orderId) throw Error('Bulk member page mismatch');
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
    heading.textContent = `Mint ${status.count} blocks · ${status.ticker}`;
    message.textContent = bulkProgress(status, localState);
    summary.replaceChildren(node('h2', 'Accepted order'), node('p', 'Blocks: ' + plan.terms.members.map(m => m.block).join(', ')),
      node('p', `Gross fee: ${tap(plan.terms.grossFeeAtoms)} TAP · Payable fee: ${tap(plan.terms.payableFeeAtoms)} TAP`),
      node('p', `Bitcoin set aside: ${plan.terms.mintFunding.satoshis} sats`), node('p', 'Returned to you after the mint, minus the Bitcoin network fees and the 546 sats per block that stay with the inscriptions.', 'small muted'), node('p', 'Payer: ' + plan.terms.payer, 'mono'), node('p', 'Receiver: ' + plan.terms.receiver, 'mono'));
    const progress = status.progress, permit = status.permit, sender = status.mintSender;
    summary.append(node('p', `Payment: ${status.payment?.state ?? status.state} · Permits ready: ${permit?.readyCount ?? 0}/${status.count} · Reveal batches sent: ${sender?.sentBatches ?? 0}/${sender?.totalBatches ?? 0}`),
      node('p', `Confirmed mints: ${progress?.minted ?? 0}/${status.count} · Released: ${progress?.released ?? 0} · Unresolved: ${progress?.unresolved ?? status.count}`));
    if (status.payable && status.state === 'awaiting_payment' && localState !== 'payment_submitted')
      summary.append(action(localState === 'payment_pending' ? 'Check and retry this payment' : `Pay and mint ${status.count} blocks`, () => pay(localState === 'payment_pending')));
    members.replaceChildren(node('h2', 'Member progress'));
    for (const member of memberPage.members) members.append(node('p', `Block ${member.block} · ${member.amount} units · ${member.state}${member.inscription ? ' · ' + member.inscription : ''}${member.reason ? ' · ' + member.reason : ''}`));
    if (memberPage.next !== null) members.append(action('Next members', async () => { offset = memberPage.next; await refresh(); }));
    if (offset) members.append(action('First members', async () => { offset = 0; await refresh(); }));
  }
  async function tick() {
    try { if (!busy) await refresh(); } catch (error) { if (!stopped) message.textContent = error.message; }
    if (!stopped) timer = setTimeout(tick, refreshMs);
  }
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}

if (typeof document !== 'undefined' && document.querySelector('script[src="/web/bulk-mint.js"]')) {
  const orderId = /^\/mint\/bulk\/([0-9a-f]{64})\/?$/.exec(location.pathname)?.[1];
  const root = document.getElementById('app');
  try {
    const target = await api('/web-api/target', { wire: true });
    const close = mountBulkMint(root, { orderId, network: target.bitcoinNetwork });
    addEventListener('pagehide', close, { once: true });
  } catch (error) { root.replaceChildren(node('p', error.message, 'note')); }
}
