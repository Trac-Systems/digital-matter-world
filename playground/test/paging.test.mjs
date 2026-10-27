import { encodeTracAddress } from '../../rules/src/trac-address.js';
const owner = '11'.repeat(32), other = '22'.repeat(32);
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createControlReadAPI as createReadAPI, projectEvent, projectJob } from '../api.mjs';
import { serveControl } from '../http.mjs';
import { listRoute, pageRows, projectLists } from '../paging.mjs';
import { createViews, viewRows } from '../views.mjs';

const order = [4, 1, 5, 0, 3, 6, 2];
const makeRow = i => ({
  id: 'id' + i, rank: i, asset: 'p' + i, amount: String(9007199254740993n + BigInt(i)),
  block: i, height: i, sequence: i, number: i, pattern: i, count: i,
  created: i, at: i, pid: i, revealFrom: i, window: i,
  name: 'name' + i, actionId: 'action' + i, agent: 'agent' + i, address: 'address' + i,
  price: String(9007199254740993n + BigInt(i)), supply: String(i), accrued: String(i),
  type: i % 2 ? 'claim' : 'mint', state: i % 2 ? 'complete' : 'failed',
  kind: i % 2 ? 'tap' : 'ethereum', strategy: i % 2 ? 'prospector' : 'crafter',
  allowed: i % 2 === 0, minted: false, pending: false, linked: i % 2 === 0,
  reason: i % 2 ? 'finder' : 'public', finder: i % 2 ? other : owner,
  consumed: { blck: i, total: String(9007199254740993n + BigInt(i)), action: i % 2 ? 'claim' : 'refund' },
  deposit: { amount: String(9007199254740993n + BigInt(i)), status: i % 2, payer: 'payer' + i },
  data: { actor: i % 2 ? other : owner, state: i % 2 ? 'complete' : 'failed' },
});
function fixture(rows = order.map(makeRow)) {
  const player = Object.fromEntries(['balances', 'mintRights', 'history', 'pendingPayments', 'bitmaps', 'discoveries', 'items'].map(k => [k, rows]));
  const results = Object.fromEntries(['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links'].map(k => [k, rows]));
  const block = Object.fromEntries(['finds', 'claims', 'draws', 'matches', 'slotList', 'mintRights'].map(k => [k, rows]));
  const engine = { state: { player: { address: owner } }, trac: async () => ({ tip: { height: 6 } }), botState: () => ({ count: rows.length, agents: rows }), get: async () => ({ records: rows }) };
  const views = {
    player: async () => ({ address: owner, ...player }), playerList: async k => player[k],
    results: async () => results, resultList: async k => results[k],
    patterns: async () => ({ patterns: rows, compounds: rows }),
    plots: async (from, to) => ({ from, to, plots: rows.filter(r => r.height >= from && r.height <= to).map(r => ({ ...r, finds: rows })) }),
    block: async () => ({ height: 1, ...block }), finds: () => ({ finds: rows }), receipts: () => ({ receipts: rows }),
    status: async () => ({ state: 'ready', components: rows }),
  };
  const jobs = { rows: new Map(rows.map(r => [r.id, r])) };
  return { api: createReadAPI({ views, engine, jobs, events: rows, paymentPlan: async () => ({ transactions: rows }) }), views, engine, jobs, rows };
}
const cases = [
  ['/api/player/balances', 'balances', 'amount'], ['/api/player/mintRights', 'mintRights', 'block'],
  ['/api/player/history', 'history', 'sequence'], ['/api/player/pendingPayments', 'pendingPayments', 'price'],
  ['/api/player/bitmaps', 'bitmaps', 'height'], ['/api/player/discoveries', 'discoveries', 'revealFrom'], ['/api/player/items', 'items', 'id'],
  ['/api/results/mints', 'mints', 'amount'], ['/api/results/payments', 'payments', 'total'], ['/api/results/ethereum', 'ethereum', 'amount'],
  ['/api/results/payouts', 'payouts', 'accrued'], ['/api/results/owed', 'owed', 'amount'], ['/api/results/paid', 'paid', 'amount'],
  ['/api/results/links', 'links', 'block'],
  ['/api/patterns', 'patterns', 'number'], ['/api/compounds', 'compounds', 'supply'], ['/api/world', 'plots', 'height'],
  ['/api/blocks/1/finds', 'finds', 'block'], ['/api/blocks/1/claims', 'claims', 'agent'], ['/api/blocks/1/draws', 'draws', 'window'],
  ['/api/blocks/1/matches', 'matches', 'number'], ['/api/blocks/1/slotList', 'slotList', 'number'], ['/api/blocks/1/mintRights', 'mintRights', 'block'],
  ['/api/finds', 'finds', 'block'], ['/api/receipts', 'receipts', 'height'], ['/api/jobs', 'jobs', 'created'],
  ['/api/bots', 'agents', 'name'], ['/api/feed', 'events', 'sequence'], ['/api/status/components', 'components', 'pid'],
  [listRoute('/api/gateway/records/batches/1', '/records'), 'items', 'rank'],
];
for (const [path, key, sort] of cases) test(path + ': limit, complete cursor walk, total and both sort directions', async () => {
  const { api } = fixture(), url = new URL(path, 'http://127.0.0.1');
  url.searchParams.set('limit', '2'); url.searchParams.set('sort', sort); url.searchParams.set('order', 'asc');
  const all = [];
  for (let i = 0; i < 4; i++) {
    const page = await api(url);
    assert.equal(page.total, 7); assert.equal(page.limit, 2); assert.equal(page.sort, sort); assert.equal(page.order, 'asc');
    assert.equal(page[key].length, i === 3 ? 1 : 2);
    all.push(...page[key].map(r => r.rank));
    if (i < 3) { assert.equal(typeof page.next, 'string'); url.searchParams.set('cursor', page.next); }
    else assert.equal(page.next, null);
  }
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5, 6]);
  url.searchParams.delete('cursor'); url.searchParams.set('order', 'desc');
  assert.deepEqual((await api(url))[key].map(r => r.rank), [6, 5]);
});

