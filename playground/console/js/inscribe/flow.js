import { h, clear, kv, pill, hashEl, fmtInt, input, field, confirmModal, inspectBtn, seg } from '../dom.js';
import { get, post, store, site } from '../api.js';
import { run, sheet } from '../flows.js';
import { pagedTable } from '../paged.js';
import { assetName, inflightNote, inflightTxid } from '../words.js';
import { tap, legacyDeployPaymentText } from '../money.js';
import { TapWalletMint, EthereumMint, BrowserMintJournal } from './wallet.js';
import { walletError } from '../wallet-errors.js';

const LABELS = { awaiting_payment: 'Awaiting payment', partly_paid: 'Partly paid', paid: 'Payment confirmed', permit_issued: 'Permit ready — you can inscribe', minted: 'Minted on Bitcoin', expired: 'Expired before payment' };
const publicId = result => result?.requestId ?? result?.request?.requestId ?? result?.request?.id;
const readStatus = id => get(`/gateway/mint/${id}`);
// A broadcast is reported so the gateway can check it on Bitcoin and show it to every viewer.
const reportInflight = value => post('/gateway/mint/inflight', value).catch(() => null);
const savedKey = () => `dmw-player-mints/${store.player?.address ?? ''}`;
const intentKey = () => savedKey() + '/quote-intents';
export function savedMintIntents() {
  try { return Object.values(JSON.parse(localStorage.getItem(intentKey()) ?? '{}')); } catch { return []; }
}
function saveIntent(intent, remove = false) {
  const pending = JSON.parse(localStorage.getItem(intentKey()) ?? '{}');
  if (remove) delete pending[intent.actionId]; else pending[intent.actionId] = intent;
  localStorage.setItem(intentKey(), JSON.stringify(pending));
}
function remember(id) {
  const previous = JSON.parse(localStorage.getItem(savedKey()) ?? '[]');
  localStorage.setItem(savedKey(), JSON.stringify([...new Set([id, ...previous])].slice(0, 100)));
}
export function savedMintRequests() {
  try { return JSON.parse(localStorage.getItem(savedKey()) ?? '[]').filter(id => /^[0-9a-f]{64}$/.test(id)); } catch { return []; }
}

