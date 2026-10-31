// Deploy your own ticker (/mint/<asset>?ticker=<request>): pay the request's deploy fee from TAP Wallet,
// inscribe its deploy from the same wallet, and the page registers it once it is in a Bitcoin block.
import { h, clear, kv, pill, hashEl, panel, table, stepper, confirmModal, fmtInt } from './console/js/dom.js';
import { tap, splitTable } from './console/js/money.js';
import { assetName, mineral, addressLink, inscriptionLink, inflightNote, inflightLine, inflightTxid } from './console/js/words.js';
import { site } from './console/js/api.js';
import { walletError } from './console/js/wallet-errors.js';
import { TapWalletMint, BrowserMintJournal, tapWalletCapabilities } from './console/js/inscribe/wallet.js';
import { tickerWords, quoteFeeText, chosenTicker, forgetTickers, SAME_REWARDS } from './console/js/tickers.js';

// Protocol responses keep their network fields; the display adapter strips them.
async function api(path, body) {
  const response = await fetch(path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) } });
  const result = await response.json().catch(() => ({ error: 'request_failed' }));
  if (!response.ok) throw Object.assign(Error(result.error ?? 'request_failed'), { status: response.status });
  return result;
}
const local = globalThis.DMW_LOCAL_AGENT === true;
// The dashboard's agent supplies its bound payout wallet; on the site the connected TAP Wallet asks.
export const requestTicker = (asset, ticker, receiver, extra = {}) => local ? api('/api/deploy-ticker', { asset, ticker, ...extra }) : api('/mint/deploy-ticker', { asset, ticker, receiver, ...extra });
export const tickerHref = (asset, id) => `/mint/${asset}?` + new URLSearchParams({ ticker: id });
const notYet = error => ['deployment_confirmations', 'tap_quorum_unavailable', 'request_failed', 'request_pending'].includes(error?.message);
const PAY_STATES = ['awaiting_payment', 'partly_paid'];

