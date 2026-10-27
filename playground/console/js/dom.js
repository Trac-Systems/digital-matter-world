import { isTracAddress, shortTracAddress } from '../../../rules/src/trac-address.js';
import { fmtInt, fmtAmount } from './amount-format.js';
export { fmtInt, fmtAmount } from './amount-format.js';
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function clear(el, ...children) { el.replaceChildren(); append(el, children); return el; }

export function logo() {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  p.setAttribute('d', 'M12 12h3v3H9V9h9v9H6V6h15'); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.75');
  svg.append(p); return svg;
}

export function short(s, a = 6, b = 4) { s = String(s ?? ''); if (isTracAddress(s)) return shortTracAddress(s); return s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s; }
export function ago(ms) {
  if (!ms) return '–';
  const d = Math.max(0, Date.now() - ms) / 1000;
  if (d < 5) return 'just now';
  if (d < 60) return `${Math.floor(d)} s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}
export function clock(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) : '–'; }
export const isHexId = v => typeof v === 'string' && /^(0x)?[0-9a-fA-F]{20,}$/.test(v);
export const looksAddress = v => typeof v === 'string' && /^(trac1|bcrt1|tb1|bc1)[0-9a-z]{20,}$/.test(v);

export function hashEl(v, label) {
  if (v === null || v === undefined || v === '') return h('span.faint', {}, '–');
  return h('span.hash', { title: String(v), role: 'button', tabindex: 0, 'aria-label': `Copy ${v}`, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(String(v)); } }, 'data-tip': `${v}\nClick to copy`, onclick: e => { e.stopPropagation(); copy(String(v)); } }, label ?? short(v, 8, 6));
}
export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast({ what: 'Copied', detail: short(text, 18, 10), state: 'complete', ttl: 1800 }); }
  catch { toast({ what: 'Copy failed', detail: 'The browser refused clipboard access.', state: 'failed', ttl: 3000 }); }
}
export function pill(text, kind = '', tip) { return h(`span.pill${kind ? '.' + kind : ''}`, tip ? { 'data-tip': tip } : {}, text); }
export function tipIcon(text) { return h('span.tipicon', { 'data-tip': text, tabindex: 0, 'aria-label': text }, '?'); }
export function tierBadge(t) { return t ? h('span.tier', { 'data-tip': `Rarity tier ${t} of 5. Higher tiers are rarer and cost more to mint on-chain.` }, `T${t}`) : h('span.faint', {}, '–'); }

// Tooltip: one floating element driven by data-tip attributes anywhere in the page.
let tipEl;
export function installTooltips() {
  tipEl = h('div', { id: 'tooltip', role: 'tooltip' });
  document.body.append(tipEl);
  let current = null;
  const show = target => {
    current = target;
    tipEl.textContent = '';
    for (const [i, line] of target.getAttribute('data-tip').split('\n').entries()) { if (i) tipEl.append(h('br')); tipEl.append(line); }
    const r = target.getBoundingClientRect();
    tipEl.classList.add('on');
    const w = tipEl.offsetWidth, ht = tipEl.offsetHeight;
    let x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    let y = r.top - ht - 8; if (y < 8) y = r.bottom + 8;
    tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
  };
  const hide = () => { current = null; tipEl.classList.remove('on'); };
  document.addEventListener('pointerover', e => { const t = e.target.closest?.('[data-tip]'); if (t && t !== current) show(t); else if (!t && current) hide(); });
  document.addEventListener('focusin', e => { const t = e.target.closest?.('[data-tip]'); if (t) show(t); });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, true);
}

// Generic table: columns are {key, label, num, render(row), tip, sort}.
export function table(rows, columns, { empty = 'Nothing here yet.', onRow, selected, group, sortable = true, max } = {}) {
  if (!rows?.length) return h('div.empty', {}, empty);
  let sortKey = null, dir = 1;
  const wrap = h('div.tablewrap');
  const draw = () => {
    let list = [...rows];
    if (sortKey) {
      const col = columns.find(c => c.key === sortKey), val = col.sort ?? (r => r[col.key]);
      list.sort((a, b) => cmp(val(a), val(b)) * dir);
    }
    if (max && list.length > max) list = list.slice(0, max);
    const head = h('tr', {}, columns.map(c => {
      const th = h(`th${c.num ? '.num' : ''}`, {}, c.label, c.tip ? tipIcon(c.tip) : null);
      if (sortable && c.sortable !== false) {
        th.classList.add('sort');
        if (sortKey === c.key) th.classList.add(dir > 0 ? 'asc' : 'desc');
        th.addEventListener('click', () => { if (sortKey === c.key) dir = -dir; else { sortKey = c.key; dir = c.num ? -1 : 1; } draw(); });
      }
      return th;
    }));
    const body = h('tbody');
    let lastGroup;
    for (const r of list) {
      if (group && !sortKey) {
        const g = group(r);
        if (g !== lastGroup) { body.append(h('tr.group', {}, h('td', { colSpan: columns.length }, g))); lastGroup = g; }
      }
      const tr = h('tr', { class: [onRow ? 'click' : '', selected?.(r) ? 'sel' : ''].join(' ') });
      if (onRow) tr.addEventListener('click', () => onRow(r));
      for (const c of columns) {
        const v = c.render ? c.render(r) : r[c.key];
        tr.append(h(`td${c.num ? '.num' : ''}`, {}, v instanceof Node ? v : (v === null || v === undefined || v === '' ? h('span.faint', {}, '–') : /^\d{13,}$/.test(String(v)) ? cell(String(v)) : c.num ? h('span.mono', {}, fmtInt(v)) : String(v))));
      }
      body.append(tr);
    }
    clear(wrap, h('table.t', {}, h('thead', {}, head), body));
    if (max && rows.length > max) wrap.append(h('div.empty.small', {}, `Showing ${max} of ${fmtInt(rows.length)}.`));
  };
  draw();
  return wrap;
}
function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  const na = typeof a === 'number' || /^-?\d+$/.test(a), nb = typeof b === 'number' || /^-?\d+$/.test(b);
  if (na && nb) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  return String(a).localeCompare(String(b));
}
export function kv(pairs) {
  const rows = pairs.filter(Boolean).map(([k, v, tip]) => h('tr', {}, h('th', {}, k, tip ? tipIcon(tip) : null),
    h('td', {}, v instanceof Node ? v : v === null || v === undefined || v === '' ? h('span.faint', {}, '–') : String(v))));
  return h('div.tablewrap', {}, h('table.t.kv', {}, h('tbody', {}, rows)));
}
// Auto columns for rows whose exact shape is not fixed by the API.
export function autoColumns(rows, prefer = [], skip = []) {
  const keys = [];
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r ?? {})) if (!keys.includes(k) && !skip.includes(k)) keys.push(k);
  keys.sort((a, b) => rank(a) - rank(b));
  function rank(k) { const i = prefer.indexOf(k); return i === -1 ? 100 : i; }
  return keys.slice(0, 9).map(k => ({ key: k, label: labelFor(k), num: rows.every(r => r[k] === undefined || r[k] === null || typeof r[k] === 'number' || (/^\d+$/.test(r[k]) && String(r[k]).length < 20)), render: r => cell(r[k]) }));
}
const LABELS = { height: 'Block', block: 'Block', asset: 'Matter', amount: 'Amount', owner: 'Owner', finder: 'Finder', txid: 'Transaction', inscription: 'Inscription', id: 'ID', state: 'State', status: 'Status', kind: 'Paid with', to: 'To', from: 'From', at: 'Time', created: 'Created', pattern: 'Pattern', count: 'Units', role: 'Role', tick: 'Ticker', ticker: 'Ticker', tap: 'TAP', erc20: 'Bridged TAP held', bitcoin: 'Bitcoin address', ethereum: 'Ethereum address' };
export function labelFor(k) { return LABELS[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()); }
export function cell(v) {
  if (v === null || v === undefined || v === '') return h('span.faint', {}, '–');
  if (typeof v === 'boolean') return v ? pill('yes', 'good') : pill('no');
  if (typeof v === 'number') return h('span.mono', {}, fmtInt(v));
  if (typeof v === 'string') {
    // Long integers are atomic amounts whose unit this generic cell cannot know; they stay in Inspect.
    if (/^\d{13,}$/.test(v)) return h('button.linkbtn', { onclick: e => { e.stopPropagation(); inspect('Raw value', v); } }, 'raw amount');
    if (/^\d+$/.test(v)) return h('span.mono', {}, fmtInt(v));
    if (isHexId(v) || looksAddress(v) || v.length > 40) return hashEl(v);
    return v;
  }
  if (Array.isArray(v)) return v.length ? h('button.linkbtn', { onclick: e => { e.stopPropagation(); inspect('Details', v); } }, `${v.length} item${v.length === 1 ? '' : 's'}`) : h('span.faint', {}, 'none');
  return h('button.linkbtn', { onclick: e => { e.stopPropagation(); inspect('Details', v); } }, 'details');
}

// Inspect drawer: raw internals live only here.
export function inspect(title, value) {
  const close = () => { back.remove(); drawer.remove(); removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const back = h('div.drawer-back', { onclick: close });
  const drawer = h('aside.drawer', { role: 'dialog', 'aria-label': `Inspect ${title}` },
    h('header', {}, h('div.grow', {}, h('h2', {}, 'Inspect'), h('div.small.muted', {}, title)),
      h('button.btn.sm.ghost', { onclick: () => copy(text) }, 'Copy JSON'), h('button.btn.sm', { onclick: close }, 'Close')),
    h('pre', { html: highlight(text) }));
  document.body.append(back, drawer);
  addEventListener('keydown', onKey);
}
function highlight(json) {
  const esc = json.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return esc.replace(/("(\\.|[^"\\])*")(\s*:)?|\b(-?\d+(\.\d+)?|true|false|null)\b/g, (m, str, _i, colon, num) =>
    str ? (colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`) : `<span class="n">${num}</span>`);
}
export function inspectBtn(title, get) { return h('button.linkbtn', { onclick: e => { e.stopPropagation(); inspect(title, typeof get === 'function' ? get() : get); } }, 'Inspect'); }

