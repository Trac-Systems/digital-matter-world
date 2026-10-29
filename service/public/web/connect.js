// One wallet connection for the whole site. The header control, the World block panel and the wallet pages
// all read this state; a page asks to connect only a wallet the header does not have yet.
import { h, clear, hashEl, copy, short } from './console/js/dom.js';
import { walletError } from './console/js/wallet-errors.js';
import { api, enc } from './data.js';
import { tapAccount, ethAccount } from './wallets.js';

export const NAMES = { tap: 'TAP Wallet', ethereum: 'MetaMask' };
export const PURPOSE = {
  tap: 'Pays mint fees in TAP, receives your agent’s earnings and proves you hold a Bitmap.',
  ethereum: 'Pays with bridged TAP on Ethereum and receives Ethereum-side earnings.',
};
const RAILS = ['tap', 'ethereum'], KEY = 'dmw-web-v1/wallets';
const ADDRESS = { tap: /^(bc1p|bcrt1p)[0-9a-z]{20,90}$/, ethereum: /^0x[0-9a-f]{40}$/ };
const provider = rail => rail === 'tap' ? window.tapprotocol : window.ethereum;
const listeners = new Set();
let target, opener;

// Per rail: { address, players: [{agent, rail}], more, error } or null.
export const wallet = {
  tap: null, ethereum: null,
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  connected() { return RAILS.some(r => this[r]); },
  // The player the connected wallets are linked to (TAP Wallet first).
  player() { for (const r of RAILS) { const p = this[r]?.players?.[0]; if (p) return p; } return null; },
  async connect(rail) {
    target ??= api('/web-api/target').catch(e => { target = undefined; throw e; });
    const found = await (rail === 'tap' ? tapAccount(await target) : ethAccount(await target, undefined, { pick: true }));
    use(rail, found.address); await lookup(rail);
  },
  // Disconnect also withdraws the site's MetaMask grant where supported, so the next connect asks again.
  forget(rail) {
    this[rail] = null; save(); changed();
    if (rail === 'ethereum') provider(rail)?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })?.catch?.(() => {});
  },
  // After a payout binding is accepted the wallet's player changes.
  refresh() { return Promise.all(RAILS.filter(r => this[r]).map(lookup)); },
  open() { opener?.(); },
};
function use(rail, address) { wallet[rail] = { address, players: null }; save(); changed(); }
// The wallet switched accounts (or locked: no accounts) while the site was connected to it.
function switched(rail, accounts) {
  if (!wallet[rail] || !Array.isArray(accounts)) return;
  const address = rail === 'ethereum' ? accounts[0]?.toLowerCase() : accounts[0];
  if (!ADDRESS[rail].test(address ?? '')) { wallet[rail] = null; save(); changed(); return; }
  if (address !== wallet[rail].address) { use(rail, address); void lookup(rail); }
}
function changed() { for (const fn of listeners) { try { fn(wallet); } catch (e) { console.error(e); } } }
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(RAILS.filter(r => wallet[r]).map(r => [r, wallet[r].address])))); } catch {}
}
async function lookup(rail) {
  const address = wallet[rail]?.address;
  if (!address) return;
  let found;
  try { found = await api('/wallets/' + enc(address)); }
  catch (e) { if (wallet[rail]?.address === address) { wallet[rail] = { address, players: [], error: walletError(e) }; changed(); } return; }
  if (wallet[rail]?.address !== address) return;
  wallet[rail] = { address, players: found.players ?? [], more: !!found.more };
  changed();
}
// The remembered choice is shown without opening the wallet; payments still ask it for the account.
{
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch {}
  for (const r of RAILS) if (typeof saved[r] === 'string' && ADDRESS[r].test(saved[r])) wallet[r] = { address: saved[r], players: null };
  void wallet.refresh();
  for (const r of RAILS) {
    const p = provider(r);
    try { p?.on?.('accountsChanged', accounts => switched(r, accounts)); } catch {}
    // An account switched while the page was closed: ask quietly, without a prompt. A locked wallet answers nothing; keep the choice then.
    if (wallet[r]) Promise.resolve(r === 'tap' ? p?.getAccounts?.() : p?.request?.({ method: 'eth_accounts' }))
      .then(accounts => { if (accounts?.length) switched(r, accounts); }, () => {});
  }
}