test('all named collections enforce the default and maximum page sizes', async () => {
  const { api } = fixture(Array.from({ length: 205 }, (_, i) => makeRow(i)));
  for (const [path, key] of cases.filter(([p]) => p !== '/api/world')) {
    const url = new URL(path, 'http://127.0.0.1');
    assert.equal((await api(url))[key].length, 50, path);
    url.searchParams.set('limit', '200'); assert.equal((await api(url))[key].length, 200, path);
    url.searchParams.set('limit', '201'); await assert.rejects(api(url), /limit_1_200/, path);
  }
});

test('summaries expose bounded previews, complete counts and usable continuation routes', async () => {
  const { api } = fixture();
  for (const path of ['/api/player', '/api/results', '/api/blocks/1', '/api/status']) {
    const value = await api(new URL(path + '?limit=2', 'http://127.0.0.1'));
    for (const [key, meta] of Object.entries(value.pages)) {
      assert.equal(value[key].length, 2); assert.equal(value.counts[key], 7); assert.equal(meta.total, 7);
      const next = new URL(meta.route, 'http://127.0.0.1'); next.searchParams.set('cursor', meta.next); next.searchParams.set('limit', '2');
      const page = await api(next); assert.equal(page.total, 7); assert.equal(page[key].length, 2);
      assert.ok(page[key].every(row => !value[key].some(first => first.id === row.id)));
    }
  }
  const patterns = await api(new URL('http://127.0.0.1/api/patterns?limit=2'));
  assert.equal(patterns.compounds.length, 2); assert.equal(patterns.pages.compounds.route, '/api/compounds');
  const world = await api(new URL('http://127.0.0.1/api/world?limit=2'));
  assert.equal(world.plots[0].finds.length, 2); assert.equal(world.plots[0].pages.finds.route, '/api/blocks/6/finds');
});

