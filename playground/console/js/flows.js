import { h, clear, toast, kv, pill, hashEl, fmtInt, seg, inspectBtn, tipIcon, confirmModal } from './dom.js';
import { get, post, job, store, refreshSoon } from './api.js';
import { pagedTable } from './paged.js';
import { assetName, mineral, plainError, mintRule, fieldName } from './words.js';
import { tap, btc, fee, splitTable } from './money.js';

// Post an action, follow its job with a toast and resolve with the job result.
export async function run(label, path, body = {}) {
  const t = toast({ what: label, detail: 'Queued', state: 'queued' });
  try {
    const done = await job(post(path, body), { onUpdate: j => t.set({ state: j.state, detail: j.state === 'running' ? 'Running…' : j.state === 'queued' ? 'Queued: jobs run one at a time' : undefined }) });
    t.set({ state: 'complete', detail: summary(done.result), inspect: done });
    refreshSoon(['status', 'player', 'patterns']);
    return done.result ?? done;
  } catch (e) {
    t.set({ state: 'failed', detail: plainError(e.job?.error ?? e.message), inspect: e.job ?? { error: e.message, body: e.body } });
    throw e;
  }
}
function summary(r) {
  if (!r || typeof r !== 'object') return 'Done';
  if (r.mined !== undefined) return `Done · tip ${fmtInt(r.tip)}, ${fmtInt(r.mined)} new block${r.mined === 1 ? '' : 's'}`;
  if (r.newHash) return `Done · ${r.depth} block${r.depth === 1 ? '' : 's'} replaced`;
  if (r.inscription || r.inscriptionId) return 'Done · inscribed on Bitcoin regtest';
  return 'Done';
}

// Mints continue in the player wallet; local Bitmap links use their saved payment intent.
export async function payWhenReady(id, type = 'mint', onWait, onPaying) {
  if (type === 'mint') return mintFlow({ id });
  const t = toast({ what: 'Payment', detail: 'Preparing the Bitmap link payment…', state: 'queued' });
  const deadline = Date.now() + 240000;
  for (let attempt = 0; ; attempt++) {
    try {
      t.set({ state: 'running', detail: 'Paying and including the transaction in a block…' });
      onPaying?.();
      const done = await job(post('/player/pay', { id, type }));
      t.set({ state: 'complete', detail: summary(done.result), inspect: done });
      refreshSoon(['status', 'player', 'patterns']);
      return done.result;
    } catch (e) {
      const reason = e.job?.error ?? e.message;
      if (/not_waiting_payment|enrolling/.test(reason) && Date.now() < deadline) { await sleep(2500); continue; }
      t.set({ state: 'failed', detail: plainError(reason), inspect: e.job ?? { error: e.message } });
      throw e;
    }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const requestId = r => r?.id ?? r?.request?.id ?? r?.requestId;
// Mint requests name their target only inside the signed fee quote scope.
export function requestTarget(r) {
  if (r.asset) return { asset: r.asset, block: r.block ?? null, type: r.type ?? 'mint' };
  try { const [type, asset, block] = JSON.parse(r.feeQuote?.scope ?? '[]'); return { asset: asset ?? null, block: block ?? null, type: type ?? 'mint' }; }
  catch { return { asset: null, block: null, type: 'mint' }; }
}

// A large modal sheet for multi-step flows.
export function sheet(titleText, lead) {
  const body = h('div', { style: { padding: '12px 18px' } });
  const foot = h('footer');
  const close = () => { back.remove(); removeEventListener('keydown', onKey); removeEventListener('hashchange', close); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  addEventListener('hashchange', close);
  const back = h('div.modal-back', { onclick: e => { if (e.target === back) close(); } },
    h('div.modal', { role: 'dialog', 'aria-modal': 'true', style: { width: 'min(720px, 100%)' } },
      h('header', {}, h('div.row', {}, h('h2', { style: { flex: 1 } }, titleText), h('button.btn.sm.ghost', { onclick: close }, 'Close')), lead ? h('p', {}, lead) : null),
      body, foot));
  document.body.append(back);
  addEventListener('keydown', onKey);
  return { body, foot, close };
}
function steps(list, at) {
  return h('div.steps', {}, list.map((s, i) => h(`div${i === at ? '.on' : i < at ? '.done' : ''}`, {}, h('b', {}, i + 1), s)));
}

// Every mint entry point uses the same player-funded payment and inscription flow.
export async function mintFlow(options = {}) {
  return (await import('./inscribe/flow.js')).playerMintFlow(options);
}
export async function compoundMintFlow(asset) {
  return (await import('./inscribe/flow.js')).playerCompoundMintFlow(asset);
}

// Fixed-price actions: base price times the link multiplier, split between burn and treasury.
export function feeTerms(kind) {
  const baseFee = store.status?.feePolicy?.baseFee;
  if (!baseFee) return null;
  const multiplier = store.status?.feePolicy?.feeSettings?.link;
  if (!Number.isSafeInteger(multiplier) || multiplier < 1) return null;
  const total = (BigInt(baseFee) * BigInt(multiplier)).toString();
  const burn = (BigInt(total) * 50n / 100n).toString();
  return { total, multiplier, split: { burn, treasury: (BigInt(total) - BigInt(burn)).toString() } };
}
export async function linkFlow(height) {
  const terms = feeTerms('link');
  if (!await confirmModal({ title: `Link Bitmap ${fmtInt(height)}?`, lead: 'Paid once; the link stays with the Bitmap. Its holder earns the Bitmap holder share of mint fees here.',
    rows: [['Plot', fmtInt(height)], ['Price', terms ? tap(terms.total) : 'Read the current quote'], ['Paid with', 'the test TAP wallet holding the Bitmap']], confirm: 'Link and pay' })) return false;
  try { const req = await run('Bitmap link', '/player/link', { height }); await payWhenReady(requestId(req), 'link'); return true; }
  catch { return false; }
}

