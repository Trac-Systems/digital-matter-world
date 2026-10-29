import { h, clear, kv, hashEl, pill, confirmModal, fmtInt, input, field, panel, table, stepper } from '../dom.js';
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
const STOPPED = /^(?:expired|cancelled|rejected|refundable|refund_\w+|unpaid_expired|quarantined|recovery|failed)$/;
// A catalog/ledger asset link handles first deployment before a signed mint
// request exists. Request links retain the payment and permanent-permit flow.
export function mount(root, { id, onPublicMint }) {
  const assetPage = /^(?:[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*))$/.test(id);
  const params = new URLSearchParams(location.search);
  const publicMode = assetPage && params.get('public') === '1';
  const publicBlock = publicMode ? params.get('block') : null;
  const publicAddress = publicBlock !== null ? params.get('tapAddress') : null;
  // One flow layout: the step indicator, the next step (status, the primary action) and the request details beside it.
  const progress = h('div'), lead = h('div.section-gap'), body = h('div.stack'), side = h('div.stack');
  const actions = h('div.row.actions'), extra = h('div.extra'), note = h('div.callout', { role: 'status', 'aria-live': 'polite' });
  // Progress and errors show in the callout by the action buttons: busy while working, red on failure.
  const say = (text, kind = '') => { note.className = 'callout' + (kind ? ' ' + kind : ''); clear(note, text); };
  const intro = h('p.lead-text', {}, assetPage ? 'This pattern has no token on Bitcoin yet. Whoever mints it first inscribes the pattern and deploys its token, once, from their own TAP Wallet. After that, every mint of it works the normal way.' : 'Pay the fee items first. Once payment is final, your permanent permit is ready. You pay the Bitcoin inscription fees, including when paying with Ethereum.');
  clear(root, h('div.page', {}, h('div.page-head', {}, h('h1', {}, 'Mint from your wallet')),
    intro, h('div.flow', {}, progress, h('div.grid.cols-main', {},
      h('div.stack', {}, h('section.panel.next-step', {}, h('header', {}, h('h2', {}, 'Next step')), h('div.body', {}, lead, note, actions, extra)), body), side))));
  let stopped = false, busy = false, timer, status, target, wallet, ethereum, publicRequest, paymentDraft = '';
  // A wallet payment is reported by its redeem inscription, found on Bitcoin.
  let reported = null, lastLookup = 0;
  const reportPayment = async current => {
    if (reported || Date.now() - lastLookup < 30000) return; lastLookup = Date.now();
    // This browser's saved payment first; otherwise the payment found on Bitcoin (paid from another browser).
    const paymentId = await wallet.paymentInscription(id, current.payer ?? current.receiver).catch(() => null)
      ?? await findPayment(id, current.payer ?? current.receiver, { network: wallet.network }).catch(() => null);
    if (!paymentId) return;
    try { await api('/mint/payment', { id, paymentId }); }
    catch (error) { if (error.message !== 'financial_transition_pending') return; }
    reported = paymentId;
    if (!stopped) say('Your payment was found on Bitcoin and reported. The permit follows with the next batch.', 'good');
  };
  // The gateway cannot read an inscription until it is in a block (and indexed).
  const notYet = error => ['deployment_confirmations', 'tap_quorum_unavailable', 'request_failed'].includes(error?.message);
  let registering = false, lastRegister = 0;
  let owner = assetPage ? new URLSearchParams(location.search).get('owner') ?? '' : '';
  const journal = new BrowserMintJournal();
  const attempt = async (fn, clicked) => {
    if (busy || stopped) return; busy = true;
    for (const button of root.querySelectorAll('.next-step button')) button.disabled = true;
    clicked?.classList.add('busy');
    say('Working…', 'busy');
    try { await fn(); if (!stopped && note.textContent === 'Working…') say(''); }
    catch (error) { if (!stopped) say(walletError(error), 'bad'); }
    finally { busy = false; clicked?.classList.remove('busy'); if (note.classList.contains('busy')) note.className = 'callout info'; for (const button of root.querySelectorAll('.next-step button')) button.disabled = false; }
  };
  // The step's main action is the large primary button; Refresh and side actions stay quiet.
  const button = (label, fn, kind = '') => h(`button.btn${kind === 'primary' ? '.primary.cta' : kind === 'quiet' ? '.ghost' : ''}`, { onclick: event => attempt(fn, event.currentTarget) }, label);
  const fill = (next, rest = []) => { clear(actions, ...next.filter(b => !b.classList?.contains('ghost')), ...next.filter(b => b.classList?.contains('ghost'))); clear(extra, ...rest); };
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
        .then(() => { if (!stopped) return refresh(); }, error => { if (!notYet(error)) say(walletError(error), 'bad'); })
        .finally(() => { registering = false; });
    }
    const waitText = 'Sent. Waiting for the next Bitcoin block (about 10 minutes). This page registers it automatically; keep it open or come back to this link.';
    // Steps: inscribe the pattern, deploy its token (each in its own Bitcoin block), then mint as usual.
    const at = registered ? 2 : job.elementId || phase === 'deployment' ? 1 : 0;
    clear(progress, stepper(['Inscribe pattern', 'Deploy token', isPublic ? 'Pay & mint' : 'Mint'], at));
    const done = text => h('span', {}, h('strong', {}, 'Done: '), text);
    clear(lead, registered ? h('p.lead', {}, h('strong', {}, 'The token is deployed. '), isPublic ? 'Continue to review the public mint fee and pay from your TAP Wallet.' : 'Ask your agent to mint now, then open the payment link it gives you.')
      : waiting ? h('div.callout.info', {}, waitText) : null);
    clear(body, panel('Steps', h('ol.numbered', {},
        h('li', {}, h('span', {}, isPublic ? 'Connect the TAP Wallet receiving your public mint. No agent or payout binding is needed.' : 'Connect TAP Wallet in the header. It must be the payout wallet linked to your agent. Enter your agent’s address (trac1…) below.')),
        h('li', {}, h('span', {}, h('strong', {}, 'Inscribe the pattern. '), job.elementId ? done('the pattern is inscribed and in a block.')
          : waiting && phase === 'element' ? 'Sent. Waiting for the next Bitcoin block.' : 'Press “Inscribe pattern” and approve it in TAP Wallet.')),
        h('li', {}, h('span', {}, h('strong', {}, 'Deploy the token. '), registered ? done('the token is deployed.')
          : waiting && phase === 'deployment' ? 'Sent. Waiting for the next Bitcoin block.' : job.elementId ? 'Press “Deploy token” and approve it in TAP Wallet.' : 'Once the pattern is in a block, press “Deploy token” and approve it.')),
        h('li', {}, h('span', {}, isPublic ? 'Continue to payment after the token is deployed. Review the public mint quote, pay every fee in one TAP payment, then inscribe your permit. Nothing is reserved.' : 'Mint as usual: ask your agent to mint a block of this pattern. It reserves your units and gives you a payment link. Open it, pay the fee in TAP, then inscribe the mint. The tokens arrive in your TAP Wallet.'))),
      ),
      h('p.small.muted', { style: { margin: 0 } }, 'Each inscription costs only Bitcoin network fees; TAP Wallet shows them before you approve. You can close this page between steps: open this same link again to continue.'));
    clear(side, panel('Pattern', kv([['Pattern', job.displayLabel ?? job.asset], ['Asset', job.asset], ['Token', pill(registered ? 'deployed' : 'not deployed yet', registered ? 'good' : 'warn')],
      job.receiver ? ['Your wallet', hashEl(job.receiver)] : null, receipt ? ['Your inscription', hashEl(receipt.inscriptionId)] : null,
      job.reason ? ['Status', job.reason.replace(/_/g, ' ')] : null]), { flush: true }));
    const next = [button('Refresh', refresh, 'quiet')];
    if (!registered && assetPage && !isPublic) lead.append(field('Your agent’s address', input({ value: owner, placeholder: 'trac1…',
      'aria-label': 'Agent address', oninput: event => { owner = event.target.value.trim(); } })));
    if (registered && publicMode) next.push(button('Continue to payment', async () => {
      if (onPublicMint) await onPublicMint({ asset: id, block: publicBlock }, text => say(text, text.endsWith('…') ? 'busy' : 'info'));
      else { history.pushState(null, '', '/mint?' + new URLSearchParams({ asset: id, block: publicBlock })); dispatchEvent(new PopStateEvent('popstate')); }
    }, 'primary'));
    if (waiting) next.push(button('Check now', async () => {
      try { await api('/mint/deployment', { asset: job.asset, phase, inscription: receipt.inscriptionId }); }
      catch (error) { if (notYet(error)) throw Error('Not in a Bitcoin block yet. This page keeps checking; nothing else to do.'); throw error; }
      await refresh();
    }, 'primary'));
    if (job.state === 'queued') lead.append(h('div.callout.busy', {}, 'Preparing the inscription. This page updates by itself in a few seconds.'));
    else if (!registered && job.state !== 'awaiting_player_deploy') next.push(button('Start', async () => {
      await api('/mint/deployment', { asset: job.asset }); await refresh();
    }, 'primary'));
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
    }, 'primary'));
    fill(next);
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
    if (['awaiting_payment', 'partly_paid'].includes(status.state) && status.payBy?.rail === 'tap') void reportPayment(status);
    if (stopped) return;
    if (status.publicMint) intro.textContent = 'Pay every quoted fee in one TAP payment. The first confirmed complete payment wins. No units are consumed. After your permanent permit is issued, inscribe the mint from your TAP Wallet.';
    if (/^(?:[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*))$/.test(status.asset)) {
      const deployment = await api('/mint/deployment-state/' + status.asset);
      if (deployment.state !== 'registered') return renderDeployment(deployment);
    }
    // Steps: reserve (a public mint only requests) → pay → permit → inscribe → minted; a stopped request marks its step red.
    const state = status.state, failed = STOPPED.test(state);
    const at = state === 'minted' ? 5 : state === 'permit_issued' ? 3 : ['paid', 'payment_confirmed'].includes(state) ? 2 : 1;
    clear(progress, stepper([status.publicMint ? 'Request' : 'Reserve', 'Pay', 'Permit', 'Inscribe', 'Minted'], at, { failed }));
    const kind = state === 'minted' ? 'good' : failed ? 'bad' : ['awaiting_payment', 'partly_paid'].includes(state) ? 'warn' : 'info';
    const due = status.missing.reduce((sum, item) => sum + BigInt(item.amount), 0n);
    clear(lead, status.missing.length && !failed ? h('div', {}, h('div.small.muted', {}, 'Remaining to pay'), h('div.price', {}, tap(due.toString()))) : null,
      state === 'permit_issued' ? h('p.lead', {}, status.publicMint ? 'Your payment won. This permit has no expiry; you can inscribe when ready.' : 'Your units have been consumed once. This permit has no expiry; you can inscribe when ready.') : null,
      state === 'minted' ? h('div.callout.good', {}, 'Minted. ', status.inscription ? ['Inscription ', hashEl(status.inscription)] : null) : null);
    const fees = status.missing.length ? table(status.missing, [
      { key: 'role', label: 'Fee', render: item => String(item.role).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) },
      { key: 'amount', label: 'Amount', num: true, render: item => h('span.mono', {}, tap(item.amount)) },
      { key: 'to', label: 'Paid to', render: item => hashEl(item.to) },
    ], { sortable: false }) : null;
    if (fees && status.missing.length > 1) fees.querySelector('tbody').append(h('tr.total', {}, h('td', {}, 'Total'), h('td.num', {}, h('span.mono', {}, tap(due.toString()))), h('td')));
    clear(body, fees ? panel('Remaining fees', fees, { flush: true }) : null);
    clear(side, panel('Request', kv([['Request', hashEl(id)], ['State', pill(state.replace(/_/g, ' '), kind)], ['Receiver', hashEl(status.receiver)], ['Units', fmtInt(status.amount)], status.publicMint && status.refunds?.length ? ['Refund', 'Owed; not sent automatically'] : null, status.inscription ? ['Inscription', hashEl(status.inscription)] : null]), { flush: true }));
    const next = [button('Refresh', refresh, 'quiet')], rest = [];
    if (['awaiting_payment', 'partly_paid'].includes(status.state) && status.payable) next.push(button('Pay missing items', async () => {
      if (!await confirmModal({ title: 'Pay the remaining fees?', lead: status.publicMint ? 'Pay every fee in one TAP payment. First confirmed complete payment wins; later payments are recorded for refund. Refunds are not sent automatically.' : 'Your wallet pays the quoted recipients. We do not refund these payments.', rows: status.missing.map(item => [item.role, tap(item.amount)]), confirm: 'Pay from my wallet' })) return;
      if (status.payBy.rail === 'tap') {
        await wallet.connect(); let result = await wallet.pay(id);
        if (result.retryable && await confirmModal({ title: 'Retry the payment?', lead: 'TAP Wallet returned no receipt for the last attempt. Retry only if your wallet shows no sent payment for this request.', rows: status.missing.map(item => [item.role, tap(item.amount)]), confirm: 'Retry payment' })) result = await wallet.pay(id, { retry: true });
        if (result.localState === 'payment_pending') throw Error(result.message);
        lastLookup = 0;
      }
      else { const plan = await api('/web-api/mint/' + id); await ethereum.connect(plan.payer); await ethereum.pay(id); }
      await refresh();
    }, 'primary'));
    if (status.ethereumRelease && !['permit_issued', 'minted'].includes(status.state)) next.push(button('Release Ethereum payment', async () => {
      const plan = await api('/web-api/mint/' + id); await ethereum.connect(plan.payer);
      if (!await confirmModal({ title: 'Release Ethereum payment?', lead: 'Your wallet submits the committee-authorized release and pays gas.', rows: [['Request', hashEl(id)]], confirm: 'Release' })) return;
      await ethereum.release(id); await refresh();
    }, 'primary'));
    const local = status.state === 'permit_issued' ? await wallet.sentInscription(id, status.receiver).catch(() => null) : null;
    const sent = local ?? (status.state === 'permit_issued' && status.sentInscription ? { inscriptionId: status.sentInscription, revealTxid: status.sentInscription.slice(0, 64) } : null);
    if (sent) lead.append(h('div.callout.info', {}, 'Your mint inscription was sent: ', h('a', { href: 'https://mempool.space/tx/' + sent.revealTxid, target: '_blank', rel: 'noreferrer noopener' }, sent.inscriptionId),
      '. It completes by itself once Bitcoin confirms it; nothing else to do.'));
    if (status.state === 'permit_issued' && !sent) next.push(button('Inscribe mint', async () => {
      await wallet.connect();
      const result = await wallet.inscribe(id, { maxFeeSats: '1000000', confirm: confirmFees });
      if (result.state === 'broadcast') await api('/mint/payment', { id, inscription: result.inscriptionId });
      await refresh();
    }, 'primary'));
    if (status.payBy.rail === 'tap' && !['permit_issued', 'minted'].includes(status.state)) {
      const paymentId = input({ value: paymentDraft, placeholder: 'Transaction ID followed by i0', 'aria-label': 'Payment inscription ID', oninput: event => { paymentDraft = event.target.value; } });
      rest.push(h('div.row', { style: { alignItems: 'flex-end' } }, h('div', { style: { flex: '1 1 260px' } }, field('Already paid? Report the redeem inscription ID shown by your wallet', paymentId)), button('Report payment', async () => {
        const value = paymentId.value.trim();
        if (!/^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(value)) throw Error('Enter the redeem inscription ID, including i0. A funding transaction ID is not an inscription ID.');
        await api('/mint/payment', { id, paymentId: value }); await refresh();
      })));
    }
    fill(next, rest);
  };
  const poll = () => { timer = setTimeout(async () => { if (stopped) return; if (!busy) try { await refresh(); } catch { say('Status unavailable. Refresh to retry.', 'warn'); } if (status?.state !== 'minted') poll(); }, 5000); };
  void attempt(async () => {
    target = await api('/web-api/target');
    if (!['mainnet', 'regtest'].includes(target.bitcoinNetwork)) throw Error('Invalid Bitcoin network');
    const options = { network: target.bitcoinNetwork, readStatus: () => api('/mint/' + id), readPaymentPlan: () => api('/web-api/mint/' + id) };
    wallet = new TapWalletMint({ ...options, journal, notify: text => say(text, busy ? 'busy' : 'info') });
    ethereum = new EthereumMint({ ...options, journal: new BrowserMintJournal(), readTarget: () => api('/web-api/target'), readPlan: () => api('/web-api/mint/' + id) });
    await refresh(); poll();
  });
  return () => { stopped = true; clearTimeout(timer); };
}