export function tickerPage(root, { asset, id }) {
  const compound = /^c2:[0-9a-f]{64}$/.test(asset);
  const progress = h('div'), lead = h('div.section-gap'), body = h('div.stack'), side = h('div.stack');
  const actions = h('div.row.actions'), note = h('div.callout', { role: 'status', 'aria-live': 'polite' });
  const say = (text, kind = '') => { note.className = 'callout' + (kind ? ' ' + kind : ''); clear(note, text); };
  root.append(h('div.page', {}, h('div.page-head', {}, h('h1', {}, 'Deploy your own ticker')),
    h('p.lead-text', {}, `Your ticker is another TAP token for ${compound ? 'this compound' : 'this pattern'}. It shares the units of the official token: a unit minted into one ticker cannot be minted into another. Every mint into your ticker pays the same rewards, plus a share to whoever holds your deploy inscription.`),
    h('div.flow', {}, progress, h('div.grid.cols-main', {},
      h('div.stack', {}, h('section.panel.next-step', {}, h('header', {}, h('h2', {}, 'Next step')), h('div.body', {}, lead, note, actions)), body), side))));
  let stopped = false, busy = false, timer, target, wallet, job, lastRegister = 0, lastInflight = 0;
  const journal = new BrowserMintJournal();
  const attempt = async (fn, clicked) => {
    if (busy || stopped) return; busy = true;
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    clicked?.classList.add('busy'); say('Working…', 'busy');
    try { await fn(); if (!stopped && note.textContent === 'Working…') say(''); }
    catch (error) { if (!stopped) say(TICKER_ERROR(error), 'bad'); }
    finally { busy = false; clicked?.classList.remove('busy'); if (note.classList.contains('busy')) note.className = 'callout info'; for (const b of actions.querySelectorAll('button')) b.disabled = false; }
  };
  const TICKER_ERROR = error => /^[a-z0-9_]+$/.test(error?.message ?? '') ? tickerWords(error.message) : walletError(error);
  const button = (label, fn, kind = '') => h(`button.btn${kind === 'primary' ? '.primary.cta' : kind === 'quiet' ? '.ghost' : ''}`, { onclick: e => attempt(fn, e.currentTarget) }, label);
  const receiptKey = () => `${target.network}/ticker-deploy/${id}`, paidKey = () => `${target.network}/ticker-fee/${id}`;
  const confirmFees = terms => confirmModal({ title: 'Inscribe with your Bitcoin wallet?',
    lead: 'Your wallet funds the commit and this browser sends the saved reveal. Keep this link to resume.',
    rows: [['Fee rate', `${terms.feeRate} sat/vB (mempool.space half-hour estimate)`], ['Miner fees', `${terms.feeSats} sat`], ['Postage', `${terms.postage} sat`], ['Receiver', hashEl(terms.receiver)]], confirm: terms.resume ? 'Resume' : 'Inscribe' });
  const register = async inscription => {
    lastRegister = Date.now();
    try { await api('/mint/deploy-ticker', { asset, requestId: id, inscription, phase: 'deployment' }); forgetTickers(asset); }
    catch (error) { if (!notYet(error)) throw error; }
  };
  // The sent deploy, checked on Bitcoin by the gateway and shown to every viewer until it is registered.
  const reportInflight = async inscription => {
    lastInflight = Date.now();
    try { await api('/mint/inflight', { kind: 'ticker', ref: id, phase: 'deployment', attempt: 0, ...inscription }); } catch {}
  };
  const report = async paymentId => {
    try { await api('/mint/ticker-payment', { id, paymentIds: [paymentId] }); }
    catch (error) { if (!/payment|confirm|unconfirmed|request_pending|request_failed/.test(error.message)) throw error; }
  };

  const draw = async () => {
    const registered = job.state === 'registered', fee = job.fee, free = !fee || BigInt(fee.price ?? 0) === 0n;
    const ticker = job.ticker ?? job.entry?.tick, receipt = await journal.get(receiptKey()), paid = await journal.get(paidKey());
    if (stopped) return;
    const labels = free ? ['Reserve name', 'Deploy ticker', 'Done'] : ['Reserve name', 'Pay fee', 'Deploy ticker', 'Done'];
    const at = registered ? labels.length : job.state === 'awaiting_player_deploy' ? labels.length - 2 : 1;
    clear(progress, stepper(labels, at, { failed: ['refused', 'recovery', 'refund_pending'].includes(job.state) || ['refused', 'recovery', 'refund_pending'].includes(fee?.state) }));
    const next = [button('Refresh', refresh, 'quiet')];
    clear(lead);
    if (registered) {
      lead.append(h('div.callout.good', {}, h('strong', {}, 'Your ticker is deployed. '), `Mints of ${assetName(asset)} can now choose ${ticker}. `, SAME_REWARDS),
        h('div.row', { style: { marginTop: '10px' } }, h('a.btn.primary', { href: site.href('table', compound ? { c: asset } : { p: asset }) }, `Open ${assetName(asset)}`)));
    } else if (job.state === 'awaiting_fee' && PAY_STATES.includes(fee?.state)) {
      lead.append(h('div', {}, h('div.small.muted', {}, fee.state === 'partly_paid' ? 'Remaining deploy fee' : 'Deploy fee'), h('div.price', {}, quoteFeeText(fee))));
      if (paid?.paymentId) lead.append(h('div.callout.info', {}, 'Fee sent. It is credited once Bitcoin confirms it; this page reports it and updates by itself.'));
      else if (fee.payable) next.push(button('Pay deploy fee', pay, 'primary'));
      if (fee.state === 'awaiting_payment' && !paid?.paymentId) next.push(button('Cancel request', cancel, 'quiet'));
    } else if (job.state === 'awaiting_fee' && fee?.state === 'paid' || job.state === 'awaiting_fee' && free) {
      lead.append(h('div.callout.busy', {}, 'Fee paid. Your deploy inscription is being prepared; this page updates by itself.'));
    } else if (job.state === 'awaiting_player_deploy') {
      const inflight = inflightTxid(job.inflight) ? job.inflight : null;
      if (receipt) {
        lead.append(inflightNote(inflight ?? { phase: 'deployment', revealTxid: receipt.inscriptionId.slice(0, 64) }, { detail: 'Sent. Waiting for the next Bitcoin block (about 10 minutes). This page registers it automatically; keep it open or come back to this link.' }));
        next.push(button('Check now', async () => { await register(receipt.inscriptionId); await refresh(); }, 'primary'));
      } else if (inflight) lead.append(inflightNote(inflight, { detail: 'This page updates by itself once it is in a block.' }));
      else next.push(button('Deploy ticker', deploy, 'primary'));
    } else {
      const reason = job.reason ?? fee?.reason;
      lead.append(h('div.callout.bad', {}, reason ? tickerWords(reason) : 'This request stopped.', fee?.refunds?.length ? ' Your fee is refunded to your TAP Wallet.' : ''));
      if (reason === 'ticker_expired') next.push(button('Start again', async () => {
        const fresh = await requestTicker(asset, ticker, job.receiver, { retry: true });
        history.replaceState(null, '', tickerHref(asset, fresh.id)); id = fresh.id; await refresh();
      }, 'primary'));
    }
    clear(actions, ...next.filter(b => !b.classList.contains('ghost')), ...next.filter(b => b.classList.contains('ghost')));
    const missing = fee?.missing ?? [];
    clear(body, missing.length && !registered ? panel('Remaining fees', table(missing, [
      { key: 'role', label: 'Fee', render: f => String(f.role).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) },
      { key: 'amount', label: 'Amount', num: true, render: f => h('span.mono', {}, tap(f.amount, fee.unit)) },
      { key: 'to', label: 'Paid to', render: f => f.to ? addressLink(f.to) : h('span.faint', {}, 'burn') }], { sortable: false }), { flush: true }) : null,
    fee?.split && !free ? panel('Fee split', h('div', { style: { padding: '0 14px 4px' } }, splitTable(fee.split, fee.destinations ?? {}, 'tap', fee.unit)), { flush: true }) : null,
    h('p.small.muted', { style: { margin: 0 } }, 'The deploy inscription costs only Bitcoin network fees; TAP Wallet shows them before you approve. You can close this page between steps: open this same link again to continue.'));
    clear(side, panel(compound ? 'Compound' : 'Pattern', kv([
      [compound ? 'Compound' : 'Pattern', h('span', {}, h('span.swatch', { style: { background: mineral(asset) } }), h('a', { href: site.href('table', compound ? { c: asset } : { p: asset }) }, assetName(asset)))],
      ['Your ticker', h('span.mono', {}, ticker ?? '–')],
      ['State', pill(registered ? 'deployed' : job.state === 'awaiting_player_deploy' ? 'ready to deploy' : job.state === 'awaiting_fee' ? 'fee due' : String(job.state).replace(/_/g, ' '), registered ? 'good' : job.state === 'refused' ? 'bad' : 'warn')],
      ['Deploy fee', quoteFeeText(fee)],
      fee?.refundFunding && PAY_STATES.includes(fee.state) ? ['Bitcoin set aside', h('div', {}, h('span.mono', {}, `${fmtInt(fee.refundFunding.satoshis)} sats`),
        h('div.small.muted', {}, 'Returned to you after the deploy is registered, minus the Bitcoin network fee.'))] : null,
      job.receiver ? ['Your wallet', addressLink(job.receiver)] : null,
      receipt ? ['Your inscription', inscriptionLink(receipt.inscriptionId)] : job.entry?.id ? ['Deploy inscription', inscriptionLink(job.entry.id)] : !registered && inflightTxid(job.inflight) ? ['Inscription sent', inflightLine(job.inflight)] : null,
    ]), { flush: true }));
    // A sent fee or inscription is reported again until it counts.
    if (paid?.paymentId && PAY_STATES.includes(fee?.state) && Date.now() - lastRegister > 30000) { lastRegister = Date.now(); void report(paid.paymentId).catch(() => {}); }
    if (receipt && job.state === 'awaiting_player_deploy' && job.inflight?.revealTxid !== receipt.inscriptionId.slice(0, 64) && Date.now() - lastInflight > 30000)
      void reportInflight({ revealTxid: receipt.inscriptionId.slice(0, 64), inscriptionId: receipt.inscriptionId });
    if (receipt && job.state === 'awaiting_player_deploy' && Date.now() - lastRegister > 30000) void register(receipt.inscriptionId).then(() => refresh()).catch(error => { if (!stopped) say(TICKER_ERROR(error), 'bad'); });
  };
  async function pay() {
    await tapWalletCapabilities(globalThis.tapprotocol);
    const fee = job.fee;
    if (!await confirmModal({ title: 'Pay the deploy fee?', lead: 'TAP Wallet pays the fee items of this request in one TAP payment. If your ticker cannot be registered, the fee is refunded.',
      rows: [...(fee.missing ?? []).map(f => [String(f.role).replace(/_/g, ' '), tap(f.amount, fee.unit)])].filter(Boolean), confirm: 'Pay from my wallet' })) return;
    await wallet.connect();
    let result = await wallet.payTickerFee(job);
    if (result.retryable && await confirmModal({ title: 'Retry the payment?', lead: 'TAP Wallet returned no receipt for the last attempt. Retry only if your wallet shows no sent payment for this ticker.', rows: [], confirm: 'Retry payment' })) result = await wallet.payTickerFee(job, { retry: true });
    if (result.localState === 'payment_pending') throw Error(result.message);
    if (/^[0-9a-f]{64}i[0-9]+$/.test(result.paymentId ?? '')) { await journal.put(paidKey(), { paymentId: result.paymentId }); await report(result.paymentId); }
    await refresh();
  }
  async function cancel() {
    if (!await confirmModal({ title: 'Cancel this ticker request?', lead: 'Nothing has been paid. The name is released for others.', rows: [], confirm: 'Cancel request', danger: true })) return;
    await api('/mint/ticker-payment', { id, expire: true }); await refresh();
  }
  async function deploy() {
    await wallet.connect();
    const fresh = await api(`/mint/ticker-state/${asset}?` + new URLSearchParams({ selector: id }));
    if (fresh.state !== 'awaiting_player_deploy') { job = fresh; await draw(); return; }
    const result = await wallet.inscribeTickerDeployment(fresh, { validateTicker: chosenTicker, maxFeeSats: '1000000', confirm: confirmFees });
    if (result.state !== 'broadcast') return;
    await journal.put(receiptKey(), { inscriptionId: result.inscriptionId });
    await reportInflight({ commitTxid: result.commitTxid, revealTxid: result.revealTxid, inscriptionId: result.inscriptionId });
    await register(result.inscriptionId); await refresh();
  }
  async function refresh() {
    job = await api(`/mint/ticker-state/${asset}?` + new URLSearchParams({ selector: id }));
    if (!stopped) await draw();
  }
  const poll = () => { timer = setTimeout(async () => { if (stopped) return; if (!busy) try { await refresh(); } catch { say('Status unavailable. Refresh to retry.', 'warn'); } if (job?.state !== 'registered') poll(); }, 5000); };
  void attempt(async () => {
    target = await api('/web-api/target');
    if (!['mainnet', 'regtest'].includes(target.bitcoinNetwork)) throw Error('Invalid Bitcoin network');
    wallet = new TapWalletMint({ network: target.bitcoinNetwork, journal, notify: text => say(text, busy ? 'busy' : 'info') });
    await refresh(); poll();
  });
  return () => { stopped = true; clearTimeout(timer); };
}
