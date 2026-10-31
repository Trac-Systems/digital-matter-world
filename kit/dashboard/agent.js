// "My agent": the local dashboard's one extra page inside the site. It uses the
// console's own components; payment and inscription continue on the site's
// /mint/<request> page with the header's TAP Wallet / MetaMask connection.
import { h, clear, panel, table, hashEl, pill, toast, figures, short, tabs, tierBadge, field, input, select, seg, copy, stepper, fmtInt } from '/web/console/js/dom.js';
import { isTracAddress } from '/rules/src/trac-address.js';
import { assetName, mineral } from '/web/console/js/words.js';
import { store, site } from '/web/console/js/api.js';
import { feePrice } from '/web/console/js/money.js';
import { tickerList, tickerChoice, deployTickerForm, whenTickers, SAME_REWARDS } from '/web/console/js/tickers.js';
// Request states before the wallet can pay: the row shows a spinner until Pay appears (the list refreshes every 15 s).
const BEFORE_PAY = ['requested', 'authorizing', 'reserving', 'enrolling', 'awaiting_payment', 'partly_paid'];
const PAY_SOON = 'Your request is being recorded on Trac. The Pay button appears here by itself, usually within a minute.';

async function api(path, body) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({ error: 'request_failed' }));
  if (!response.ok) throw Error(result.error === 'login_required' ? 'Open the private link printed by your local dashboard.' : result.error ?? 'request_failed');
  return result;
}
const words = value => String(value ?? '').replace(/_/g, ' ');
const localPath = href => { try { const url = new URL(href, location.href); return url.pathname + url.search; } catch { return null; } };
const STATE_KIND = { awaiting_payment: 'warn', partly_paid: 'warn', permit_issued: 'info', paid: 'info', minted: 'good', expired: 'bad', failed: 'bad' };
// A unit's key as a short detail: "#e9f0843e" for a compound, "#7" for pattern p2:7, imported keys as they are.
const unitKey = asset => /^c2:[0-9a-f]{64}$/.test(asset) ? '#' + asset.slice(3, 11) : /^p2:(0|[1-9][0-9]*)$/.test(asset) ? '#' + asset.slice(3) : asset;
// Every mention is a link to its page on the site: a pattern or compound, an agent (any trac1… address), a block, a batch.
const COMPOUND = /^c2:[0-9a-f]{64}$/;
// merged: older compound ids and the compound each became (from /api/info); an old id opens the compound it is now.
let merged = {};
const assetHref = asset => site.href('table', COMPOUND.test(asset) ? { c: merged[asset] ?? asset } : { p: asset });
// The site's own name when it knows the asset (plain names, merged compounds); else the server's.
const nameOf = (asset, name) => store.pattern(asset) || store.compound(asset) || !name ? assetName(asset) : name;
const assetLink = (asset, name) => h('a', { href: assetHref(asset) }, nameOf(asset, name));
// A compound's name is its recipe and can be long: it wraps inside its cell instead of pushing the columns aside.
const matter = (asset, name) => h(COMPOUND.test(asset) ? 'span' : 'span.nowrap', {}, h('span.swatch', { style: { background: mineral(asset) } }), assetLink(asset, name));
const agentLink = (address, label) => h('a.mono', { href: site.href('agents', { a: address }), title: address }, label ?? short(address));
const blockLink = block => h('a.mono', { href: site.href('world', { b: block }) }, String(block));
const batchLink = batch => h('a', { href: '/records/batches/' + batch }, 'batch ' + batch);
// Bitcoin addresses have no page on the site; they open on the explorer its transaction links use.
const EXPLORER = { mainnet: 'https://mempool.space', testnet: 'https://mempool.space/testnet', signet: 'https://mempool.space/signet' };
const addressLink = (address, network) => EXPLORER[network ?? 'mainnet']
  ? h('a.mono', { href: `${EXPLORER[network ?? 'mainnet']}/address/${address}`, target: '_blank', rel: 'noreferrer noopener', title: address }, short(address, 8, 6)) : hashEl(address);
// "2 Florite, 3 Nullspar fusion": amounts with linked names.
const assetList = (items, sep = ', ') => items.map((i, n) => [n ? sep : '', `${fmtInt(i.amount)} `, assetLink(i.asset, i.name)]);
const go = path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); };
// A pattern's token: deployed once (inscribe the pattern, then deploy the token) before anyone can mint it.
const TOKEN = { deployed: ['deployed', 'good'], inscribed: ['pattern inscribed', 'info'], not_deployed: ['not deployed', 'warn'], unknown: ['unknown', ''] };
const TOKEN_NOTE = { inscribed: 'Next: deploy the token.', not_deployed: 'Inscribe the pattern, then deploy its token.', unknown: 'Could not read the token state. Open the deployment page to check.' };
const countText = (n, more) => n === null || n === undefined ? '–' : fmtInt(n) + (more ? '+' : '');
// Send units on Trac: plain words for every check and every outcome.
const TRAC_NOTE = 'Units move on the Trac network to a trac1… address. This is not a Bitcoin or TAP token transfer and not an inscription; minted Bitcoin tokens are separate.';
const SEND_WORDS = {
  send_address: 'Not a valid Trac address. It starts with trac1; check that it was copied completely.',
  send_self: 'That is your own agent’s address.',
  send_unit_unknown: 'Your agent holds no units by that name. Use a name from the list.',
  send_unit_ambiguous: 'Two of your units have that name. Use the unit’s key shown under its name.',
  send_amount: 'Enter a whole number of units, 1 or more.',
  send_over_available: 'More than your agent has available of this unit (all rows together).',
  send_empty: 'Add at least one row.', send_too_many_rows: 'At most 200 rows in one send.', send_too_many_recipients: 'At most 50 recipients in one send.',
  send_rejected: 'The network did not accept this send. The units stay with your agent.',
  send_nothing_to_retry: 'Nothing left to retry in this send.',
  send_outcome_unknown: 'The gateway never answered and this send is too old to repeat. If the units are still with your agent after the next block, it did not arrive; ask your agent to reconcile it before sending again.',
  transfer_insufficient_units: 'Not enough units available. Units set aside for a mint request cannot be sent.',
  transfer_unknown_asset: 'This unit is not known on the network.',
  transfer_assets: 'Each unit may appear once, with a whole amount of 1 or more.',
  transfer_intent_stale: 'An earlier send changed your account first. Sign this one again; nothing was sent.',
  transfer_intent_expired: 'This signed send expired before it was sent. Sign it again; nothing was sent.',
  transfer_v2_unavailable: 'Sending units is not open on the network yet. The send is saved; retry later.',
  transfer_account_changed: 'Your account changed while signing. Retry.',
  compound_not_deployed: 'This compound’s TAP token is not deployed yet. Its first maker deploys it first.',
  compound_over_available: 'More units than your agent has available of this compound.',
  invalid_compound_mint: 'Enter a whole number of units, 1 or more.',
  saved_payout_changed: 'Your payout wallet changed after the earlier request was signed. Let that request expire, then make the units real again.',
  sender_rate: 'The gateway paces sends. The rest waits a moment and continues by itself.',
  next_batch_work_capacity: 'The next batch is full. The rest waits for the next Bitcoin block and is sent by itself.',
  next_batch_byte_capacity: 'The next batch is full. The rest waits for the next Bitcoin block and is sent by itself.',
  next_batch_account_capacity: 'The next batch is full. The rest waits for the next Bitcoin block and is sent by itself.',
};
// TNK: the Trac network's own coin. It pays the gas of paid Trac transactions
// and has real value; units are game matter and move for free.
const TNK_NOTE = 'Game moves and unit sends are free; TNK is only needed for paid Trac transactions.';
const TNK_WORDS = {
  tnk_invalid_address: 'Not a valid Trac address. It starts with trac1; check that it was copied completely.',
  tnk_invalid_amount: 'Enter an amount in TNK, like 1.25 (up to 18 decimals).',
  tnk_self: 'That is your own agent’s address.',
  tnk_insufficient: 'Not enough TNK for this amount plus the network fee.',
  tnk_validators: 'Waiting for the Trac network — try again in a minute.',
  tnk_fee_unavailable: 'The network fee is not readable yet. Try again in a minute.',
  tnk_balance_unavailable: 'Your TNK balance is not readable yet. Try again in a minute.',
  tnk_balance_changed: 'Your TNK balance or the fee changed while signing. Nothing was sent; ask your agent to check this send before a new one.',
  tnk_unknown_status: 'No clear answer from the Trac network yet. Retry sends the same signed transfer again; it cannot arrive twice.',
  tnk_interrupted: 'Signing was interrupted. Your agent never signs the same send twice, so nothing more happens here; check your TNK balance before a new send.',
  tnk_prepare_failed: 'Signing failed. Your agent keeps this send; ask your agent to check it before a new one.',
  tnk_unavailable: 'This agent cannot reach TNK. Start the dashboard with your agent’s player runtime.',
  tnk_action_conflict: 'This send was saved with other details. Start a new send.',
  tnk_packet: 'The saved transfer does not match. Nothing more is sent; ask your agent to check it.',
  tnk_signer: 'Your agent’s Trac wallet does not match this agent.',
  tnk_nothing_to_retry: 'Nothing to retry in this send.',
};
const sendWords = code => SEND_WORDS[code] ?? TNK_WORDS[code] ?? words(code);
const SEND_STATE = {
  waiting: ['waiting', ''], sending: ['sending…', 'info'], received: ['sent to the gateway', 'info'], confirmed: ['confirmed', 'good'],
  queued: ['next block', 'warn'], uncertain: ['unclear', 'warn'], failed: ['not sent', 'bad'], stale: ['sign again', 'warn'], replaced: ['signed again', ''],
};

