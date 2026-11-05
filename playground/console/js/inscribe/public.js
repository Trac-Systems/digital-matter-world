import { h, clear, kv, hashEl, pill, confirmModal, fmtInt, input, field, panel, table, stepper } from '../dom.js';
import { tap } from '../money.js';
import { TapWalletMint, EthereumMint, BrowserMintJournal, tapWalletCapabilities, discovererOnly } from './wallet.js';
import { walletError, knownReason, publicOpeningLabel, PAY_SOON, BEFORE_PAY, windowShort, payWithin, bitcoinTip, creditedAmount } from '../wallet-errors.js';
import { PAYMENT_STATE, assetName, rememberCompound, inflightNote, inflightLine, inflightTxid, addressLink, agentLink, assetLink, blockLink, setEthereumChain } from '../words.js';
import { validateTracAddress } from '../../../../rules/src/trac-address.js';
import { rememberRequester, requesterHeaders } from '../requester-storage.js';
import { compoundTickerMessage } from '../../../../rules/src/ticker-grammar.js';
import { officialTickerForm } from '../tickers.js';

// Protocol responses must retain chain/network fields; the display-only public
// read adapter deliberately strips those and cannot be used for wallet signing.
async function api(path, body) {
  const response = await fetch(path, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { accept: 'application/json', ...requesterHeaders(path, body), ...(body ? { 'content-type': 'application/json' } : {}) }, credentials: 'same-origin' });
  // A proxy timeout returns an empty body; report it as an unfinished request, not a JSON error.
  const result = await response.json().catch(() => ({ error: 'request_failed' }));
  if (!response.ok) throw Error(result.error ?? 'request_failed');
  rememberRequester(result);
  return result;
}
const STOPPED = /^(?:expired|cancelled|rejected|refundable|refund_\w+|unpaid_expired|quarantined|recovery|failed)$/;
// One approval (TAP Wallet 1.0.49): the payment sets aside Bitcoin and the server sends the mint.
const SENDER_STATES = ['waiting_funding', 'funded', 'sending', 'sent', 'minted', 'needs_user', 'returning', 'returned'];
// The server will not send: the person inscribes with their own wallet, as without a set-aside.
const SENDER_STOPPED = ['needs_user', 'returning', 'returned'];
export const PAID_ONCE = 'Paid. Your mint goes out automatically when the permit arrives. You can close this page.';
export const NEEDS_USER = 'Bitcoin fees rose above the Bitcoin your payment set aside, so our server cannot send your mint. Inscribe it from your TAP Wallet; the Bitcoin set aside is sent back to you.';
const txid = value => /^[0-9a-f]{64}$/.test(value ?? '') ? value : null;
const txLink = (value, label = value) => h('a.mono', { href: 'https://mempool.space/tx/' + value, target: '_blank', rel: 'noreferrer noopener' }, label);
export function refundStatus(record) {
  const delivery = record?.refundDelivery;
  if (['refund_sent', 'refund_confirmed'].includes(delivery?.state) && txid(delivery.revealTxid))
    return h('span', {}, 'Refund sent: ', txLink(delivery.revealTxid));
  if (delivery?.state === 'refund_waiting_funds') return 'Refund waiting for operator funds';
  if (delivery?.state === 'refund_needs_operator') return 'Refund waiting for operator action';
  return 'Refund pending';
}
const sats = n => `${fmtInt(n)} sats`;
// Where a fee credit came from: the request or bulk order whose payment arrived after it expired.
export function creditOrigin(credit) {
  const request = credit?.origin?.requestId, order = credit?.origin?.orderId;
  if (/^[0-9a-f]{64}$/.test(order ?? '')) return h('a', { href: '/mint/bulk/' + order }, 'Bulk order ', h('span.mono', {}, order.slice(0, 8)));
  if (/^[0-9a-f]{64}$/.test(request ?? '')) return h('a', { href: '/mint/' + request }, 'Mint request ', h('span.mono', {}, request.slice(0, 8)));
  return h('span.muted', {}, 'An earlier payment');
}
// The agent dashboard's My agent page, opened on the claimed blocks of this pattern.
const myAgentHref = asset => '/me' + (asset ? '?' + new URLSearchParams({ pattern: asset }) : '');
const setAside = status => Number.isSafeInteger(status?.mintFunding?.satoshis) ? status.mintFunding : null;
// Payment timing from a newer gateway (null from an older one): decimal block heights as strings.
const paymentTiming = status => status?.paymentTiming && typeof status.paymentTiming === 'object' ? status.paymentTiming : null;
const blockNumber = value => /^(0|[1-9][0-9]*)$/.test(String(value ?? '')) ? Number(value).toLocaleString('en-US') : null;
const sender = status => SENDER_STATES.includes(status?.mintSender?.state) ? status.mintSender : null;
// The server-sent mint in plain words: payment confirmed → permit → mint sent → minted.
function senderSteps(status, ms) {
  // A payment sent in time and still confirming (confirming_payment, paymentTiming.held) is not paid yet.
  const confirming = ['confirming_payment', 'late_payment_minting'].includes(status.state) || status.paymentTiming?.held === true;
  const paid = !confirming && (!['awaiting_payment', 'partly_paid'].includes(status.state) || ms.state !== 'waiting_funding');
  const permit = ['permit_issued', 'minted'].includes(status.state);
  const commit = txid(ms.commitTxid), reveal = txid(ms.revealTxid), minted = status.state === 'minted' || ms.state === 'minted';
  const inscription = /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(ms.inscriptionId ?? '') ? ms.inscriptionId : reveal ? reveal + 'i0' : null;
  const now = text => h('span', {}, h('strong', {}, 'Now: '), text), done = (...text) => h('span', {}, h('strong', {}, 'Done: '), ...text);
  return kv([
    ['Payment', paid ? done('your payment confirmed on Bitcoin.') : now('waiting for your payment to confirm on Bitcoin.')],
    ['Permit', permit ? done('the permit is issued.') : paid ? now('waiting for the permit (next batch).') : 'After the payment confirms.'],
    ['Mint', commit || reveal ? done('sent. ', commit ? ['Commit ', txLink(commit, commit.slice(0, 12) + '…'), ' '] : null, reveal ? ['Reveal ', txLink(reveal, reveal.slice(0, 12) + '…')] : null)
      : ms.state === 'sending' ? now('our server is sending your mint inscription.') : 'Sent by our server when the permit arrives.'],
    ['Minted', minted ? done(inscription ? ['inscription ', hashEl(inscription)] : 'the tokens are in your TAP Wallet.') : reveal ? now('waiting for Bitcoin to confirm the mint.') : 'When Bitcoin confirms the mint.'],
  ]);
}
// A catalog/ledger asset link handles first deployment before a signed mint
// request exists. Request links retain the payment and permanent-permit flow.
export function mount(root, { id, onPublicMint }) {
  const assetPage = /^(?:[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/.test(id);
  // A v2 compound has no pattern to inscribe: its first maker deploys the token, then holders make units real.
  const compound = /^c2:[0-9a-f]{64}$/.test(id);
  const params = new URLSearchParams(location.search);
  const publicMode = assetPage && params.get('public') === '1';
  const publicBlock = publicMode ? params.get('block') : null;
  const publicAddress = publicBlock !== null ? params.get('tapAddress') : null;
  // One flow layout: the step indicator, the next step (status, the primary action) and the request details beside it.
  const progress = h('div'), lead = h('div.section-gap'), body = h('div.stack'), side = h('div.stack');
  const actions = h('div.row.actions'), extra = h('div.extra'), note = h('div.callout', { role: 'status', 'aria-live': 'polite' });
  // Progress and errors show in the callout by the action buttons: busy while working, red on failure.
  const say = (text, kind = '') => { note.className = 'callout' + (kind ? ' ' + kind : ''); clear(note, text); };
  const intro = h('p.lead-text', {}, compound ? 'This compound has no token on Bitcoin yet. Its first maker chooses its ticker and deploys its token, once, from their own TAP Wallet. After that, holders make their units real from My agent.' : assetPage ? 'This pattern has no token on Bitcoin yet. Whoever mints it first inscribes the pattern and deploys its token, once, from their own TAP Wallet. After that, every mint of it works the normal way.' : 'Pay the fee items first. Once payment is final, your permanent permit is ready. You pay the Bitcoin inscription fees, including when paying with Ethereum.');
  const initialIntro = intro.textContent;
  clear(root, h('div.page', {}, h('div.page-head', {}, h('h1', {}, 'Mint from your wallet')),
    intro, h('div.flow', {}, progress, h('div.grid.cols-main', {},
      h('div.stack', {}, h('section.panel.next-step', {}, h('header', {}, h('h2', {}, 'Next step')), h('div.body', {}, lead, note, actions, extra)), body), side))));
  let stopped = false, busy = false, timer, status, target, wallet, ethereum, publicRequest, paymentDraft = '';
  // The agent dashboard shows this page too: its agent can use a matching fee credit for this request.
  const agentHere = globalThis.DMW_LOCAL_AGENT === true;
  // shortWindow: the wallet refused to start a payment with fewer than 2 blocks left.
  let shortWindow = false, offerCache = { at: 0, value: null }, requestOwner;
  // A used credit counts with the next Trac batch; until the fees due change, Pay stays hidden so nothing is paid twice.
  const usedKey = 'dmw-credit-use/' + id;
  const usedCredit = () => { try { return JSON.parse(sessionStorage.getItem(usedKey) ?? 'null'); } catch { return null; } };
  const creditOffer = async () => {
    if (Date.now() - offerCache.at < 30000) return offerCache.value;
    let value = null;
    try {
      const href = (await api('/api/requests/' + id)).feeCredits?.href, found = [];
      // An agent with many credits: the matching one may sit on a later page.
      for (let page = 0, cursor = null; typeof href === 'string' && href.startsWith('/api/credits?') && page < 4; page++) {
        const result = await api(href + '&limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        found.push(...(result.credits ?? []));
        if (typeof result.next !== 'string' || !result.next) break;
        cursor = result.next;
      }
      value = found.filter(c => c.usable === true && c.state === 'available' && /^[1-9][0-9]*$/.test(c.matchingAmount ?? ''))
        .sort((a, b) => BigInt(b.matchingAmount) > BigInt(a.matchingAmount) ? 1 : BigInt(b.matchingAmount) < BigInt(a.matchingAmount) ? -1 : 0)[0] ?? null;
    } catch { value = null; }
    offerCache = { at: Date.now(), value };
    return value;
  };
  // A wallet payment is reported by its redeem inscription, found on Bitcoin.
  // paidHere: this page's wallet sent a payment; until the gateway sees it, the page says so instead of asking again.
  let reported = null, lastLookup = 0, paidHere = false, creditFailed = false, lastState = null;
  const reportPayment = async current => {
    if (Date.now() - lastLookup < 30000) return; lastLookup = Date.now();
    // This browser's saved payment first; otherwise the payment found on Bitcoin (paid from another browser).
    const paymentId = reported ?? await wallet.paymentInscription(id, current.payer ?? current.receiver).catch(() => null)
      ?? await findPayment(id, current.payer ?? current.receiver, { network: wallet.network, paymentData: current.fees?.map(fee => fee.dta) }).catch(() => null);
    if (!paymentId) return;
    // Seen on Bitcoin by the gateway, the sent payment shows to every viewer until it is counted.
    if (/^[0-9a-f]{64}i0$/.test(paymentId)) void reportInflight({ kind: 'mint', ref: id, phase: 'payment', attempt: 0, revealTxid: paymentId.slice(0, 64), inscriptionId: paymentId },
      current.inflight?.phase === 'payment' ? current.inflight : null).then(result => { if (result?.inflight && !stopped && !busy) return refresh(); }).catch(() => {});
    try { await api('/mint/payment', { id, paymentId }); }
    catch (error) { if (error.message !== 'financial_transition_pending') return; }
    // The outcome line names it from the request's state: counted, or a fee credit if the request expired first.
    reported = paymentId;
    if (!stopped && !busy) await refresh().catch(() => {});
  };
  // The gateway cannot read an inscription until it is in a block (and indexed).
  const notYet = error => ['deployment_confirmations', 'tap_quorum_unavailable', 'request_failed'].includes(error?.message);
  // The gateway answers request_pending when its inscription checks outlast the response budget; the work continues
  // there and the next status read shows the result, so this is progress, not a failure.
  const stillWorking = error => error?.message === 'request_pending';
  let registering = false, lastRegister = 0;
  // A sent inscription is reported to the gateway, which checks it on Bitcoin and shows it to every viewer.
  // A receipt saved before that existed, or whose report was lost, is reported again from this page.
  const inflightReports = new Map();
  const reportInflight = (value, shown) => {
    const key = `${value.kind}/${value.ref}/${value.phase}/${value.revealTxid}`;
    if (!inflightTxid(value) || shown?.revealTxid === value.revealTxid || Date.now() - (inflightReports.get(key) ?? 0) < 30000) return Promise.resolve(null);
    inflightReports.set(key, Date.now());
    return api('/mint/inflight', value).catch(() => null);
  };
  let owner = assetPage ? new URLSearchParams(location.search).get('owner') ?? '' : '';
  const journal = new BrowserMintJournal();
  const attempt = async (fn, clicked) => {
    if (busy || stopped) return; busy = true;
    for (const button of root.querySelectorAll('.next-step button')) button.disabled = true;
    clicked?.classList.add('busy');
    say('Working…', 'busy');
    try { await fn(); if (!stopped && note.textContent === 'Working…') say(''); }
    catch (error) {
      if (stopped) return;
      // Too little time left: the page itself explains it and offers a fresh request.
      if (windowShort(error) && status && !assetPage) { shortWindow = true; say(''); await refresh().catch(() => {}); }
      else say(walletError(error), 'bad');
    }
    finally { busy = false; clicked?.classList.remove('busy'); if (note.classList.contains('busy')) note.className = 'callout info'; for (const button of root.querySelectorAll('.next-step button')) button.disabled = false; }
  };
  // The step's main action is the large primary button; Refresh and side actions stay quiet.
  const button = (label, fn, kind = '') => h(`button.btn${kind === 'primary' ? '.primary.cta' : kind === 'quiet' ? '.ghost' : ''}`, { onclick: event => attempt(fn, event.currentTarget) }, label);
  const fill = (next, rest = []) => { clear(actions, ...next.filter(b => !b.classList?.contains('ghost')), ...next.filter(b => b.classList?.contains('ghost'))); clear(extra, ...rest); };
  const confirmFees = terms => confirmModal({ title: 'Inscribe with your Bitcoin wallet?',
    lead: 'Your wallet funds the commit and this browser sends the saved reveal. Keep this link to resume.',
    rows: [['Fee rate', `${terms.feeRate} sat/vB (mempool.space half-hour estimate)`], ['Miner fees', `${terms.feeSats} sat`], ['Postage', `${terms.postage} sat`], ['Receiver', hashEl(terms.receiver)]], confirm: terms.resume ? 'Resume' : 'Inscribe' });
  // A compound's official ticker is chosen by its first maker: in the agent dashboard their agent signs, on the
  // site the TAP Wallet bound to that agent signs. The form is kept across refreshes so typing is not lost.
  let tickerForm = null, tickerFormFor = null;
  const chooseTicker = async (job, tick) => {
    if (globalThis.DMW_LOCAL_AGENT === true) return api('/api/compound-ticker', { asset: job.asset, ticker: tick });
    validateTracAddress(owner);
    if (job.definition?.firstMaker !== owner) throw Error('Only this compound’s first maker sets its ticker. Enter the first maker’s agent address.');
    const binding = (await api(`/payout-bindings/${encodeURIComponent(owner)}/tap`)).binding;
    await wallet.connect();
    if (!binding?.request?.address || binding.request.address !== wallet.address) throw Error('Connect the TAP Wallet bound to the first maker’s agent.');
    const fresh = await api('/mint/deployment-state/' + job.asset);
    const revision = (fresh.chosenTicker?.revision ?? 0) + 1, expiry = Date.now() + 600000;
    const message = compoundTickerMessage({ network: fresh.network ?? target.network, asset: job.asset, ticker: tick, revision, expiry, firstMaker: owner });
    const walletSignature = await wallet.provider.signMessage(message, 'bip322-simple');
    return api('/mint/deployment-ticker', { asset: job.asset, ticker: tick, revision, expiry, walletSignature });
  };
  const renderDeployment = async job => {
    intro.hidden = false;
    const phase = job.phase, current = job.attempts?.find(a => a.phase === phase && a.attempt === (phase === 'element' ? job.elementAttempt : job.tickerAttempt));
    const receiptKey = current && `${target.network}/deployment-receipt/${job.asset}/${current.id}`;
    const receipt = receiptKey ? await journal.get(receiptKey) : null;
    if (stopped) return;
    const registered = job.state === 'registered', isPublic = publicMode || status?.publicMint === true;
    // Seen on Bitcoin by the gateway for this same phase and attempt: every viewer waits for it, nobody inscribes again.
    const inflight = !registered && job.state === 'awaiting_player_deploy' && job.inflight?.phase === phase && inflightTxid(job.inflight) ? job.inflight : null;
    if (receipt && current && job.state === 'awaiting_player_deploy' && !busy) void reportInflight({ kind: 'deployment', ref: job.asset, phase, attempt: current.attempt,
      revealTxid: receipt.inscriptionId.slice(0, 64), inscriptionId: receipt.inscriptionId }, inflight).then(result => { if (result?.inflight && !stopped && !busy) return refresh(); }).catch(() => {});
    // Who may deploy a pattern's token now: during its discoverer's week only the discoverer, after it anyone.
    const week = !compound && !registered && job.deployer?.onlyDiscoverer ? job.deployer : null;
    if (assetPage && !compound && !registered && job.deployer) intro.textContent = (week
      ? `This pattern has no token on Bitcoin yet. Until block ${week.until} only its discoverer can inscribe the pattern and deploy its token, once, from their own TAP Wallet. After that anyone can.`
      : 'This pattern has no token on Bitcoin yet. Whoever mints it first inscribes the pattern and deploys its token, once, from their own TAP Wallet.')
      + ' Whoever deploys holds the deploy inscription and can add art to it later. After that, every mint of it works the normal way.';
    // A sent inscription is registered by this page once it is in a block; until then the gateway cannot read it.
    const waiting = !registered && receipt, sent = waiting || inflight;
    if (waiting && !registering && Date.now() - lastRegister > 30000) {
      registering = true; lastRegister = Date.now();
      api('/mint/deployment', { asset: job.asset, phase, inscription: receipt.inscriptionId })
        .then(() => { if (!stopped) return refresh(); }, error => { if (!notYet(error) && !stillWorking(error)) say(walletError(error), 'bad'); })
        .finally(() => { registering = false; });
    }
    const waitText = 'Sent. Waiting for the next Bitcoin block (about 10 minutes). This page registers it automatically; keep it open or come back to this link.';
    // A compound's ticker: chosen (or changed) until its deploy is sent; until then there is nothing to deploy.
    const chosen = compound ? job.chosenTicker?.tick ?? null : null;
    const choosing = compound && !registered && !sent && ['not_started', 'queued', 'awaiting_ticker', 'awaiting_player_deploy'].includes(job.state) && !job.entry;
    const needsTicker = choosing && (job.state !== 'awaiting_player_deploy' || !chosen);
    // Steps: inscribe the pattern, deploy its token (each in its own Bitcoin block), then mint as usual.
    const at = registered ? 2 : job.elementId || phase === 'deployment' ? 1 : 0;
    clear(progress, compound ? stepper(['Choose ticker', 'Deploy token', 'Make real'], registered ? 2 : needsTicker ? 0 : 1) : stepper(['Inscribe pattern', 'Deploy token', isPublic ? 'Pay & mint' : 'Mint'], at));
    const done = text => h('span', {}, h('strong', {}, 'Done: '), text);
    clear(lead, registered ? h('p.lead', {}, h('strong', {}, 'The token is deployed. '), compound ? 'Make your units real from My agent → Your compounds.' : isPublic ? 'Continue to review the public mint fee and pay from your TAP Wallet.' : 'Ask your agent to mint now, then open the payment link it gives you.')
      : sent ? inflightNote(inflight ?? { phase, revealTxid: receipt.inscriptionId.slice(0, 64) }, { detail: waiting ? waitText : 'This page updates by itself once it is in a block.' }) : null);
    if (compound && job.definition && Array.isArray(job.definition.inputs)) rememberCompound({ ...job.definition, id: job.asset });
    clear(body, ...(compound ? [panel('Steps', h('ol.numbered', {},
        h('li', {}, h('span', {}, 'Connect TAP Wallet in the header. It must be the payout wallet linked to your agent, the compound’s first maker. Your agent’s address is filled in below.')),
        h('li', {}, h('span', {}, h('strong', {}, 'Choose its ticker. '), registered || sent ? done('the ticker is fixed.') : chosen ? ['Chosen: ', h('span.mono', {}, chosen), '. You can change it until the deploy is in a Bitcoin block.']
          : 'Only you, its first maker, choose the name of its TAP token. Your signature proves it is you.')),
        h('li', {}, h('span', {}, h('strong', {}, 'Deploy the token. '), registered ? done('the token is deployed.')
          : sent ? 'Sent. Waiting for the next Bitcoin block.' : 'Press “Deploy token” and approve it in TAP Wallet.')),
        h('li', {}, h('span', {}, 'Make units real: My agent → Your compounds → Make real on TAP. You pay the fee per mint from your TAP Wallet; the tokens arrive at your payout wallet.'))),
      ),
      h('p.small.muted', { style: { margin: 0 } }, 'The inscription costs only Bitcoin network fees; TAP Wallet shows them before you approve. You can close this page and open this same link again to continue.')] : [panel('Steps', h('ol.numbered', {},
        h('li', {}, h('span', {}, isPublic ? 'Connect the TAP Wallet receiving your public mint. No agent or payout binding is needed.' : 'Connect TAP Wallet in the header. It must be the payout wallet linked to your agent. Enter your agent’s address (trac1…) below.')),
        h('li', {}, h('span', {}, h('strong', {}, 'Inscribe the pattern. '), job.elementId ? done('the pattern is inscribed and in a block.')
          : sent && phase === 'element' ? 'Sent. Waiting for the next Bitcoin block.' : 'Press “Inscribe pattern” and approve it in TAP Wallet.')),
        h('li', {}, h('span', {}, h('strong', {}, 'Deploy the token. '), registered ? done('the token is deployed.')
          : sent && phase === 'deployment' ? 'Sent. Waiting for the next Bitcoin block.' : job.elementId ? 'Press “Deploy token” and approve it in TAP Wallet.' : 'Once the pattern is in a block, press “Deploy token” and approve it.')),
        h('li', {}, h('span', {}, isPublic ? 'Continue to payment after the token is deployed. Review the public mint quote, pay every fee in one TAP payment, then inscribe your permit. Nothing is reserved.' : 'Mint as usual: ask your agent to mint a block of this pattern. It reserves your units and gives you a payment link. Open it, pay the fee in TAP, then inscribe the mint. The tokens arrive in your TAP Wallet.'))),
      ),
      h('p.small.muted', { style: { margin: 0 } }, 'Each inscription costs only Bitcoin network fees; TAP Wallet shows them before you approve. You can close this page between steps: open this same link again to continue.'),
      registered ? null : h('p.small.muted', { style: { margin: 0 } }, 'The deploy inscription stays in the wallet that deploys. Its holder can add art to it later.')]));
    clear(side, panel(compound ? 'Compound' : 'Pattern', kv([compound ? ['Compound', assetName(job.asset)] : ['Pattern', job.displayLabel ?? job.asset], compound ? null : ['Asset', job.asset], ['Token', pill(registered ? 'deployed' : 'not deployed yet', registered ? 'good' : 'warn')],
      registered && job.entry?.tick ? ['Ticker', h('span.mono', {}, job.entry.tick)] : null,
      compound && !registered ? ['Ticker', chosen ? h('span.mono', {}, chosen) : 'not chosen yet'] : null,
      !compound && !registered && job.deployer ? ['Who can deploy', week ? `Only its discoverer, until block ${week.until}. After that, anyone.` : 'Anyone'] : null,
      week ? ['Discoverer', hashEl(week.discoverer)] : null,
      job.receiver ? ['Your wallet', hashEl(job.receiver)] : null, receipt ? ['Your inscription', hashEl(receipt.inscriptionId)] : inflight ? ['Inscription sent', inflightLine(inflight)] : null,
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
      catch (error) {
        if (notYet(error)) throw Error('Not in a Bitcoin block yet. This page keeps checking; nothing else to do.');
        if (stillWorking(error)) throw Error('Still checking the inscription. This page updates by itself in a few seconds.');
        throw error;
      }
      await refresh();
    }, 'primary'));
    if (needsTicker) lead.append(h('div.callout.info', {}, job.reason === 'ticker_occupied' ? 'The chosen ticker was taken on TAP before the deploy. Choose another one.' : 'Choose the ticker of its TAP token first.'));
    else if (job.state === 'queued') lead.append(h('div.callout.busy', {}, 'Preparing the inscription. This page updates by itself in a few seconds.'));
    else if (!registered && job.state !== 'awaiting_player_deploy') next.push(button('Start', async () => {
      await api('/mint/deployment', { asset: job.asset }); await refresh();
    }, 'primary'));
    if (job.state === 'awaiting_player_deploy' && !receipt && !inflight && !needsTicker) next.push(button(phase === 'element' ? 'Inscribe pattern' : 'Deploy token', async () => {
      let binding;
      if (!isPublic) {
        if (!assetPage) owner = (await api('/web-api/mint/' + id)).owner;
        validateTracAddress(owner);
        if (job.kind === 'compound' && job.definition?.firstMaker !== owner) throw Error('Only this compound’s first maker deploys its token. Enter the first maker’s agent address.');
        if (week && week.discoverer !== owner) throw Error(discovererOnly(week.until));
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
      await reportInflight({ kind: 'deployment', ref: job.asset, phase: result.phase, attempt: current.attempt, commitTxid: result.commitTxid, revealTxid: result.revealTxid, inscriptionId: result.inscriptionId });
      try { await api('/mint/deployment', { asset: job.asset, phase: result.phase, inscription: result.inscriptionId }); }
      catch (error) {
        await refresh();
        if (notYet(error) || stillWorking(error)) return;
        throw error;
      }
      await refresh();
    }, 'primary'));
    if (choosing) {
      if (!tickerForm || tickerFormFor !== chosen) {
        tickerFormFor = chosen;
        tickerForm = officialTickerForm({ current: chosen, choose: tick => chooseTicker(job, tick), onChosen: () => { tickerForm = null; return refresh(); } });
      }
      return fill(next, [tickerForm]);
    }
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
    if (['awaiting_payment', 'partly_paid', 'confirming_payment', 'scanning'].includes(status.state) && status.payBy?.rail === 'tap') void reportPayment(status);
    if (stopped) return;
    const funding = status.payBy?.rail === 'tap' ? setAside(status) : null, ms = sender(status), serverSends = !!(funding || ms) && !SENDER_STOPPED.includes(ms?.state);
    if (status.requesterRequired) intro.textContent = 'Open this request in the browser where you created it to review the block and pay. The block becomes public after the payment wins.';
    else if (status.publicMint) intro.textContent = 'Pay every quoted fee in one TAP payment. The first confirmed complete payment wins. No units are consumed. ' + (serverSends ? 'TAP Wallet asks once: our server sends your mint inscription when the permit is issued. If your payment does not win the block, your TAP is refunded automatically and the unused Bitcoin comes back to you.' : 'After your permanent permit is issued, inscribe the mint from your TAP Wallet.');
    else if (serverSends) intro.textContent = 'Pay the fee items. TAP Wallet asks once: the same payment sets aside the Bitcoin for your mint inscription, and our server sends the mint when your permanent permit is ready.';
    else intro.textContent = initialIntro;
    if (/^(?:[pc][0-9a-z]{1,23}|p2:(?:0|[1-9][0-9]*)|c2:[0-9a-f]{64})$/.test(status.asset)) {
      const deployment = await api('/mint/deployment-state/' + status.asset);
      if (deployment.state !== 'registered') return renderDeployment(deployment);
    }
    // A payment reported before the deadline holds the request until Bitcoin confirms it (paymentTiming.confirmByBlock):
    // the mint then continues by itself. late_payment_minting / latePayment.completes are older names for the same.
    const state = status.state, timing = paymentTiming(status);
    const confirming = !['paid', 'payment_confirmed', 'permit_issued', 'minted'].includes(state) && (state === 'confirming_payment' || state === 'late_payment_minting'
      || timing?.held === true && ['awaiting_payment', 'partly_paid'].includes(state) || status.latePayment?.completes === true);
    const failed = STOPPED.test(state) && !confirming, expired = state === 'expired' && !confirming, credit = expired ? creditedAmount(status) : null;
    // Expired with the payment being turned into a fee credit (newer gateways say credit_pending or creditRecovery).
    const creditPending = expired && !credit && (status.reason === 'credit_pending' || ['pending', 'queued'].includes(status.creditRecovery?.state));
    // A notice from an earlier state (a reported payment, a used credit) never stays next to a different outcome.
    if (lastState !== null && lastState !== state && !busy) say('');
    lastState = state;
    // The page's general how-to stays off a finished request; its outcome line says what happened.
    intro.hidden = failed || state === 'minted';
    const payingNow = ['awaiting_payment', 'partly_paid'].includes(state) && status.payable && !confirming;
    const tip = payingNow ? await bitcoinTip(target.bitcoinNetwork) : null;
    if (stopped) return;
    const left = tip !== null && /^(0|[1-9][0-9]*)$/.test(String(status.payBy?.untilBlock ?? '')) ? Number(status.payBy.untilBlock) - Number(tip) : null;
    // Fewer than 2 blocks left: the wallet does not start a payment; the page offers a fresh request instead.
    const tooLate = payingNow && (shortWindow || left !== null && left < 2);
    const used = usedCredit(), dueNow = status.missing.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString();
    if (used && (used.due !== dueNow || !payingNow)) { try { sessionStorage.removeItem(usedKey); } catch { /* private mode */ } }
    const creditCounting = used?.due === dueNow && payingNow;
    // A TAP payment the gateway has seen on Bitcoin for exactly these fees: every viewer waits for it, nobody pays again.
    const paymentSent = ['awaiting_payment', 'partly_paid'].includes(state) && status.inflight?.phase === 'payment' && inflightTxid(status.inflight) ? status.inflight : null;
    // Sent from this page or found on Bitcoin and reported, but not yet seen by the gateway.
    const paymentOut = ['awaiting_payment', 'partly_paid'].includes(state) && !paymentSent && (paidHere || !!reported);
    if (!payingNow) paidHere = false;
    const offer = payingNow && agentHere && !tooLate && !creditCounting && !paymentSent && !paymentOut && !creditFailed ? await creditOffer() : null;
    if (stopped) return;
    // On the site, a credit is named with the agent that made the request (and can use it).
    if (credit && !agentHere && !status.publicMint && requestOwner === undefined) requestOwner = await api('/web-api/mint/' + id).then(plan => plan.owner ?? null, () => null);
    if (stopped) return;
    // A payment still on its way after expiry becomes a fee credit once Bitcoin confirms it.
    const lateSent = expired && !credit && !creditPending && (status.inflight?.phase === 'payment' && inflightTxid(status.inflight) || reported || status.latePayment?.seen === true);
    const latePayment = lateSent && status.inflight?.phase === 'payment' && inflightTxid(status.inflight) ? status.inflight : null;
    // The mint inscription on its way: this browser's broadcast, the gateway's record of it, or the server's send.
    const local = state === 'permit_issued' ? await wallet.sentInscription(id, status.receiver).catch(() => null) : null;
    if (stopped) return;
    const shown = state === 'permit_issued' && inflightTxid(status.inflight) ? status.inflight : null;
    // This browser's broadcast, or a wallet-reported one, is checked on Bitcoin by the gateway so every viewer sees it.
    const reportable = local ?? (state === 'permit_issued' && /^[0-9a-f]{64}i0$/.test(status.sentInscription ?? '') ? { inscriptionId: status.sentInscription, revealTxid: status.sentInscription.slice(0, 64) } : null);
    if (reportable && !busy) void reportInflight({ kind: 'mint', ref: id, phase: 'mint', attempt: 0, ...(txid(reportable.commitTxid) ? { commitTxid: reportable.commitTxid } : {}),
      revealTxid: reportable.revealTxid, inscriptionId: reportable.inscriptionId }, shown).then(result => { if (result?.inflight && !stopped && !busy) return refresh(); }).catch(() => {});
    const sent = local ?? (shown ? { inscriptionId: shown.inscriptionId, revealTxid: shown.revealTxid } : null) ?? (state === 'permit_issued' && status.sentInscription ? { inscriptionId: status.sentInscription, revealTxid: status.sentInscription.slice(0, 64) } : null)
      ?? (state === 'permit_issued' && ms && !SENDER_STOPPED.includes(ms.state) && txid(ms.revealTxid) ? { inscriptionId: /^[0-9a-f]{64}i0$/.test(ms.inscriptionId ?? '') ? ms.inscriptionId : ms.revealTxid + 'i0', revealTxid: ms.revealTxid } : null);
    const needsUser = state === 'permit_issued' && ms && SENDER_STOPPED.includes(ms.state);
    // Steps: what the player does, and what then happens by itself. A finished or expired request shows how it ended.
    const yourPartDone = ['paid', 'payment_confirmed', 'permit_issued'].includes(state) || confirming || !!paymentSent || paymentOut;
    const [steps, at] = credit ? [['Request', 'Paid late', 'Fee credit'], 3]
      : creditPending ? [['Request', 'Paid late', 'Fee credit'], 2]
      : lateSent ? [['Request', 'Paid late', 'Becomes a fee credit'], 2]
      : failed ? [['Request', expired ? 'Expired' : 'Stopped'], 1]
      : serverSends && !needsUser ? [['You: sign & pay', 'Automatic: permit & mint', 'Minted'], state === 'minted' ? 3 : yourPartDone ? 1 : 0]
      : [['You: pay', 'Automatic: permit', 'You: inscribe', 'Minted'], state === 'minted' ? 4 : state === 'permit_issued' ? (sent ? 3 : 2) : yourPartDone ? 1 : 0];
    clear(progress, stepper(steps, at, { failed: failed && !lateSent && !creditPending }));
    const kind = state === 'minted' ? 'good' : credit || lateSent || creditPending ? 'warn' : failed ? 'bad' : payingNow && !paymentSent && !paymentOut ? 'warn' : 'info';
    const due = status.missing.reduce((sum, item) => sum + BigInt(item.amount), 0n);
    const freshHint = agentHere ? 'Once it expires, press Mint on the block in My agent for a fresh request.' : status.publicMint ? 'Once it expires, request the block again from Mint.' : 'Once it expires, the agent that made it can mint the block again for a fresh request.';
    const againHint = agentHere ? 'Mint the block again from My agent for a fresh request.' : status.publicMint ? 'Request the block again for a fresh request.' : 'The agent that made it can mint the block again from My agent for a fresh request.';
    const untilBlock = /^(0|[1-9][0-9]*)$/.test(String(status.payBy?.untilBlock ?? '')) ? Number(status.payBy.untilBlock).toLocaleString('en-US') : null;
    const confirmBy = blockNumber(timing?.confirmByBlock);
    const covers = offer ? BigInt(offer.matchingAmount) >= due : false, rest = offer && !covers ? due - BigInt(offer.matchingAmount) : null;
    const line = (kind, title, ...detail) => h('div.callout.' + kind, {}, h('strong', {}, title), ...detail);
    const words = state === 'not_yet_public' ? publicOpeningLabel(status) ?? 'not public yet' : (PAYMENT_STATE[state] ?? state.replace(/_/g, ' ')).toLowerCase();
    // One outcome, never two: what happened, what comes next and whether anything is left to do.
    const outcome = state === 'minted' ? line('good', 'Minted. ', 'Your tokens are in your TAP Wallet.', status.inscription ? h('div.small', {}, 'Inscription ', hashEl(status.inscription)) : null)
      : confirming ? line('info', 'Payment sent in time — waiting for Bitcoin. ', `Your mint continues once it confirms${confirmBy ? ` (by block ${confirmBy})` : ''}. Nothing to do; do not pay again.`,
        inflightTxid(status.inflight) && status.inflight.phase === 'payment' ? h('div.small', {}, inflightLine(status.inflight)) : null)
      : credit ? line('warn', 'Paid too late: your payment became a fee credit of ', h('strong.nowrap', {}, tap(credit)), h('strong', {}, '. '),
        'This request expired before Bitcoin confirmed your payment, so no mint was made from it. ',
        agentHere ? 'Your agent can use it for the fees of a new mint, such as this block minted again; you then pay only what it does not cover.'
          : status.publicMint ? 'No mint was made from it.'
          : ['It belongs to the agent that made this request', requestOwner ? [', ', agentLink(requestOwner)] : null, '. That agent uses it for a new mint from its own dashboard, under My agent.'])
      : creditPending ? line('warn', 'Your payment is being turned into a fee credit. ',
        'This request expired before Bitcoin confirmed your payment, so no mint was made from it. The credit shows here once it is ready. Nothing to do; do not pay again.')
      : lateSent ? line('warn', 'This request expired while your payment was still waiting for Bitcoin. ',
        'Once Bitcoin confirms it, it becomes a fee credit for a new mint and shows here. Nothing to do now; do not pay again.', latePayment ? h('div.small', {}, inflightLine(latePayment)) : null)
      : expired ? line('bad', status.reason === 'reservation_expired' ? 'This request expired before Trac reserved it. ' : 'This request expired before it was paid. ', 'Nothing was paid. ', againHint)
      : failed ? line('bad', 'This request has stopped. ', knownReason(status.reason) ?? `Its last state is “${words}”${status.reason ? ` (${status.reason})` : ''}. Nothing more happens on it.`)
      : tooLate && !paymentSent && !paymentOut ? line('warn', 'Too little time is left to pay. ',
        'Fewer than 2 Bitcoin blocks (about 20 minutes) remain, and a payment that confirms after this request expires only becomes a fee credit. Your wallet does not start it; nothing was paid. ', freshHint)
      : creditCounting ? line('info', 'Your fee credit is being used for this request. ', 'It counts with the next Trac batch, usually within a few minutes, and this page updates by itself. Do not pay these fees again.')
      : needsUser ? line('warn', 'Your mint needs one more approval. ', NEEDS_USER, typeof ms.message === 'string' && ms.message.length <= 200 ? h('div.small', {}, ms.message) : null)
      : sent ? inflightNote({ phase: 'mint', revealTxid: sent.revealTxid, confirmations: shown?.revealTxid === sent.revealTxid ? shown.confirmations : null },
        { detail: 'It completes by itself once Bitcoin confirms it, usually within about 10 minutes; nothing else to do.' })
      : state === 'permit_issued' && serverSends ? line('info', 'Your permit is ready; our server is sending your mint. ', 'Nothing to do; you can close this page.')
      : state === 'permit_issued' ? line('info', status.publicMint ? 'Your payment won and your permit is ready. ' : 'Your permanent permit is ready. ', 'Inscribe the mint from your TAP Wallet below when you like; the permit has no expiry.')
      : ['paid', 'payment_confirmed'].includes(state) ? line('info', 'Payment confirmed. ', 'Your permit comes with the next Trac batch, usually within a few minutes; ',
        serverSends ? 'then our server sends your mint. Nothing to do; you can close this page.' : 'then you inscribe the mint here.')
      // A newer gateway (paymentTiming) holds a payment sent in time until it confirms; an older one turned a late confirmation into a fee credit.
      : paymentSent ? inflightNote(paymentSent, { detail: `Usually about 10 minutes; longer when Bitcoin fees are high. ${untilBlock && !timing ? `If it confirms after block ${untilBlock}, it becomes a fee credit instead. ` : ''}Nothing to do; do not pay again.` })
      : paymentOut ? line('info', 'Your payment is sent. ', `It counts once Bitcoin confirms it, usually within about 10 minutes${serverSends ? '; then the rest happens by itself' : ''}. Nothing to do; do not pay again.`)
      : state === 'scanning' ? line('busy', 'Checking recent Bitcoin payments for this block. ', 'Nothing to do; this page updates by itself.')
      : BEFORE_PAY.includes(state) && !status.payable && !status.sentInscription ? h('div.callout.busy', {}, PAY_SOON)
      : payingNow && offer ? line('good', `You have a fee credit of ${tap(offer.matchingAmount)} from an earlier request. `, covers
        ? 'Use it: it pays the fees of this request, and nothing is paid from your wallet.' : `Use it first: then you pay only the remaining ${tap(rest.toString())} with your wallet.`,
        h('div.small', {}, 'From ', creditOrigin(offer)))
      : payingNow ? line('warn', state === 'partly_paid' ? 'Part of the fees is paid; the rest needs your payment. ' : 'Needs your payment. ',
        payWithin(status.payBy?.untilBlock, tip) ?? '', ' ', funding ? 'TAP Wallet asks once; your permit and your mint then follow by themselves.' : 'Your permit then follows by itself; then you inscribe the mint here.',
        // On the site the agent's fee credits are not visible; its dashboard shows them on this same page.
        !agentHere && !status.publicMint ? h('div.small', {}, 'Have a fee credit from an earlier request? Open this request from your agent’s dashboard (My agent) to use it before paying.') : null)
      : line('info', `This request is ${words}. `, 'This page updates by itself.');
    const asked = payingNow && !paymentSent && !paymentOut && !tooLate && !creditCounting;
    clear(lead, outcome, asked ? h('div', {}, h('div.small.muted', {}, 'Remaining to pay'), h('div.price', {}, tap(due.toString())),
      offer ? h('div.small.muted', { style: { marginTop: '4px' } }, 'After your fee credit: ', h('strong.nowrap', {}, rest !== null ? tap(rest.toString()) : 'nothing to pay')) : null) : null);
    // A stopped request has nothing left to pay: its fee table is not shown.
    const fees = status.missing.length && !failed ? table(status.missing, [
      { key: 'role', label: 'Fee', render: item => String(item.role).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) },
      { key: 'amount', label: 'Amount', num: true, render: item => h('span.mono', {}, tap(item.amount)) },
      { key: 'to', label: 'Paid to', render: item => addressLink(item.to) },
    ], { sortable: false }) : null;
    if (fees && status.missing.length > 1) fees.querySelector('tbody').append(h('tr.total', {}, h('td', {}, 'Total'), h('td.num', {}, h('span.mono', {}, tap(due.toString()))), h('td')));
    clear(body, fees ? panel(asked ? 'Remaining fees' : 'Fees of this request', fees, { flush: true }) : null, ms && !SENDER_STOPPED.includes(ms.state) && !failed ? panel('Your mint', senderSteps(status, ms), { flush: true }) : null);
    // The Bitcoin for the mint inscription, in one line: what it is for and where it is now.
    const aside = funding ?? (Number.isSafeInteger(ms?.satoshis) ? ms : null);
    const asideNow = ms?.state === 'returning' ? 'Being sent back to your wallet.'
      : ms?.state === 'returned' ? (txid(ms.returnTxid) ? h('span', {}, 'Sent back to your wallet: ', txLink(ms.returnTxid, ms.returnTxid.slice(0, 12) + '…')) : 'Sent back to your wallet.')
      : 'Returned to you after the mint, minus the Bitcoin network fee and the 546 sats that stay with the inscription.';
    const stateLabel = credit ? 'Paid late · fee credit' : creditPending ? 'Paid late · credit coming' : confirming ? 'Payment sent · confirming' : lateSent ? 'Expired · payment on its way'
      : expired ? 'Expired · nothing paid' : paymentSent || paymentOut ? 'Payment sent' : payingNow ? 'Waiting for your payment' : words.replace(/^./, c => c.toUpperCase());
    // Units reserved for an expired agent request go back to that agent; a public mint consumes none.
    const units = expired && !status.publicMint ? h('span', {}, fmtInt(status.amount), h('div.small.muted', {}, 'Reserved for this request, now back with the agent.')) : fmtInt(status.amount);
    clear(side, panel('Request', kv([['Request', hashEl(id)], ['State', pill(stateLabel, kind)],
      credit ? ['Fee credit', h('span', {}, h('span.mono', {}, tap(credit)), status.creditsCount > 1 ? h('div.small.muted', {}, `In ${fmtInt(status.creditsCount)} credits`) : null)] : null,
      payingNow && status.payBy?.untilBlock != null ? ['Pay by', h('span', {}, 'block ', blockLink(status.payBy.untilBlock))] : null, status.asset ? ['Pattern', assetLink(status.asset)] : null, status.block != null ? ['Block', blockLink(status.block)] : null,
      status.actualTicker ? ['Ticker', h('span.mono', {}, status.actualTicker)] : null, ['Receiver', addressLink(status.receiver)], ['Units', units],
      paymentSent ? ['Payment sent', inflightLine(paymentSent)] : latePayment ? ['Payment sent', inflightLine(latePayment)] : null,
      confirming && confirmBy ? ['Confirms by', h('span', {}, 'block ', blockLink(timing.confirmByBlock))] : null,
      aside && (!failed || ['returning', 'returned'].includes(ms?.state)) ? ['Bitcoin for the mint inscription', h('span', {}, sats(aside.satoshis), h('div.small.muted', {}, asideNow))] : null,
      status.publicMint && status.refunds?.length ? ['Refund', h('span', {}, status.refunds.flatMap((r, i) => [i ? ' · ' : '', refundStatus(r)]))] : null, status.publicMint && (status.reason || status.refunds?.[0]?.reason) ? ['Reason', walletError(status.reason ?? status.refunds[0].reason, status)] : null, status.inscription ? ['Inscription', hashEl(status.inscription)] : null]), { flush: true }));
    const next = [button('Refresh', refresh, 'quiet')], extraRows = [];
    // A credited or unpaid expiry, or too little time left: the next step is a fresh request of the block.
    const again = agentHere && !status.publicMint ? h('a.btn.primary.cta', { href: myAgentHref(status.asset) }, credit ? 'Use it for a new mint' : 'Mint again from My agent')
      : status.publicMint && status.asset && status.block != null ? h('a.btn.primary.cta', { href: '/mint?' + new URLSearchParams({ asset: status.asset, block: String(status.block) }) }, 'Request the block again') : null;
    if (again && (credit || expired && !lateSent && !creditPending || tooLate && !paymentSent && !paymentOut)) next.push(again);
    if (credit && agentHere) next.push(h('a.btn.ghost', { href: '/me#fee-credits' }, 'Your fee credits'));
    // A matching fee credit is the first path: Pay shows again (for what is left) once the credit counts.
    if (offer) next.push(button(`Use credit (${tap(offer.matchingAmount)})`, async () => {
      if (!await confirmModal({ title: 'Use your fee credit?', lead: (covers ? 'Your fee credit pays the remaining fees of this request. ' : `Your fee credit pays ${tap(offer.matchingAmount)} of the fees; pay the remaining ${tap(rest.toString())} with your wallet once it counts. `)
        + 'Nothing is paid from your wallet for this. It counts with the next Trac batch.', rows: [['Fee credit', tap(offer.matchingAmount)], ['From', creditOrigin(offer)]], confirm: 'Use credit' })) return;
      // The same action id for the same credit and request: a retry never spends twice.
      try { await api('/api/credits/use', { actionId: 'use-' + offer.id.slice(0, 24) + '-' + id.slice(0, 24), credit: offer.id, request: id }); }
      // The credit could not be used: Pay shows again so the request can still be paid.
      catch (error) { creditFailed = true; offerCache = { at: 0, value: null }; await refresh().catch(() => {}); throw error; }
      try { sessionStorage.setItem(usedKey, JSON.stringify({ due: dueNow })); } catch { /* private mode */ }
      offerCache = { at: 0, value: null };
      await refresh();
    }, 'primary'));
    if (asked && !offer) next.push(button(funding ? 'Pay and mint' : 'Pay missing items', async () => {
      // Every TAP Wallet action needs 1.0.49 or newer: checked before the confirmation and any other wallet call.
      if (status.payBy.rail === 'tap') await tapWalletCapabilities(globalThis.tapprotocol);
      const once = funding ? 'TAP Wallet asks once: the same payment sets aside the Bitcoin for your mint inscription, and our server sends the mint when the permit arrives. ' : '';
      if (!await confirmModal({ title: funding ? 'Pay and mint?' : 'Pay the remaining fees?', lead: once + (status.publicMint ? 'Pay every fee in one TAP payment. First confirmed complete payment wins. ' + (funding ? 'If your payment does not win the block, your TAP is refunded automatically and the unused Bitcoin comes back to you.' : 'If your payment does not win the block, your refund needs operator action because this payment has no Bitcoin set-aside.') : 'Your wallet pays the quoted recipients. We do not refund these payments.'),
        rows: [...status.missing.map(item => [item.role, tap(item.amount)]), funding ? ['Bitcoin for the mint inscription', sats(funding.satoshis)] : null].filter(Boolean), confirm: funding ? 'Pay and mint' : 'Pay from my wallet' })) return;
      if (status.payBy.rail === 'tap') {
        await wallet.connect(); let result = await wallet.pay(id);
        if (result.retryable && await confirmModal({ title: 'Retry the payment?', lead: 'TAP Wallet returned no receipt for the last attempt. Retry only if your wallet shows no sent payment for this request.', rows: status.missing.map(item => [item.role, tap(item.amount)]), confirm: 'Retry payment' })) result = await wallet.pay(id, { retry: true });
        if (result.localState === 'payment_pending') throw Error(result.message);
        lastLookup = 0;
        // The outcome line says the payment is sent; the gateway then shows it to every viewer.
        if (result.localState === 'payment_submitted' || result.mintFunded) paidHere = true;
      }
      else { const plan = await api('/web-api/mint/' + id); await ethereum.connect(plan.payer); await ethereum.pay(id); }
      await refresh();
    }, 'primary'));
    if (status.ethereumRelease && !['permit_issued', 'minted'].includes(status.state)) next.push(button('Release Ethereum payment', async () => {
      const plan = await api('/web-api/mint/' + id); await ethereum.connect(plan.payer);
      if (!await confirmModal({ title: 'Release Ethereum payment?', lead: 'Your wallet submits the committee-authorized release and pays gas.', rows: [['Request', hashEl(id)]], confirm: 'Release' })) return;
      await ethereum.release(id); await refresh();
    }, 'primary'));
    // With a set-aside the server sends the mint; Inscribe mint stays the fallback when it cannot (or never had one).
    if (status.state === 'permit_issued' && !sent && (!ms || SENDER_STOPPED.includes(ms.state))) next.push(button('Inscribe mint', async () => {
      await wallet.connect();
      const result = await wallet.inscribe(id, { maxFeeSats: '1000000', confirm: confirmFees });
      if (result.state === 'broadcast') {
        await api('/mint/payment', { id, inscription: result.inscriptionId });
        await reportInflight({ kind: 'mint', ref: id, phase: 'mint', attempt: 0, commitTxid: result.commitTxid, revealTxid: result.revealTxid, inscriptionId: result.inscriptionId });
      }
      await refresh();
    }, 'primary'));
    // A payment sent before expiry can still be reported; it then becomes a fee credit. A credited request needs nothing more.
    // Only while a payment could still be missing: an open request, or one that expired unpaid.
    if (status.payBy.rail === 'tap' && (payingNow || state === 'scanning' || expired && !credit && !creditPending) && !latePayment && !paymentSent && !confirming) {
      const paymentId = input({ value: paymentDraft, placeholder: 'Transaction ID followed by i0', 'aria-label': 'Payment inscription ID', oninput: event => { paymentDraft = event.target.value; } });
      extraRows.push(h('div.row', { style: { alignItems: 'flex-end' } }, h('div', { style: { flex: '1 1 260px' } }, field('Already paid? Report the redeem inscription ID shown by your wallet', paymentId)), button('Report payment', async () => {
        const value = paymentId.value.trim();
        if (!/^[0-9a-f]{64}i(?:0|[1-9][0-9]{0,9})$/.test(value)) throw Error('Enter the redeem inscription ID, including i0. A funding transaction ID is not an inscription ID.');
        await api('/mint/payment', { id, paymentId: value }); await refresh();
      })));
    }
    fill(next, extraRows);
  };
  const poll = () => { timer = setTimeout(async () => { if (stopped) return; if (!busy) try { await refresh(); } catch { say('Status unavailable. Refresh to retry.', 'warn'); } if (status?.state !== 'minted') poll(); }, 5000); };
  void attempt(async () => {
    target = await api('/web-api/target');
    if (!['mainnet', 'regtest'].includes(target.bitcoinNetwork)) throw Error('Invalid Bitcoin network');
    setEthereumChain(target.ethereum?.chainId);
    const options = { network: target.bitcoinNetwork, readStatus: () => api('/mint/' + id), readPaymentPlan: () => api('/web-api/mint/' + id) };
    wallet = new TapWalletMint({ ...options, journal, notify: text => say(text, busy ? 'busy' : 'info') });
    ethereum = new EthereumMint({ ...options, journal: new BrowserMintJournal(), readTarget: () => api('/web-api/target'), readPlan: () => api('/web-api/mint/' + id) });
    await refresh(); poll();
    // An installed TAP Wallet older than 1.0.49 is named up front; every wallet button checks again.
    if (globalThis.tapprotocol) await tapWalletCapabilities(globalThis.tapprotocol).catch(error => { if (!stopped) say(error.message, 'bad'); });
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
export async function findPayment(id, address, { network = 'mainnet', fetchImpl = globalThis.fetch, paymentData = [] } = {}) {
  if (!/^[0-9a-f]{64}$/.test(id ?? '') || !address || network === 'regtest') return null;
  const base = 'https://mempool.space' + (network === 'mainnet' ? '' : '/' + network) + '/api/address/' + encodeURIComponent(address) + '/txs';
  const response = await fetchImpl(base, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  const markers = [`dmw-pay-v2|${id}|`, ...paymentData.filter(data => typeof data === 'string' && data.startsWith('dmw-public-pay-v1|'))];
  for (const tx of await response.json()) {
    if (!tx.status?.confirmed) continue;
    const script = tx.vin?.[0]?.witness?.find(w => w.length > 200);
    if (script && markers.some(marker => scriptText(script).includes(marker))) return tx.txid + 'i0';
  }
  return null;
}