// The message a person sends their agent (README prompt, step 4).
export const linkMessage = (rail, address) => `Link my payout wallet and give me the link to sign:\n${rail === 'tap' ? 'TAP wallet' : 'MetaMask'}: ${address}`;
export function copyBlock(text, label = 'Copy') {
  return h('div.copyline', {}, h('pre', {}, text), h('button.btn.sm', { type: 'button', onclick: () => copy(text) }, label));
}
// One connected wallet: address, its player, or how to link it.
export function walletSummary(rail, { forget = false, purpose = false } = {}) {
  const w = wallet[rail];
  if (!w) return null;
  const players = w.players;
  return h('div.wallet-row', {},
    h('div.row', {}, h('strong', {}, NAMES[rail]), hashEl(w.address), h('div.grow'), forget ? h('button.linkbtn', { type: 'button', onclick: () => wallet.forget(rail) }, 'Disconnect') : null),
    purpose ? h('div.small.muted', {}, PURPOSE[rail]) : null,
    players === null ? h('div.small.muted', {}, 'Looking up the player…')
      : w.error ? h('div.small.muted', {}, `Player lookup failed: ${w.error}`)
      : players.length ? h('div.small', {}, 'Linked to player ', ...players.map((p, i) => [i ? ', ' : '', h('a.mono', { href: '/agents/' + p.agent }, short(p.agent))]), w.more ? ' and more' : '', '.')
      : [h('div.small', {}, h('strong', {}, 'Not linked to a player yet. '), 'Linking lets your agent’s earnings reach this wallet. Send your agent:'),
        copyBlock(linkMessage(rail, w.address))]);
}
// Connect buttons for the wallets not connected yet, each saying what it is for.
export function connectButtons(rails = RAILS, status) {
  return rails.filter(r => !wallet[r]).map(rail => h('div.wallet-row', {},
    h('button.btn', { type: 'button', onclick: async e => {
      const b = e.currentTarget; b.disabled = true; if (status) clear(status);
      try { await wallet.connect(rail); }
      catch (error) { if (status) clear(status, error.code === 4001 ? 'Connection cancelled.' : walletError(error)); }
      finally { b.disabled = false; }
    } }, rail === 'tap' ? 'Connect TAP wallet' : 'Connect MetaMask'),
    h('div.small.muted', {}, PURPOSE[rail])));
}

// Header: "Connect wallet", or the connected address. The menu lists the wallets, their player and the Mint & wallets page.
export function walletControl() {
  const button = h('button.btn.sm.wallet-btn', { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
  const menu = h('div.wallet-menu', { role: 'dialog', 'aria-label': 'Wallet', hidden: true });
  const status = h('div.note', { role: 'status' });
  const el = h('div.wallet', {}, button, menu);
  const label = () => {
    const w = wallet.tap ?? wallet.ethereum;
    clear(button, w ? [h('span.dot.good'), h('span.mono', {}, short(w.address, 6, 4))] : [h('span.hide-phone', {}, 'Connect wallet'), h('span.show-phone', {}, 'Wallet')]);
  };
  const draw = () => {
    label();
    if (menu.hidden) return;
    const any = wallet.connected();
    clear(menu,
      h('div.wallet-sec', {}, h('h3', {}, any ? 'Connected wallets' : 'Connect a wallet'),
        any ? null : h('p.small.muted', {}, 'One connection for the whole site: minting, Bitmap links and payout wallets.'),
        ['tap', 'ethereum'].map(r => walletSummary(r, { forget: true, purpose: true })), connectButtons(undefined, status), status),
      h('nav.wallet-sec.wallet-jobs', { 'aria-label': 'Wallet page' },
        h('a', { href: '/mint' }, 'Mint & wallets')));
  };
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  const open = () => { menu.hidden = false; button.setAttribute('aria-expanded', 'true'); draw(); };
  button.onclick = () => menu.hidden ? open() : close();
  menu.addEventListener('click', e => { if (e.target.closest('a[href]')) close(); });
  // The path is fixed at dispatch, so a click on a control the menu just redrew still counts as inside.
  document.addEventListener('click', e => { if (!menu.hidden && !e.composedPath().includes(el)) close(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { close(); button.focus(); } });
  // Opened from a button elsewhere: after that click has finished bubbling.
  opener = () => setTimeout(() => { open(); scrollTo(0, 0); });
  wallet.on(draw); label();
  return el;
}