// Craft: plain words for the recipe, the properties and every outcome.
const CRAFT_NOTE = 'Crafting combines units of your patterns into a new compound. It uses up the units you put in, is free, and happens with the next batch on Trac.';
const RECIPES = {
  fusion: ['Fusion', 'Melts any ingredients together into one compound.'],
  resonance: ['Resonance', 'Only for ingredients with the same charge. The result comes out rarer.'],
};
// A pattern's spectrum names the block header field it was found in; a compound keeps every field of its ingredients.
const SPECTRUM = [[1, 'block height'], [2, 'nonce'], [4, 'difficulty bits']];
const spectrumText = n => Number.isSafeInteger(n) ? SPECTRUM.filter(([bit]) => n & bit).map(([, w]) => w).join(' + ') || '–' : '–';
const softValue = text => h('span', { style: { font: '600 15px/1.35 var(--sans)' } }, text);
const generationText = g => g === undefined || g === null ? '–' : g === '0' ? '0 · a pattern' : `${g} · crafted`;
const CRAFT_WORDS = {
  craft_upgrade_pending: 'These units become craftable at the compound upgrade activation height.',
  craft_two_inputs: 'Choose at least two different ingredients.',
  craft_too_many_inputs: 'Too many ingredients for one craft.',
  craft_amount: 'Enter a whole number of units, 1 or more.',
  craft_over_available: 'More than your agent has available of this ingredient.',
  craft_unit_unknown: 'Your agent holds no craftable units of this kind.',
  craft_unavailable: 'Crafting is not open for this agent yet.',
  resonance_charge: 'Resonance needs ingredients with the same charge. Choose Fusion, or ingredients of equal charge.',
  compound_ratio: 'This mix is too uneven. Amounts are reduced to their simplest ratio (like 2 : 3), and that ratio may add up to at most 64. Equal amounts always work.',
  compound_input_unknown: 'One ingredient is not in the accepted catalog yet. Try again after the next batch.',
  craft_preview_proof: 'The preview did not check out against the accepted catalog. Nothing was signed; try again in a minute.',
  craft_preview_root: 'The preview did not check out against the accepted catalog. Nothing was signed; try again in a minute.',
  craft_preview_value: 'The preview did not check out against the accepted catalog. Nothing was signed; try again in a minute.',
  craft_inputs: 'Each ingredient may appear once, with 1 or more units.',
  craft_rejected: 'The network did not accept this craft. Your units stay with your agent.',
  craft_authorization: 'This signed craft expired before the network took it. Nothing was used; start a new craft.',
  craft_output: 'The ingredients changed before the network took this craft. Nothing was used; start a new craft.',
  craft_outcome_unknown: 'The gateway never answered and this craft is too old to repeat. If your units are unchanged after the next block, it did not happen; ask your agent to reconcile it.',
  craft_nothing_to_retry: 'Nothing left to retry in this craft.',
  craft_running: 'Your agent is already working on this.',
  insufficient_units: 'Not enough units available. Units set aside for a mint request cannot be crafted.',
};
const craftWords = code => CRAFT_WORDS[code] ?? sendWords(code);
const CRAFT_STATE = {
  waiting: ['waiting', ''], crafting: ['signing…', 'info'], received: ['sent', 'info'], confirmed: ['confirmed', 'good'],
  queued: ['next block', 'warn'], uncertain: ['unclear', 'warn'], failed: ['not crafted', 'bad'],
};
const CRAFT_STEPS = ['Signed', 'Sent to the gateway', 'Confirmed in a batch'];
// A craft's result: an existing compound links to its page; a new one has no page until the craft is confirmed.
const resultName = r => r.existing && COMPOUND.test(r.id ?? '') ? assetLink(r.id, r.label) : r.label;

