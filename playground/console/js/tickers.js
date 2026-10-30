// Several TAP tokens ("tickers") per pattern or compound. The first deployment is the official one; once it
// exists anyone can deploy another ticker under a name they choose. All tickers share the pattern's units, and
// every mint pays the same rewards whichever ticker it goes to.
// The ticker list read is the switch: before the feature opens the gateway refuses (or lacks) it, and every
// control here stays hidden.
import { h, clear, hashEl, pill, fmtInt, field, input, select, kv, short } from './dom.js';
import { pagedTable } from './paged.js';
import { get, store } from './api.js';
import { tap } from './money.js';
import { validateChosenTicker } from '../../../rules/src/ticker-grammar.js';

export const SAME_REWARDS = 'Units go to the ticker you choose. The rewards are the same whichever ticker.';
export const OFFICIAL_FIRST = 'The official token is deployed first. Once it exists, anyone can deploy another ticker for it.';
// Plain words for the gateway's ticker refusals.
export const TICKER_WORDS = {
  ticker_invalid: 'This name cannot be a TAP ticker. Use 1 to 32 characters; it cannot start with “-” or “dmt-”.',
  ticker_occupied: 'This ticker is already taken on TAP. Choose another name.',
  ticker_taken: 'This ticker is already taken on TAP. Choose another name.',
  ticker_conflict: 'This name is the official name of another pattern or compound. Choose another name.',
  ticker_reserved: 'Someone else has a pending request for this ticker. Choose another name, or try again later.',
  official_deployment_required: OFFICIAL_FIRST,
  multi_ticker_inactive: 'Extra tickers are not open yet.',
  ticker_retry_not_terminal: 'Your earlier request for this ticker is still open. Continue it first.',
  ticker_refund_pending: 'The refund of your earlier request is still being recorded. Try again in a few minutes.',
  ticker_payment_binding: 'This payment belongs to another request.',
  ticker_request_missing: 'This ticker request was not found.',
  ticker_expired: 'This request expired before its fee was paid.',
  deployment_content: 'The inscription differs from this ticker’s deployment.',
  deployment_confirmations: 'Not in a Bitcoin block yet. This page keeps checking.',
  invalid_ticker_request: 'Enter a ticker name.',
  no_payout: 'Bind a payout TAP wallet to your agent first.',
};
export const tickerWords = code => TICKER_WORDS[code] ?? String(code ?? '').replace(/_/g, ' ');

// The gateway's own ticker grammar; the gateway checks again.
export const chosenTicker = text => validateChosenTicker(String(text ?? ''));

// The deploy fee before a quote: base fee times the ticker multiplier of the live settings; none means free.
export function deployFeeText(status = store.status) {
  const multiplier = status?.settings?.values?.tickerDeployMultiplier, base = status?.feePolicy?.baseFee;
  if (!multiplier) return 'free';
  if (!Number.isSafeInteger(multiplier) || !/^(0|[1-9]\d*)$/.test(base ?? '')) return 'shown before you pay';
  return tap((BigInt(base) * BigInt(multiplier)).toString(), status.feePolicy.unit);
}
export const quoteFeeText = fee => fee?.price === undefined || fee.price === null ? deployFeeText() : BigInt(fee.price) === 0n ? 'free' : tap(fee.price, fee.unit);

const path = asset => `/assets/${asset}/tickers`;
// First pages, kept a minute. null: extra tickers are not open (or this gateway has no ticker list).
const firstPages = new Map(), KEEP_MS = 60000;
let closedUntil = 0;
export function tickers(asset) {
  if (Date.now() < closedUntil) return Promise.resolve(null);
  const hit = firstPages.get(asset);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.value;
  const value = get(`${path(asset)}?limit=50`).then(r => Array.isArray(r?.rows) ? r.rows : null, error => {
    if (error?.status === 404 || error?.message === 'multi_ticker_inactive' || error?.message === 'not_found') closedUntil = Date.now() + KEEP_MS;
    firstPages.delete(asset); return null;
  });
  firstPages.set(asset, { at: Date.now(), value });
  return value;
}
export const forgetTickers = asset => firstPages.delete(asset);
// Whether extra tickers are open at all, asked of one known pattern.
export const tickersOpen = () => tickers(store.patterns?.patterns?.find(p => p.asset)?.asset ?? 'p2:0').then(rows => !!rows);
// Shows `el` only once extra tickers are open for this asset.
// (display, not hidden: a .btn sets its own display.)
export function whenTickers(asset, el) { el.style.display = 'none'; tickers(asset).then(rows => { if (rows) el.style.display = ''; }); return el; }
const official = row => row?.ordinal === '1' || row?.ordinal === 1;
const inscriptionLink = id => /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/.test(id ?? '')
  ? h('a', { href: 'https://ordinals.com/inscription/' + id, target: '_blank', rel: 'noreferrer noopener', title: id }, 'Deploy inscription') : null;
