import { h, clear, kv, hashEl, pill, confirmModal, fmtInt, input, field } from '../dom.js';
import { tap } from '../money.js';
import { TapWalletMint, EthereumMint, BrowserMintJournal } from './wallet.js';
import { walletError } from '../wallet-errors.js';

// Protocol responses must retain chain/network fields; the display-only public
// read adapter deliberately strips those and cannot be used for wallet signing.
async function api(path, body) {
  const response = await fetch(path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, credentials: 'same-origin' });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? 'request_failed');
  return result;
}
// Only a request link opens this page; Mint On-Chain without one is the public money page's own view.
export function mount(root, { id }) {
  const body = h('div.stack'), actions = h('div.row'), note = h('div', { role: 'status', 'aria-live': 'polite' });
  clear(root, h('div.page', {}, h('div.page-head', {}, h('h1', {}, 'Mint from your wallet')),
    h('p', {}, 'Pay the fee items first. Once payment is final, your units are consumed and your permanent permit is ready. You pay the Bitcoin inscription fees, including when paying with Ethereum.'), body, actions, note));
  let stopped = false, busy = false, timer, status, target, wallet, ethereum, paymentDraft = '';
  const attempt = async fn => {
    if (busy || stopped) return; busy = true;
    for (const button of actions.querySelectorAll('button')) button.disabled = true;
    clear(note, 'Working…');
    try { await fn(); if (!stopped) clear(note, 'Saved wallet steps can be resumed using this same request link.'); }
    catch (error) { if (!stopped) clear(note, walletError(error)); }
    finally { busy = false; for (const button of actions.querySelectorAll('button')) button.disabled = false; }
  };
  const button = (label, fn) => h('button.btn', { onclick: () => attempt(fn) }, label);
  const refresh = async () => {
    status = await wallet.status(id);
    if (stopped) return;
    clear(body, kv([['Request', hashEl(id)], ['State', pill(status.state.replace(/_/g, ' '))], ['Receiver', hashEl(status.receiver)], ['Units', fmtInt(status.amount)], status.inscription ? ['Inscription', hashEl(status.inscription)] : null]),
      h('h3', {}, 'Remaining fees'), ...status.missing.map(item => h('p', {}, `${item.role}: ${tap(item.amount)} · `, hashEl(item.to))),
      status.state === 'permit_issued' ? h('p', {}, 'Your units have been consumed once. This permit has no expiry; you can inscribe when ready.') : null);
    const next = [button('Refresh', refresh)];
    if (['awaiting_payment', 'partly_paid'].includes(status.state) && status.payable) next.push(button('Pay missing items', async () => {
      if (!await confirmModal({ title: 'Pay the remaining fees?', lead: 'Your wallet pays the quoted recipients. We do not refund these payments.', rows: status.missing.map(item => [item.role, tap(item.amount)]), confirm: 'Pay from my wallet' })) return;
      if (status.payBy.rail === 'tap') { await wallet.connect(); const result = await wallet.pay(id); if (result.localState === 'payment_pending') throw Error(result.message); }
      else { const plan = await api('/web-api/mint/' + id); await ethereum.connect(plan.payer); await ethereum.pay(id); }
      await refresh();
    }));
    if (status.ethereumRelease && !['permit_issued', 'minted'].includes(status.state)) next.push(button('Release Ethereum payment', async () => {
      const plan = await api('/web-api/mint/' + id); await ethereum.connect(plan.payer);
      if (!await confirmModal({ title: 'Release Ethereum payment?', lead: 'Your wallet submits the committee-authorized release and pays gas.', rows: [['Request', hashEl(id)]], confirm: 'Release' })) return;
      await ethereum.release(id); await refresh();
    }));
    if (status.state === 'permit_issued') next.push(button('Inscribe mint', async () => {
      await wallet.connect();
      const result = await wallet.inscribe(id, { maxFeeSats: '1000000', confirm: terms => confirmModal({ title: 'Inscribe with your Bitcoin wallet?', lead: 'Your wallet funds the commit and this browser sends the saved reveal. Keep this request link to resume.', rows: [['Miner fees', `${terms.feeSats} sat`], ['Postage', `${terms.postage} sat`], ['Receiver', hashEl(terms.receiver)]], confirm: terms.resume ? 'Resume' : 'Inscribe' }) });
      if (result.state === 'broadcast') await api('/mint/payment', { id, inscription: result.inscriptionId });
      await refresh();
    }));
    if (status.payBy.rail === 'tap' && !['permit_issued', 'minted'].includes(status.state)) {
      const paymentId = input({ value: paymentDraft, placeholder: 'Transaction ID followed by i0', 'aria-label': 'Payment inscription ID', oninput: event => { paymentDraft = event.target.value; } });
      next.push(field('Already paid? Report the redeem inscription ID shown by your wallet', paymentId), button('Report payment', async () => {
        const value = paymentId.value.trim();
        if (!/^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(value)) throw Error('Enter the redeem inscription ID, including i0. A funding transaction ID is not an inscription ID.');
        await api('/mint/payment', { id, paymentId: value }); await refresh();
      }));
    }
    clear(actions, ...next);
  };
  const poll = () => { timer = setTimeout(async () => { if (stopped) return; if (!busy) try { await refresh(); } catch { clear(note, 'Status unavailable. Refresh to retry.'); } if (status?.state !== 'minted') poll(); }, 5000); };
  void attempt(async () => {
    target = await api('/web-api/target');
    if (!['mainnet', 'regtest'].includes(target.bitcoinNetwork)) throw Error('Invalid Bitcoin network');
    const options = { network: target.bitcoinNetwork, readStatus: () => api('/mint/' + id), readPaymentPlan: () => api('/web-api/mint/' + id) };
    wallet = new TapWalletMint({ ...options, notify: text => clear(note, text) });
    ethereum = new EthereumMint({ ...options, journal: new BrowserMintJournal(), readTarget: () => api('/web-api/target'), readPlan: () => api('/web-api/mint/' + id) });
    await refresh(); poll();
  });
  return () => { stopped = true; clearTimeout(timer); };
}