test('filters apply before totals and paging; result kind selects a collection', async () => {
  const { api } = fixture();
  const get = path => api(new URL(path, 'http://127.0.0.1'));
  for (const [path, key, total] of [
    ['/api/player/mintRights?whoMayMint=me', 'mintRights', 4], ['/api/player/mintRights?whoMayMint=finder&asset=p1', 'mintRights', 1],
    ['/api/player/history?type=mint', 'history', 4], ['/api/player/bitmaps?linked=false', 'bitmaps', 3],
    ['/api/finds?owner=' + encodeTracAddress(owner), 'finds', 4], ['/api/results/mints?kind=tap', 'mints', 3],
    ['/api/results/payments?action=refund', 'payments', 4], ['/api/results/ethereum?status=1', 'ethereum', 3],
    ['/api/patterns?q=NAME3', 'patterns', 1], ['/api/bots?strategy=prospector', 'agents', 3],
    ['/api/jobs?state=failed', 'jobs', 4], ['/api/feed?actor=' + encodeTracAddress(owner), 'events', 4],
    ['/api/feed?category=problems', 'events', 4], ['/api/world?from=2&to=4', 'plots', 3],
    ['/api/blocks/1/matches?positive=true', 'matches', 6],
  ]) { const page = await get(path + '&limit=1'); assert.equal(page.total, total, path); assert.equal(page[key].length, 1, path); }
  const page = await get('/api/results?kind=links&limit=2'); assert.equal(page.links.length, 2); assert.equal(page.total, 7);
});

test('cursors reject corruption and changed scopes, preserve ties and permit a different page size', async () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: 'row' + i, amount: '100' }));
  const config = { route: '/test', keys: ['amount'], filters: { state: String } };
  const first = pageRows(rows, new URLSearchParams('limit=2'), config);
  const next = pageRows([{ id: 'row-before', amount: '0' }, ...rows], new URLSearchParams({ limit: '7', cursor: first.meta.next }), config);
  assert.deepEqual(next.entries.map(e => e.row.id), rows.slice(2).map(r => r.id));
  for (const params of [
    { cursor: first.meta.next + 'x' }, { cursor: first.meta.next, order: 'desc' }, { cursor: first.meta.next, state: 'new' },
    { cursor: 'not-a-cursor' }, { limit: '0' }, { limit: '1.5' }, { limit: 'Infinity' }, { sort: '__proto__' },
  ]) assert.throws(() => pageRows(rows, new URLSearchParams(params), config));
  assert.throws(() => pageRows(rows, new URLSearchParams({ cursor: first.meta.next }), { ...config, route: '/other' }), /invalid_cursor/);
  assert.throws(() => pageRows(rows, new URLSearchParams('limit=2&limit=3'), config), /duplicate_parameter/);
  const { api } = fixture();
  for (const path of ['/api/player/bitmaps?linked=yes', '/api/world?from=-1', '/api/finds?sort=typo', '/api/feed?category=typo', '/api/results?kind=typo']) await assert.rejects(api(new URL(path, 'http://127.0.0.1')));
});

test('nested gateway, payment-plan, job and event arrays have retrievable bounded pages', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => makeRow(i)), { api, jobs } = fixture(rows);
  const job = { id: 'nested', result: { windows: rows.map(r => r.height), tuples: rows.map(r => [r.asset, r.amount]) } };
  jobs.rows.set(job.id, job);
  for (const path of ['/api/gateway/world', '/api/payment-plan/test', '/api/jobs/nested']) {
    const value = await api(new URL(path + '?limit=2', 'http://127.0.0.1'));
    const parent = value.result ?? value, key = Object.keys(parent.pages)[0], meta = parent.pages[key];
    assert.equal(parent[key].length, 2); assert.equal(meta.total, 205);
    const url = new URL(meta.route, 'http://127.0.0.1'); url.searchParams.set('cursor', meta.next); url.searchParams.set('limit', '2');
    const next = await api(url); assert.equal(next.items.length, 2); assert.equal(next.total, 205);
  }
  assert.equal(projectJob(job).result.windows.length, 50);
  assert.deepEqual(projectJob(job).result.tuples[0], ['p0', '9007199254740993']);
  const event = projectEvent({ sequence: 1, data: { windows: rows } });
  assert.equal(event.data.windows.length, 50); assert.match(event.data.pages.windows.route, /source=%2Fapi%2Ffeed%2F1/);
  for (const source of ['https://example.invalid/api/status', '/api/list', '/api/events', '/api/jobs/id#hash']) await assert.rejects(api(new URL(listRoute(source, '/rows'), 'http://127.0.0.1')));
});

