import { h, clear, table, fmtInt, seg, select } from './dom.js';
import { get } from './api.js';

// Rows of a page: its named array, or `items` for nested /list routes.
export function pageRows(r, key) {
  if (!r || typeof r !== 'object') return [];
  return Array.isArray(r[key]) ? r[key] : Array.isArray(r.items) ? r.items : [];
}

// One server page at a time: total count, sort, filters and a cursor pager. Only the current page is rendered.
// opts: path (string or () => string), key, columns, sorts [['key:asc|desc', label]], sort, filters
// [{ name, label, options: [[value, label]], value }], limit, empty (text, or filters => text), onRow, selected, onPage(rows, body), group(rows) to merge rows before rendering,
// render(rows) for a custom body instead of a table, onError(error) returning true when the caller shows the failure itself,
// skipEmpty to read past empty pages of a bounded scan.
export function pagedTable(opts) {
  const state = { sort: opts.sort ?? opts.sorts?.[0]?.[0] ?? null, filters: Object.fromEntries((opts.filters ?? []).map(f => [f.name, f.value ?? ''])), cursors: [null], at: 0, seq: 0, loading: false, count: 0 };
  const limit = opts.limit ?? 50;
  const bar = h('div.pager-bar');
  const body = h('div.pager-body');
  const foot = h('div.pager-foot');
  const error = h('div.note.bad', { role: 'alert', hidden: true });
  const el = h('div.paged', {}, bar, error, body, foot);

  async function load(at = state.at) {
    const seq = ++state.seq;
    state.requestedAt = at;
    state.loading = true;
    el.setAttribute('aria-busy', 'true');
    error.hidden = true;
    for (const button of foot.querySelectorAll('button')) button.disabled = true;
    const params = new URLSearchParams({ limit: String(limit) });
    const cursor = state.cursors[at];
    if (cursor) params.set('cursor', cursor);
    // Sort options are "key:asc|desc".
    if (state.sort) { const [k, o] = state.sort.split(':'); params.set('sort', k); if (o) params.set('order', o); }
    for (const [k, v] of Object.entries(state.filters)) if (v !== '' && v !== null && v !== undefined) params.set(k, v);
    const base = (typeof opts.path === 'function' ? opts.path() : opts.path).replace(/^\/api(?=\/)/, '');
    if (!body.childElementCount) clear(body, h('div.empty', {}, 'Loading…'));
    let r;
    try { r = await get(`${base}${base.includes('?') ? '&' : '?'}${params}`); }
    catch (e) {
      if (seq === state.seq) {
        state.loading = false;
        el.setAttribute('aria-busy', 'false');
        if (opts.onError?.(e)) return;
        if (!state.count) clear(body);
        clear(error, `Could not load this list (${e.message}). `,
          h('button.btn.sm', { onclick: () => { if (!state.loading) load(at); } }, 'Retry'));
        error.hidden = false;
        drawFoot(state.count);
      }
      return;
    }
    if (seq !== state.seq) return;
    const rows = pageRows(r, opts.key);
    // Bounded server scans can return empty pages with a cursor: keep reading instead of showing a blank page.
    for (let pages = 0; opts.skipEmpty && !rows.length && r.next && pages < 60; pages++) {
      const more = new URLSearchParams(params); more.set('cursor', r.next);
      let n;
      try { n = await get(`${base}${base.includes('?') ? '&' : '?'}${more}`); } catch { break; }
      if (seq !== state.seq) return;
      rows.push(...pageRows(n, opts.key)); r = n;
    }
    // A group (one settlement of finds) can spill over the server's page cap: keep reading while it continues.
    for (let pages = 0; opts.joins && r.next && rows.length && pages < 30; pages++) {
      const more = new URLSearchParams(params); more.set('cursor', r.next);
      let n;
      try { n = await get(`${base}${base.includes('?') ? '&' : '?'}${more}`); } catch { break; }
      if (seq !== state.seq) return;
      const next = pageRows(n, opts.key);
      if (!next.length || !opts.joins(rows.at(-1), next[0])) break;
      rows.push(...next); r = n;
    }
    state.loading = false;
    state.at = at;
    state.count = rows.length;
    el.setAttribute('aria-busy', 'false');
    state.total = Number.isSafeInteger(r.total) ? r.total : null;
    state.cursors[state.at + 1] = r.next ?? null;
    state.cursors.length = state.at + 2;
    const empty = (typeof opts.empty === 'function' ? opts.empty(state.filters) : opts.empty) ?? 'Nothing here yet.';
    clear(body, opts.render ? (rows.length ? opts.render(rows, { offset: state.at * limit }) : h('div.empty', {}, empty)) : table(opts.group ? opts.group(rows) : rows, opts.columns, { empty, onRow: opts.onRow, selected: opts.selected, sortable: false }));
    drawFoot(rows.length);
    opts.onPage?.(rows, r);
  }
  function drawBar() {
    clear(bar,
      state.total !== undefined && state.total !== null ? h('span.pager-total', {}, `${fmtInt(state.total)} total`) : null,
      ...(opts.filters ?? []).map(f => h('label.pager-ctl', {}, h('span', {}, f.label),
        f.options.length <= 4 ? seg(f.options, state.filters[f.name], v => { state.filters[f.name] = v; reset(); })
          : select(f.options, { value: state.filters[f.name], 'aria-label': f.label, onchange: e => { state.filters[f.name] = e.target.value; reset(); } }))),
      opts.sorts?.length ? h('label.pager-ctl', {}, h('span', {}, 'Sort'), select(opts.sorts, { value: state.sort, 'aria-label': 'Sort', onchange: e => { state.sort = e.target.value; reset(); } })) : null);
  }
  function drawFoot(n) {
    const from = state.at * limit + (n ? 1 : 0), to = state.at * limit + n;
    const hasNext = !!state.cursors[state.at + 1], hasPrev = state.at > 0;
    clear(foot, h('span.small.muted', {}, n ? `${fmtInt(from)}–${fmtInt(to)}${state.total !== null ? ` of ${fmtInt(state.total)}` : ''}` : ''),
      h('div.grow'),
      h('button.btn.sm.ghost', { disabled: state.loading || !hasPrev, onclick: () => { if (!state.loading && hasPrev) load(state.at - 1); }, 'aria-label': 'Previous page' }, '‹ Prev'),
      h('button.btn.sm.ghost', { disabled: state.loading || !hasNext, onclick: () => { if (!state.loading && hasNext) load(state.at + 1); }, 'aria-label': 'Next page' }, 'Next ›'));
    drawBar();
  }
  function reset() { state.cursors = [null]; state.at = 0; state.count = 0; clear(body); clear(foot); load(); }
  drawBar();
  load();
  return { el, reload: () => load(state.loading ? state.requestedAt : state.at), reset };
}
