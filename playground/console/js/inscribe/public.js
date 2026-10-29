import { h, clear, kv, hashEl, pill, confirmModal, fmtInt, input, field } from '../dom.js';
import { tap } from '../money.js';
import { TapWalletMint, EthereumMint, BrowserMintJournal } from './wallet.js';
import { walletError } from '../wallet-errors.js';
import { validateTracAddress } from '../../../../rules/src/trac-address.js';

// Protocol responses must retain chain/network fields; the display-only public
// read adapter deliberately strips those and cannot be used for wallet signing.
async function api(path, body) {
  const response = await fetch(path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, credentials: 'same-origin' });
  // A proxy timeout returns an empty body; report it as an unfinished request, not a JSON error.
  const result = await response.json().catch(() => ({ error: 'request_failed' }));
  if (!response.ok) throw Error(result.error ?? 'request_failed');
  return result;
}
// A catalog/ledger asset link handles first deployment before a signed mint
// request exists. Request links retain the payment and permanent-permit flow.
export function mount(root, { id, onPublicMint }) {
  const assetPage = /^(?:[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*))$/.test(id);
  const params = new URLSearchParams(location.search);
  const publicMode = assetPage && params.get('public') === '1';
  const publicBlock = publicMode ? params.get('block') : null;
  const publicAddress = publicBlock !== null ? params.get('tapAddress') : null;
  const body = h('div.stack'), actions = h('div.row'), note = h('div', { role: 'status', 'aria-live': 'polite' });
  const intro = h('p', {}, assetPage ? 'This pattern has no token on Bitcoin yet. Whoever mints it first inscribes the pattern and deploys its token, once, from their own TAP Wallet. After that, every mint of it works the normal way.' : 'Pay the fee items first. Once payment is final, your permanent permit is ready. You pay the Bitcoin inscription fees, including when paying with Ethereum.');
  clear(root, h('div.page', {}, h('div.page-head', {}, h('h1', {}, 'Mint from your wallet')),
    intro, body, actions, note));
  let stopped = false, busy = false, timer, status, target, wallet, ethereum, publicRequest, paymentDraft = '';
  // The gateway cannot read an inscription until it is in a block (and indexed).
  const notYet = error => ['deployment_confirmations', 'tap_quorum_unavailable', 'request_failed'].includes(error?.message);
  let registering = false, lastRegister = 0;
  let owner = assetPage ? new URLSearchParams(location.search).get('owner') ?? '' : '';
  const journal = new BrowserMintJournal();
  const attempt = async fn => {
    if (busy || stopped) return; busy = true;
    for (const button of actions.querySelectorAll('button')) button.disabled = true;
    clear(note, 'Working…');
    try { await fn(); if (!stopped && note.textContent === 'Working…') clear(note, 'Saved wallet steps can be resumed using this same request link.'); }
    catch (error) { if (!stopped) clear(note, walletError(error)); }
    finally { busy = false; for (const button of actions.querySelectorAll('button')) button.disabled = false; }
  };
  const button = (label, fn) => h('button.btn', { onclick: () => attempt(fn) }, label);
  const confirmFees = terms => confirmModal({ title: 'Inscribe with your Bitcoin wallet?',
    lead: 'Your wallet funds the commit and this browser sends the saved reveal. Keep this link to resume.',
    rows: [['Fee rate', `${terms.feeRate} sat/vB (mempool.space half-hour estimate)`], ['Miner fees', `${terms.feeSats} sat`], ['Postage', `${terms.postage} sat`], ['Receiver', hashEl(terms.receiver)]], confirm: terms.resume ? 'Resume' : 'Inscribe' });
  const renderDeployment = async job => {
    const phase = job.phase, current = job.attempts?.find(a => a.phase === phase && a.attempt === (phase === 'element' ? job.elementAttempt : job.tickerAttempt));
    const receiptKey = current && `${target.network}/deployment-receipt/${job.asset}/${current.id}`;
    const receipt = receiptKey ? await journal.get(receiptKey) : null;
    if (stopped) return;
    const registered = job.state === 'registered', isPublic = publicMode || status?.publicMint === true;
    // A sent inscription is registered by this page once it is in a block; until then the gateway cannot read it.
    const waiting = !registered && receipt;
    if (waiting && !registering && Date.now() - lastRegister > 30000) {
      registering = true; lastRegister = Date.now();
      api('/mint/deployment', { asset: job.asset, phase, inscription: receipt.inscriptionId })
        .then(() => { if (!stopped) return refresh(); }, error => { if (!notYet(error)) clear(note, walletError(error)); })
        .finally(() => { registering = false; });
    }
    const waitText = 'Sent. Waiting for the next Bitcoin block (about 10 minutes). This page registers it automatically; keep it open or come back to this link.';
    clear(body, kv([['Pattern', job.displayLabel ?? job.asset], ['Asset', job.asset], ['Token', pill(registered ? 'deployed' : 'not deployed yet', registered ? 'good' : 'warn')],
      job.receiver ? ['Your wallet', hashEl(job.receiver)] : null, receipt ? ['Your inscription', hashEl(receipt.inscriptionId)] : null]),
      h('h3', {}, 'Steps'),
      h('ol', {},
        h('li', {}, isPublic ? 'Connect the TAP Wallet receiving your public mint. No agent or payout binding is needed.' : 'Connect TAP Wallet in the header. It must be the payout wallet linked to your agent. Enter your agent’s address (trac1…) below.'),
        h('li', {}, h('strong', {}, 'Inscribe the pattern. '), job.elementId ? h('span', {}, h('strong', {}, 'Done: '), 'the pattern is inscribed and in a block.')
          : waiting && phase === 'element' ? waitText : 'Press “Inscribe pattern” and approve it in TAP Wallet.'),
        h('li', {}, h('strong', {}, 'Deploy the token. '), registered ? h('span', {}, h('strong', {}, 'Done: '), 'the token is deployed.')
          : waiting && phase === 'deployment' ? waitText : job.elementId ? 'Press “Deploy token” and approve it in TAP Wallet.' : 'Once the pattern is in a block, press “Deploy token” and approve it.'),
        h('li', {}, isPublic ? 'Continue to payment after the token is deployed. Review the public mint quote, pay every fee in one TAP payment, then inscribe your permit. Nothing is reserved.' : 'Mint as usual: ask your agent to mint a block of this pattern. It reserves your units and gives you a payment link. Open it, pay the fee in TAP, then inscribe the mint. The tokens arrive in your TAP Wallet.')),
      h('p.small.muted', {}, 'Each inscription costs only Bitcoin network fees; TAP Wallet shows them before you approve. You can close this page between steps: open this same link again to continue.'),
      registered ? h('p', {}, h('strong', {}, 'The token is deployed. '), isPublic ? 'Continue to review the public mint price and pay from your TAP Wallet.' : 'Ask your agent to mint now, then open the payment link it gives you.') : null,
      job.reason ? h('p.small.muted', {}, 'Status: ' + job.reason.replace(/_/g, ' ')) : null);
    const next = [button('Refresh', refresh)];
    if (!registered && assetPage && !isPublic) next.push(field('Your agent’s address', input({ value: owner, placeholder: 'trac1…',
      'aria-label': 'Agent address', oninput: event => { owner = event.target.value.trim(); } })));
    if (registered && publicMode) next.push(button('Continue to payment', async () => {
      if (onPublicMint) await onPublicMint({ asset: id, block: publicBlock }, text => clear(note, text));
      else location.assign('/mint?' + new URLSearchParams({ asset: id, block: publicBlock }));
    }));
    if (waiting) next.push(button('Check now', async () => {
      try { await api('/mint/deployment', { asset: job.asset, phase, inscription: receipt.inscriptionId }); }
      catch (error) { if (notYet(error)) throw Error('Not in a Bitcoin block yet. This page keeps checking; nothing else to do.'); throw error; }
      await refresh();
    }));
    if (job.state === 'queued') next.push(h('span.small.muted', {}, 'Preparing the inscription. This page updates by itself in a few seconds.'));
    else if (!registered && job.state !== 'awaiting_player_deploy') next.push(button('Start', async () => {
      await api('/mint/deployment', { asset: job.asset }); await refresh();
    }));
    if (job.state === 'awaiting_player_deploy' && !receipt) next.push(button(phase === 'element' ? 'Inscribe pattern' : 'Deploy token', async () => {
      let binding;
      if (!isPublic) {
        if (!assetPage) owner = (await api('/web-api/mint/' + id)).owner;
        validateTracAddress(owner);
        binding = (await api(`/payout-bindings/${encodeURIComponent(owner)}/tap`)).binding;
      }
      if (publicMode) {
        publicRequest = await api('/public-mints/quote', { asset: id, block: publicBlock, tapAddress: publicAddress });
        if (publicRequest.state !== 'deployment_needed') { await refresh(); return; }
      }
      await wallet.connect();
      const fresh = await api('/mint/deployment-state/' + job.asset);
      const freshAttempt = fresh.attempts?.find(a => a.phase === fresh.phase && a.attempt === (fresh.phase === 'element' ? fresh.elementAttempt : fresh.tickerAttempt));
      if (freshAttempt?.id !== current.id || fresh.phase !== phase) { await refresh(); throw Error('Deployment changed. Review the current phase before inscribing.'); }
      const result = await wallet.inscribeDeployment(fresh, { owner, binding, ...(isPublic ? { publicRequest: publicRequest ?? status } : {}), maxFeeSats: '1000000', confirm: confirmFees });
      if (result.state !== 'broadcast') return;
      await journal.put(receiptKey, { inscriptionId: result.inscriptionId });
      try { await api('/mint/deployment', { asset: job.asset, phase: result.phase, inscription: result.inscriptionId }); }
      catch (error) {
        await refresh();
        if (notYet(error)) return;
        throw error;
      }
      await refresh();
    }));
    clear(actions, ...next);
  };
  const refresh = async () => {
    if (assetPage) {
      if (publicMode) {
        if (!/^(0|[1-9][0-9]*)$/.test(publicBlock) || !publicAddress) throw Error('Invalid public mint link');
        publicRequest = await api('/public-mints/quote', { asset: id, block: publicBlock, tapAddress: publicAddress });
        if (publicRequest.receiver !== publicAddress || String(publicRequest.block) !== publicBlock) throw Error('Public mint receiver or block changed');
      }
      return renderDeployment(await api('/mint/deployment-state/' + id));
    }
    status = await wallet.status(id);
    if (stopped) return;
    if (status.publicMint) intro.textContent = 'Pay every quoted fee in one TAP payment. The first confirmed complete payment wins. No units are consumed. After your permanent permit is issued, inscribe the mint from your TAP Wallet.';
    if (/^(?:[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*))$/.test(status.asset)) {
      const deployment = await api('/mint/deployment-state/' + status.asset);
      if (deployment.state !== 'registered') return renderDeployment(deployment);
    }
    clear(body, kv([['Request', hashEl(id)], ['State', pill(status.state.replace(/_/g, ' '))], ['Receiver', hashEl(status.receiver)], ['Units', fmtInt(status.amount)], status.publicMint && status.refunds?.length ? ['Refund', 'Owed; not sent automatically'] : null, status.inscription ? ['Inscription', hashEl(status.inscription)] : null]),
      h('h3', {}, 'Remaining fees'), ...status.missing.map(item => h('p', {}, `${item.role}: ${tap(item.amount)} · `, hashEl(item.to))),
      status.state === 'permit_issued' ? h('p', {}, status.publicMint ? 'Your payment won. This permit has no expiry; you can inscribe when ready.' : 'Your units have been consumed once. This permit has no expiry; you can inscribe when ready.') : null);
    const next = [button('Refresh', refresh)];
    if (['awaiting_payment', 'partly_paid'].includes(status.state) && status.payable) next.push(button('Pay missing items', async () => {
      if (!await confirmModal({ title: 'Pay the remaining fees?', lead: status.publicMint ? 'Pay every fee in one TAP payment. First confirmed complete payment wins; later payments are recorded for refund. Refunds are not sent automatically.' : 'Your wallet pays the quoted recipients. We do not refund these payments.', rows: status.missing.map(item => [item.role, tap(item.amount)]), confirm: 'Pay from my wallet' })) return;
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
      const result = await wallet.inscribe(id, { maxFeeSats: '1000000', confirm: confirmFees });
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
    wallet = new TapWalletMint({ ...options, journal, notify: text => clear(note, text) });
    ethereum = new EthereumMint({ ...options, journal: new BrowserMintJournal(), readTarget: () => api('/web-api/target'), readPlan: () => api('/web-api/mint/' + id) });
    await refresh(); poll();
  });
  return () => { stopped = true; clearTimeout(timer); };
}