// Confirmation modal: a summary table of exactly what will happen.
export function confirmModal({ title, lead, rows = [], extra, confirm = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const done = v => { back.remove(); removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') done(false); };
    const ok = h(`button.btn.${danger ? 'danger' : 'primary'}`, { onclick: () => done(true) }, confirm);
    const back = h('div.modal-back', { onclick: e => { if (e.target === back) done(false); } },
      h('div.modal', { role: 'dialog', 'aria-modal': 'true' },
        h('header', {}, h('h2', {}, title), lead ? h('p', {}, lead) : null),
        rows.length ? h('div.body', {}, kv(rows)) : null,
        extra ? h('div', { style: { padding: '4px 18px 12px' } }, extra) : null,
        h('footer', {}, h('button.btn.ghost', { onclick: () => done(false) }, 'Cancel'), ok)));
    document.body.append(back);
    addEventListener('keydown', onKey);
    ok.focus();
  });
}

// Toasts for jobs and short notices.
let toastBox;
export function toast({ what, detail, state = 'queued', ttl = 0, onInspect }) {
  toastBox ??= document.getElementById('toasts');
  const dot = h('span.dot');
  const detailEl = h('div.detail', {}, detail ?? '');
  const el = h('div.toast', { role: 'status' }, dot, h('div.what', {}, what), h('button.x', { 'aria-label': 'Dismiss', onclick: () => el.remove() }, '×'), detailEl);
  const set = ({ state: s, detail: d, inspect: data }) => {
    dot.className = `dot ${s === 'complete' ? 'good' : s === 'failed' ? 'bad' : 'warn'}`;
    if (d !== undefined) clear(detailEl, d);
    if (data !== undefined) detailEl.append(' ', inspectBtn(what, data));
    if (s === 'complete' || s === 'failed') setTimeout(() => el.remove(), s === 'failed' ? 14000 : 6000);
  };
  set({ state, detail });
  if (onInspect) detailEl.append(' ', inspectBtn(what, onInspect));
  toastBox.prepend(el);
  while (toastBox.children.length > 5) toastBox.lastChild.remove();
  if (ttl) setTimeout(() => el.remove(), ttl);
  return { set, el };
}

