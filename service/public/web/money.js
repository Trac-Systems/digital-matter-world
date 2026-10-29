import { api } from './data.js';
import { walletError, publicMintMessages, publicOpeningLabel, PAY_SOON, BEFORE_PAY } from './console/js/wallet-errors.js';
import { mount as mintPage, findPayment, refundStatus } from './console/js/inscribe/public.js';
import { presentation, get, store, site } from './console/js/api.js';
import { tokenStatus } from './console/js/views/table.js';
import { pagedTable } from './console/js/paged.js';
import { h, clear, panel, kv, pill, hashEl, fmtInt, table, confirmModal, stepper, figures, inspectBtn as rawInspectBtn } from './console/js/dom.js';
import { splitTable, btc, tap, feePrice } from './console/js/money.js';
import { assetName, mineral, title } from './console/js/words.js';
import { formatTap } from './amount-format.js';
import { tapAccount, ethAccount, receipt, orderResult, authority, oneTxReady, requireTapActions, WalletJournal, wait, hex, sha256, unhex, fail } from './wallets.js';
import { wallet, walletSummary, connectButtons } from './connect.js';
const inspectBtn = (title, value) => rawInspectBtn(title, () => presentation(typeof value === 'function' ? value() : value));
const complete = new Set(['complete', 'accepted', 'settled', 'minted', 'credited', 'refunded']);
const stopped = new Set(['expired', 'cancelled', 'rejected', 'refund_wait', 'refund_eligible', 'unpaid_expired', 'quarantined', 'recovery', 'failed']);
const TITLES = { link: 'Link a Bitmap', 'bind-payout': 'Bind payout wallet' };
const STEPS = { lock: 'TAP payment lock', 'link-release': 'Bitmap link fee release', approval: 'TAP allowance', deposit: 'Escrow deposit', networkFee: 'Bitcoin inscription fee', refund: 'Refund', 'authority-order': 'TAP authority', 'authority-activation': 'TAP authority activation' };
const statePill = s => pill(String(s ?? '–').replace(/_/g, ' '), complete.has(s) ? 'good' : stopped.has(s) ? 'bad' : 'warn');
const note = (attrs = {}) => h('div.note', { role: 'status', ...attrs });
const blockLink = n => n === null || n === undefined ? null : h('a.mono', { href: '/block/' + n }, fmtInt(n));
// /mint, /link and /bind-payout without a request link are one page: Mint & wallets. A request link
// (/mint/<id>, /link/<id>, /bind-payout/<id>) opens that request's own flow, with a way back.
export function moneyPage(root, { type, id }) {
  if (!id) return walletsHome(root, type);
  const back = h('div.row', { style: { marginBottom: '16px' } }, h('a.btn.sm.ghost', { href: '/mint' }, '← Mint & wallets'));
  if (type === 'mint') {
    const cleanup = mintPage(root, { id, onPublicMint: mintPublic });
    root.querySelector('.page-head').after(back);
    return cleanup;
  }
  const app = h('div.stack'), side = h('div.stack'), progress = h('div');
  root.append(h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, TITLES[type]), h('p', {}, 'Mining, claims, discoveries and crafting are free. Payments happen here through your wallet.'))),
    back,
    h('div.flow', {}, progress, h('div.grid.cols-main', {}, app, side))));
  // Mount returns a disposer immediately; pending reads belong to this view only.
  let stopped = false;
  async function load() {
    let target;
    try { target = await api('/web-api/target'); }
    catch (e) { if (!stopped) app.append(h('div.note.bad', {}, `Unable to load: ${walletError(e)}.`)); return; }
    if (stopped) return;
    side.append(panel('Payment contracts', kv([
      target.ethereum ? ['Bridged TAP token', hashEl(target.ethereum.token)] : null,
      target.ethereum ? ['Escrow contract', hashEl(target.ethereum.escrow)] : null,
    ]), { flush: true }));
    try {
      if (type === 'bind-payout') return await binding(app, id, target);
      await request(app, type, id, target, progress);
    } catch (e) { if (!stopped) app.append(h('div.note.bad', { role: 'alert' }, `Unable to load: ${walletError(e)}. `, h('a', { href: location.pathname + location.search }, 'Retry'))); }
  }
  void load();
  return () => { stopped = true; };
}
// A request's payment page: the step indicator, one Next step panel (fee, status, the primary action), then the review.
async function request(app, type, id, target, progress) {
  const journal = new WalletJournal(`${target.network}/${type}/${id}`);
  const review = h('section.panel'), status = h('div.callout', { role: 'status' }), evidence = h('div'), lead = h('div');
  const pay = h('button.btn.primary.cta', { type: 'button' }, 'Connect wallet and continue');
  const refresh = h('button.btn.ghost', { type: 'button' }, 'Refresh receipt');
  const refund = h('button.btn', { type: 'button', hidden: true }, 'Refund with wallet');
  app.append(h('section.panel.next-step', {}, h('header', {}, h('h2', {}, 'Payment')), h('div.body', {}, lead, status, h('div.row.actions', {}, pay, refund, refresh))), review, evidence);
  let plan, busy = false;
  const mayPay = () => type === 'mint' || plan?.financialVersion === 2 ? !!plan && (plan.ethereumRelease && plan.ethereumDepositStatus === 1 && !plan.ethereumRefundEligible || plan.payable && ['awaiting_payment','partly_paid'].includes(plan.state)) : ['awaiting_wallet','waiting_payment'].includes(plan?.state);
  // Wallet progress shows busy; the final word is good, bad or plain information.
  const notify = (s, kind = 'busy') => { status.className = 'callout' + (kind ? ' ' + kind : ''); status.textContent = s; };
  const receipts = () => {
    const steps = Object.entries(journal.data).filter(([, step]) => step && typeof step === 'object' && step.state).map(([name, step]) => ({ name, ...step }));
    const ledger = '/results/' + (type === 'mint' ? 'mints' : 'links');
    clear(evidence, panel('Wallet receipts', [
      table(steps, [
        { key: 'name', label: 'Step', render: r => STEPS[r.name] ?? r.name },
        { key: 'state', label: 'State', render: r => pill(r.state === 'done' ? 'done' : r.state, r.state === 'done' ? 'good' : 'warn') },
        { key: 'result', label: 'Transaction', render: r => typeof r.result === 'string' ? hashEl(r.result) : r.result ? inspectBtn(STEPS[r.name] ?? r.name, r.result) : h('span.faint', {}, '–') },
      ], { sortable: false, empty: 'No wallet step yet.' }),
      plan?.payment || plan?.inscription ? kv([plan.payment ? ['Indexed payment', hashEl(plan.payment)] : null, plan.inscription ? ['Bitcoin inscription', hashEl(plan.inscription)] : null]) : null,
      h('div.row', { style: { padding: '10px 14px' } }, h('a.btn.sm.ghost', { href: ledger }, 'Public result ledger')),
    ], { flush: true }));
  };
  async function load() {
    plan = await api(`/web-api/${type}/${id}`);
    const unit = plan.unit, labels = type === 'link' ? ['Prepare', 'Pay', 'Confirm', 'Linked'] : ['Pay', 'Confirm', 'Done'];
    const at = complete.has(plan.state) ? labels.length : type === 'link' ? (plan.walletPreparation ? 0 : plan.payment ? 2 : 1) : plan.payment ? 1 : 0;
    clear(progress, stepper(labels, at, { failed: stopped.has(plan.state) }));
    clear(lead, plan.price && !complete.has(plan.state) ? h('div', {}, h('div.small.muted', {}, 'Fee'), h('div.price', {}, formatTap(plan.price, unit?.decimals))) : null);
    clear(review,
      h('header', {}, h('h2', {}, 'Review request'), statePill(plan.state), h('div.grow'), inspectBtn('Request', plan)),
      kv([
        ['Request', hashEl(plan.id)],
        plan.asset ? ['Matter', h('span', {}, h('span.swatch', { style: { background: mineral(plan.asset) } }), assetName(plan.asset))] : null,
        plan.block !== null && plan.block !== undefined ? [type === 'mint' ? 'From block' : 'Block', blockLink(plan.block)] : null,
        plan.amount ? ['Units used up', h('span.mono', {}, fmtInt(plan.amount))] : null,
        plan.kind ? ['Paid with', plan.kind === 'ethereum' ? 'Bridged TAP' : 'TAP'] : null,
        plan.price ? ['Fee', h('strong.mono', {}, formatTap(plan.price, unit?.decimals))] : null,
        plan.baseFee ? ['Base fee', h('span.mono', {}, formatTap(plan.baseFee, unit?.decimals))] : null,
        plan.networkFee && BigInt(plan.networkFee.sats ?? 0) > 0n ? ['Bitcoin inscription fee', h('span.mono', {}, `${btc(plan.networkFee.sats)} · ${fmtInt(plan.networkFee.sats)} sats`)] : null,
        ['Payer', hashEl(plan.payer)],
        plan.owner ? ['Agent', hashEl(plan.owner)] : null,
        plan.receiver ? ['Receiver', hashEl(plan.receiver)] : null,
        plan.deadline !== undefined ? ['Pay by block', h('span.mono', {}, fmtInt(plan.deadline))] : null,
        plan.refundAfter !== undefined && plan.refundAfter !== null ? ['Refund after block', h('span.mono', {}, fmtInt(plan.refundAfter))] : null,
        plan.ethereumRefundAfter ? ['Escrow refund from', h('span.mono', {}, new Date(Number(plan.ethereumRefundAfter) * 1000).toLocaleString())] : null,
        plan.counted !== undefined ? ['Counted', h('span.mono', {}, fmtInt(plan.counted))] : null,
        plan.reason ? ['Reason', publicMintMessages[plan.reason] ?? String(plan.reason).replace(/_/g, ' ')] : null,
      ]),
      plan.split ? [h('div.section-label', {}, 'Fee split'), h('div', { style: { padding: '0 14px 4px' } }, splitTable(plan.split, plan.destinations ?? {}, plan.kind, unit))] : null,
      h('div.body.small.muted', {}, type === 'link' ? 'Bitmap links are paid before publication. The link follows the Bitmap when it changes owners.'
        : type === 'mint' ? 'Pay the remaining fees first. After payment is final, your units are consumed and your permanent permit is ready. You then inscribe it from your Bitcoin wallet, including when paying with Ethereum.' : 'The wallet can refund after the displayed deadline if payment remains unspent.'));
    if (type === 'mint' || plan.financialVersion === 2) {
      if (!mayPay() && BEFORE_PAY.includes(plan.state)) review.append(h('div.callout.busy', {}, PAY_SOON));
      else if (plan.blocked?.length) review.append(h('div.note.bad', {}, 'This payment is not currently available.'));
      if (plan.missing?.length) review.append(h('div.section-label', {}, 'Remaining fees'), table(plan.missing, [
        { key: 'role', label: 'Fee', render: f => String(f.role).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) },
        { key: 'amount', label: 'Amount', num: true, render: f => h('span.mono', {}, formatTap(f.amount, 18)) }], { sortable: false }));
      if (plan.inscriptionText) review.append(h('div.section-label', {}, 'Permanent mint content'), h('div.body', {}, h('p', { style: { marginTop: 0 } }, 'Inscribe this exact content from your Bitcoin wallet to the receiver above. This permit does not expire.'), h('pre', {}, plan.inscriptionText)));
    }
    pay.disabled = busy || !mayPay();
    pay.textContent = type === 'mint' && plan.ethereumRelease && plan.ethereumDepositStatus === 1 ? 'Release paid fees with wallet' : plan.walletPreparation ? 'Prepare Bitmap payment with wallet' : journal.data.lock || journal.data.deposit || journal.data.networkFee ? 'Resume payment' : 'Approve payment in wallet';
    refund.hidden = (type === 'mint' || plan.financialVersion === 2) && plan.kind === 'tap' || complete.has(plan.state) || (plan.kind === 'ethereum' ? !plan.ethereumRefundEligible : !(plan.payment || journal.data.paymentId) || plan.counted < plan.refundAfter);
    const words = v => String(v).replace(/_/g, ' ');
    notify(complete.has(plan.state) ? `Confirmed: ${words(plan.state)}.` : `Request state: ${words(plan.state)}${plan.reason ? ' — ' + words(plan.reason) : ''}.`, complete.has(plan.state) ? 'good' : stopped.has(plan.state) ? 'bad' : '');
    receipts();
  }
  async function guard(fn, clicked) {
    if (busy) return; busy = true; pay.disabled = refresh.disabled = refund.disabled = true; clicked?.classList.add('busy');
    try {
      if (!navigator.locks) fail('This browser needs Web Locks to safely resume wallet payments.');
      await navigator.locks.request(journal.key, { ifAvailable: true }, async lock => {
        if (!lock) fail('This payment is open in another tab. Continue there.');
        journal.data = JSON.parse(localStorage.getItem(journal.key) ?? '{}'); await fn();
      });
    } catch (e) { notify(e.code === 4001 ? 'Wallet request closed. If a payment step was started, its result may be uncertain. Inspect TAP Wallet; saved payment attempts will not be sent again.' : walletError(e), 'bad'); }
    finally { busy = false; clicked?.classList.remove('busy'); if (status.classList.contains('busy')) notify(status.textContent, 'info'); refresh.disabled = refund.disabled = false; pay.disabled = !mayPay(); receipts(); }
  }
  async function prepare() {
    const { tap } = await tapAccount(target, plan.payer);
    requireTapActions(tap);
    if (!journal.data.linkSecret) { journal.data.linkSecret = hex(crypto.getRandomValues(new Uint8Array(32))); journal.save(); }
    const paymentHash = await sha256(unhex(journal.data.linkSecret));
    const message = `dmw-link-payment-v1\n${target.network}\n${id}\n${paymentHash}`;
    const walletSignature = await tap.signMessage(message, 'bip322-simple');
    await api(`/web-api/link/${id}/prepare`, { paymentHash, walletSignature });
    await load(); notify('Payment prepared. Review the fixed fee and split, then approve payment.', 'good');
  }
  async function sendPayment() {
    await load();
    if (complete.has(plan.state)) return;
    if (type === 'link' && plan.walletPreparation) return prepare();
    if (type === 'mint' || plan.financialVersion === 2) return sendMintPayment();
    if (type === 'link') {
      if (!journal.data.linkSecret) fail('This link was prepared elsewhere. Continue in the browser that prepared it, or ask your agent for a new link request.');
      if (await sha256(unhex(journal.data.linkSecret)) !== plan.redeem?.actions[0].condition.hash) fail('The saved Bitmap payment does not match this request.');
    }
    const { tap, address } = await tapAccount(target, plan.kind === 'tap' ? plan.payer : undefined);
    if (plan.kind === 'tap') {
      const checkAccount = () => tapAccount(target, plan.payer);
      const auth = await authority(tap, address, journal, notify, checkAccount);
      await tapAccount(target, plan.payer);
      notify('Approve the TAP payment lock in your wallet.');
      const order = await journal.step('lock', () => tap.redeemTapActions({ ...plan.redeem, auth }, { label: `Digital Matter World ${type}` }));
      journal.data.paymentId = await orderResult(tap, order) + ':0'; journal.save();
      if (type === 'link') {
        notify('Waiting for the payment lock to be confirmed and accepted before releasing the fee.');
        let verified;
        for (let i = 0; i < 90; i++) {
          verified = await api(`/web-api/link/${id}/lock?paymentId=${encodeURIComponent(journal.data.paymentId)}`);
          if (verified.ready || verified.consumed) break;
          await wait(2000);
        }
        if (!verified?.ready && !verified?.consumed) fail('Payment lock is not verified yet. Resume to check again; the saved payment will not be repeated.');
        if (!verified.consumed) {
          await tapAccount(target, plan.payer); notify('Approve release of the Bitmap link fee to the displayed split.');
          const released = await journal.step('link-release', () => tap.redeemTapActions({ auth, items: [], data: id,
            actions: [{ op: 'claim', lock: journal.data.paymentId, preimage: journal.data.linkSecret }] }, { label: 'Release Bitmap link fee' }));
          await orderResult(tap, released);
        }
      }
    } else {
      const { eth } = await ethAccount(target, plan.payer);
      // Save exact deposit expiry/calldata before the first wallet transaction.
      if (!journal.data.ethereumPlan) { journal.data.ethereumPlan = plan.transactions; journal.save(); }
      for (const [i, name] of (plan.ethereumDepositStatus ? [] : ['approval', 'deposit']).entries()) {
        await ethAccount(target, plan.payer); notify(`Approve the ${name === 'approval' ? 'exact TAP allowance' : 'TAP escrow deposit'} in MetaMask.`);
        const tx = await journal.step(name, () => eth.request({ method: 'eth_sendTransaction', params: [journal.data.ethereumPlan[i]] }));
        await receipt(eth, tx);
      }
      journal.data.paymentId = id; journal.save();
    }
    notify('Payment sent. Waiting for block inclusion and gateway verification…'); receipts();
    // Submission is idempotent by the same request/payment IDs. Never resend
    // wallet transactions just because the indexers are still catching up.
    for (let i = 0; i < 90; i++) {
      const current = await api(`/web-api/${type}/${id}`);
      if (current.payment || complete.has(current.state)) break;
      try { await api(plan.submit, { id, paymentId: journal.data.paymentId }); break; }
      catch (e) { if (!/payment|unconfirmed|unpaid|confirm|lock_missing|unavailable|read_failed|escrow/.test(e.message)) throw e; }
      await wait(2000);
    }
    await load();
    if (!complete.has(plan.state)) notify('Payment submitted or awaiting confirmations. Refresh the receipt to follow completion; completed wallet steps are saved.', 'info');
  }
  async function sendMintPayment() {
    if (!mayPay()) fail('This request is not ready for a wallet payment. Refresh its status.');
    if (plan.kind === 'tap') {
      if (plan.blocked?.length) fail('This payment is not currently available.');
      const { tap, address } = await tapAccount(target, plan.payer);
      if (typeof tap.singleTxTransfer !== 'function') fail('This wallet does not support direct TAP fee items.');
      await authority(tap, address, journal, notify, () => tapAccount(target, plan.payer));
      const batch = await sha256(new TextEncoder().encode(JSON.stringify(plan.missing)));
      const result = await journal.step('fees/' + batch, () => tap.singleTxTransfer(plan.redeem.items), { definitelyNotSent: e => e?.message === 'No authority found' });
      const paymentId = typeof result === 'string' ? result : result.inscriptionId;
      if (/^[0-9a-f]{64}i[0-9]+$/.test(paymentId ?? '')) await api(plan.submit, { id, paymentId });
    } else {
      const { eth, address } = await ethAccount(target, plan.ethereumRelease ? undefined : plan.payer);
      if (plan.ethereumRelease) {
        if (BigInt(plan.ethereumRelease.chainId) !== BigInt(target.ethereum.chainId) || plan.ethereumRelease.to.toLowerCase() !== target.ethereum.escrow.toLowerCase()) fail('Release contract does not match this payment.');
        const tx = await journal.step('mint-release', () => eth.request({method:'eth_sendTransaction',params:[{from:address,to:plan.ethereumRelease.to,data:plan.ethereumRelease.data}]}));
        await receipt(eth,tx);
      } else {
        if (!journal.data.ethereumPlan) { journal.data.ethereumPlan = plan.transactions; journal.save(); }
        for (const [i,tx] of journal.data.ethereumPlan.entries()) {
          await ethAccount(target,plan.payer);
          const sent = await journal.step(i===0?'approval':'deposit',()=>eth.request({method:'eth_sendTransaction',params:[tx]}));
          await receipt(eth,sent);
        }
      }
    }
    await load(); notify(type === 'link' ? 'Wallet payment submitted. Refresh for confirmations and the accepted Bitmap link.' : 'Wallet payment submitted. Refresh for confirmations and your permanent mint permit.', 'info');
  }
  pay.onclick = () => guard(sendPayment, pay);
  refresh.onclick = () => guard(load, refresh);
  refund.onclick = () => guard(async () => {
    await load(); if (complete.has(plan.state)) return;
    if (plan.kind === 'ethereum') {
      if (!plan.ethereumRefundEligible) fail('The Ethereum escrow has not reached its refund time, or was already spent.');
      const { eth } = await ethAccount(target, plan.payer);
      const tx = await journal.step('refund', () => eth.request({ method: 'eth_sendTransaction', params: [plan.refundTransaction] }));
      await receipt(eth, tx);
    } else {
      if (plan.counted < plan.refundAfter) fail('The refund height has not been reached.');
      const { tap, address } = await tapAccount(target, plan.payer), auth = await authority(tap, address, journal, notify, () => tapAccount(target, plan.payer));
      const result = await journal.step('refund', () => tap.redeemTapActions({ auth, items: [], data: id, actions: [{ op: 'refund', lock: plan.payment ?? journal.data.paymentId }] }, { label: 'Refund Digital Matter World payment' }));
      await orderResult(tap, result);
    }
    notify(plan.kind === 'tap' ? 'Refund inscription submitted; waiting for verification.' : 'Refund transaction confirmed. Refresh for the gateway result.', 'info');
  }, refund);
  await load();
  // The gateway credits a TAP payment once it is reported and in a block. Signing reports it once,
  // usually before its block; so while the request waits, find the payment on Bitcoin (from any
  // browser) and report it every 30 seconds until it is credited.
  const watchPayment = async () => {
    if (!app.isConnected) return clearInterval(watcher);
    if (busy || plan?.financialVersion !== 2 || plan.kind !== 'tap' || !plan.submit || !['awaiting_payment', 'partly_paid'].includes(plan.state)) return;
    const paymentId = await findPayment(id, plan.payer, { network: target.bitcoinNetwork }).catch(() => null);
    if (!paymentId || !app.isConnected) return;
    await api(plan.submit, { id, paymentId }).catch(() => {});
    await load().catch(() => {});
    if (['awaiting_payment', 'partly_paid'].includes(plan.state)) notify('Your payment was found on Bitcoin and reported. It is credited with the next batch; this page updates by itself.');
  };
  const watcher = setInterval(() => void watchPayment(), 30000);
  void watchPayment();
}
async function binding(app, id, target) {
  let pending = await api('/payout-bindings/requests/' + id);
  const r = pending.request;
  const status = note({ class: 'binding-status' });
  const button = h('button.btn.primary.binding-action', { type: 'button' }, 'Sign with wallet and bind');
  const review = h('section.panel', {}, h('header', {}, h('h2', {}, 'Review payout binding'), h('div.grow'), inspectBtn('Binding request', pending)),
    kv([['Agent', hashEl(r.agent)], ['Rail', r.rail === 'ethereum' ? 'Ethereum' : 'TAP'], ['Wallet', hashEl(r.address)], ['Expires', h('span.mono', {}, new Date(r.expiry).toLocaleString())]]),
    h('div.body', {}, h('div.stack', { style: { gap: '10px' } }, h('p.small.muted', { style: { margin: 0 } }, 'Linking connects this wallet to your agent’s player, so its earnings reach you and you can mint its finds. Your agent started this link; you confirm it by signing with the wallet shown. A new link replaces the old one for future quotes.'), status, h('div.row', {}, button))));
  app.append(review);
  function draw() { button.disabled = pending.state === 'accepted' || pending.request.expiry <= Date.now(); status.textContent = pending.state === 'accepted' ? 'Payout wallet bound.' : pending.request.expiry <= Date.now() ? 'Request expired. Ask your agent for a new binding link.' : 'Review the agent and wallet address before signing.'; }
  button.onclick = async () => {
    button.disabled = true;
    try {
      pending = await api('/payout-bindings/requests/' + id);
      if (pending.state === 'accepted') { draw(); return; }
      if (pending.request.expiry <= Date.now()) fail('Request expired. Ask your agent for a new binding link.');
      let walletSignature;
      if (pending.request.rail === 'tap') { const { tap } = await tapAccount(target, pending.request.address); walletSignature = await tap.signMessage(pending.message, 'bip322-simple'); }
      else { const { eth, address } = await ethAccount(target, pending.request.address); walletSignature = await eth.request({ method: 'personal_sign', params: ['0x' + hex(new TextEncoder().encode(pending.message)), address] }); }
      const accepted = await api('/payout-bindings/complete', { id, walletSignature });
      pending.state = 'accepted'; draw(); void wallet.refresh();
      app.append(panel('Accepted binding receipt', kv([['Binding', hashEl(accepted.id ?? id)], ['Accepted', accepted.acceptedAt ? h('span.mono', {}, new Date(accepted.acceptedAt).toLocaleString()) : null], ['Wallet', hashEl(accepted.request?.address)]]), { flush: true, actions: inspectBtn('Accepted binding', accepted) }));
    } catch (e) {
      // The gateway may finish the binding after this reply timed out; show the real outcome.
      try { const now = await api('/payout-bindings/requests/' + id); if (now.state === 'accepted') { pending = now; draw(); void wallet.refresh(); return; } } catch {}
      status.textContent = e.code === 4001 ? 'Signature cancelled. You can retry.' : walletError(e); button.disabled = false;
    }
  }; draw();
}
// Mint & wallets: public blocks anyone mints with TAP Wallet, refunds owed to the connected TAP Wallet,
// the header's wallets and Bitmap links. /link and /bind-payout without a request link open the same page at their section.
const PUBLIC_STATES = { public: ['Public', 'good'], not_yet_public: ['Not public yet', ''], claimed: ['Claimed', ''], paid: ['Payment confirmed', 'info'], permit_issued: ['Being minted', 'info'], minted: ['Minted', ''], already_minted: ['Minted', ''] };
const publicState = row => {
  const [label, kind] = PUBLIC_STATES[row.state] ?? [String(row.state ?? '–').replace(/_/g, ' '), 'warn'];
  return [row.state === 'not_yet_public' ? publicOpeningLabel(row) ?? label : label, kind];
};
const PUBLIC_MINT_COPY = 'Blocks show up here once their 1-week finder window has passed without a claim.';
const SET_ASIDE = { waiting_funding: 'not sent', funded: 'held', sending: 'held', sent: 'spent on the mint', minted: 'spent on the mint', needs_user: 'to be returned', returning: 'being returned', returned: 'returned' };
function setAsideCell(r) {
  const sats = [r.setAside?.satoshis, r.mintFunding?.satoshis, r.mintSender?.satoshis].find(Number.isSafeInteger), state = SET_ASIDE[r.setAside?.state ?? r.mintSender?.state];
  const txid = [r.setAside?.returnTxid, r.mintSender?.returnTxid].find(v => /^[0-9a-f]{64}$/.test(v ?? ''));
  if (sats === undefined && !state) return '–';
  return h('span', {}, sats !== undefined ? h('span.mono', {}, `${fmtInt(sats)} sats`) : null, state ? ` ${state}` : null,
    txid ? [' ', h('a.mono', { href: 'https://mempool.space/tx/' + txid, target: '_blank', rel: 'noreferrer noopener' }, txid.slice(0, 12) + '…')] : null);
}
const REFUND_REASONS = { claimed_first: publicMintMessages.claimed_first, someone_paid_first: 'Another payment confirmed first', public_payment_incomplete: 'Payment did not cover every fee', already_minted: 'Block was already minted' };
const publicError = walletError;
// A missing route or a switched-off feature is not an error for visitors: public minting just has not opened.
const notOpen = e => e?.status === 404 || ['not_found', 'public_mint_inactive', 'public_index_warming'].includes(e?.message);
const PATTERN = /^(?:[a-z0-9]{1,24}|p2:(?:0|[1-9][0-9]*))$/;
const KIT_DOCS = 'https://github.com/Trac-Systems/digital-matter-world/tree/main/kit';
const matter = asset => h('span', {}, h('span.swatch', { style: { background: mineral(asset) } }), h('a', { href: site.href('table', { p: asset }) }, assetName(asset)));
const tapTotal = fees => (fees ?? []).reduce((sum, f) => sum + BigInt(/^[0-9]+$/.test(f?.amount ?? '') ? f.amount : 0), 0n).toString();
async function feeRate() {
  try {
    const r = await fetch('https://mempool.space/api/v1/fees/recommended', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const fee = (await r.json()).halfHourFee;
    return Number.isFinite(fee) && fee >= 1 && fee <= 1000 ? `${fee} sat/vB (mempool.space half-hour estimate)` : null;
  } catch { return null; }
}
// Mint one public block: TAP Wallet → quote (a preview, nothing reserved) → start → the request's payment page.
async function mintPublic(row, notify) {
  if (!wallet.tap) await wallet.connect('tap');
  const tapAddress = wallet.tap?.address;
  if (!tapAddress) fail('Connect TAP Wallet to mint.');
  notify('Checking 1-TX Transfers in TAP Wallet…');
  await oneTxReady(tapAddress);
  const body = { asset: row.asset, block: String(row.block), tapAddress };
  notify('Getting the fee…');
  const [quote, rate] = await Promise.all([api('/public-mints/quote', body), feeRate()]);
  const matches = value => (value.asset === row.asset || value.catalogAsset === row.asset || (store.patterns?.patterns ?? []).some(p => p.asset === row.asset && p.legacy?.asset === value.asset))
    && String(value.block) === body.block && value.kind === 'tap' && value.receiver === tapAddress;
  const preparation = value => {
    if (!['deployment_needed', 'deployment_pending'].includes(value.state)) return false;
    if (!matches(value) || value.publicMint !== true || value.payable !== false || value.requestId != null) fail('The deployment does not match this public mint.');
    if (value.state === 'deployment_needed') go('/mint/' + row.asset + '?' + new URLSearchParams({ public: '1', block: body.block, tapAddress }));
    else notify('The token is deployed. Its registration is being confirmed. Continue again in a few seconds; nothing has been paid or reserved.');
    return true;
  };
  if (!matches(quote)) fail('The quote does not match this block. Refresh the list and try again.');
  if (preparation(quote)) return;
  const decimals = quote.feeQuote?.unit?.decimals ?? 18;
  // With server sending on, the quote names the Bitcoin the payment sets aside for the mint inscription.
  const budget = quote.mintFunding ?? quote.mintFundingEstimate;
  const setAside = Number.isSafeInteger(budget?.satoshis) ? budget.satoshis : null;
  notify('');
  if (!await confirmModal({ title: `Mint ${assetName(row.asset)} from block ${fmtInt(row.block)}?`,
    lead: (setAside !== null
      ? 'Nothing is reserved. TAP Wallet asks once: on the next page it pays the fee and sets aside the Bitcoin for your mint inscription; our server then sends the mint. If your payment does not win the block, your TAP is refunded automatically and the unused Bitcoin comes back to you.'
      : 'Nothing is reserved: the next page asks TAP Wallet to pay, then to inscribe the mint.'),
    rows: [['Pattern', assetName(row.asset)], ['Block', fmtInt(row.block)], ['Units', fmtInt(quote.amount ?? row.amount)],
      ['Fee', h('strong.mono', {}, formatTap(quote.price, decimals))],
      ...(quote.fees ?? []).map(f => [`· ${String(f.role ?? 'fee').replace(/_/g, ' ')}`, h('span.mono', {}, formatTap(f.amount, decimals))]),
      setAside !== null ? ['Bitcoin set aside for the mint inscription and a possible refund', h('span.mono', {}, `${fmtInt(setAside)} sats`)] : null,
      ['Bitcoin fee rate', rate ?? 'TAP Wallet shows the network fee before you approve'],
      ['Receiver', hashEl(quote.receiver ?? tapAddress)]],
    confirm: 'Continue to payment' })) return;
  notify('Creating the payment request…');
  const started = await api('/public-mints/start', body);
  if (preparation(started)) return;
  if (!matches(started) || !/^[0-9a-f]{64}$/.test(started.id ?? '') || started.paymentPage && started.paymentPage !== '/mint/' + started.id) fail('The payment request is not valid. Refresh and try again.');
  go('/mint/' + started.id);
}
// On an agent owner's local dashboard the agent signs the link request with
// one click; the link's payment page then proves the Bitmap and takes the fee.
function localLink(initial) {
  const height = h('input.input', { style: { flex: '1 1 160px', width: 'auto' }, type: 'text', inputmode: 'numeric', value: initial ?? '', placeholder: 'Bitmap block, e.g. 611638', 'aria-label': 'Bitmap block' });
  const status = h('div.callout', { role: 'status' });
  const say = (text, kind) => { status.className = 'callout ' + kind; status.textContent = text; };
  const start = h('button.btn.primary', { onclick: async () => {
    const value = height.value.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(value)) { say('Enter the block number of your Bitmap.', 'bad'); return; }
    if (!wallet.tap) { say('Connect the TAP Wallet that holds the Bitmap first (Connect wallet, top right).', 'bad'); return; }
    start.disabled = true; start.textContent = 'Your agent is signing…'; start.classList.add('busy'); say(`Signing the link request for ${value}.bitmap…`, 'busy');
    try {
      await oneTxReady(wallet.tap.address);
      const response = await fetch('/api/link', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ height: value, payer: wallet.tap.address }) });
      const result = await response.json().catch(() => ({ error: 'request_failed' }));
      if (!response.ok) throw Error(String(result.error ?? 'request_failed').replace(/_/g, ' '));
      const link = new URL(result.paymentLink, location.href);
      go(link.pathname + link.search);
    } catch (error) { say(error.message, 'bad'); start.disabled = false; start.classList.remove('busy'); start.textContent = 'Link with my agent'; }
  } }, 'Link with my agent');
  return h('div.stack', { style: { gap: '8px' } }, h('div.row', { style: { gap: '8px' } }, height, start), status,
    h('p.small.muted', { style: { margin: 0 } }, 'Hold the Bitmap in the TAP Wallet connected above. Your agent signs the request here; then you review the fee and pay on the link page.'));
}
// A search field, not one control per pattern: there can be thousands. The server searches by name
// (/patterns?q=) as you type and returns at most ten suggestions. Returns the label's contents.
const SUGGESTIONS = 10, P2 = /^p2:(0|[1-9][0-9]*)$/;
const nameOf = p => assetName(p.asset) === p.asset ? title(p.name) : assetName(p.asset);
function patternSearch(listId, value, say, onPick) {
  const choices = h('datalist', { id: listId });
  let asked = 0, typing;
  // Up to ten { name, asset } suggestions for the typed text, or null when a newer search replaced this one.
  async function suggest(text) {
    const seq = ++asked, q = text.trim().toLowerCase().replace(/^dmw/, ''), hits = [];
    if (q) {
      const params = new URLSearchParams({ q, sort: 'name', limit: String(SUGGESTIONS) });
      // The name search is a bounded scan: follow its cursor a few pages while it has not found enough.
      for (let page = 0; page < 8 && hits.length < SUGGESTIONS; page++) {
        const r = await get('/patterns?' + params);
        hits.push(...(r.patterns ?? []).filter(p => P2.test(p.asset ?? '')).map(p => ({ name: nameOf(p), asset: p.asset })));
        if (!r.next) break; params.set('cursor', r.next);
      }
    }
    if (seq !== asked) return null;
    clear(choices, ...hits.slice(0, SUGGESTIONS).map(p => h('option', { value: p.name })));
    return hits.slice(0, SUGGESTIONS);
  }
  const search = h('input', { type: 'search', value, placeholder: 'Search a pattern by name',
    'aria-label': 'Pattern', autocomplete: 'off',
    oninput: () => { clearTimeout(typing); typing = setTimeout(() => suggest(search.value).catch(() => {}), 250); },
    onchange: async () => {
      const text = search.value.trim();
      if (!text) return;
      clearTimeout(typing);
      let hits;
      try { hits = await suggest(text); } catch (error) { say(`Pattern search failed (${walletError(error)}). Try again.`); return; }
      if (!hits) return;
      // The exact name, a pattern id, or the one pattern whose name contains the text ("null" finds Nullspar).
      const want = text.toLowerCase().replace(/^dmw/, '');
      const pick = hits.find(p => p.name.toLowerCase() === want) ?? (P2.test(text) ? { asset: text, name: assetName(text) } : hits.length === 1 ? hits[0] : null);
      if (!pick) { say(hits.length ? `${hits.length === SUGGESTIONS ? 'Many' : fmtInt(hits.length)} patterns match “${text}”. Pick one from the suggestions.` : `No pattern named “${text}”.`); return; }
      say(''); search.value = pick.name;
      onPick(pick);
    } });
  search.setAttribute('list', listId);
  return [search, choices];
}
// Found a new pattern? Whoever mints it first inscribes it and deploys its token, once. The connected
// wallet's agent sees its own discoveries; anyone can search a pattern. Both lead to the deployment page.
function deployPanel() {
  const agent = wallet.player()?.agent ?? null, found = h('div'), note = h('div.callout', { role: 'status', 'aria-live': 'polite' });
  const say = text => { note.textContent = text; };
  const search = patternSearch('deploy-pattern-names', '', say, pick => clear(found, h('div.row', { style: { gap: '10px' } }, matter(pick.asset), tokenStatus(pick.asset, { owner: agent }))));
  const mine = agent ? pagedTable({ path: `/agents/${encodeURIComponent(agent)}/discoveries`, key: 'discoveries', limit: 10, empty: 'Your agent has not discovered a pattern yet.',
    onError: () => true,
    columns: [
      { key: 'asset', label: 'Your agent’s patterns', render: r => matter(r.asset) },
      { key: 'token', label: 'On Bitcoin', render: r => tokenStatus(r.asset, { owner: agent, lazy: true }) },
    ] }) : null;
  return panel('Found a new pattern?', [h('div.stack', { style: { gap: '10px', padding: '12px 14px' } },
    h('p', { style: { margin: 0 } }, 'Inscribe it and deploy its token, once, from your own TAP Wallet. Then it mints like any other pattern. The discoverer does this first, during the finder week.'),
    h('label.pager-ctl', {}, h('span', {}, 'Pattern'), ...search), found, note,
    agent ? null : h('p.small.muted', { style: { margin: 0 } }, 'Connect the TAP Wallet linked to your agent to see the patterns it found. ', h('a', { href: '/table' }, 'Browse all patterns'), '.')),
    mine?.el ?? null], { flush: true, id: 'deploy' });
}
// In-page navigation: a full reload would make wallet extensions ask to reconnect.
const go = path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); };
// TAP Wallet is what public minting needs: its connect button is the section's primary action.
const primaryTap = rows => { for (const b of rows.flatMap(r => [...r.querySelectorAll('button')])) if (b.textContent === 'Connect TAP wallet') b.classList.add('primary'); return rows; };
function walletsHome(root, type) {
  const params = new URLSearchParams(location.search), asset = PATTERN.test(params.get('asset') ?? '') ? params.get('asset') : null;
  const block = /^(0|[1-9][0-9]*)$/.test(params.get('block') ?? '') ? params.get('block') : null;
  const chosen = type === 'mint' && asset && block !== null ? { asset, block } : null;
  const bitmap = type === 'link' ? block : null;
  const app = h('div.stack'), side = h('div.stack');
  root.append(h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'Mint & wallets'), h('p', {}, PUBLIC_MINT_COPY, ' ',
      h('a', { href: '#deploy', onclick: e => { e.preventDefault(); document.getElementById('deploy')?.scrollIntoView({ block: 'start' }); } }, 'Found a new pattern? Inscribe it and deploy its token')))),
    h('div.grid.cols-main', {}, app, side)));
  const policy = store.status?.feePolicy;
  side.append(...[panel('How public minting works', h('ol.numbered', {},
    h('li', {}, PUBLIC_MINT_COPY + ' A claimed or minted block cannot be minted here.'),
    h('li', {}, 'Press Mint on a block and connect TAP Wallet. You see the fee before anything is paid.'),
    h('li', {}, 'On the payment page, pay the fee in TAP from TAP Wallet, then inscribe the mint. The tokens arrive in your wallet.'),
    h('li', {}, h('strong', {}, 'Token not deployed yet? '), 'The payment page first asks you to inscribe the pattern and deploy its token, once, each in its own Bitcoin block.'))),
    // Fees: the two headline fees, then one cell per tier.
    policy?.baseFee ? panel('Fees', [kv([['Base fee', h('span.mono', {}, tap(policy.baseFee, policy.unit))], policy.feeSettings ? ['Bitmap link', h('span.mono', {}, feePrice(policy, 'link'))] : null]),
      policy.feeSettings ? [h('div.section-label', {}, 'A block’s fee is the base fee times its pattern’s tier'),
        h('div.tiers', {}, Array.from({ length: 5 }, (_, i) => h('div', {}, h('div.k', {}, `Tier ${i + 1}`), h('div.v', {}, feePrice(policy, 'find', i + 1)))))] : null,
      h('p.small.muted', { style: { margin: 0, padding: '8px 14px 12px', borderTop: '1px solid var(--rule-2)' } }, 'Mint shows the exact fee before you pay.')], { flush: true }) : null,
    h('p.small.muted', { style: { margin: 0 } }, 'Agents mint their own finds from their local dashboard (', h('code', {}, 'dmw dashboard'), '). ', h('a', { href: KIT_DOCS, rel: 'noopener' }, 'Kit docs'), '.')].filter(Boolean));
  // The public list stays mounted across wallet changes; Mint reads the connected wallet when pressed.
  const status = note(), listNote = h('div.callout', { role: 'status', 'aria-live': 'polite' }), soon = h('div', { hidden: true });
  // Mint progress shows above the list (busy while working, red on failure) and on the pressed button.
  const say = (text, kind) => { listNote.className = 'callout' + (text && kind ? ' ' + kind : ''); listNote.textContent = text; };
  let list;
  const mintButton = row => h('button.btn.sm.primary', { type: 'button', onclick: async e => {
    const b = e.currentTarget; b.disabled = true; b.classList.add('busy');
    try { await mintPublic(row, text => say(text, text.endsWith('…') ? 'busy' : 'info')); }
    catch (error) {
      say(error.code === 4001 ? 'Wallet request cancelled. You can retry.' : publicError(error), error.code === 4001 ? 'warn' : 'bad');
      if (['someone_paid_first', 'already_minted', 'claimed', 'claimed_first', 'public_minted'].includes(error.message)) list?.reload();
    } finally { b.disabled = false; b.classList.remove('busy'); }
  } }, 'Mint');
  const stateCell = r => { const [label, kind] = publicState(r);
    return h('span.row', { style: { gap: '6px' } }, pill(label, kind), r.bitmapHolderOnly ? pill('Bitmap holder only', 'info', `Only the TAP Wallet holding ${r.block}.bitmap can mint this block.`) : null); };
  const opensSoon = e => { clear(soon, h('div.callout.info', {}, e?.message === 'public_index_warming' ? publicMintMessages.public_index_warming : 'Public minting opens soon. ' + PUBLIC_MINT_COPY)); soon.hidden = false; list.el.hidden = true; return true; };
  let selectedAsset = chosen?.asset ?? (/^p2:(0|[1-9][0-9]*)$/.test(asset ?? '') ? asset : (store.patterns?.patterns ?? []).find(p => /^p2:(0|[1-9][0-9]*)$/.test(p.asset))?.asset ?? 'p2:0');
  const search = patternSearch('public-pattern-names', assetName(selectedAsset) === selectedAsset ? '' : assetName(selectedAsset), text => { listNote.textContent = text; },
    pick => { selectedAsset = pick.asset; drawToken(); list.reset(); });
  const picker = h('label.pager-ctl', {}, h('span', {}, 'Pattern'), ...search);
  // The picked pattern's token on Bitcoin; until it is deployed, the way to inscribe and deploy it.
  const tokenLine = h('div');
  const drawToken = () => clear(tokenLine, tokenStatus(selectedAsset));
  drawToken();
  list = pagedTable({ path: () => '/public-mints?asset=' + encodeURIComponent(selectedAsset), key: 'rows', limit: 25, skipEmpty: true,
    empty: () => `No public blocks of ${assetName(selectedAsset)} right now. ${PUBLIC_MINT_COPY}`,
    onError: e => notOpen(e) && opensSoon(e),
    onPage: (_rows, body) => { if (body.state === 'inactive') return opensSoon(); soon.hidden = true; list.el.hidden = false; },
    columns: [
      { key: 'asset', label: 'Pattern', render: r => matter(r.asset) },
      { key: 'block', label: 'Block', num: true, render: r => blockLink(r.block) },
      { key: 'amount', label: 'Units', num: true, render: r => h('span.mono', {}, fmtInt(r.amount)) },
      { key: 'state', label: 'State', render: stateCell },
      // Only a row the API lists as public gets a Mint button.
      { key: 'act', label: '', render: r => r.state === 'public' ? mintButton(r) : null },
    ] });
  list.el.classList.add('public-mints');
  const publicPanel = panel('Public blocks', [h('div.stack', { style: { gap: '10px', padding: '12px 14px' } },
    h('p', { style: { margin: 0 } }, h('strong', {}, PUBLIC_MINT_COPY)), picker, tokenLine, listNote, soon), list.el], { flush: true, id: 'mint', actions: pill('No agent needed', 'good') });
  // A block opened from elsewhere (/mint?asset=…&block=…): its current state from the point read.
  const bigger = b => { b.classList.remove('sm'); b.classList.add('cta'); return b; };
  let chosenBox = null;
  if (chosen) {
    chosenBox = h('div.stack.chosen', { style: { gap: '12px' } }, h('div.faint', {}, 'Loading…'));
    get(`/public-mints/${chosen.asset}/${chosen.block}`).then(r => {
      const [label, kind] = publicState(r);
      clear(chosenBox, h('div.row', { style: { gap: '10px' } }, pill(label, kind), r.bitmapHolderOnly ? pill('Bitmap holder only', 'info') : null, h('span.price', {}, `${fmtInt(r.amount)} units`)),
        r.state === 'public' ? h('div.row', {}, bigger(mintButton({ ...chosen, ...r, asset: chosen.asset, block: chosen.block }))) : h('p', { style: { margin: 0 } }, Object.hasOwn(publicMintMessages, r.state) ? walletError(r.state, r) : 'This block is not public, so it cannot be minted here.'));
    }, e => clear(chosenBox, h('p', { style: { margin: 0 } }, notOpen(e) ? 'Public minting opens soon.' : `This block is not listed as public (${publicError(e)}).`)));
  }
  // Refunds owed to the connected TAP Wallet; shown only when there are any.
  let refunds = null, refundsFor = null;
  const refundPanel = () => {
    const address = wallet.tap?.address ?? null;
    if (address === refundsFor) return refunds;
    refundsFor = address; refunds = null;
    if (!address) return null;
    const box = pagedTable({ path: `/public-mints/refunds?tapAddress=${encodeURIComponent(address)}`, key: 'rows', limit: 10, empty: 'No refunds owed.',
      onError: () => true, onPage: rows => { if (rows.length) refunds.hidden = false; },
      columns: [
        { key: 'asset', label: 'Pattern', render: r => matter(r.asset) },
        { key: 'block', label: 'Block', num: true, render: r => blockLink(r.block) },
        { key: 'fees', label: 'Paid', num: true, render: r => h('span.mono', {}, formatTap(tapTotal(r.fees), 18)) },
        { key: 'reason', label: 'Why', render: r => h('span', {}, REFUND_REASONS[r.reason] ?? String(r.reason ?? '–').replace(/_/g, ' '), ' · ', refundStatus(r)) },
        // The Bitcoin a one-approval payment set aside for the mint goes back to the payer as well.
        { key: 'setAside', label: 'Set aside', num: true, render: r => setAsideCell(r) },
        { key: 'id', label: '', render: r => /^[0-9a-f]{64}$/.test(r.requestId ?? r.id ?? '') ? h('a.btn.sm.ghost', { href: '/mint/' + (r.requestId ?? r.id) }, 'Request') : null },
      ] });
    box.el.classList.add('public-mints');
    refunds = panel('Your refunds', [h('p', { style: { margin: 0, padding: '12px 14px' } }, 'These payments from your TAP Wallet did not win their blocks. Your TAP is refunded automatically using the Bitcoin set aside with your payment. Payments without a Bitcoin set-aside need operator action.'), box.el], { flush: true, id: 'refunds' });
    refunds.hidden = true;
    return refunds;
  };
  // Rebuilt only when the wallet's agent changes.
  let deploy = null, deployAgent;
  const deploySection = () => { const agent = wallet.player()?.agent ?? null; if (!deploy || agent !== deployAgent) { deployAgent = agent; deploy = deployPanel(); } return deploy; };
  const draw = () => {
    const any = wallet.connected();
    const out = [];
    if (chosen) out.push(panel(`${assetName(chosen.asset)} from block ${fmtInt(chosen.block)}`, chosenBox));
    out.push(publicPanel, deploySection(), refundPanel());
    out.push(panel('Your wallets', h('div.stack', { style: { gap: '10px' } },
      h('p', { style: { margin: 0 } }, any ? 'The wallets connected in the header. TAP Wallet pays and inscribes public mints. A wallet linked to an agent’s player is its payout wallet: that agent’s earnings reach it. Your agent starts the link; you sign it on the link it gives you.'
        : 'Connect here or in the header; it is one connection for the whole site. Minting public blocks needs only TAP Wallet.'),
      walletSummary('tap', { purpose: true }), walletSummary('ethereum', { purpose: true }),
      wallet.ethereum && !wallet.tap ? h('p.small.muted', { style: { margin: 0 } }, 'Also connect TAP Wallet: mints are paid and inscribed on Bitcoin.') : null,
      primaryTap(connectButtons(undefined, status)), status), { id: 'wallets' }));
    out.push(panel('Link a Bitmap', h('div.stack', { style: { gap: '8px' } },
      h('p', { style: { margin: 0 } }, 'Bitmap holders earn 15% of every mint on their plot. During the finder’s week only the finder mints; afterwards any agent can. TAP Wallet proves you hold the Bitmap and pays the link fee in TAP.'),
      globalThis.DMW_LOCAL_AGENT === true ? localLink(bitmap)
        : bitmap !== null ? h('div.small', {}, 'Block ', blockLink(bitmap), `: hold ${bitmap}.bitmap in TAP Wallet, then ask your agent to link it.`) : null,
      wallet.tap ? null : h('p.small.muted', { style: { margin: 0 } }, wallet.ethereum ? 'MetaMask cannot do this: Bitmaps live on Bitcoin. Connect TAP Wallet above.' : 'Needs TAP Wallet: connect it above.'),
      globalThis.DMW_LOCAL_AGENT === true ? null : h('p.small.muted', { style: { margin: 0 } }, 'Your agent starts the link. Open the link request it gives you to review the fee and pay.')), { id: 'bitmap' }));
    // Keep mounted panels (and their loaded pages) when only the wallet changed.
    clear(app, ...out.filter(Boolean));
  };
  draw();
  return wallet.on(draw);
}