// A TAP fee payment found on Bitcoin by its request id, so a page can report it to the
// gateway from any browser: the payer's recent transactions are read from mempool.space and
// the redeem inscription whose items carry "dmw-pay-v2|<id>|" wins. The gateway verifies
// whatever is reported, so a wrong match is refused, not credited.
// Push data of a tapscript, joined: inscription bodies are split into 520-byte pushes.
export function scriptText(hex) {
  const b = Uint8Array.from(hex.match(/../g) ?? [], x => parseInt(x, 16)), parts = [];
  for (let i = 0; i < b.length;) {
    const op = b[i++];
    let n = op >= 1 && op <= 75 ? op : op === 76 ? b[i++] : op === 77 ? b[i++] | b[i++] << 8 : op === 78 ? (b[i++] | b[i++] << 8 | b[i++] << 16 | b[i++] << 24) >>> 0 : 0;
    if (n) { parts.push(b.subarray(i, i + n)); i += n; }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(parts.flatMap(p => [...p])));
}

// The inscription id ("<txid>i0") of the payment for request `id` from `address`, or null.
export async function findPayment(id, address, { network = 'mainnet', fetchImpl = globalThis.fetch } = {}) {
  if (!/^[0-9a-f]{64}$/.test(id ?? '') || !address || network === 'regtest') return null;
  const base = 'https://mempool.space' + (network === 'mainnet' ? '' : '/' + network) + '/api/address/' + encodeURIComponent(address) + '/txs';
  const response = await fetchImpl(base, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  const marker = `dmw-pay-v2|${id}|`;
  for (const tx of await response.json()) {
    if (!tx.status?.confirmed) continue;
    const script = tx.vin?.[0]?.witness?.find(w => w.length > 200);
    if (script && scriptText(script).includes(marker)) return tx.txid + 'i0';
  }
  return null;
}
