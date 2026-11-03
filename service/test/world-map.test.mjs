import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PublicViews } from '../src/public-views.mjs';
import { createPublicAPI } from '../src/public-api.mjs';
import { serve } from '../src/http.mjs';
import { rules } from '../src/rules.mjs';
import { heightKey } from '../src/util.mjs';
import { Store } from '../src/store.mjs';
import { temp } from './helpers.mjs';
import { chromium } from 'playwright';

async function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE records(space TEXT,id TEXT,value TEXT,PRIMARY KEY(space,id)) WITHOUT ROWID');
  const put = (space, id, value) => db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(space, String(id), JSON.stringify(value));
  const store = { db, get(space, id) { const r = db.prepare('SELECT value FROM records WHERE space=? AND id=?').get(space, String(id)); return r ? JSON.parse(r.value) : null; } };
  const tip = 1_000_000, history = { length: tip + 1, hashAt: h => String(h), get: h => ({ height: h, time: h, nonce: 1, bits: 1 }) };
  put('meta', 'patterns', [0, 1, 2].map(number => ({ number, name: 'digit' + number, pat: '[0-9]', fld: 4, dt: 'n' })));
  put('meta', 'ruleState', { rounds: [] });
  for (const number of [0, 1, 2]) put('finds', rules.findId(tip - 1, number), { block: tip - 1, pattern: number, asset: 'p' + number, finder: 'a'.repeat(64), count: 7, findHeight: tip - 1 });
  put('minted', `p2/${tip - 1}`, true); put('links', heightKey(tip), { block: tip });
  const status = { tip, counted: tip, feePolicy: { baseFee: '100', unit: { decimals: 18 } } };
  const reads = { head: async () => ({ tip: { height: tip }, counted: tip }) };
  const views = new PublicViews({ store, reads, history });
  await views.readIndex.sync(); views.refreshOnRead = false;
  const api = createPublicAPI({ views });
  return { api, views, put, history, status, tip };
}

test('bounded map projection matches paged marks without reading headers or upstream state', async t => {
  const { api, views, put, history, tip } = await fixture(t);
  const reference = await api.read(`/world?from=${tip - 1}&to=${tip}&limit=200`);
  history.hashAt = history.get = () => assert.fail('canvas must not hydrate headers');
  views.reads.head = () => assert.fail('canvas must use committed head');
  const at = performance.now(), map = await api.read('/world/map');
  assert.equal(map.from, tip - 40000); assert.equal(map.to, tip); assert.equal(map.tip, tip);
  for (const p of reference.plots) {
    const mark = map.marks.find(r => r.height === p.height);
    assert.deepEqual([mark.found, mark.linked, mark.minted], [p.found, p.linked, p.minted]);
    assert.deepEqual(mark.finds, p.finds.slice(0, 2).map(f => ({ asset: f.asset, minted: f.minted })));
    assert.equal(mark.findCount, p.finds.length);
    assert.equal(mark.findMinted, p.finds.some(f => f.minted));
  }
  assert.ok(JSON.stringify(map).length < 1000, 'a plain world sends only sparse marks');
  t.diagnostic(`million-plot map read: ${(performance.now() - at).toFixed(1)} ms`);
  for (const query of ['from=0&to=40001', 'from=-1', 'from=1&to=0', `to=${tip + 1}`, 'from=0&from=1', 'limit=200', 'cursor=anything']) await assert.rejects(api.read('/world/map?' + query));
  assert.equal((await api.read('/world/map?from=0&to=0')).marks.length, 0);
  // Uncommitted changes stay invisible until the ordinary index refresh.
  put('links', heightKey(tip - 2), { block: tip - 2 });
  assert.equal((await api.read('/world/map')).marks.length, 2);
  views.readIndex.length = tip;
  await assert.rejects(api.read('/world/map'), { message: 'index_catching_up', status: 503 });
  views.readIndex.ready = false;
  await assert.rejects(api.read('/world/map'), { message: 'public_index_pending', status: 503 });
});

