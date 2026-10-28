import { api } from './data.js';
import { walletError } from './console/js/wallet-errors.js';
import { mount as mintPage } from './console/js/inscribe/public.js';
import { presentation, get, store } from './console/js/api.js';
import { pagedTable } from './console/js/paged.js';
import { h, clear, panel, kv, pill, hashEl, fmtInt, table, confirmModal, copy, inspectBtn as rawInspectBtn } from './console/js/dom.js';
import { splitTable, btc, tap, feePrice } from './console/js/money.js';
import { assetName, mineral, mintRule } from './console/js/words.js';
import { formatTap } from './amount-format.js';
import { tapAccount, ethAccount, receipt, orderResult, authority, requireTapActions, WalletJournal, wait, hex, sha256, unhex, fail } from './wallets.js';
import { wallet, walletSummary, connectButtons, copyBlock } from './connect.js';
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
    const cleanup = mintPage(root, { id });
    root.querySelector('.page-head').after(back);
    return cleanup;
  }
  const app = h('div.stack'), side = h('div.stack');
  root.append(h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, TITLES[type]), h('p', {}, 'Mining, claims, discoveries and crafting are free. Payments happen here through your wallet.'))),
    back,
    h('div.grid.cols-main', {}, app, side)));
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
      await request(app, type, id, target);
    } catch (e) { if (!stopped) app.append(h('div.note.bad', { role: 'alert' }, `Unable to load: ${walletError(e)}. `, h('a', { href: location.pathname + location.search }, 'Retry'))); }
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
  const mayPay = () => type === 'mint' || plan?.financialVersion === 2 ? !!plan && (plan.ethereumRelease && plan.ethereumDepositStatus === 1 && !plan.ethereumRefundEligible || plan.payable && ['awaiting_payment','partly_paid'].includes(plan.state)) : ['awaiting_wallet','waiting_payment'].includes(plan?.state);
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
        plan.baseFee ? ['Base price', h('span.mono', {}, formatTap(plan.baseFee, unit?.decimals))] : null,
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
    if (type === 'mint' || plan.financialVersion === 2) {
      if (plan.blocked?.length) review.append(h('div.note.bad', {}, 'This payment is not currently available.'));
      if (plan.missing?.length) review.append(panel('Remaining fees', kv(plan.missing.map(f => [f.role, formatTap(f.amount,18)]))));
      if (plan.inscriptionText) review.append(panel('Permanent mint content', [h('p', {}, 'Inscribe this exact content from your Bitcoin wallet to the receiver above. This permit does not expire.'),h('pre', {}, plan.inscriptionText)]));
    }
    pay.disabled = busy || !mayPay();
    pay.textContent = type === 'mint' && plan.ethereumRelease && plan.ethereumDepositStatus === 1 ? 'Release paid fees with wallet' : plan.walletPreparation ? 'Prepare Bitmap payment with wallet' : journal.data.lock || journal.data.deposit || journal.data.networkFee ? 'Resume payment' : 'Approve payment in wallet';
    refund.hidden = (type === 'mint' || plan.financialVersion === 2) && plan.kind === 'tap' || complete.has(plan.state) || (plan.kind === 'ethereum' ? !plan.ethereumRefundEligible : !(plan.payment || journal.data.paymentId) || plan.counted < plan.refundAfter);
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
    } catch (e) { notify(e.code === 4001 ? 'Wallet request closed. If a payment step was started, its result may be uncertain. Inspect TAP Wallet; saved payment attempts will not be sent again.' : walletError(e)); }
    finally { busy = false; refresh.disabled = refund.disabled = false; pay.disabled = !mayPay(); receipts(); }
  }
  async function prepare() {
    const { tap } = await tapAccount(target, plan.payer);
    requireTapActions(tap);
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
    if (!complete.has(plan.state)) notify('Payment submitted or awaiting confirmations. Refresh the receipt to follow completion; completed wallet steps are saved.');
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
    await load(); notify(type === 'link' ? 'Wallet payment submitted. Refresh for confirmations and the accepted Bitmap link.' : 'Wallet payment submitted. Refresh for confirmations and your permanent mint permit.');
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
      const { tap, address } = await tapAccount(target, plan.payer), auth = await authority(tap, address, journal, notify, () => tapAccount(target, plan.payer));
      const result = await journal.step('refund', () => tap.redeemTapActions({ auth, items: [], data: id, actions: [{ op: 'refund', lock: plan.payment ?? journal.data.paymentId }] }, { label: 'Refund Digital Matter World payment' }));
      await orderResult(tap, result);
    }
    notify(plan.kind === 'tap' ? 'Refund inscription submitted; waiting for verification.' : 'Refund transaction confirmed. Refresh for the gateway result.');
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
// Mint & wallets: the header's wallets with their payout link, the player's finds to mint, and Bitmap links.
// /link and /bind-payout without a request link open the same page at their section.
function walletsHome(root, type) {
  const params = new URLSearchParams(location.search), asset = params.get('asset'), block = /^\d+$/.test(params.get('block') ?? '') ? Number(params.get('block')) : null;
  const chosen = type === 'mint' && /^[a-z0-9]{1,24}$/.test(asset ?? '') && block !== null ? { asset, block } : null;
  const bitmap = type === 'link' ? block : null;
  const app = h('div.stack'), side = h('div.stack');
  root.append(h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'Mint & wallets'), h('p', {}, 'Turn your agent’s finds into TAP tokens on Bitcoin, link a Bitmap and see your payout wallets, all with the wallets connected in the header. Mining, claims and crafting are free.'))),
    h('div.grid.cols-main', {}, app, side)));
  const policy = store.status?.feePolicy;
  side.append(...[panel('How minting works', h('ol.steps-list', {},
    h('li', {}, 'Your agent finds a pattern in a block and the find settles.'),
    h('li', {}, 'You link your wallet to your agent’s player: your agent starts it, you sign.'),
    h('li', {}, h('strong', {}, 'Token not deployed yet? Inscribe the pattern and deploy its token first, then mint. '), 'Your find shows an “Inscribe & deploy” button: inscribe the pattern, wait for a Bitcoin block, deploy the token, wait for a block. ',
      h('strong', {}, 'Already deployed? Just mint.'), ' Your find shows a “Mint On-Chain” button.'),
    h('li', {}, 'Ask your agent to mint: it reserves the units and gives you a payment link.'),
    h('li', {}, 'On that link, pay the fee in TAP, then inscribe the mint with your wallet. The tokens arrive in your wallet.'))),
    policy?.baseFee ? panel('Prices', [kv([['Base price', h('span.mono', {}, tap(policy.baseFee, policy.unit))], policy.feeSettings ? ['Bitmap link', h('span.mono', {}, feePrice(policy, 'link'))] : null]),
      h('p.small.muted', { style: { margin: '0 14px 12px' } }, policy.feeSettings ? `A find costs the base price times its tier: ${Array.from({ length: 5 }, (_, i) => `tier ${i + 1}: ${feePrice(policy, 'find', i + 1)}`).join(', ')}. ` : '', 'The request shows the exact price before you pay.')], { flush: true }) : null,
    h('p.small.muted', { style: { margin: 0 } }, 'Already have a payment link from your agent? Open it; it shows the request and lets you pay.')].filter(Boolean));
  const status = note();
  const ask = (r, w) => `Mint ${r.asset} (${assetName(r.asset)}) from block ${r.block} on-chain and give me the payment link.\n${w === wallet.ethereum ? 'MetaMask' : 'TAP wallet'}: ${w.address}`;
  const mintButton = (r, primary) => h(`button.btn.sm${primary ? '.primary' : ''}`, { type: 'button', onclick: async () => {
    const w = wallet.tap ?? wallet.ethereum, text = ask(r, w);
    if (await confirmModal({ title: `Mint ${assetName(r.asset)} from block ${fmtInt(r.block)}`, lead: 'Your agent reserves the units and creates the payment request. Send it this message, then open the link it gives you to pay and inscribe.', extra: copyBlock(text), confirm: 'Copy message' })) copy(text);
  } }, 'Mint On-Chain');
  const rights = player => pagedTable({ path: `/mint-rights?owner=${player.agent}`, key: 'mintRights', limit: 10, sorts: [['block:desc', 'Newest block'], ['block:asc', 'Oldest block']],
    filters: [{ name: 'allowed', label: 'Show', value: 'true', options: [['true', 'Ready for you'], ['', 'All settled finds']] }],
    empty: 'Nothing here. Switch to All settled finds to see why.',
    columns: [
      { key: 'asset', label: 'Matter', render: r => h('span', {}, h('span.swatch', { style: { background: mineral(r.asset) } }), assetName(r.asset)) },
      { key: 'block', label: 'Block', num: true, render: r => r.block === null ? h('span.faint', {}, 'compound') : blockLink(r.block) },
      { key: 'amount', label: 'Units', num: true },
      { key: 'rule', label: 'May mint', render: r => { const rule = mintRule(r, store.status?.counted); return h('span', {}, pill(r.allowed ? 'You may mint' : rule.label, r.allowed ? 'good' : rule.kind, rule.text)); } },
      { key: 'act', label: '', render: r => r.allowed && r.block !== null ? mintButton(r, true) : undeployed(r) ? h('a.btn.sm', { href: deployHref(r.asset, player) }, 'Inscribe & deploy') : null },
    ] }).el;
  // A pattern's first mint deploys its TAP token; until then its finds are not ready to mint.
  const undeployed = r => r.reason === 'asset_unregistered' && r.rightAllowed && r.block !== null;
  const deployHref = (asset, player) => `/mint/${asset}?owner=${encodeURIComponent(player.agent)}`;
  // Why nothing is ready, from the player's first page of settled finds.
  async function reason(player, out) {
    let rows;
    try { rows = (await get(`/mint-rights?owner=${player.agent}&allowed=true&limit=1`)).total ? null : (await get(`/mint-rights?owner=${player.agent}&limit=50`)).mintRights ?? []; }
    catch { return; }
    if (!rows) return;
    const own = rows.filter(r => r.finder === player.agent);
    // One row per held pattern: imported patterns are listed under their ledger asset (p0).
    let held = [];
    try { held = ((await get(`/agents/${player.agent}/assets?limit=50`)).assets ?? []).map(a => a.asset).filter(a => a.startsWith('p')); } catch {}
    const firsts = await Promise.all(held.map(a => get(`/mint-rights?owner=${player.agent}&asset=${encodeURIComponent(store.pattern(a)?.legacy?.asset ?? a)}&limit=1`).then(r => r.mintRights?.[0], () => null)));
    const deploy = [...new Set([...rows, ...firsts.filter(Boolean)].filter(undeployed).map(r => r.asset))];
    if (deploy.length) return clear(out, h('div.note', {}, `${deploy.map(assetName).join(', ')} ${deploy.length > 1 ? 'have' : 'has'} no token on Bitcoin yet. Before the first mint, inscribe the pattern and deploy its token, once, from your wallet, each in its own block. `,
      ...deploy.map(a => h('a.btn.sm', { href: deployHref(a, player), style: { marginLeft: '6px' } }, `Inscribe & deploy ${assetName(a)}`))));
    clear(out, h('div.note', {}, !rows.length ? 'No settled find yet. When your agent wins a find and it settles, it shows up here.'
      : rows.some(r => r.whoMayMint === 'finder' && r.finder !== player.agent) && !own.length ? 'The finds so far are still in another agent’s finder window: only the finder may mint for 1,008 blocks (about a week) after the find.'
      : own.some(r => r.reason === 'insufficient_balance') ? 'Your player does not hold enough units for its finds right now.'
      : own.some(r => r.minted || r.pending) ? 'Your agent’s finds are already minted or have a mint in progress.'
      : 'Nothing is ready for your player right now. Switch to All settled finds to see each find’s rule.'));
  }
  async function picked(player, out) {
    const w = wallet.tap ?? wallet.ethereum;
    if (!player) { clear(out, h('p.small.muted', { style: { margin: 0 } }, 'Link your wallet first (see above); then ask your agent to mint it.')); return; }
    let row;
    try { row = ((await get(`/blocks/${chosen.block}/mintRights?owner=${player.agent}&asset=${chosen.asset}&limit=1`)).mintRights ?? [])[0]; } catch {}
    const rule = row ? mintRule(row, store.status?.counted) : null;
    clear(out, row ? h('div.row', {}, pill(row.allowed ? 'You may mint' : rule.label, row.allowed ? 'good' : rule.kind), h('span.small.muted', {}, rule.text)) : h('p.small.muted', { style: { margin: 0 } }, 'This block has no settled find of this pattern.'),
      row?.allowed ? [h('p.small', { style: { margin: 0 } }, 'Your agent creates the payment request. Send it this message, then open the link it gives you:'), copyBlock(ask(chosen, w))] : null);
  }
  const draw = () => {
    const player = wallet.player(), any = wallet.connected();
    const out = [];
    out.push(panel('Your wallets', h('div.stack', { style: { gap: '10px' } },
      h('p', { style: { margin: 0 } }, any ? 'The wallets connected in the header. A wallet linked to your agent’s player is its payout wallet: your agent’s earnings reach it and you can mint its finds. Your agent starts the link; you sign it on the link it gives you.'
        : 'Connect here or in the header; it is one connection for the whole site.'),
      walletSummary('tap', { purpose: true }), walletSummary('ethereum', { purpose: true }),
      wallet.ethereum && !wallet.tap ? h('p.small.muted', { style: { margin: 0 } }, 'Also connect TAP Wallet: mints are inscribed and Bitmaps linked on Bitcoin.') : null,
      connectButtons(undefined, status), status), { id: 'wallets' }));
    if (chosen) { const box = h('div.stack', { style: { gap: '8px' } }, any ? h('div.empty', {}, 'Loading…') : h('p.small.muted', { style: { margin: 0 } }, 'Connect your wallet above to see whether you may mint it.')); out.push(panel(`${assetName(chosen.asset)} from block ${fmtInt(chosen.block)}`, box)); if (any) void picked(player, box); }
    if (player) { const why = h('div'); out.push(panel('What you can mint', [h('div', { style: { padding: '10px 14px 0' } }, why), rights(player)], { flush: true, id: 'mint' })); void reason(player, why); }
    else out.push(panel('What you can mint', h('p', { style: { margin: 0 } }, !any ? 'Connect a wallet to see the finds your agent’s player may mint.'
      : [wallet.tap, wallet.ethereum].some(w => w && w.players === null) ? 'Looking up your player…' : 'Your wallet is not linked to a player yet, so there is nothing to mint. Ask your agent to link it (message above), sign the link it gives you, then come back.'), { id: 'mint' }));
    out.push(panel('Link a Bitmap', h('div.stack', { style: { gap: '8px' } },
      h('p', { style: { margin: 0 } }, 'Linking a Bitmap earns you the Bitmap holder share whenever a pattern in that block is minted, and, if linked before a find, the mint right after the finder window. TAP Wallet proves you hold the Bitmap and pays the link fee in TAP.'),
      bitmap !== null ? h('div.small', {}, 'Block ', blockLink(bitmap), `: hold ${bitmap}.bitmap in TAP Wallet, then ask your agent to link it.`) : null,
      wallet.tap ? null : h('p.small.muted', { style: { margin: 0 } }, wallet.ethereum ? 'MetaMask cannot do this: Bitmaps live on Bitcoin. Connect TAP Wallet above.' : 'Needs TAP Wallet: connect it above.'),
      h('p.small.muted', { style: { margin: 0 } }, 'Your agent starts the link. Open the link request it gives you to review the price and pay.')), { id: 'bitmap' }));
    clear(app, ...out);
  };
  draw();
  return wallet.on(draw);
}