export function mount(el) {
  let stopped = false, cursor, next, offset = 0, busy = false;
  // One status callout under the title: busy while loading or signing, red on failure.
  const note = h('div.callout', { role: 'status', 'aria-live': 'polite' });
  const say = (text, kind = 'info') => { note.className = 'callout ' + kind; note.textContent = text; };
  const profile = h('div.stack', { style: { gap: '10px' } }), claims = h('div.public-mints'), requests = h('div.public-mints'), pager = h('div.pager-foot');
  let page = 1, mintable = null, open = null, more = { claims: false, requests: false }, info = null;
  // claimAsset: the pattern filter above the claims table (the gateway's id for it); undefined shows all.
  let patterns = null, claimAsset;
  const patternList = h('div'), filter = h('div'), claimsPanel = h('div', { style: { scrollMarginTop: '72px' } });
  // Tickers of one pattern or compound, opened from its row: its tokens on TAP, the ticker its mints go to
  // and the way to deploy another. tickerPicks: the picked ticker per asset (Official unless picked).
  const tickerPicks = new Map(), patternTickers = h('div'), compoundTickers = h('div');
  let lastClaims = null;
  const choiceOf = asset => {
    if (!tickerPicks.has(asset)) tickerPicks.set(asset, tickerChoice(asset, { single: 'Official ticker. ' + SAME_REWARDS, onChange: () => { if (lastClaims) drawClaims(lastClaims); drawCompounds(); } }));
    return tickerPicks.get(asset);
  };
  const tickersButton = (asset, name, box, compound) => whenTickers(asset, h('button.btn.sm.ghost', { type: 'button', onclick: () => {
    const choice = choiceOf(asset);
    clear(box, h('div', { style: { borderTop: '1px solid var(--rule-2)' } },
      h('div.section-label', {}, assetLink(asset, name), ' · Tokens on TAP'), tickerList(asset, { label: false }),
      h('div.stack', { style: { gap: '12px', padding: '10px 14px 14px' } },
        h('div', {}, h('div.small.muted', { style: { marginBottom: '4px' } }, compound ? 'Make real into' : 'Mint into'), choice.el),
        deployTickerForm(asset, { compound, request: ticker => api('/api/deploy-ticker', { asset, ticker }), open: job => go(`/mint/${asset}?` + new URLSearchParams({ ticker: job.id })) }))));
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } }, 'Tickers'));
  const act = async (label, fn) => {
    if (busy) return; busy = true; if (label) say(label, 'busy');
    try { await fn(); if (label && note.textContent === label) clear(note); } catch (error) { say(sendWords(error.message), 'bad'); } finally { busy = false; }
  };
  // The clicked button and a toast both show progress; a mint takes seconds.
  const mint = (row, button) => act('', async () => {
    const label = `${nameOf(row.asset, row.name)} · block ${row.block}`;
    const status = toast({ what: 'Minting ' + label, detail: 'Your agent is signing the mint request…', state: 'queued' });
    const idle = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Signing…'; button.classList.add('busy'); }
    say(`Minting ${label}: your agent is signing the mint request…`, 'busy');
    let result;
    const deployment = tickerPicks.get(row.asset)?.value();
    try { result = await api('/api/mint', { asset: row.asset, block: row.block, ...(deployment ? { deployment } : {}) }); }
    catch (error) { status.set({ state: 'failed', detail: words(error.message) }); if (button) { button.disabled = false; button.textContent = idle; button.classList.remove('busy'); } throw error; }
    if (result.requestId) { status.set({ state: 'complete', detail: 'Request ready. Pay and inscribe with your wallet.' }); go('/mint/' + result.requestId); return; }
    status.set({ state: 'complete', detail: words(result.state ?? 'Request saved; it appears under Open requests.') });
    if (result.deploymentLink) { say('This pattern needs its first token deployment before it can be minted. Opening the deployment page.'); go(localPath(result.deploymentLink)); return; }
    say(words(result.state ?? 'Request is being prepared. It appears under Open requests.'));
    await load();
  });
  // Summary tiles: who the agent is, where its payouts go, and what waits on the pages shown below.
  const drawProfile = () => info && clear(profile,
    figures([
      ['Agent', h('a.mono', { href: site.href('agents', { a: info.address }), style: { fontSize: '15px' } }, short(info.address))],
      ['Payout TAP wallet', info.payoutAddress ? addressLink(info.payoutAddress, info.bitcoinNetwork) : pill('not bound', 'bad')],
      ['Ready to mint', mintable ?? '–', more.claims ? 'on this page; more on the next' : null],
      ['Open requests', open ?? '–', more.requests ? 'on this page; older ones follow' : null],
    ]),
    info.payoutAddress ? null : h('div.callout.bad', {}, 'No payout TAP wallet bound yet. Ask your agent to bind one before minting.'),
    h('p.muted', { style: { margin: 0 } }, 'Mint requests are signed here by your agent. You pay and inscribe on the request page with the wallet connected in the header (TAP Wallet, or MetaMask for bridged TAP).'));
  const drawClaims = data => {
    lastClaims = data; next = data.next; mintable = data.claims.filter(r => r.canMint).length; more.claims = !!next; drawProfile();
    clear(claims, data.claims.length ? table(data.claims, [
      { key: 'name', label: 'Pattern · block', render: r => h('div', {}, h('strong', {}, matter(r.asset, r.name)), h('div.small.muted', {}, 'block ', blockLink(r.block))) },
      { key: 'count', label: 'Units / balance', num: true, render: r => h('div', {}, h('span.mono', {}, `${fmtInt(r.count)} / ${fmtInt(r.balance)}`), r.balanceCurrent ? null : h('div.small.faint', {}, 'unverified')) },
      { key: 'state', label: 'Who may mint', render: r => h('div', {}, pill(words(r.eligibility ?? r.state), r.canMint ? 'good' : r.reason ? 'warn' : ''), r.reason ? h('div.small.muted', {}, r.reason === 'insufficient_balance' ? `Needs ${fmtInt(r.count)} units, you hold ${fmtInt(r.balance)}` : words(r.reason)) : null) },
      { key: 'action', label: '', render: r => r.canMint ? h('div.stack', { style: { gap: '4px', alignItems: 'flex-start' } }, h('button.btn.sm.primary', { onclick: event => mint(r, event.currentTarget) }, 'Mint'),
          tickerPicks.get(r.asset)?.label() ? h('div.small.muted', {}, 'into ', h('a.mono', { href: assetHref(r.asset) }, tickerPicks.get(r.asset).label())) : null)
        : r.requestId ? h('a.btn.sm.ghost', { href: '/mint/' + r.requestId }, 'Open request')
        : r.deploymentLink ? h('a.btn.sm.ghost', { href: localPath(r.deploymentLink) }, 'Deploy pattern') : null },
    ], { sortable: false }) : h('div.empty', {}, next ? 'Nothing mintable on this page. Try the next page.' : claimAsset ? 'No claimed blocks of this pattern your agent may mint right now.' : 'No claimed blocks your agent may mint right now.'));
    clear(pager, h('span.pager-total', {}, `Page ${page}`),
      h('button.btn.sm.ghost', { disabled: !cursor, onclick: () => { cursor = undefined; page = 1; act('Loading…', loadClaims); } }, 'First page'),
      h('button.btn.sm.ghost', { disabled: !next, onclick: () => { cursor = next; page++; act('Loading…', loadClaims); } }, 'Next page'));
  };
  const pick = asset => { claimAsset = asset; cursor = undefined; page = 1; drawFilter(); act('Loading…', loadClaims); };
  // Pattern tabs above the claims table, each with its unminted claim count.
  const drawFilter = () => {
    const shown = (patterns ?? []).filter(p => p.claims > 0 || p.id === claimAsset);
    if (!shown.length) { clear(filter); return; }
    const total = shown.reduce((n, p) => n + (p.claims ?? 0), 0), plus = shown.some(p => p.moreClaims);
    clear(filter, tabs([['all', `All · ${countText(total, plus)}`], ...shown.map(p => [p.id, `${nameOf(p.asset ?? p.id, p.name)} · ${countText(p.claims, p.moreClaims)}`])],
      id => pick(id === 'all' ? undefined : id), claimAsset ?? 'all'));
  };
  const showClaims = p => { pick(p.id); claimsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  // Your patterns: one row per pattern the agent discovered or holds claims in, with its next deployment step.
  const drawPatterns = data => {
    patterns = data.patterns; drawFilter();
    clear(patternList, patterns.length ? table(patterns, [
      { key: 'name', label: 'Pattern', render: p => h('div', {}, h('strong', {}, matter(p.asset, p.name)),
        h('div.small.muted', {}, h('span.mono', {}, unitKey(p.asset)), p.amountMode === 'field-value' ? ' · field value ' : ' ', p.tier ? tierBadge(p.tier) : null), p.discovered ? h('div.small.muted', {}, 'discovered by your agent') : null) },
      // Each next step sits under its state, so a phone shows it without scrolling sideways.
      // During the discoverer's week only the discoverer deploys; the deploy inscription stays with whoever deploys.
      { key: 'token', label: 'Token', render: p => { const week = p.deployer?.onlyDiscoverer ? p.deployer : null, waits = week && !p.ownWeek && p.token !== 'unknown';
        return h('div.stack', { style: { gap: '4px', alignItems: 'flex-start' } },
          pill(TOKEN[p.token]?.[0] ?? words(p.token), TOKEN[p.token]?.[1] ?? ''), p.ticker ? h('div.small.muted', {}, 'Ticker ', h('a.mono', { href: assetHref(p.asset) }, p.ticker)) : null,
          TOKEN_NOTE[p.token] && !waits ? h('div.small.muted', {}, TOKEN_NOTE[p.token]) : null,
          week ? h('div.small.muted', {}, p.ownWeek ? 'Only you, its discoverer, can deploy it until block ' : 'Only its discoverer can deploy it until block ', blockLink(week.until), p.ownWeek ? '. After that anyone can.' : '. After that you can.')
            : p.deployer ? h('div.small.muted', {}, 'Anyone can deploy it now.') : null,
          p.deploymentLink ? waits ? h('button.btn.sm', { disabled: true, title: `Only its discoverer, until block ${week.until}` }, 'Deploy pattern')
            : h(p.token === 'unknown' ? 'a.btn.sm.ghost' : 'a.btn.sm.primary', { href: localPath(p.deploymentLink) },
              p.token === 'inscribed' ? 'Continue deployment' : p.token === 'unknown' ? 'Open deployment' : 'Deploy pattern') : null,
          p.deployer && !waits ? h('div.small.muted', {}, 'Whoever deploys holds the deploy inscription and can add art to it later.') : null,
          p.token === 'deployed' ? tickersButton(p.asset, nameOf(p.asset, p.name), patternTickers, false) : null); } },
      { key: 'claims', label: 'Unminted claims', render: p => h('div.stack', { style: { gap: '4px', alignItems: 'flex-start' } },
        h('span.mono', {}, countText(p.claims, p.moreClaims)), p.claims > 0 ? h('button.btn.sm.ghost', { onclick: () => showClaims(p) }, 'Show claims') : null) },
    ], { sortable: false }) : h('div.empty', {}, 'No patterns yet. When your agent discovers a pattern, it appears here with its Deploy button.'));
    if (data.more) patternList.append(h('div.empty.small', {}, 'Showing the first patterns only.'));
    patternList.append(patternTickers);
  };
  const requestPager = h('div.pager-foot');
  // Open requests: ten per page, newest first, with the page's range and Newest / Older buttons.
  const drawRequests = data => {
    open = data.requests.length; more.requests = data.next !== null; drawProfile();
    clear(requests, data.requests.length ? table(data.requests, [
      { key: 'asset', label: 'Pattern', render: r => matter(r.asset, r.name) }, { key: 'block', label: 'Block', num: true, render: r => r.block === undefined || r.block === null ? '—' : blockLink(r.block) },
      { key: 'state', label: 'State', render: r => pill(words(r.state), STATE_KIND[r.state] ?? '') },
      { key: 'action', label: '', render: r => ['unknown', 'authorizing'].includes(r.state) && r.block !== undefined
        ? h('button.btn.sm', { onclick: event => mint(r, event.currentTarget) }, 'Resume')
        // Same conditions as the request page: Pay and mint with a set-aside; Inscribe only while the server is not sending.
        : h(!r.payable && BEFORE_PAY.includes(r.state) ? 'a.btn.sm.busy' : 'a.btn.sm', { href: '/mint/' + r.requestId, title: !r.payable && BEFORE_PAY.includes(r.state) ? PAY_SOON : null }, r.state === 'permit_issued' ? (!r.mintSender || ['needs_user', 'returning', 'returned'].includes(r.mintSender.state) ? 'Inscribe' : 'Open')
          : r.payable ? (r.mintFunding ? 'Pay and mint' : 'Pay') : BEFORE_PAY.includes(r.state) ? 'Preparing…' : 'Open') },
    ], { sortable: false }) : h('div.empty', {}, offset ? 'No more open requests.' : 'No open mint requests. Press Mint on a claimed block to start one.'));
    clear(requestPager, h('span.pager-total', {}, data.requests.length ? `${offset + 1}–${offset + data.requests.length}` : ''),
      h('button.btn.sm.ghost', { disabled: !offset, onclick: () => { offset = 0; act('Loading…', loadRequests); } }, 'Newest'),
      h('button.btn.sm.ghost', { disabled: data.next === null, onclick: () => { offset = data.next; act('Loading…', loadRequests); } }, 'Older requests'));
  };
  let linkOffset = 0;
  const links = h('div'), linkPager = h('div.pager-foot');
  const drawLinks = data => {
    clear(links, data.links.length ? table(data.links, [
      { key: 'block', label: 'Bitmap', render: r => r.block !== null ? h('a', { href: site.href('world', { b: r.block }) }, `${r.block}.bitmap`) : '—' },
      { key: 'state', label: 'State', render: r => pill(words(r.state), r.state === 'linked' || r.state === 'accepted' ? 'good' : r.payable ? 'warn' : '') },
      { key: 'action', label: '', render: r => r.price === '0' ? h('a.btn.sm', { href: r.paymentLink }, 'Free') : !r.payable && BEFORE_PAY.includes(r.state) ? h('a.btn.sm.busy', { href: r.paymentLink, title: PAY_SOON }, 'Preparing…') : h('a.btn.sm', { href: r.paymentLink }, r.payable ? 'Pay' : 'Open') },
    ], { sortable: false }) : h('div.empty', {}, linkOffset ? 'No more link requests.' : 'No Bitmap link requests yet.'));
    clear(linkPager, h('span.pager-total', {}, data.links.length ? `${linkOffset + 1}–${linkOffset + data.links.length}` : ''),
      h('button.btn.sm.ghost', { disabled: !linkOffset, onclick: () => { linkOffset = 0; act('Loading…', loadLinks); } }, 'Newest'),
      h('button.btn.sm.ghost', { disabled: data.next === null, onclick: () => { linkOffset = data.next; act('Loading…', loadLinks); } }, 'Older links'));
  };
  async function loadLinks() {
    const data = await api('/api/links?' + new URLSearchParams({ offset: String(linkOffset), limit: '10' })); if (!stopped) drawLinks(data);
  }
  async function loadRequests() {
    const data = await api('/api/requests?' + new URLSearchParams({ offset: String(offset), limit: '10' })); if (!stopped) drawRequests(data);
  }
  async function loadPatterns() {
    let data;
    try { data = await api('/api/patterns'); } catch (error) { if (!stopped && !patterns) clear(patternList, h('div.callout.bad', {}, 'Could not load your patterns: ' + words(error.message))); return; }
    if (!stopped) drawPatterns(data);
  }
  async function loadClaims() {
    let data;
    try { data = await api('/api/claims?' + new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}), ...(claimAsset ? { asset: claimAsset } : {}) })); }
    catch (error) { if (cursor && /cursor_stale/.test(error.message)) { cursor = undefined; page = 1; return loadClaims(); } throw error; }
    if (!stopped) drawClaims(data);
  }
  async function load() {
    info = await api('/api/info'); if (stopped) return; merged = info.merged ?? {}; drawProfile(); drawReceive();
    await loadPatterns(); await loadClaims(); await loadUnits().catch(error => { if (!units) clear(sendBody, h('div.callout.bad', {}, 'Could not load your units: ' + sendWords(error.message))); });
    await loadSends(); await loadCraft(); await loadTnk().catch(() => {}); await loadTnkSends().catch(() => {}); await loadRequests(); await loadLinks();
  }
  // Send units on Trac: rows or a pasted list → review of every row → one
  // confirm → one transfer per recipient, sent in turn by the agent.
  let units = null, unitsKey = '', sendMode = 'rows', sendRows = [{ to: '', unit: '', amount: '' }], pasteText = '', review = null, sends = null;
  const sendBody = h('div'), receiveBody = h('div'), sendsBody = h('div'), sendsPanel = h('div', { style: { scrollMarginTop: '72px' } });
  const blankRow = () => ({ to: '', unit: '', amount: '' });
  const grow = (el, flex) => { el.style.flex = flex; return el; };
  const unitOf = asset => units?.find(u => u.asset === asset);
  const keyLine = u => h('div.small.faint', {}, h('span.mono', {}, unitKey(u.asset)), u.kind === 'legacy' ? ' · imported units' : u.kind === 'compound' ? ' · crafted compound' : '');
  const sendRowEl = (row, i, spendable) => {
    const hint = h('div.hint'), unitHint = h('div'), errorEl = h('div.small', { style: { color: 'var(--bad)' } }, row.error ? sendWords(row.error) : '');
    const checkAddress = () => { const v = row.to.trim(); hint.textContent = v && !isTracAddress(v) ? sendWords('send_address') : ''; hint.style.color = 'var(--bad)'; };
    const to = h('input.input.mono', { value: row.to, placeholder: 'trac1…', spellcheck: 'false', autocomplete: 'off', 'aria-label': `Recipient Trac address, row ${i + 1}`,
      oninput: e => { row.to = e.target.value; row.error = null; errorEl.textContent = ''; checkAddress(); } });
    const showUnit = () => { const u = unitOf(row.unit); clear(unitHint, u ? keyLine(u) : null); };
    const pickUnit = select([['', 'Choose units…'], ...spendable.map(u => [u.asset, `${nameOf(u.asset, u.name)}${u.tier ? ' · T' + u.tier : ''} · ${fmtInt(u.available)} available`])],
      { value: row.unit, 'aria-label': `Units, row ${i + 1}`, onchange: e => { row.unit = e.target.value; row.error = null; errorEl.textContent = ''; showUnit(); } });
    const amount = h('input.input.mono', { value: row.amount, inputmode: 'numeric', placeholder: '0', 'aria-label': `Amount, row ${i + 1}`, style: { width: '96px' },
      oninput: e => { row.amount = e.target.value; row.error = null; errorEl.textContent = ''; } });
    // Max: what is available of this unit after the other rows.
    const max = h('button.btn.sm.ghost', { type: 'button', onclick: () => {
      const u = unitOf(row.unit); if (!u) { errorEl.textContent = 'Choose units first.'; return; }
      const others = sendRows.filter(r => r !== row && r.unit === row.unit && /^[1-9][0-9]*$/.test(r.amount.trim())).reduce((n, r) => n + BigInt(r.amount.trim()), 0n);
      const left = BigInt(u.available) - others; row.amount = String(left > 0n ? left : 0n); amount.value = row.amount; } }, 'Max');
    const remove = sendRows.length > 1 ? h('button.btn.sm.ghost', { type: 'button', 'aria-label': `Remove row ${i + 1}`, onclick: () => { sendRows.splice(i, 1); drawSend(); } }, 'Remove') : null;
    checkAddress(); showUnit();
    return h('div', { style: { borderTop: i ? '1px solid var(--rule-2)' : '0', paddingTop: i ? '10px' : '0' } },
      h('div.row', { style: { alignItems: 'flex-start', gap: '10px' } },
        grow(field('To (Trac address)', to), '1 1 100%'), grow(h('div.field', {}, h('label', {}, 'Units'), pickUnit, unitHint), '1 1 240px'),
        grow(h('div.field', {}, h('label', {}, 'Amount'), h('div.row', { style: { flexWrap: 'nowrap', gap: '6px' } }, amount, max, remove)), '0 0 auto')),
      hint, errorEl);
  };
  const drawSend = () => {
    if (!units) { clear(sendBody, h('div.empty', {}, 'Loading your units…')); return; }
    if (review) { drawReview(); return; }
    const spendable = units.filter(u => BigInt(u.available) > 0n);
    const lead = h('p.muted', { style: { margin: '0 0 12px' } }, TRAC_NOTE, ' Free for you; it arrives with the next Bitcoin block.');
    if (!spendable.length) { clear(sendBody, lead, h('div.empty', { style: { padding: '4px 0' } }, 'Your agent holds no units it can send yet.')); return; }
    const form = sendMode === 'rows'
      ? h('div.stack', { style: { gap: '10px' } }, sendRows.map((row, i) => sendRowEl(row, i, spendable)),
        h('div.row', {}, h('button.btn.sm.ghost', { type: 'button', disabled: sendRows.length >= 200, onclick: () => { sendRows.push(blankRow()); drawSend(); } }, 'Add row'),
          h('span.small.muted', {}, 'Several rows to one address become one transfer.')))
      : field('One line per send: Trac address, unit name, amount',
        Object.assign(h('textarea.input', { rows: 6, placeholder: 'trac1…, dmwmuffinite, 2\ntrac1…, dmwflorite, 5', spellcheck: 'false', 'aria-label': 'List of sends', oninput: e => { pasteText = e.target.value; } }), { value: pasteText }),
        'Commas, tabs or spaces between the parts. Names as in the Units list, or the unit key. Up to 200 lines.');
    clear(sendBody, lead, h('div.row', { style: { marginBottom: '12px' } }, seg([['rows', 'Fill in rows'], ['paste', 'Paste a list']], sendMode, mode => { sendMode = mode; drawSend(); })),
      form, h('div.row', { style: { marginTop: '14px' } }, h('button.btn.primary', { onclick: reviewSend }, 'Review send')));
  };
  const reviewSend = () => act('', async () => {
    const body = sendMode === 'paste' ? { text: pasteText } : { rows: sendRows.map((r, i) => ({ line: i + 1, to: r.to.trim(), unit: r.unit, amount: r.amount.trim() })) };
    review = await api('/api/send-review', body);
    if (sendMode === 'rows') review.rows.forEach((r, i) => { if (sendRows[i]) sendRows[i].error = r.error; });
    drawSend();
  });
  const confirmText = r => {
    const g = r.groups, recipients = new Set(g.map(x => x.to)).size;
    return g.length === 1 && g[0].assets.length === 1 ? ['Send ', `${g[0].assets[0][1]} `, assetLink(g[0].assets[0][0], g[0].labels[0]), ' to ', agentLink(g[0].to), ' on Trac?']
      : ['Send ', assetList(r.totals), ` to ${recipients} Trac address${recipients === 1 ? '' : 'es'}?`];
  };
  const drawReview = () => {
    const back = h('button.btn.ghost', { onclick: () => { review = null; drawSend(); } }, 'Back to edit');
    if (!review.ok) {
      clear(sendBody, h('div.callout.bad', { style: { marginBottom: '12px' } }, 'Some rows need a fix. Nothing was signed.'),
        table(review.rows.filter(r => r.error), [
          { key: 'line', label: sendMode === 'paste' ? 'Line' : 'Row', num: true, render: r => String(r.line) },
          { key: 'to', label: 'To', render: r => r.to && isTracAddress(r.to) ? agentLink(r.to) : h('span.mono', {}, r.to ? short(r.to) : '–') },
          { key: 'unit', label: 'Units', render: r => [`${r.amount || '–'} `, r.asset ? assetLink(r.asset, r.name) : r.name ?? r.unit ?? ''] },
          { key: 'error', label: 'What to fix', render: r => sendWords(r.error) }], { sortable: false }),
        h('div.row', { style: { marginTop: '12px' } }, back));
      return;
    }
    const go = h('button.btn.primary', { onclick: () => confirmSend(go) }, 'Send on Trac');
    clear(sendBody,
      h('p', { style: { margin: '0 0 6px', fontWeight: 700 } }, confirmText(review), ' Free, arrives with the next Bitcoin block.'),
      h('p.small', { style: { margin: '0 0 6px' } }, 'These are game units, not TNK: no network fee.'),
      h('p.muted.small', { style: { margin: '0 0 12px' } }, 'The units move on the Trac network to these trac1… addresses. This is not a Bitcoin or TAP token transfer and not an inscription.',
        review.groups.length > 1 ? ` Your agent signs ${review.groups.length} transfers, one per address (up to 16 units each), and sends them one after another.` : ''),
      table(review.groups, [
        { key: 'to', label: 'To (Trac address)', render: g => agentLink(g.to) },
        { key: 'assets', label: 'Units', render: g => h('div', {}, g.assets.map(([asset, amount], i) => h('div', {}, h('span.mono', {}, fmtInt(amount)), ' ', assetLink(asset, g.labels[i])))) }], { sortable: false }),
      h('div.small.muted', { style: { margin: '10px 0 0' } }, 'Total: ', review.totals.map((t, i) => [i ? ' · ' : '', `${fmtInt(t.amount)} of ${fmtInt(t.available)} available `, assetLink(t.asset, t.name)])),
      h('div.row', { style: { marginTop: '14px' } }, back, go));
  };
  const confirmSend = button => act('', async () => {
    button.disabled = true; button.textContent = 'Signing…'; button.classList.add('busy');
    let send;
    try { send = await api('/api/send', { rows: review.rows.map(r => ({ to: r.to, unit: r.asset, amount: r.amount })) }); }
    catch (error) { button.disabled = false; button.textContent = 'Send on Trac'; button.classList.remove('busy'); throw error; }
    review = null; sendRows = [blankRow()]; pasteText = '';
    toast({ what: 'Sending on Trac', detail: `${send.groups.length} transfer${send.groups.length === 1 ? '' : 's'} saved; your agent sends them now.`, state: 'complete', ttl: 5000 });
    await loadSends(); await loadUnits(true);
    sendsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const stateNote = g => ({
    waiting: g.signed ? 'Signed and saved; sends in turn.' : 'Saved; your agent signs and sends it in turn.',
    sending: 'Your agent is signing and sending it on Trac…',
    received: g.batch ? ['Sent to the gateway. Confirms in ', batchLink(g.batch), ', normally with the next Bitcoin block.'] : 'Sent to the gateway. Confirms with the next Bitcoin block.',
    confirmed: g.batch ? ['Confirmed in ', batchLink(g.batch), '. The units are at the recipient.'] : 'Confirmed. The units are at the recipient.',
    uncertain: 'No clear answer from the gateway. Retry sends this same transfer again; it cannot arrive twice.',
    replaced: 'Signed again below; this signature can no longer be used.',
  }[g.state] ?? sendWords(g.error));
  const SEND_STEPS = ['Signed and saved', 'Sent to the gateway', 'Confirmed in a batch'];
  const sendCard = (send, newest) => {
    const live = send.groups.filter(g => g.state !== 'replaced'), done = live.filter(g => g.state === 'confirmed').length;
    const at = done === live.length ? 3 : live.every(g => ['received', 'confirmed'].includes(g.state)) ? 2 : live.some(g => g.signed || ['received', 'confirmed', 'sending'].includes(g.state)) ? 1 : 0;
    const stuck = !send.running && live.some(g => ['failed', 'uncertain', 'stale', 'queued', 'waiting'].includes(g.state));
    const retry = !send.running && live.some(g => ['failed', 'uncertain', 'queued', 'waiting'].includes(g.state));
    return h('div', { style: { borderTop: newest ? '0' : '1px solid var(--rule-2)' } },
      h('div.row', { style: { padding: '10px 14px 4px', justifyContent: 'space-between' } },
        h('span.small.muted', {}, new Date(send.createdAt).toLocaleString(), ' · ', `${live.length} transfer${live.length === 1 ? '' : 's'} on Trac`, ' · ', `${done} confirmed`),
        send.running ? pill('sending…', 'info') : null),
      newest ? h('div', { style: { padding: '4px 14px' } }, stepper(SEND_STEPS, at, { failed: stuck && at < 3 })) : null,
      send.waiting ? h('div.callout.warn', { style: { margin: '6px 14px' } }, sendWords(send.waiting.reason), ` Next try about ${new Date(send.waiting.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`) : null,
      table(send.groups, [
        { key: 'to', label: 'To (Trac address)', render: g => agentLink(g.to) },
        { key: 'assets', label: 'Units', render: g => h('div', {}, assetList(g.assets), h('div.small.faint.mono', {}, g.assets.map(a => unitKey(a.asset)).join(' · '))) },
        { key: 'state', label: 'State', render: g => h('div', {}, pill(...(SEND_STATE[g.state] ?? [words(g.state), ''])), h('div.small.muted', {}, stateNote(g))) },
        ...(send.groups.some(g => g.state === 'stale') && !send.running
          ? [{ key: 'action', label: '', render: g => g.state === 'stale' ? h('button.btn.sm', { onclick: event => resign(send, g, event.currentTarget) }, 'Sign again') : '' }] : []),
      ], { sortable: false }),
      retry ? h('div.row', { style: { padding: '10px 14px' } }, h('button.btn.sm', { onclick: event => retrySend(send, event.currentTarget) }, 'Retry unsent'),
        h('span.small.muted', {}, 'Sends the same saved transfers again; none can arrive twice.')) : null);
  };
  const retrySend = (send, button) => act('', async () => { button.disabled = true; await api('/api/send-retry', { id: send.id }); await loadSends(); });
  const resign = (send, g, button) => act('', async () => { button.disabled = true; await api('/api/send-resign', { id: send.id, actionId: g.actionId }); await loadSends(); });
  const drawSends = () => {
    const list = sends?.sends ?? [];
    clear(sendsBody, list.length ? list.map((send, i) => sendCard(send, i === 0)) : h('div.empty', {}, 'No sends yet. Units you send on Trac appear here with their progress.'));
  };
  // The agent's one trac1… address: it receives units and TNK alike.
  const addressBox = () => [h('div.mono', { style: { wordBreak: 'break-all', padding: '10px 12px', border: '1px solid var(--rule)', borderRadius: 'var(--radius)', background: 'var(--paper)' } }, h('a', { href: site.href('agents', { a: info.address }) }, info.address)),
    h('div.row', { style: { marginTop: '10px' } }, h('button.btn.sm', { onclick: () => copy(info.address) }, 'Copy address'))];
  const drawReceive = () => info && clear(receiveBody,
    h('p.muted', { style: { margin: '0 0 10px' } }, 'Other players send units to this address on the Trac network. It is not a Bitcoin address: minted Bitcoin tokens go to your payout TAP wallet.'),
    ...addressBox());
  // A refresh redraws the form only when the units changed and nobody types in it.
  async function loadUnits(force = false) {
    const data = await api('/api/units'); if (stopped) return;
    units = data.units; const key = JSON.stringify(units);
    if (force || key !== unitsKey && !sendBody.contains(document.activeElement)) { unitsKey = key; drawSend(); }
  }
  async function loadSends() { const data = await api('/api/sends'); if (!stopped) { sends = data; drawSends(); } }
  const sendsActive = () => sends?.sends.some(s => s.running || s.groups.some(g => ['sending', 'received', 'waiting'].includes(g.state)));
  // TNK (Trac network gas): balance, fee, funding address, and one send at a
  // time → review in plain words → Send → Pending → Confirmed.
  let tnk = null, tnkTo = '', tnkAmount = '', tnkReview = null, tnkSends = null;
  const tnkCard = h('div'), tnkBody = h('div'), tnkSendsBody = h('div'), tnkSendsPanel = h('div', { style: { scrollMarginTop: '72px' } });
  const tnkText = value => `${value} TNK`;
  const drawTnkCard = () => {
    if (!tnk || !info) { clear(tnkCard, h('div.empty', {}, 'Loading TNK…')); return; }
    clear(tnkCard,
      tnk.ready ? figures([['Balance', tnk.accountExists ? tnkText(tnk.balanceTnk) : 'No TNK yet', tnk.outTnk !== '0' ? `${tnkText(tnk.outTnk)} on its way out` : null],
        ['Network fee per send', tnkText(tnk.feeTnk)]])
        : h('div.callout.warn', {}, 'Could not read TNK: ' + sendWords(tnk.error)),
      h('p.muted', { style: { margin: '12px 0 10px' } }, TNK_NOTE),
      h('div.field', {}, h('label', {}, 'Send TNK here to fund your agent'), ...addressBox()),
      h('p.small.muted', { style: { margin: '8px 0 0' } }, 'The same trac1… address that receives units. Send TNK only on the Trac network, not from Bitcoin.'));
  };
  const drawTnkSend = () => {
    if (!tnk) { clear(tnkBody, h('div.empty', {}, 'Loading TNK…')); return; }
    if (tnkReview) { drawTnkReview(); return; }
    const lead = h('p.muted', { style: { margin: '0 0 12px' } }, 'TNK is the Trac network’s own coin. It has real value, and every send costs a network fee.');
    if (!tnk.ready || !tnk.accountExists || tnk.maxTnk === '0') {
      clear(tnkBody, lead, h('div.empty', { style: { padding: '4px 0' } }, !tnk.ready ? 'TNK cannot be read right now.' : !tnk.accountExists ? 'No TNK yet. Send TNK to your agent’s address to fund it.'
        : tnk.outTnk !== '0' ? 'All TNK not on its way out is needed for the network fee. Wait for your sends to confirm.' : 'Not enough TNK to cover the network fee.'));
      return;
    }
    const hint = h('div.hint'), errorEl = h('div.small', { style: { color: 'var(--bad)' } });
    const checkAddress = () => { const v = tnkTo.trim(); hint.textContent = v && !isTracAddress(v) ? sendWords('tnk_invalid_address') : ''; hint.style.color = 'var(--bad)'; };
    const to = h('input.input.mono', { value: tnkTo, placeholder: 'trac1…', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'TNK recipient Trac address',
      oninput: e => { tnkTo = e.target.value; errorEl.textContent = ''; checkAddress(); } });
    const amount = h('input.input.mono', { value: tnkAmount, inputmode: 'decimal', placeholder: '0.0', 'aria-label': 'TNK amount', style: { width: '160px' },
      oninput: e => { tnkAmount = e.target.value; errorEl.textContent = ''; } });
    // Max: everything except the network fee of this send.
    const max = h('button.btn.sm.ghost', { type: 'button', onclick: () => { tnkAmount = tnk.maxTnk; amount.value = tnkAmount; errorEl.textContent = ''; } }, 'Max');
    const check = h('button.btn.primary', { onclick: () => reviewTnk(check, errorEl) }, 'Review TNK send');
    checkAddress();
    clear(tnkBody, lead,
      h('div.row', { style: { alignItems: 'flex-start', gap: '10px' } },
        grow(field('To (Trac address)', to), '1 1 100%'),
        grow(h('div.field', {}, h('label', {}, 'Amount (TNK)'), h('div.row', { style: { flexWrap: 'nowrap', gap: '6px' } }, amount, max),
          h('div.hint', {}, `Up to ${tnkText(tnk.maxTnk)}: your balance minus the ${tnkText(tnk.feeTnk)} network fee${tnk.outTnk !== '0' ? ' and TNK still on its way out' : ''}.`)), '1 1 240px')),
      hint, errorEl, h('div.row', { style: { marginTop: '14px' } }, check));
  };
  const reviewTnk = (button, errorEl) => act('', async () => {
    button.disabled = true;
    try { tnkReview = await api('/api/tnk-review', { to: tnkTo.trim(), amount: tnkAmount.trim() }); }
    catch (error) { button.disabled = false; errorEl.textContent = sendWords(error.message); return; }
    drawTnkSend();
  });
  const drawTnkReview = () => {
    const r = tnkReview, back = h('button.btn.ghost', { onclick: () => { tnkReview = null; drawTnkSend(); } }, 'Back to edit');
    const send = h('button.btn.primary', { onclick: () => confirmTnk(send) }, 'Send TNK');
    clear(tnkBody,
      h('p', { style: { margin: '0 0 6px', fontWeight: 700 } }, `Send ${tnkText(r.amount)} to `, agentLink(r.to), `? Network fee ${tnkText(r.feeTnk)}.`),
      h('p.muted.small', { style: { margin: '0 0 12px' } }, 'This sends TNK, the Trac network’s coin with real value — not game units. A TNK send cannot be undone.'),
      figures([['To (Trac address)', agentLink(r.to)], ['Total from your agent', tnkText(r.totalTnk), 'amount + fee'], ['Left after the send', tnkText(r.remainingTnk)]]),
      h('div.row', { style: { marginTop: '14px' } }, back, send));
  };
  const confirmTnk = button => act('', async () => {
    button.disabled = true; button.textContent = 'Signing…'; button.classList.add('busy');
    try { await api('/api/tnk-send', { to: tnkReview.to, amount: tnkReview.amount }); }
    catch (error) { button.disabled = false; button.textContent = 'Send TNK'; button.classList.remove('busy'); throw error; }
    tnkReview = null; tnkTo = ''; tnkAmount = '';
    toast({ what: 'Sending TNK', detail: 'Saved; your agent signs and sends it now.', state: 'complete', ttl: 5000 });
    await loadTnkSends(); await loadTnk(true);
    tnkSendsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const TNK_STATE = { waiting: ['not sent yet', 'warn'], sending: ['sending…', 'info'], sent: ['pending', 'info'], pending: ['pending', 'info'],
    confirmed: ['confirmed', 'good'], uncertain: ['unclear', 'warn'], failed: ['not sent', 'bad'] };
  const tnkNote = s => ({
    waiting: 'Saved, not sent yet. Retry sends it.',
    sending: 'Your agent is signing and sending it on Trac…',
    sent: 'Sent to the Trac network. Waiting for it to show as pending.',
    pending: 'Pending on the Trac network. It confirms by itself.',
    confirmed: 'Confirmed. The TNK is at the recipient.',
  }[s.state] ?? sendWords(s.error) + (s.state === 'failed' && s.signed && s.retry ? ' Signed and saved; Retry sends this same transfer.' : ''));
  const TNK_STEPS = ['Signed and saved', 'Sent to the Trac network', 'Confirmed'];
  const tnkStep = s => s.state === 'confirmed' ? 3 : ['sent', 'pending'].includes(s.state) ? 2 : s.signed || s.state === 'uncertain' ? 1 : 0;
  const drawTnkSends = () => {
    const list = tnkSends?.sends ?? [], newest = list[0];
    clear(tnkSendsBody, list.length ? [
      h('div', { style: { padding: '10px 14px 4px' } }, stepper(TNK_STEPS, tnkStep(newest), { failed: ['failed', 'uncertain', 'waiting'].includes(newest.state) })),
      table(list, [
        { key: 'to', label: 'To (Trac address)', render: s => h('div', {}, agentLink(s.to), h('div.small.faint', {}, new Date(s.createdAt).toLocaleString())) },
        { key: 'amount', label: 'TNK', render: s => h('div', {}, h('span.mono', {}, tnkText(s.amount)), h('div.small.faint', {}, `fee ${tnkText(s.feeTnk)}`)) },
        { key: 'state', label: 'State', render: s => h('div.stack', { style: { gap: '4px', alignItems: 'flex-start' } }, pill(...(TNK_STATE[s.state] ?? [words(s.state), ''])), h('div.small.muted', {}, tnkNote(s)),
          s.retry ? h('button.btn.sm', { title: 'Sends the same saved transfer again; it cannot arrive twice.', onclick: event => retryTnk(s, event.currentTarget) }, s.state === 'sent' ? 'Send again' : 'Retry') : null) },
      ], { sortable: false })] : h('div.empty', {}, 'No TNK sends yet. TNK you send appears here with its progress.'));
  };
  const retryTnk = (s, button) => act('', async () => { button.disabled = true; await api('/api/tnk-retry', { id: s.id }); await loadTnkSends(); });
  // The send form redraws only when TNK changed and nobody types in it.
  let tnkKey = '';
  async function loadTnk(force = false) {
    const data = await api('/api/tnk'); if (stopped) return;
    tnk = data; drawTnkCard(); const key = JSON.stringify(data);
    if (force || key !== tnkKey && !tnkBody.contains(document.activeElement)) { tnkKey = key; drawTnkSend(); }
  }
  async function loadTnkSends() { const data = await api('/api/tnk-sends'); if (!stopped) { tnkSends = data; drawTnkSends(); } }
  const tnkActive = () => tnkSends?.sends.some(s => ['sending', 'sent', 'pending'].includes(s.state));
  // Craft: pick ingredients → recipe → live preview from the gateway's
  // verified proof → review in plain words → the agent signs → progress.
  let craft = null, craftKey = '', picked = new Map(), recipe = 'fusion', craftReview = false, preview = null, previewError = null, previewTicket = 0, previewTimer = null;
  const craftBody = h('div'), compoundsBody = h('div'), craftsBody = h('div'), craftsPanel = h('div', { style: { scrollMarginTop: '72px' } });
  const ingredientOf = asset => craft?.ingredients.find(i => i.asset === asset);
  const craftable = () => (craft?.ingredients ?? []).filter(i => i.craftable && BigInt(i.available) > 0n);
  const chosen = () => [...picked].filter(([asset]) => ingredientOf(asset)?.craftable).map(([asset, amount]) => [asset, amount.trim()]);
  const amountOk = v => /^[1-9][0-9]*$/.test(v);
  // Resonance is offered only while every chosen ingredient has the same known charge.
  const resonance = () => {
    const list = chosen().map(([asset]) => ingredientOf(asset));
    if (list.length < 2) return { ok: false, why: 'Choose two ingredients first.' };
    const charges = list.map(i => i.properties?.charge);
    if (charges.some(c => !Number.isSafeInteger(c))) return { ok: true };
    return new Set(charges).size === 1 ? { ok: true } : { ok: false, why: 'Not possible here: ' + list.map(i => `${i.name} has charge ${i.properties.charge}`).join(', ') + '. Resonance needs the same charge on every ingredient.' };
  };
  const propLine = i => i.properties ? [`Charge ${i.properties.charge}`, `Spectrum: ${spectrumText(i.properties.spectrum)}`, `Generation ${generationText(i.properties.generation)}`,
    i.properties.matches ? `${i.properties.matches} known blocks` : null].filter(Boolean).join(' · ') : 'Properties are read from the catalog.';
  const ingredientRow = (i, n) => {
    const on = picked.has(i.asset), usable = i.craftable && BigInt(i.available) > 0n;
    const amount = h('input.input.mono', { value: on ? picked.get(i.asset) : '1', inputmode: 'numeric', disabled: !on, 'aria-label': `Units of ${i.name} to use`, style: { width: '88px' },
      oninput: e => { picked.set(i.asset, e.target.value); schedulePreview(); } });
    const max = h('button.btn.sm.ghost', { type: 'button', disabled: !on, 'aria-label': `Use all ${fmtInt(i.available)} ${i.name}`, onclick: () => { picked.set(i.asset, i.available); amount.value = i.available; schedulePreview(); } }, 'Max');
    const box = h('input', { type: 'checkbox', id: 'craft-use-' + i.asset, checked: on, disabled: !usable,
      onchange: e => { if (e.target.checked) picked.set(i.asset, amount.value.trim() || '1'); else picked.delete(i.asset); schedulePreview(); } });
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '6px 12px', alignItems: 'center', padding: '10px 0',
      borderTop: n ? '1px solid var(--rule-2)' : '0', opacity: usable ? '1' : '0.55' } },
      h('label.check', { for: 'craft-use-' + i.asset, style: { alignItems: 'flex-start', cursor: usable ? 'pointer' : 'not-allowed', minWidth: 0 } }, box,
        h('span', { style: { minWidth: 0 } },
          h('span', { style: { fontWeight: 700 } }, h('span.swatch', { style: { background: mineral(i.asset) } }), i.name), ' ', i.tier ? tierBadge(i.tier) : null,
          h('span.small.muted', {}, ' · ', `${fmtInt(i.available)} available`),
          h('div.small.muted', {}, i.craftable ? propLine(i) : craftWords(i.reason)))),
      usable ? h('div.row', { style: { flexWrap: 'nowrap', gap: '6px', opacity: on ? '1' : '0.45' } }, amount, max) : h('span'));
  };
  const recipeChoice = () => {
    const res = resonance();
    if (recipe === 'resonance' && !res.ok) recipe = 'fusion';
    return h('fieldset', { style: { border: 0, margin: 0, padding: 0, minWidth: 0 } }, h('legend.small', { style: { fontWeight: 700, color: 'var(--ink-2)', padding: 0, marginBottom: '6px' } }, '2 · Recipe'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px' } }, Object.entries(RECIPES).map(([id, [label, line]]) => {
        const disabled = id === 'resonance' && !res.ok;
        return h('label.check', { style: { alignItems: 'flex-start', padding: '10px 12px', border: `1px solid ${recipe === id ? 'var(--ink)' : 'var(--rule)'}`, borderRadius: 'var(--radius)',
          background: 'var(--sheet)', opacity: disabled ? '0.6' : '1', cursor: disabled ? 'not-allowed' : 'pointer' } },
          h('input', { type: 'radio', name: 'craft-recipe', id: 'craft-recipe-' + id, value: id, checked: recipe === id, disabled, onchange: () => { recipe = id; schedulePreview(); } }),
          h('span', {}, h('strong', {}, label), h('div.small.muted', {}, disabled ? res.why : line)));
      })));
  };
  // The preview box keeps its size while it updates, so nothing below jumps.
  const previewBox = () => {
    const inputs = chosen(), ready = inputs.length >= 2 && inputs.every(([, a]) => amountOk(a));
    const frame = (...children) => h('div', { 'aria-live': 'polite', style: { minHeight: '196px', border: '1px dashed var(--rule)', borderRadius: 'var(--radius)', background: 'var(--paper)', padding: '12px 14px' } }, ...children);
    const head = h('div.row', { style: { justifyContent: 'space-between', marginBottom: '8px' } }, h('span.small', { style: { fontWeight: 700, color: 'var(--ink-2)' } }, '3 · Result'),
      pill(preview?.loading ? 'updating preview…' : 'preview — nothing signed', preview?.loading ? 'info' : ''));
    if (!ready) return frame(head, h('div.empty', { style: { padding: '18px 0' } }, inputs.length < 2 ? 'Choose at least two ingredients to see what you would get.' : 'Enter a whole number of units, 1 or more, for every ingredient.'));
    if (previewError && !preview?.result) return frame(head, h('div.callout.bad', {}, craftWords(previewError)));
    if (!preview?.result) return frame(head, h('div.empty', { style: { padding: '18px 0' } }, 'Working out the result…'));
    const r = preview.result;
    return frame(head, h('div', { style: { opacity: preview.loading ? '0.55' : '1', transition: 'opacity .15s' } },
      h('div', { style: { fontFamily: 'var(--serif)', fontSize: '18px', marginBottom: '8px' } }, r.existing ? `Adds ${fmtInt(r.amount)} units to ` : 'Creates ', resultName(r)),
      figures([['You get', `${fmtInt(r.amount)} unit${r.amount === '1' ? '' : 's'}`], ['Tier', r.tier ? tierBadge(r.tier) : pill('settles later', 'warn'), r.tier ? null : 'Refine sets it after crafting'],
        ['Charge', String(r.properties.charge)], ['Spectrum', softValue(spectrumText(r.properties.spectrum))]]),
      h('div.small.muted', { style: { marginTop: '8px' } }, `Generation ${r.properties.generation}: ${r.properties.generation === '1' ? 'made straight from patterns' : `its newest ingredient is generation ${BigInt(r.properties.generation) - 1n}`}. `, 'Uses ', preview.inputs.map((i, n) => [n ? ' + ' : '', `${fmtInt(i.amount)} `, assetLink(i.asset, i.name), ` (${fmtInt(i.left)} left)`]), '.'),
      previewError ? h('div.small', { style: { color: 'var(--bad)', marginTop: '6px' } }, craftWords(previewError)) : null));
  };
  const warningsBox = () => (preview?.warnings ?? []).map(w => w.code === 'craft_uses_mint_units'
    ? h('div.callout.warn', { style: { marginTop: '10px' } }, `You have ${w.blocks}${w.more ? '+' : ''} claimed block${w.blocks === 1 ? '' : 's'} of `, assetLink(w.asset, w.name), ` waiting to mint that need ${w.units} units. After this craft ${w.left} are left, so some of those blocks could not be minted.`)
    : w.code === 'craft_mint_units_ok' ? h('div.small.muted', { style: { marginTop: '8px' } }, `${w.blocks}${w.more ? '+' : ''} claimed block${w.blocks === 1 ? '' : 's'} of `, assetLink(w.asset, w.name), ` waiting to mint need ${w.units} units; ${w.left} are left after this craft — enough.`)
    : h('div.callout.warn', { style: { marginTop: '10px' } }, 'Could not check your claimed blocks of ', assetLink(w.asset, w.name), '. Look under Claimed blocks before you craft.'));
  const drawCraft = () => {
    if (!craft) { clear(craftBody, h('div.empty', {}, 'Loading your ingredients…')); return; }
    if (craftReview && preview?.result) { drawCraftReview(); return; }
    const lead = h('p.muted', { style: { margin: '0 0 12px' } }, CRAFT_NOTE);
    const list = craft.ingredients, usable = craftable();
    if (!list.length) { clear(craftBody, lead, h('div.empty', { style: { padding: '4px 0' } }, 'Your agent holds no units yet. Claim blocks of two patterns, then craft them here.')); return; }
    const few = usable.length < 2 ? h('div.callout.info', { style: { marginBottom: '10px' } }, 'You need units of at least two patterns to craft — claim blocks of another pattern first.') : null;
    const inputs = chosen(), ready = inputs.length >= 2 && inputs.every(([, a]) => amountOk(a)) && preview?.result && !preview.loading && !previewError;
    const over = inputs.length > craft.maxInputs;
    const review = h('button.btn.primary', { disabled: !ready || over, onclick: () => { craftReview = true; drawCraft(); } }, 'Review craft');
    clear(craftBody, lead, few,
      h('div', { role: 'group', 'aria-label': 'Ingredients' }, h('div.small', { style: { fontWeight: 700, color: 'var(--ink-2)' } }, `1 · Ingredients`, h('span.muted', { style: { fontWeight: 400 } }, ` — choose 2 to ${craft.maxInputs}, and how many units of each`)),
        list.map((i, n) => ingredientRow(i, n))),
      over ? h('div.small', { style: { color: 'var(--bad)' } }, `At most ${craft.maxInputs} ingredients in one craft.`) : null,
      h('div', { style: { margin: '14px 0' } }, recipeChoice()),
      previewBox(), warningsBox(),
      h('p.small.muted', { style: { margin: '10px 0 0' } }, 'Equal amounts give that many compound units (3 + 3 makes 3). Uneven amounts are a recipe ratio: 2 + 3 makes 1 unit.'),
      h('div.row', { style: { marginTop: '14px' } }, review, inputs.length ? h('button.btn.ghost', { type: 'button', onclick: () => { picked.clear(); preview = null; previewError = null; drawCraft(); } }, 'Clear') : null));
  };
  // Debounced: one preview request per pause in typing; older answers are dropped.
  const schedulePreview = () => {
    clearTimeout(previewTimer); previewError = null;
    const inputs = chosen();
    if (inputs.length < 2 || !inputs.every(([, a]) => amountOk(a))) { preview = null; refreshPreview(); return; }
    if (preview) preview.loading = true; refreshPreview();
    const ticket = ++previewTicket;
    previewTimer = setTimeout(async () => {
      let result = null, error = null;
      try { result = await api('/api/craft-preview', { recipe, inputs }); } catch (e) { error = e.message; }
      if (ticket !== previewTicket || stopped) return;
      if (result) { preview = result; previewError = null; } else { preview = null; previewError = error; }
      refreshPreview();
    }, 400);
  };
  // Redraw only the preview, warnings and button, never the inputs being typed in.
  const refreshPreview = () => {
    if (craftReview) return;
    const focus = craftBody.contains(document.activeElement) ? document.activeElement : null, at = focus?.selectionStart;
    const same = focus && (focus.id ? el => el.id === focus.id : focus.getAttribute('aria-label') ? el => el.getAttribute('aria-label') === focus.getAttribute('aria-label') : null);
    drawCraft();
    if (same) { const again = [...craftBody.querySelectorAll('input, button')].find(same); if (again) { again.focus(); if (at !== undefined && at !== null && again.setSelectionRange) try { again.setSelectionRange(at, at); } catch { /* not a text input */ } } }
  };
  const drawCraftReview = () => {
    const p = preview, r = p.result;
    const back = h('button.btn.ghost', { onclick: () => { craftReview = false; drawCraft(); } }, 'Back to edit');
    const go = h('button.btn.primary', { onclick: () => confirmCraft(go) }, 'Craft now');
    const risky = p.warnings.filter(w => w.code !== 'craft_mint_units_ok');
    clear(craftBody,
      h('p', { style: { margin: '0 0 6px', fontWeight: 700 } }, r.existing ? [`Adds ${fmtInt(r.amount)} units to `, resultName(r)] : ['Creates ', resultName(r), ` with ${fmtInt(r.amount)} units`], ' from ', assetList(p.inputs, ' + '), '?'),
      h('p.muted.small', { style: { margin: '0 0 12px' } }, `Your agent signs this ${RECIPES[p.recipe][0].toLowerCase()} craft. It is free. The ${fmtInt(p.inputs.reduce((n, i) => n + BigInt(i.amount), 0n))} units you put in are used up, and the compound arrives with the next batch on Trac. A craft cannot be undone.`),
      table(p.inputs, [
        { key: 'name', label: 'Ingredient', render: i => matter(i.asset, i.name) },
        { key: 'amount', label: 'Uses', num: true, render: i => h('span.mono', {}, fmtInt(i.amount)) },
        { key: 'left', label: 'Left after', num: true, render: i => h('span.mono', {}, fmtInt(i.left)) }], { sortable: false }),
      h('div', { style: { marginTop: '10px' } }, figures([['You get', `${fmtInt(r.amount)} unit${r.amount === '1' ? '' : 's'}`], ['Tier', r.tier ? tierBadge(r.tier) : pill('settles later', 'warn')],
        ['Charge', String(r.properties.charge)], ['Spectrum', softValue(spectrumText(r.properties.spectrum))]])),
      risky.length ? warningsBox().filter((_, n) => p.warnings[n].code !== 'craft_mint_units_ok') : null,
      h('p.small.muted', { style: { margin: '10px 0 0' } }, 'The result is checked again when your agent signs. An existing compound keeps its original tier; a new compound receives its tier on the first craft.'),
      h('div.row', { style: { marginTop: '14px' } }, back, go));
  };
  const confirmCraft = button => act('', async () => {
    button.disabled = true; button.textContent = 'Signing…'; button.classList.add('busy');
    let started;
    try { started = await api('/api/craft', { recipe: preview.recipe, inputs: preview.inputs.map(i => [i.asset, i.amount]) }); }
    catch (error) { button.disabled = false; button.textContent = 'Craft now'; button.classList.remove('busy'); throw Error(craftWords(error.message)); }
    craftReview = false; picked.clear(); preview = null;
    toast({ what: 'Crafting', detail: `${started.label} — saved; your agent signs and sends it now.`, state: 'complete', ttl: 5000 });
    await loadCraft(true);
    craftsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const craftNote = c => ({
    waiting: 'Saved; your agent signs and sends it in turn.',
    crafting: c.kind === 'refine' ? 'Your agent is working out the tier…' : 'Your agent is signing and sending the craft…',
    received: c.batch ? ['Sent to the gateway. Confirms in ', batchLink(c.batch), ', normally with the next Bitcoin block.'] : 'Sent to the gateway. Confirms with the next Bitcoin block.',
    confirmed: c.kind === 'refine' ? 'Done.' : c.batch ? ['Confirmed in ', batchLink(c.batch), '. The compound is in your units.'] : 'Confirmed. The compound is in your units.',
    uncertain: c.error && CRAFT_WORDS[c.error] ? craftWords(c.error) : 'No clear answer from the gateway. Retry sends this same signed craft again; it cannot happen twice.',
  }[c.state] ?? craftWords(c.error));
  const craftStep = c => c.state === 'confirmed' ? 3 : c.state === 'received' ? 2 : c.signed || c.state === 'uncertain' ? 1 : 0;
  const retryCraft = (c, button) => act('', async () => { button.disabled = true; await api('/api/craft-retry', { id: c.id }); await loadCraft(true); });
  const refine = (asset, button) => act('', async () => {
    button.disabled = true; button.textContent = 'Refining…'; button.classList.add('busy');
    try { await api('/api/craft-refine', { asset }); } catch (error) { button.disabled = false; button.textContent = 'Refine'; button.classList.remove('busy'); throw Error(craftWords(error.message)); }
    await loadCraft(true);
  });
  const drawCrafts = () => {
    const list = (craft?.crafts ?? []).filter(c => c.kind !== 'refine'), newest = list[0];
    clear(craftsBody, list.length ? [
      h('div', { style: { padding: '10px 14px 4px' } }, stepper(newest.state === 'confirmed' && newest.batch ? [...CRAFT_STEPS.slice(0, 2), `Confirmed in batch ${newest.batch}`] : CRAFT_STEPS,
        craftStep(newest), { failed: ['failed', 'uncertain', 'queued'].includes(newest.state) })),
      table(list, [
        { key: 'label', label: 'Compound', render: c => h('div', {}, h('strong', {}, c.asset ? assetLink(c.asset, c.label ?? undefined) : c.label ?? 'Compound'), h('div.small.faint', {}, new Date(c.createdAt).toLocaleString(), ' · ', RECIPES[c.recipe]?.[0] ?? c.recipe)) },
        { key: 'inputs', label: 'Used', render: c => h('div.small', {}, assetList(c.inputs, ' + '), c.amount ? h('div.muted', {}, `→ ${fmtInt(c.amount)} unit${c.amount === '1' ? '' : 's'}`) : null) },
        { key: 'state', label: 'State', render: c => h('div.stack', { style: { gap: '4px', alignItems: 'flex-start' } }, pill(...(CRAFT_STATE[c.state] ?? [words(c.state), ''])), h('div.small.muted', {}, craftNote(c)),
          ['failed', 'uncertain', 'queued', 'waiting'].includes(c.state) && c.error !== 'craft_rejected' && !['craft_authorization', 'craft_output', 'craft_outcome_unknown'].includes(c.error)
            ? h('button.btn.sm', { title: 'Sends the same saved craft again; it cannot happen twice.', onclick: event => retryCraft(c, event.currentTarget) }, 'Retry') : null) },
      ], { sortable: false })] : h('div.empty', {}, 'No crafts yet. Crafts appear here with their progress.'));
  };
  // A compound's next step on TAP: its first maker deploys the token once; then holders make units real.
  const COMPOUND_TOKEN = { deployed: ['token deployed', 'good'], not_deployed: ['not deployed', 'warn'], unknown: ['unknown', ''] };
  const compoundToken = c => {
    const [label, kind] = COMPOUND_TOKEN[c.token] ?? COMPOUND_TOKEN.unknown, stack = (...items) => h('div.stack', { style: { gap: '4px', alignItems: 'flex-start' } }, pill(label, kind), ...items);
    if (c.token === 'deployed') {
      const amount = input({ value: c.available, inputmode: 'numeric', 'aria-label': 'Units to make real', style: { width: '72px', height: '30px' } });
      const fee = c.tier ? feePrice(store.status?.feePolicy, 'compound', c.tier) : 'the compound fee';
      return stack(c.ticker ? h('div.small.muted', {}, 'Ticker ', h('a.mono', { href: assetHref(c.asset) }, c.ticker)) : null, h('div.row', { style: { gap: '6px' } }, amount,
        h('button.btn.sm.primary', { disabled: c.available === '0', onclick: event => mintCompound(c, amount.value.trim(), event.currentTarget) }, 'Make real on TAP')),
        h('div.small.muted', {}, `Quoted fee ${fee} per mint from your TAP Wallet (all tiers share one amount under flat fees); the units leave your agent and arrive as TAP tokens at your payout wallet.`),
        tickerPicks.get(c.asset)?.label() ? h('div.small.muted', {}, 'into ', h('a.mono', { href: assetHref(c.asset) }, tickerPicks.get(c.asset).label())) : null,
        tickersButton(c.asset, nameOf(c.asset, c.name), compoundTickers, true));
    }
    if (c.token === 'not_deployed' && c.firstMaker && c.needsRefine) return stack(
      h('button.btn.sm', { disabled: true, title: 'Refine its tier first.' }, 'Deploy its TAP token'),
      h('div.small.muted', {}, 'You made it first, so you deploy its TAP token once. Refine its tier first; then deploy it here.'));
    if (c.token === 'not_deployed' && c.firstMaker && c.deploymentLink) return stack(
      h('a.btn.sm.primary', { href: localPath(c.deploymentLink) }, 'Deploy its TAP token'),
      h('div.small.muted', {}, 'You made it first, so you deploy its TAP token once with your TAP Wallet (one inscription; it costs only Bitcoin network fees). Then holders can make units real.'));
    if (c.token === 'not_deployed') return stack(h('div.small.muted', {}, 'Its first maker deploys its TAP token first. Then you can make your units real here.'));
    return stack(h('div.small.muted', {}, 'Could not read its token state. It is read again on the next refresh.'));
  };
  const mintCompound = (c, amount, button) => act('', async () => {
    if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > BigInt(c.available)) { say(`Enter a whole number of units from 1 to ${fmtInt(c.available)}.`, 'bad'); return; }
    const status = toast({ what: `Making ${amount} ${nameOf(c.asset, c.name)} real`, detail: 'Your agent is signing the mint request…', state: 'queued' });
    button.disabled = true; button.textContent = 'Signing…'; button.classList.add('busy');
    let result;
    const deployment = tickerPicks.get(c.asset)?.value();
    try { result = await api('/api/mint-compound', { asset: c.asset, amount, ...(deployment ? { deployment } : {}) }); }
    catch (error) { status.set({ state: 'failed', detail: words(error.message) }); button.disabled = false; button.textContent = 'Make real on TAP'; button.classList.remove('busy'); throw error; }
    if (result.requestId) {
      status.set({ state: 'complete', detail: result.replayed ? `Your earlier request for ${fmtInt(result.amount)} units is still open. Pay and inscribe it first.` : 'Request ready. Pay and inscribe with your wallet.' });
      go('/mint/' + result.requestId); return;
    }
    status.set({ state: 'complete', detail: words(result.state ?? 'Request saved; it appears under Open requests.') });
    say(words(result.state ?? 'Request is being prepared. It appears under Open requests.'));
    await load();
  });
  const REFINE_NOTE = 'The exact tier of this compound is not settled yet. Refine lets your agent finish that calculation on Trac: free, it uses no units, and the compound stays the same.';
  const drawCompounds = () => {
    const list = craft?.compounds ?? [];
    clear(compoundsBody, list.length ? table(list, [
      { key: 'name', label: 'Compound', render: c => h('div', {}, h('strong', {}, h('span.swatch', { style: { background: mineral(c.asset) } }), assetLink(c.asset, c.name)), h('div.small.faint', {}, hashEl(c.asset, '#' + c.asset.slice(3, 11)))) },
      { key: 'tier', label: 'Tier', render: c => c.needsRefine ? h('div.stack', { style: { gap: '4px', alignItems: 'flex-start' } }, pill('not settled', 'warn', REFINE_NOTE),
        c.refine && ['crafting', 'received', 'waiting'].includes(c.refine.state) ? h('div.small.muted', {}, craftNote(c.refine))
          : h('button.btn.sm', { title: REFINE_NOTE, onclick: event => refine(c.asset, event.currentTarget) }, 'Refine'),
        c.refine?.state === 'failed' ? h('div.small', { style: { color: 'var(--bad)' } }, craftWords(c.refine.error)) : null) : tierBadge(c.tier) },
      { key: 'amount', label: 'Units', num: true, render: c => h('div', {}, h('span.mono', {}, fmtInt(c.amount)), c.available !== c.amount ? h('div.small.faint', {}, `${fmtInt(c.available)} available`) : null) },
      { key: 'from', label: 'Made from', render: c => c.from.length ? h('div.small', {}, c.from.map((i, n) => [n ? ' + ' : '', assetLink(i.asset, store.pattern(i.asset) || store.compound(i.asset) || !i.name ? assetName(i.asset) : i.name)]),
        h('div.muted', {}, [RECIPES[c.recipe]?.[0] ?? c.recipe, 'recipe ' + c.from.map(i => i.amount).join(' : '), c.generation === null || c.generation === undefined ? null : 'generation ' + c.generation].filter(Boolean).join(' · '))) : h('span.faint', {}, '–') },
      { key: 'token', label: 'On TAP', render: compoundToken },
    ], { sortable: false }) : h('div.empty', {}, 'No compounds yet. Craft one above; it appears here and under Send units.'));
    compoundsBody.append(compoundTickers);
    if (list.some(c => c.needsRefine)) compoundsBody.append(h('p.small.muted', { style: { margin: 0, padding: '10px 14px', borderTop: '1px solid var(--rule-2)' } }, REFINE_NOTE));
  };
  // A refresh redraws the picker only when the ingredients changed and nobody types in it.
  async function loadCraft(force = false) {
    let data;
    try { data = await api('/api/craft'); } catch (error) { if (!stopped && !craft) clear(craftBody, h('div.callout.bad', {}, 'Could not load crafting: ' + craftWords(error.message))); return; }
    if (stopped) return;
    craft = data; drawCrafts(); drawCompounds();
    for (const asset of [...picked.keys()]) if (!ingredientOf(asset)?.craftable) picked.delete(asset);
    const key = JSON.stringify(craft.ingredients);
    if (force || key !== craftKey && !craftBody.contains(document.activeElement)) { craftKey = key; drawCraft(); }
    if (force && (craft.crafts.some(c => c.state === 'confirmed') || craft.compounds.length)) await loadUnits(true).catch(() => {});
  }
  const craftActive = () => craft?.crafts.some(c => ['crafting', 'received', 'waiting'].includes(c.state));
  clear(claimsPanel, panel('Claimed blocks you may mint', h('div', {}, h('p.muted', { style: { margin: 0, padding: '10px 14px', borderBottom: '1px solid var(--rule-2)' } },
    'During the finder’s week only the finder mints; afterwards any agent can. Bitmap holders earn 15% of every mint on their plot. Minting requires enough units. Unclaimed blocks after their week are public: see ', h('a', { href: '/mint' }, 'Mint'), '.'), filter, claims, pager), { flush: true }));
  clear(el, h('div.page', {},
    h('div.page-head', {}, h('div.grow', {}, h('h1', {}, 'My agent'), h('p', {}, 'Your agent’s patterns and claimed blocks, with one click to deploy or mint, compounds to craft, units to send on Trac, and its TNK. Everything else on this dashboard is the live site.'))),
    h('div.stack', {}, note, profile,
      panel('Your patterns', h('div', {}, h('p.muted', { style: { margin: 0, padding: '10px 14px', borderBottom: '1px solid var(--rule-2)' } },
        'Patterns your agent discovered or holds claims in. A new pattern is minted only after its token is deployed: inscribe the pattern, then deploy the token, each with your TAP Wallet.'), patternList), { flush: true }),
      claimsPanel,
      h('div.grid.cols-main', { style: { alignItems: 'start' } },
        panel('Craft a compound', craftBody, { tip: CRAFT_NOTE }),
        panel('Your compounds', compoundsBody, { flush: true })),
      clear(craftsPanel, panel('Recent crafts', craftsBody, { flush: true })),
      h('div.grid.cols-main', { style: { alignItems: 'start' } },
        panel('Send units on Trac', sendBody, { tip: TRAC_NOTE }),
        panel('Your Trac address', receiveBody)),
      clear(sendsPanel, panel('Recent sends on Trac', sendsBody, { flush: true })),
      h('div.grid.cols-main', { style: { alignItems: 'start' } },
        panel('Send TNK', tnkBody, { tip: 'TNK is the Trac network’s own coin (gas) with real value. Each send costs a network fee. ' + TNK_NOTE }),
        panel('TNK (Trac network gas)', tnkCard)),
      clear(tnkSendsPanel, panel('Recent TNK sends', tnkSendsBody, { flush: true })),
      h('div.grid.cols-main', {},
        panel('Open requests', h('div', {}, requests, requestPager), { flush: true }),
        panel('Bitmap links', h('div', {}, h('p.muted', { style: { margin: 0, padding: '10px 14px', borderBottom: '1px solid var(--rule-2)' } }, 'Earn the Bitmap holder share for a block you hold as a .bitmap. ',
          h('a.btn.sm.primary', { href: '/link#bitmap' }, 'Link a Bitmap')), links, linkPager), { flush: true })))));
  act('Loading your agent…', load).then(() => { if (!stopped && note.textContent === 'Loading your agent…') clear(note); });
  const timer = setInterval(() => { if (!busy && !document.hidden) load().catch(() => {}); }, 15000);
  // Sends in progress refresh faster: sent → confirmed in a batch.
  const sendTimer = setInterval(() => {
    if (document.hidden) return;
    if (sendsActive()) loadSends().catch(() => {});
    if (craftActive()) loadCraft().catch(() => {});
    if (tnkActive()) loadTnkSends().then(() => tnkActive() ? null : loadTnk()).catch(() => {});
  }, 4000);
  return () => { stopped = true; clearInterval(timer); clearInterval(sendTimer); };
}