export function panel(title, body, { actions, tip, flush = false, id } = {}) {
  return h('section.panel', id ? { id } : {},
    h('header', {}, h('h2', {}, title), tip ? tipIcon(tip) : null, h('div.grow'), actions ?? null),
    h(flush ? 'div.flush' : 'div.body', {}, body));
}
export function tabs(items, onPick, current) {
  const bar = h('div.tabs', { role: 'tablist' });
  for (const [id, label] of items) bar.append(h(`button${id === current ? '.on' : ''}`, { role: 'tab', 'aria-selected': id === current ? 'true' : 'false', onclick: () => onPick(id) }, label));
  return bar;
}
export function seg(items, value, onPick) {
  const el = h('div.seg', { role: 'group' });
  for (const [id, label] of items) el.append(h(`button${id === value ? '.on' : ''}`, { type: 'button', onclick: () => onPick(id) }, label));
  return el;
}
export function field(label, input, hint) { return h('div.field', {}, h('label', {}, label), input, hint ? h('div.hint', {}, hint) : null); }
export function input(attrs = {}) { return h('input.input', attrs); }
export function select(options, attrs = {}) {
  const el = h('select.input', attrs);
  for (const o of options) { const [v, l] = Array.isArray(o) ? o : [o, o]; el.append(h('option', { value: v }, l)); }
  if (attrs.value !== undefined) el.value = attrs.value;
  return el;
}
export function figures(items) {
  return h('div.figures', {}, items.map(([k, v, u, tip]) => h('div', tip ? { 'data-tip': tip } : {}, h('div.k', {}, k), h('div.v', {}, v ?? '–'), u ? h('div.u', {}, u) : null)));
}