export const tickerLabel = row => h('span.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, h('span.mono', {}, row.tick ?? row.ticker), official(row) ? pill('Official', 'good') : null);

// "Tokens on TAP": the official ticker first, then the others, a page at a time. Hidden until the feature is open.
export function tickerList(asset, { title = 'Tokens on TAP', label = true } = {}) {
  const box = h('div', { hidden: true });
  tickers(asset).then(rows => {
    if (!rows) return;
    const list = pagedTable({ path: path(asset), key: 'rows', limit: 25, cursorParam: 'after',
      empty: OFFICIAL_FIRST, onError: () => { box.hidden = true; return true; },
      // Three columns fit the side panel and a phone; the deploy inscription link sits under its ticker.
      columns: [
        { key: 'tick', label: 'Ticker', render: r => h('div', {}, tickerLabel(r), h('div.small', {}, inscriptionLink(r.deploymentId))) },
        { key: 'deployer', label: 'Deployer', render: r => r.deployer ? hashEl(r.deployer, short(r.deployer)) : h('span.faint', {}, '–') },
        { key: 'unitsMinted', label: 'Units minted', num: true, render: r => r.unitsMinted === null || r.unitsMinted === undefined ? h('span.faint', {}, '–') : h('span.mono', {}, fmtInt(r.unitsMinted)) },
      ] });
    list.el.classList.add('public-mints');
    clear(box, label ? h('div.section-label', {}, title) : null, list.el,
      h('p.small.muted', { style: { margin: 0, padding: '8px 14px 12px' } }, 'All tickers share this pattern’s units: a unit minted into one ticker cannot be minted into another. Every mint pays the same rewards, plus a share to the holder of that ticker’s deploy inscription.'));
    box.hidden = false;
  });
  return box;
}

// The ticker a mint goes to, Official by default. Shown only when there is more than one ticker.
// value() is the chosen deployment inscription, or null for the official one; label() its ticker.
// single: text shown instead when there is only the official ticker.
export function tickerChoice(asset, { onChange, single } = {}) {
  const el = h('div', { hidden: true });
  let chosen = null, names = new Map();
  tickers(asset).then(rows => {
    if (rows?.length === 1 && single) { clear(el, h('div.small.muted', {}, single)); el.hidden = false; }
    if (!rows || rows.length < 2) return;
    const sorted = [...rows.filter(official), ...rows.filter(r => !official(r))];
    names = new Map(sorted.map(r => [official(r) ? '' : r.deploymentId, r.tick]));
    const pick = select(sorted.map(r => [official(r) ? '' : r.deploymentId, official(r) ? `${r.tick} · Official` : r.tick]),
      { value: '', 'aria-label': 'Ticker', onchange: e => { chosen = e.target.value || null; onChange?.(chosen); } });
    clear(el, h('label.pager-ctl', {}, h('span', {}, 'Ticker'), pick), h('div.small.muted', { style: { marginTop: '4px' } }, SAME_REWARDS));
    el.hidden = false;
  });
  return { el, value: () => chosen, label: () => chosen ? names.get(chosen) ?? null : null };
}

// "Deploy your own ticker": a name with live checks, the fee, then the request and its payment page.
// request(ticker) prepares it on the gateway and returns the request; open(job) continues to its page.
// toggle: start as one quiet button that opens the form; padded: inside a flush panel.
export function deployTickerForm(asset, { request, open, compound = false, compact = false, toggle = false, padded = false } = {}) {
  const el = h('div', { hidden: true, style: padded ? { padding: '10px 14px' } : {} });
  tickers(asset).then(rows => {
    if (!rows) return;
    el.hidden = false;
    if (!rows.length) { clear(el, h('p.small.muted', { style: { margin: 0 } }, OFFICIAL_FIRST)); return; }
    if (toggle) clear(el, h('button.btn.sm', { type: 'button', onclick: () => form(rows) }, 'Deploy your own ticker'));
    else form(rows);
  });
  const form = rows => {
    const hint = h('div.hint', { role: 'status', 'aria-live': 'polite' }), fee = h('span.mono', {}, deployFeeText());
    const note = h('div.callout', { role: 'status', 'aria-live': 'polite' });
    const taken = new Set(rows.map(r => String(r.tick ?? '').toLowerCase()));
    let typing, asked = 0, ok = false;
    const show = (text, bad) => { hint.textContent = text; hint.style.color = bad ? 'var(--bad)' : ''; };
    const check = async () => {
      const seq = ++asked, text = name.value;
      ok = false; go.disabled = true; clear(note); note.className = 'callout';
      if (!text) { show(''); return; }
      let tick;
      try { tick = chosenTicker(text); } catch (error) { show(tickerWords(error.message), true); return; }
      if (taken.has(tick)) { show('This ticker already belongs to this ' + (compound ? 'compound' : 'pattern') + '. Choose another name.', true); return; }
      show('Checking…');
      // Another pattern's official name; the gateway also checks compounds, TAP itself and pending requests.
      const names = await get('/patterns?' + new URLSearchParams({ q: tick, limit: '10' })).then(r => r.patterns ?? [], () => []);
      if (seq !== asked) return;
      if (names.some(p => String(p.name).toLowerCase() === tick || String(p.name).toLowerCase() === 'dmt-' + tick)) { show(TICKER_WORDS.ticker_conflict, true); return; }
      ok = true; go.disabled = false;
      show(`“${tick}” looks free. Continue checks it on TAP and against pending requests.`);
    };
    const name = input({ placeholder: 'Ticker name', 'aria-label': 'Ticker name', maxlength: 64, autocomplete: 'off', spellcheck: 'false',
      oninput: () => { clearTimeout(typing); ok = false; go.disabled = true; typing = setTimeout(() => void check(), 250); } });
    const go = h('button.btn.primary', { type: 'button', disabled: true, onclick: async () => {
      if (!ok) return;
      go.disabled = true; go.classList.add('busy'); note.className = 'callout busy'; note.textContent = 'Checking the name on TAP…';
      try {
        const job = await request(chosenTicker(name.value));
        forgetTickers(asset);
        note.className = 'callout info';
        clear(note, 'Name reserved for you. Deploy fee: ', h('strong.mono', {}, quoteFeeText(job.fee)), '. ', job.fee && BigInt(job.fee.price ?? 0) > 0n ? 'You pay it from your TAP Wallet on the next page.' : 'Next, inscribe the deploy from your TAP Wallet.');
        open?.(job);
      } catch (error) {
        // A refused name is said once, under the field; anything else in the callout.
        if (['ticker_occupied', 'ticker_taken', 'ticker_conflict', 'ticker_reserved', 'ticker_invalid'].includes(error.message)) { show(tickerWords(error.message), true); ok = false; clear(note); note.className = 'callout'; }
        else { note.className = 'callout bad'; note.textContent = tickerWords(error.message); }
      } finally { go.classList.remove('busy'); go.disabled = !ok; }
    } }, 'Continue');
    clear(el, h('div.stack', { style: { gap: '10px' } },
      compact ? null : h('p', { style: { margin: 0 } }, 'Deploy another TAP token for this ' + (compound ? 'compound' : 'pattern') + ' under a name you choose. It shares the units of the official token; whoever holds its deploy inscription earns a share of every mint into it.'),
      field('Your ticker', name, hint),
      kv([['Deploy fee', fee, 'Set by the operator. The exact fee is quoted before you pay.']]),
      h('div.row', {}, go), note));
    if (toggle) name.focus();
  };
  return el;
}