test('mainnet-sized explorer loads all 40,001 plots in one map request and cancels late navigation', async t => {
  const { api, status, tip } = await fixture(t), calls = [], errors = [];
  const server = await serve({ intake: { store: {} }, files: { serve: async () => false }, publicAPI: { handles: () => true, read: async path => {
    calls.push(path);
    if (path === '/status') return status;
    if (path.startsWith('/patterns')) return { patterns: [], total: 0, next: null };
    if (path.startsWith('/feed')) return { events: [], total: 0, next: null };
    return api.read(path);
  } } }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  const at = performance.now();
  await page.goto(server.url + '/explore');
  await page.waitForFunction(() => document.getElementById('world-count')?.textContent.startsWith('40,001'), null, { timeout: 10000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  t.diagnostic(`explorer content/paint: ${(performance.now() - at).toFixed(1)} ms`);
  assert.deepEqual(calls.filter(p => p.startsWith('/world')), [`/world/map?from=${tip - 40000}&to=${tip}`]);
  assert.deepEqual(errors, []);
  // A late response from a prior mount must not repaint or fill a detached map.
  let release, started;
  const held = new Promise(resolve => { started = resolve; });
  await page.route('**/world/map?*', async route => { started(); await new Promise(resolve => { release = resolve; }); await route.fulfill({ json: { from: 0, to: 0, tip: 0, marks: [] } }); });
  await page.reload({ waitUntil: 'domcontentloaded' }); await held;
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await page.locator('article.about').waitFor(); release();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#world-count').count(), 0); assert.deepEqual(errors, []);
});


test('v2 explorer follows map continuations and pattern links read submitted blocks', async t => {
  const store = await Store.open(await temp()); t.after(() => store.close());
  const tip = 1000000, calls = [], errors = [];
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: String(tip) });
  await store.put('meta', 'head', { tip: String(tip), hash: rules.hash('tip') });
  await store.put('catalogPatterns', 'p2:0', { number: '0', name: 'v2-known', pat: '[0-9]', fld: 4, dt: 'n', knownMatchCount: '1', tier: 1 });
  await store.put('claimed2/p2:0', rules.uintKeyV2(String(tip)), { height: String(tip), pattern: '0', count: '1', hash: rules.hash('tip') });
  for (let i = 0; i < 5; i++) await store.put('links', heightKey(tip - i), { block: String(tip - i), linkHeight: '1' });
  const api = createPublicAPI({ views: { store }, settings: { patternDetailRows: 2 } });
  const server = await serve({ intake: { store }, files: { serve: async () => false }, publicAPI: { handles: () => true, read: async path => {
    calls.push(path);
    if (path === '/status') return { tip: String(tip), counted: String(tip), feePolicy: { baseFee: '100', unit: { decimals: 18 } } };
    return api.read(path);
  } } }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.url + '/explore');
  await page.waitForFunction(() => document.getElementById('world-count')?.textContent.startsWith('40,001'));
  await page.waitForLoadState('networkidle');
  assert.equal(calls.filter(p => p.startsWith('/world/map')).length, 3);
  await page.goto(server.url + '/pattern/p2:0');
  await page.waitForLoadState('networkidle');
  assert.ok(calls.some(p => p.startsWith('/patterns/p2:0/claimed-blocks')));
  assert.equal(await page.getByRole('heading', { name: 'V2-Known', exact: false }).count() > 0 || await page.locator('h2').filter({ hasText: /v2.known/i }).count() > 0, true);
  assert.deepEqual(errors, []);
});

test('the explorer map continues after the last plot read when batches keep making its cursor stale', async t => {
  const store = await Store.open(await temp()); t.after(() => store.close());
  const tip = 1000000, calls = [], errors = [];
  await store.put('meta', 'ruleState', { batchVersion: 2, counted: String(tip) });
  await store.put('meta', 'head', { tip: String(tip), hash: rules.hash('tip') });
  for (let i = 0; i < 7; i++) await store.put('links', heightKey(tip - i), { block: String(tip - i), linkHeight: '1' });
  const api = createPublicAPI({ views: { store }, settings: { patternDetailRows: 2 } });
  let refusals = 0;
  const server = await serve({ intake: { store }, files: { serve: async () => false }, publicAPI: { handles: () => true, read: async path => {
    calls.push(path);
    if (path === '/status') return { tip: String(tip), counted: String(tip), feePolicy: { baseFee: '100', unit: { decimals: 18 } } };
    // Two batches land during the traversal, one after each cursor page.
    if (path.startsWith('/world/map') && path.includes('cursor=') && refusals < 2) { refusals++; throw Object.assign(Error('page_cursor_stale'), { status: 409 }); }
    return api.read(path);
  } } }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(server.url + '/explore');
  await page.waitForFunction(() => document.getElementById('world-count')?.textContent.startsWith('40,001'));
  await page.waitForLoadState('networkidle');
  const map = calls.filter(p => p.startsWith('/world/map')), starts = map.map(p => Number(new URL(p, 'http://x').searchParams.get('from')));
  assert.equal(refusals, 2); assert.equal(await page.getByText(/did not load/).count(), 0);
  assert.ok(starts.at(-1) > starts[0], 'a resumed read starts after the plots already read');
  assert.deepEqual(errors, []);
});
