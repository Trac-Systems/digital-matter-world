import { api } from './data.js';
import { mount as mintPage } from './console/js/inscribe/public.js';
import { presentation } from './console/js/api.js';
import { h, clear, panel, kv, pill, hashEl, fmtInt, tabs, field, input, select, table, inspectBtn as rawInspectBtn } from './console/js/dom.js';
import { splitTable, btc } from './console/js/money.js';
import { assetName, mineral } from './console/js/words.js';
import { formatTap } from './amount-format.js';
import { tapAccount, ethAccount, receipt, orderResult, authority, WalletJournal, wait, hex, sha256, unhex, fail } from './wallets.js';
const inspectBtn = (title, value) => rawInspectBtn(title, () => presentation(typeof value === 'function' ? value() : value));
const complete = new Set(['complete', 'accepted', 'settled', 'minted']);
const stopped = new Set(['expired', 'cancelled', 'rejected', 'refund_wait', 'refund_eligible', 'unpaid_expired', 'quarantined', 'recovery', 'failed']);
const PAGES = [['mint', 'Mint On-Chain'], ['link', 'Link Bitmap'], ['bind-payout', 'Payout wallets']];
const TITLES = { mint: 'Mint On-Chain', link: 'Link a Bitmap', 'bind-payout': 'Bind payout wallet' };
const STEPS = { lock: 'TAP payment lock', 'link-release': 'Bitmap link fee release', approval: 'TAP allowance', deposit: 'Escrow deposit', networkFee: 'Bitcoin inscription fee', refund: 'Refund', 'authority-order': 'TAP authority', 'authority-activation': 'TAP authority activation' };
const statePill = s => pill(String(s ?? '–').replace(/_/g, ' '), complete.has(s) ? 'good' : stopped.has(s) ? 'bad' : 'warn');
const note = (attrs = {}) => h('div.note', { role: 'status', ...attrs });
const blockLink = n => n === null || n === undefined ? null : h('a.mono', { href: '/block/' + n }, fmtInt(n));
// The wallet pages share the console's page head, tabs and side panel layout.
export function moneyPage(root, { type, id }, navigate) {
  const navigation = h('section.panel', { style: { marginBottom: '16px' } }, tabs(PAGES, t => {
    if (t !== type) navigate('/' + t);
  }, type));
  if (type === 'mint') {
    const cleanup = mintPage(root, { id });
    root.querySelector('.page-head').after(navigation);
    return cleanup;
  }
  const app = h('div.stack'), side = h('div.stack');
  root.append(h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, TITLES[type]), h('p', {}, 'Mining, claims, discoveries and crafting are free. Payments happen here through your wallet.'))),
    navigation,
    h('div.grid.cols-main', {}, app, side)));
  // Mount returns a disposer immediately; pending reads belong to this view only.
  let stopped = false;
  async function load() {
    let target;
    try { target = await api('/web-api/target'); }
    catch (e) { if (!stopped) app.append(h('div.note.bad', {}, `Unable to load: ${e.message}.`)); return; }
    if (stopped) return;
    side.append(panel('Payment contracts', kv([
      target.ethereum ? ['Bridged TAP token', hashEl(target.ethereum.token)] : null,
      target.ethereum ? ['Escrow contract', hashEl(target.ethereum.escrow)] : null,
    ]), { flush: true }));
    try {
      if (!id) return await introduction(app, type, target);
      if (type === 'bind-payout') return await binding(app, id, target);
      await request(app, type, id, target);
    } catch (e) { if (!stopped) app.append(h('div.note.bad', { role: 'alert' }, `Unable to load: ${e.message}. `, h('a', { href: location.pathname + location.search }, 'Retry'))); }
  }
  void load();
  return () => { stopped = true; };
}
async function request(app, type, id, target) {
  const journal = new WalletJournal(`${target.network}/${type}/${id}`);
  const review = h('section.panel'), status = note(), evidence = h('div');
  const pay = h('button.btn.primary', { type: 'button' }, 'Connect wallet and continue');
  const refresh = h('button.btn', { type: 'button' }, 'Refresh receipt');
  const refund = h('button.btn', { type: 'button', hidden: true }, 'Refund with wallet');
  app.append(review, h('section.panel', {}, h('header', {}, h('h2', {}, 'Payment')), h('div.body', {}, h('div.stack', { style: { gap: '10px' } }, status, h('div.row', {}, pay, refresh, refund)))), evidence);
  let plan, busy = false;
  const mayPay = () => type === 'mint' ? !!plan && (plan.ethereumRelease && plan.ethereumDepositStatus === 1 && !plan.ethereumRefundEligible || plan.payable && ['awaiting_payment','partly_paid'].includes(plan.state)) : ['awaiting_wallet','waiting_payment'].includes(plan?.state);
  const notify = s => { status.textContent = s; };
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
    const unit = plan.unit;
    clear(review,
      h('header', {}, h('h2', {}, 'Review request'), statePill(plan.state), h('div.grow'), inspectBtn('Request', plan)),
      kv([
        ['Request', hashEl(plan.id)],
        plan.asset ? ['Matter', h('span', {}, h('span.swatch', { style: { background: mineral(plan.asset) } }), assetName(plan.asset))] : null,
        plan.block !== null && plan.block !== undefined ? [type === 'mint' ? 'From block' : 'Block', blockLink(plan.block)] : null,
        plan.amount ? ['Units used up', h('span.mono', {}, fmtInt(plan.amount))] : null,
        plan.kind ? ['Paid with', plan.kind === 'ethereum' ? 'Bridged TAP' : 'TAP'] : null,
        plan.price ? ['Price', h('strong.mono', {}, formatTap(plan.price, unit?.decimals))] : null,
        plan.baseFee ? ['Base fee B', h('span.mono', {}, formatTap(plan.baseFee, unit?.decimals))] : null,
        plan.networkFee && BigInt(plan.networkFee.sats ?? 0) > 0n ? ['Bitcoin inscription fee', h('span.mono', {}, `${btc(plan.networkFee.sats)} · ${fmtInt(plan.networkFee.sats)} sats`)] : null,
        ['Payer', hashEl(plan.payer)],
        plan.owner ? ['Agent', hashEl(plan.owner)] : null,
        plan.receiver ? ['Receiver', hashEl(plan.receiver)] : null,
        plan.deadline !== undefined ? ['Pay by block', h('span.mono', {}, fmtInt(plan.deadline))] : null,
        plan.refundAfter !== undefined && plan.refundAfter !== null ? ['Refund after block', h('span.mono', {}, fmtInt(plan.refundAfter))] : null,
        plan.ethereumRefundAfter ? ['Escrow refund from', h('span.mono', {}, new Date(Number(plan.ethereumRefundAfter) * 1000).toLocaleString())] : null,
        plan.counted !== undefined ? ['Counted', h('span.mono', {}, fmtInt(plan.counted))] : null,
        plan.reason ? ['Reason', String(plan.reason).replace(/_/g, ' ')] : null,
      ]),
      plan.split ? [h('div.section-label', {}, 'Fee split'), h('div', { style: { padding: '0 14px 4px' } }, splitTable(plan.split, plan.destinations ?? {}, plan.kind, unit))] : null,
      h('div.body.small.muted', {}, type === 'link' ? 'Bitmap links are paid before publication. The link follows the Bitmap when it changes owners.'
        : type === 'mint' ? 'Pay the remaining fees first. After payment is final, your units are consumed and your permanent permit is ready. You then inscribe it from your Bitcoin wallet, including when paying with Ethereum.' : 'The wallet can refund after the displayed deadline if payment remains unspent.'));
    if (type === 'mint') {
      if (plan.blocked?.length) review.append(h('div.note.bad', {}, 'This payment is not currently available.'));
      if (plan.missing?.length) review.append(panel('Remaining fees', kv(plan.missing.map(f => [f.role, formatTap(f.amount,18)]))));
      if (plan.inscriptionText) review.append(panel('Permanent mint content', [h('p', {}, 'Inscribe this exact content from your Bitcoin wallet to the receiver above. This permit does not expire.'),h('pre', {}, plan.inscriptionText)]));
    }
    pay.disabled = busy || !mayPay();
    pay.textContent = type === 'mint' && plan.ethereumRelease && plan.ethereumDepositStatus === 1 ? 'Release paid fees with wallet' : plan.walletPreparation ? 'Prepare Bitmap payment with wallet' : journal.data.lock || journal.data.deposit || journal.data.networkFee ? 'Resume payment' : 'Approve payment in wallet';
    refund.hidden = type === 'mint' && plan.kind === 'tap' || complete.has(plan.state) || (plan.kind === 'ethereum' ? !plan.ethereumRefundEligible : !(plan.payment || journal.data.paymentId) || plan.counted < plan.refundAfter);
    notify(complete.has(plan.state) ? `Confirmed: ${plan.state}.` : `Request state: ${plan.state}${plan.reason ? ' — ' + plan.reason : ''}.`);
    receipts();
  }
  async function guard(fn) {
    if (busy) return; busy = true; pay.disabled = refresh.disabled = refund.disabled = true;
    try {
      if (!navigator.locks) fail('This browser needs Web Locks to safely resume wallet payments.');
      await navigator.locks.request(journal.key, { ifAvailable: true }, async lock => {
        if (!lock) fail('This payment is open in another tab. Continue there.');
        journal.data = JSON.parse(localStorage.getItem(journal.key) ?? '{}'); await fn();
      });
    } catch (e) { notify(e.code === 4001 ? 'Wallet request cancelled. You can resume without repeating completed payments.' : e.message); }
    finally { busy = false; refresh.disabled = refund.disabled = false; pay.disabled = !mayPay(); receipts(); }
  }
  async function prepare() {
    const { tap } = await tapAccount(target, plan.payer);
    if (!journal.data.linkSecret) { journal.data.linkSecret = hex(crypto.getRandomValues(new Uint8Array(32))); journal.save(); }
    const paymentHash = await sha256(unhex(journal.data.linkSecret));
    const message = `dmw-link-payment-v1\n${target.network}\n${id}\n${paymentHash}`;
    const walletSignature = await tap.signMessage(message, 'bip322-simple');
    await api(`/web-api/link/${id}/prepare`, { paymentHash, walletSignature });
    await load(); notify('Payment prepared. Review the fixed price and split, then approve payment.');
  }
  async function sendPayment() {
    await load();
    if (complete.has(plan.state)) return;
    if (type === 'mint') return sendMintPayment();
    if (type === 'link') {
      if (!journal.data.linkSecret) fail('This link was prepared elsewhere. Continue in the browser that prepared it, or ask your agent for a new link request.');
      if (await sha256(unhex(journal.data.linkSecret)) !== plan.redeem?.actions[0].condition.hash) fail('The saved Bitmap payment does not match this request.');
    }
    const { tap, address } = await tapAccount(target, plan.kind === 'tap' ? plan.payer : undefined);
    if (plan.kind === 'tap') {
      const auth = await authority(tap, address, journal, notify);
      await tapAccount(target, plan.payer);
      notify('Approve the TAP payment lock in your wallet.');
      const order = await journal.step('lock', () => tap.redeemTapActions({ ...plan.redeem, auth }, { label: `Digital Matter World ${type}` }));
      journal.data.paymentId = await orderResult(tap, order) + ':0'; journal.save();
      if (type === 'link') {
        await tapAccount(target, plan.payer); notify('Approve release of the Bitmap link fee to the displayed split.');
        const released = await journal.step('link-release', () => tap.redeemTapActions({ auth, items: [], data: id,
          actions: [{ op: 'claim', lock: journal.data.paymentId, preimage: journal.data.linkSecret }] }, { label: 'Release Bitmap link fee' }));
        await orderResult(tap, released);
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
    if (!complete.has(plan.state)) notify('Payment submitted or awaiting confirmations. Refresh the receipt to follow completion; completed wallet steps are saved.');
  }
  async function sendMintPayment() {
    if (!mayPay()) fail('This request is not ready for a wallet payment. Refresh its status.');
    if (plan.kind === 'tap') {
      if (plan.blocked?.length) fail('This payment is not currently available.');
      const { tap } = await tapAccount(target, plan.payer);
      if (typeof tap.singleTxTransfer !== 'function') fail('This wallet does not support direct TAP fee items.');
      const batch = await sha256(new TextEncoder().encode(JSON.stringify(plan.missing)));
      const result = await journal.step('fees/' + batch, () => tap.singleTxTransfer(plan.redeem.items));
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
    await load(); notify('Wallet payment submitted. Refresh for confirmations and your permanent mint permit.');
  }
  pay.onclick = () => guard(sendPayment);
  refresh.onclick = () => guard(load);
  refund.onclick = () => guard(async () => {
    await load(); if (complete.has(plan.state)) return;
    if (plan.kind === 'ethereum') {
      if (!plan.ethereumRefundEligible) fail('The Ethereum escrow has not reached its refund time, or was already spent.');
      const { eth } = await ethAccount(target, plan.payer);
      const tx = await journal.step('refund', () => eth.request({ method: 'eth_sendTransaction', params: [plan.refundTransaction] }));
      await receipt(eth, tx);
    } else {
      if (plan.counted < plan.refundAfter) fail('The refund height has not been reached.');
      const { tap, address } = await tapAccount(target, plan.payer), auth = await authority(tap, address, journal, notify);
      const result = await journal.step('refund', () => tap.redeemTapActions({ auth, items: [], data: id, actions: [{ op: 'refund', lock: plan.payment ?? journal.data.paymentId }] }, { label: 'Refund Digital Matter World payment' }));
      await orderResult(tap, result);
    }
    notify('Refund transaction confirmed by the wallet. Refresh for the gateway result.');
  });
  await load();
}
async function binding(app, id, target) {
  let pending = await api('/payout-bindings/requests/' + id);
  const r = pending.request;
  const status = note({ class: 'binding-status' });
  const button = h('button.btn.primary.binding-action', { type: 'button' }, 'Sign with wallet and bind');
  const review = h('section.panel', {}, h('header', {}, h('h2', {}, 'Review payout binding'), h('div.grow'), inspectBtn('Binding request', pending)),
    kv([['Agent', hashEl(r.agent)], ['Rail', r.rail === 'ethereum' ? 'Ethereum' : 'TAP'], ['Wallet', hashEl(r.address)], ['Expires', h('span.mono', {}, new Date(r.expiry).toLocaleString())]]),
    h('div.body', {}, h('div.stack', { style: { gap: '10px' } }, h('p.small.muted', { style: { margin: 0 } }, 'Both your agent and your payout wallet sign this request. Replacements apply to future quotes.'), status, h('div.row', {}, button))));
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
      pending.state = 'accepted'; draw();
      app.append(panel('Accepted binding receipt', kv([['Binding', hashEl(accepted.id ?? id)], ['Accepted', accepted.acceptedAt ? h('span.mono', {}, new Date(accepted.acceptedAt).toLocaleString()) : null], ['Wallet', hashEl(accepted.request?.address)]]), { flush: true, actions: inspectBtn('Accepted binding', accepted) }));
    } catch (e) { status.textContent = e.code === 4001 ? 'Signature cancelled. You can retry.' : e.message; button.disabled = false; }
  }; draw();
}
async function introduction(app, type, target) {
  const status = note({ class: 'wallet-status' }), wallets = h('div');
  const controls = h('div.row.wallet-connect');
  const connected = [];
  for (const rail of type === 'link' ? ['tap'] : ['tap', 'ethereum']) {
    const b = h('button.btn', { type: 'button' }, rail === 'tap' ? 'Connect TAP wallet' : 'Connect MetaMask');
    b.onclick = async () => { b.disabled = true; try { const found = await (rail === 'tap' ? tapAccount(target) : ethAccount(target)); connected.push([rail === 'tap' ? 'TAP wallet' : 'MetaMask', hashEl(found.address)]); clear(wallets, kv(connected)); status.textContent = 'Connected. Your agent uses this wallet address when creating the signed request.'; } catch (e) { status.textContent = e.code === 4001 ? 'Connection cancelled.' : e.message; } finally { b.disabled = false; } }; controls.append(b);
  }
  app.append(h('section.panel', {}, h('header', {}, h('h2', {}, 'Connected wallets')),
    h('div.body', {}, h('div.stack', { style: { gap: '10px' } }, h('p', { style: { margin: 0 } }, type === 'bind-payout' ? 'Open the payout-binding link issued by your agent. The link identifies a signed request; your wallet completes it here.' : 'Open the payment link issued by your agent to approve its signed request. The agent authorizes the matter or plot; your connected wallet approves the payment.'), controls, status)),
    h('div.flush', {}, wallets)));
  if (type !== 'mint') return;
  const params = new URLSearchParams(location.search), output = h('div');
  const form = h('form.form.mint-quote', {},
    field('Asset', input({ name: 'asset', required: true, pattern: '[a-z0-9]{1,24}', value: params.get('asset') ?? '', class: 'mono' })),
    h('div.two', {},
      field('Block (patterns only)', input({ name: 'block', type: 'number', min: '0', step: '1', value: params.get('block') ?? '', class: 'mono' })),
      field('Units (compounds only)', input({ name: 'amount', type: 'text', inputmode: 'numeric', pattern: '[1-9][0-9]*', value: '1', class: 'mono' }))),
    field('Payment rail', select([['tap', 'TAP wallet'], ['ethereum', 'MetaMask']], { name: 'kind' })),
    h('div.row', {}, h('button.btn.primary', {}, 'Get quote')));
  form.onsubmit = async e => { e.preventDefault(); const f = Object.fromEntries(new FormData(form)); const input = { asset: f.asset, kind: f.kind, ...(f.block === '' ? { amount: f.amount } : { block: Number(f.block) }) };
    try {
      const q = await api('/mint/quote', input);
      clear(output, h('section.panel', {}, h('header', {}, h('h2', {}, `Quote: ${formatTap(q.price)}`), h('div.grow'), inspectBtn('Quote', q)),
        kv([
          ['Matter', h('span', {}, h('span.swatch', { style: { background: mineral(q.asset) } }), assetName(q.asset))],
          q.block !== undefined ? ['From block', blockLink(q.block)] : null,
          q.amount !== undefined && q.block === undefined ? ['Units', h('span.mono', {}, fmtInt(q.amount))] : null,
          ['Paid with', q.kind === 'ethereum' ? 'Bridged TAP' : 'TAP'],
          ['Price', h('strong.mono', {}, formatTap(q.price))],
          ['Base fee B', h('span.mono', {}, formatTap(q.baseFee))],
          q.networkFeeSats ? ['Bitcoin inscription fee', h('span.mono', {}, `${btc(q.networkFeeSats)} · ${fmtInt(q.networkFeeSats)} sats`)] : null,
          q.feeQuote?.validUntil ? ['Price holds', h('span', {}, `until block ${fmtInt(q.feeQuote.validUntil)}`)] : null,
        ]),
        q.split ? [h('div.section-label', {}, 'Fee split'), h('div', { style: { padding: '0 14px 4px' } }, splitTable(q.split, q.destinations ?? {}, q.kind, q.unit))] : null,
        h('div.body.small.muted', {}, 'This quote does not reserve units. Your agent creates the signed request and payment link for your connected wallets.')));
    }
    catch (e) { clear(output, h('div.note.bad', { role: 'alert' }, `Quote unavailable: ${e.message}`)); } };
  app.append(panel('Quote', form), output);
}