test('real view sources include records beyond the old 100/500 ceilings', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE records(space TEXT,id TEXT,value TEXT); CREATE TABLE actions(scope TEXT,id TEXT,state TEXT)');
    const insert = db.prepare('INSERT INTO records VALUES(?,?,?)'), action = db.prepare('INSERT INTO actions VALUES(?,?,?)');
    for (let i = 0; i < 620; i++) { insert.run('finds', String(i), JSON.stringify({ block: i, asset: 'p0', finder: 'owner' })); action.run('owner', 'claim/' + i, 'received'); }
    const engine = { store: { database: () => db, get: () => null }, actor: async () => ({ journal: { db, scope: 'owner' } }) };
    assert.equal(viewRows(engine, 'finds').length, 620);
    const views = createViews(engine); assert.equal(views.finds().finds.length, 620);
    const history = await views.playerList('history'); assert.equal(history.length, 620); assert.equal(history[619].type, 'claim');
    const api = createReadAPI({ views, engine });
    const page = await api(new URL('http://127.0.0.1/api/finds?limit=200'));
    assert.equal(page.total, 620); assert.equal(page.finds.length, 200); assert.equal(page.finds[0].block, 619);
    const second = await api(new URL('http://127.0.0.1/api/finds?' + new URLSearchParams({ limit: '200', cursor: page.next })));
    assert.equal(second.finds[0].block, 419); assert.equal(second.total, 620);
  } finally { db.close(); }
});

test('generic previews preserve existing metadata fields, empty pages and atomic wallet documents', async () => {
  const raw = { pages: [1, 2, 3], counts: { original: 3 } };
  const value = projectLists(raw, { source: '/api/gateway/world', params: new URLSearchParams('limit=1') });
  assert.deepEqual(value.pages, [1]); assert.equal(value.pagination.pages.total, 3);
  assert.deepEqual(value.counts, raw.counts); assert.equal(value.listCounts.pages, 3);
  const empty = projectLists([], { source: '/api/gateway/world' });
  assert.deepEqual(empty.items, []); assert.equal(empty.total, 0); assert.equal(empty.next, null);
  const redeem = { p: 'tap', op: 'token-auth', redeem: { items: [], data: 'request', actions: [{ op: 'lock', al: [{ amt: '1' }, { amt: '2' }] }] } };
  const api = createReadAPI({ paymentPlan: async () => ({ redeem, transactions: [{ id: 1 }, { id: 2 }] }) });
  const plan = await api(new URL('http://127.0.0.1/api/payment-plan/test?limit=1'));
  assert.deepEqual(plan.redeem, redeem); assert.equal(plan.transactions.length, 1); assert.equal(plan.pages.transactions.total, 2);
});

test('HTTP exposes page validation errors and SSE bounds replay while continuing live events', async t => {
  const { api } = fixture();
  const events = Array.from({ length: 205 }, (_, i) => ({ sequence: i + 1, type: 'block', data: { windows: Array.from({ length: 205 }, (_, j) => j) } }));
  const control = await serveControl({ token: 'paging-test', events, route: (_, url) => api(url), port: 0 }); t.after(() => control.close());
  const base = `http://127.0.0.1:${control.server.address().port}`, headers = { authorization: 'Bearer paging-test' };
  assert.equal((await fetch(base + '/api/finds?limit=201', { headers })).status, 400);
  const controller = new AbortController();
  const response = await fetch(base + '/api/events', { headers: { ...headers, 'last-event-id': '0' }, signal: controller.signal });
  const reader = response.body.getReader(); let text = '';
  while (!text.includes(': connected')) text += new TextDecoder().decode((await reader.read()).value);
  assert.equal((text.match(/^id: /gm) ?? []).length, 200); assert.match(text, /^id: 6$/m); assert.doesNotMatch(text, /^id: 5$/m);
  const first = JSON.parse(text.match(/^data: (.*)$/m)[1]); assert.equal(first.data.windows.length, 50); assert.equal(first.data.counts.windows, 205);
  control.publish({ sequence: 206, type: 'block', data: { tip: 206 } });
  assert.match(new TextDecoder().decode((await reader.read()).value), /id: 206/); controller.abort(); await reader.cancel().catch(() => {});
  const fresh = new AbortController(), live = await fetch(base + '/api/events', { headers, signal: fresh.signal });
  const liveReader = live.body.getReader(); assert.equal(new TextDecoder().decode((await liveReader.read()).value), ': connected\n\n');
  fresh.abort(); await liveReader.cancel().catch(() => {});
});