export function playerMintFlow({ asset, block, amount, id, compound = false, resumeIntent } = {}) {
  const s = sheet('Mint from your wallet', 'Pay the fee items, wait for your permit, then inscribe to your Bitcoin address. You pay your own Bitcoin fees.');
  const network = site.public ? 'mainnet' : 'regtest';
  const wallet = new TapWalletMint({ readStatus, network, readerPath: '/api/gateway/web-api/tap-reader', readPaymentPlan: id => get(`/gateway/web-api/mint/${id}`), notify: text => clear(note, text) });
  const ethereum = new EthereumMint({ readStatus, network, journal: new BrowserMintJournal(),
    readTarget: () => get('/gateway/web-api/target'), readPlan: id => get(`/gateway/web-api/mint/${id}`) });
  const intent = resumeIntent ?? { asset, block, amount, compound, actionId: `web-${crypto.randomUUID()}` };
  compound = intent.compound;
  let busy = false, timer, connected = false, status;
  const note = h('div.small', { role: 'status', 'aria-live': 'polite' });
  const setBusy = value => { busy = value; s.body.setAttribute('aria-busy', String(value)); for (const el of s.foot.querySelectorAll('button')) el.disabled = value; };
  const attempt = async fn => {
    if (busy) return; setBusy(true); clear(note, 'Working…');
    try { await fn(); } catch (error) { clear(note, h('div.note.bad', {}, walletError(error))); }
    finally { setBusy(false); }
  };
  const connect = async () => { if (!connected) { await wallet.connect(); connected = true; } };
  const button = (text, fn) => h('button.btn.primary', { onclick: () => attempt(fn) }, text);
  const refresh = async () => {
    if (!id) return;
    status = await wallet.status(id); render();
  };
  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!s.body.isConnected || status?.state === 'minted') return;
      if (!busy) try { await refresh(); } catch (error) { clear(note, 'Status unavailable. Keep this request ID and retry: ', walletError(error)); }
      poll();
    }, 3000);
  };
  const confirmFees = terms => confirmModal({ title: terms.resume ? 'Resume your inscription?' : 'Inscribe with your Bitcoin wallet?',
    lead: 'Your wallet funds the commit. This browser sends the reveal to your address. Keep this browser’s saved request until it is indexed.',
    rows: [['Bitcoin miner fees', `${terms.feeSats} sat`], ['Fee rate', `${terms.feeRate} sat/vB`], ['Postage kept with the inscription', `${terms.postage} sat`], ['Receiver', hashEl(terms.receiver)]], confirm: terms.resume ? 'Resume' : 'Inscribe' });
  function render() {
    const missing = status.missing ?? [], burn = status.payBy?.rail === 'tap' && missing.some(i => i.tt === 'b');
    clear(s.body, kv([
      ['Request', hashEl(id)], ['State', pill(LABELS[status.state] ?? String(status.state).replace(/_/g, ' '), status.state === 'minted' ? 'good' : 'warn')],
      ['Matter', `${assetName(status.asset)} · ${fmtInt(status.amount)} units`], ['Receiver', hashEl(status.receiver)],
      status.inscription ? ['Inscription', hashEl(status.inscription)] : null,
    ]), status.state === 'permit_issued' ? inflightNote(status.inflight) : null, missing.length ? h('div', {}, h('h3', {}, 'Still missing'),
      ...missing.map(item => h('p.small', {}, `${item.role}: ${tap(item.amount)} · `, item.tt === 'b' ? 'native burn' : hashEl(item.to)))) : h('p.small', {}, 'No missing fee items.'),
    status.reservation === 'pending' ? h('p.small', {}, 'Waiting for the unit reservation to be confirmed before payment.') : null,
    status.fullFees?.length > status.fees.length ? h('p.small', {}, 'Shares payable to your own wallet stay with you and are omitted from payment.') : null,
    burn ? h('div.note.bad', {}, 'The current TAP Wallet cannot execute the required native burn in this payment. Payment is stopped. The burn share will not be sent to an address.') : null,
    status.state === 'permit_issued' ? h('p.small', {}, 'Your Trac units have been consumed. Your receiver-bound permit has no expiry; you can inscribe when you are ready.') : null,
    h('p.small.muted', {}, 'Payments go to the quoted recipients before the permit. We do not refund them. Ethereum payers also need a Bitcoin wallet and BTC to inscribe.' + legacyDeployPaymentText(status)),
    note, inspectBtn('Mint request', status));
    const actions = [h('button.btn.ghost', { onclick: s.close }, 'Close'), h('button.btn', { onclick: () => attempt(refresh) }, 'Refresh')];
    if (['awaiting_payment', 'partly_paid'].includes(status.state) && status.payable !== false && !burn && status.payBy?.rail === 'tap') actions.push(button('Pay missing items', async () => {
      await connect();
      if (!await confirmModal({ title: 'Pay these missing fee items?', lead: 'Your TAP Wallet pays each recipient now. Payment happens before your mint permit is issued.',
        rows: missing.map(i => [i.role, tap(i.amount)]), confirm: 'Pay from my wallet' })) return;
      let result = await wallet.pay(id);
      if (result.retryable && await confirmModal({ title: 'Retry the payment?', lead: 'TAP Wallet returned no receipt for the last attempt. Retry only if your wallet shows no sent payment for this request.',
        rows: missing.map(i => [i.role, tap(i.amount)]), confirm: 'Retry payment' })) result = await wallet.pay(id, { retry: true });
      await refresh(); clear(note, result.message ?? 'Payment requested. Waiting for the indexed block.');
    }));
    if (['awaiting_payment', 'partly_paid'].includes(status.state) && status.payable && status.payBy?.rail === 'ethereum') actions.push(button('Pay with Ethereum wallet', async () => {
      const plan = await get(`/gateway/web-api/mint/${id}`); await ethereum.connect(plan.payer);
      if (!await confirmModal({ title: 'Deposit bridged TAP?', lead: 'Your wallet approves the quoted amount, then deposits it into the escrow. You pay Ethereum gas and still need BTC for the mint inscription.',
        rows: [['Amount', tap(plan.payableAmount).replace(' TAP', ' bridged TAP')], ['Escrow', hashEl(plan.target.ethereum.escrow)]], confirm: 'Approve and deposit' })) return;
      const result = await ethereum.pay(id); await refresh(); clear(note, result.sent === false ? 'A deposit is already pending. Waiting for confirmation.' : 'Deposit submitted. Wait for the committee release.');
    }));
    if (status.ethereumRelease && !['permit_issued', 'minted'].includes(status.state)) actions.push(button('Release Ethereum payment', async () => {
      const plan = await get(`/gateway/web-api/mint/${id}`); await ethereum.connect(plan.payer);
      if (!await confirmModal({ title: 'Release the escrow payment?', lead: 'The committee has authorized this split. Your wallet submits the release and pays its gas.', rows: [['Request', hashEl(id)]], confirm: 'Release from my wallet' })) return;
      await ethereum.release(id); await refresh(); clear(note, 'Release submitted. Waiting for final payment and your mint permit.');
    }));
    if (status.state === 'permit_issued' && !inflightTxid(status.inflight)) actions.push(button('Inscribe mint', async () => {
      await connect();
      const result = await wallet.inscribe(id, { maxFeeSats: '1000000', confirm: confirmFees });
      if (result.state === 'broadcast') await reportInflight({ kind: 'mint', ref: id, phase: 'mint', attempt: 0, commitTxid: result.commitTxid, revealTxid: result.revealTxid, inscriptionId: result.inscriptionId });
      await refresh();
      clear(note, result.state === 'broadcast' ? 'Inscription broadcast. Waiting for the indexer to show it as minted.' : 'No new transaction was sent.');
    }));
    clear(s.foot, ...actions);
    setBusy(busy);
    poll();
  }
  const deployReceiptKey = job => `${savedKey()}/deployment/${intent.asset}/${job.phase}/${job.phase === 'element' ? job.elementAttempt : job.tickerAttempt}`;
  const deployReview = job => {
    let receipt; try { receipt = JSON.parse(localStorage.getItem(deployReceiptKey(job)) ?? 'null'); } catch {}
    if (receipt && job.state === 'awaiting_player_deploy' && job.inflight?.inscriptionId !== receipt.inscriptionId && /^[0-9a-f]{64}i0$/.test(receipt.inscriptionId ?? ''))
      void reportInflight({ kind: 'deployment', ref: intent.asset, phase: job.phase, attempt: job.phase === 'element' ? job.elementAttempt : job.tickerAttempt, revealTxid: receipt.inscriptionId.slice(0, 64), inscriptionId: receipt.inscriptionId });
    const firstMaker = job.kind === 'dmt' || job.definition?.firstMaker === store.player?.address;
    const inflight = job.state === 'awaiting_player_deploy' && job.inflight?.phase === job.phase && inflightTxid(job.inflight) ? job.inflight : null;
    clear(s.body, seg([['tap', 'TAP on Bitcoin'], ['ethereum', 'Bridged TAP on Ethereum']], intent.kind ?? 'tap', kind => { if (intent.receiver) return; intent.kind = kind; review(); }), kv([['Matter', assetName(intent.asset)], ['Deployment', String(job.state).replace(/_/g, ' ')], [job.kind === 'dmt' ? 'Phase' : 'First maker', job.kind === 'dmt' ? job.phase : hashEl(job.definition?.firstMaker)]]),
      h('p.small', {}, 'The first minter pays for the pattern’s element and deployment. Each phase is ready once its inscription is included in a block. Compounds are deployed by their first maker.'),
      !firstMaker ? h('p.small', {}, 'Wait for the first maker to deploy this compound.') : null, inflightNote(inflight),
      receipt ? h('div', {}, h('p.small', {}, 'Deployment broadcast. Once it is included in a Bitcoin block, register this same inscription here:'),
        h('pre', {}, JSON.stringify({ asset: intent.asset, phase: job.phase, inscription: receipt.inscriptionId }, null, 2)),
        h('p.small', {}, 'Keep this receipt. Registration can be retried without another inscription.')) : null,
      note, inspectBtn('Deployment content', job));
    const actions = [h('button.btn.ghost', { onclick: s.close }, 'Close'), button('Check registration', quote)];
    if (firstMaker && receipt) actions.push(button('Register deployment', async () => {
      await post('/gateway/mint/deployment', { asset: intent.asset, phase: job.phase, inscription: receipt.inscriptionId });
      await quote();
    }));
    if (firstMaker && job.state === 'awaiting_player_deploy' && (receipt || !inflight)) actions.push(button(receipt ? 'Resume deployment' : job.phase === 'element' ? 'Inscribe pattern element' : job.kind === 'dmt' ? 'Inscribe pattern deploy' : 'Inscribe compound deploy', async () => {
      await connect();
      const binding = await get(`/gateway/payout-bindings/${encodeURIComponent(store.player.address)}/tap`);
      const fresh = await get(`/gateway/mint/deployment/${intent.asset}`);
      const result = await wallet.inscribeDeployment(fresh, { owner: store.player.address, binding: binding.binding, maxFeeSats: '1000000', confirm: confirmFees });
      if (result.state === 'broadcast') {
        localStorage.setItem(deployReceiptKey(fresh), JSON.stringify({ inscriptionId: result.inscriptionId }));
        await reportInflight({ kind: 'deployment', ref: intent.asset, phase: fresh.phase, attempt: fresh.phase === 'element' ? fresh.elementAttempt : fresh.tickerAttempt,
          commitTxid: result.commitTxid, revealTxid: result.revealTxid, inscriptionId: result.inscriptionId });
      }
      deployReview(fresh);
    }));
    clear(s.foot, ...actions); setBusy(busy);
  };
  const quote = async () => {
    await connect();
    {
      const job = await get(`/gateway/mint/deployment/${intent.asset}`);
      if (job.state !== 'registered') { deployReview(job); return; }
    }
    const kind = intent.kind ?? 'tap';
    const payer = kind === 'ethereum' ? (await ethereum.connect(intent.payer)).address : wallet.address;
    if (intent.receiver && intent.receiver !== wallet.address) throw Error('Reconnect the wallet saved with this quote intent.');
    Object.assign(intent, { receiver: wallet.address, payer, kind });
    saveIntent(intent);
    const args = { ...intent };
    const result = await run('Reserve mint and quote fees', compound ? '/player/compound/mint' : '/player/mint', args);
    id = publicId(result);
    if (!/^[0-9a-f]{64}$/.test(id)) throw Error('The gateway did not return a player-paid mint request. Keep the action ID and check the gateway version.');
    remember(id); saveIntent(intent, true); await refresh();
  };
  const review = () => {
    clear(s.body, seg([['tap', 'TAP on Bitcoin'], ['ethereum', 'Bridged TAP on Ethereum']], intent.kind ?? 'tap', kind => { if (intent.receiver) return; intent.kind = kind; review(); }), kv([['Matter', assetName(intent.asset)], ['Units', fmtInt(intent.amount)], ...(compound ? [] : [['Block', fmtInt(intent.block)]])]),
      h('p.small', {}, 'Before your first quote, bind a payout wallet using bind_payout_wallet in the kit and complete its wallet signature.'),
      h('p.small', {}, 'Getting a quote reserves your units. Review the recipients before approving payment in your TAP Wallet.'), note);
    clear(s.foot, h('button.btn.ghost', { onclick: s.close }, 'Cancel'), button('Connect wallet and get quote', quote));
  };
  if (id) { remember(id); attempt(refresh); return; }
  if (resumeIntent) { review(); return; }
  if (compound) {
    const units = input({ value: String(amount ?? '1'), inputmode: 'numeric', 'aria-label': 'Compound units' });
    clear(s.body, field('Units to inscribe', units), note);
    clear(s.foot, button('Review', async () => {
      if (!/^[1-9][0-9]*$/.test(units.value)) throw Error('Enter a positive whole number of units.');
      intent.amount = units.value; review();
    })); return;
  }
  if (asset && block !== undefined && block !== null) { review(); return; }
  const list = pagedTable({ path: '/player/mintRights', key: 'mintRights', limit: 15,
    filters: [{ name: 'whoMayMint', label: 'Show', value: '', options: [['', 'All slots'], ['me', 'Ready to mint']] }],
    sorts: [['block:desc', 'Newest block'], ['block:asc', 'Oldest block']], empty: 'Win and settle a find before minting.',
    columns: [{ key: 'asset', label: 'Matter', render: r => assetName(r.asset) }, { key: 'block', label: 'Block', num: true }, { key: 'amount', label: 'Units', num: true },
      { key: 'choose', label: '', render: r => (r.allowed || r.rightAllowed && r.reason === 'asset_unregistered' && BigInt(r.balance ?? '0') >= BigInt(r.amount)) && !r.minted && !r.pending && (!asset || r.asset === asset) ? h('button.btn.sm', { onclick: () => { Object.assign(intent, { asset: r.asset, block: r.block, amount: r.amount }); review(); } }, 'Choose') : null }] });
  clear(s.body, list.el, note);
}
export const playerCompoundMintFlow = asset => playerMintFlow({ asset, compound: true });
