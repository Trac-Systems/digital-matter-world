import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../../../service/src/http.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { encodeTracAddress } from '../../../rules/src/trac-address.js';
const { chromium } = await import('playwright');
const owner = encodeTracAddress('11'.repeat(32));
const pattern = { asset: 'p0', number: 0, name: 'dmwdigit', pat: '[0-9]', fld: 4, tier: 1, rarity: 1, supply: '10' };
const events = [3, 2, 1].map(sequence => ({ sequence, id: `event${sequence}`, at: 1, type: 'block', data: { height: sequence, tip: sequence } }));
const finds = Array.from({ length: 35 }, (_, i) => ({ asset: 'p0', block: 1000 - i, count: 1, finder: owner }));
function pageRows(key, rows, u) {
  const at = Number(u.searchParams.get('cursor') ?? 0), limit = Number(u.searchParams.get('limit') ?? 50);
  return { [key]: rows.slice(at, at + limit), total: rows.length, next: at + limit < rows.length ? String(at + limit) : null };
}
function read(path) {
  const u = new URL(path, 'http://local'), p = u.pathname;
  if (p === '/status') return { tip: 10, counted: 10, feePolicy: { baseFee: '1000000000000000000', feeSettings: { link: 3, tierMultipliers: [1,3,10,30,100], compoundMinimum: 10 }, unit: { decimals: 18 } } };
  if (p === '/patterns') return pageRows('patterns', !u.searchParams.has('asset') || u.searchParams.get('asset') === pattern.asset ? [pattern] : [], u);
  if (p === '/feed') return pageRows('events', events.filter(e => e.sequence > Number(u.searchParams.get('since') ?? 0)), u);
  if (p === '/finds') return pageRows('finds', finds, u);
  if (p === '/agents') return pageRows('agents', [{ address: owner, finds: 35 }], u);
  if (p === '/agents/' + owner) return { address: owner, scores: { finds: 35 } };
  if (p === '/results') return { counts: {}, treasury: {}, burn: {}, outstandingSupply: {} };
  if (p === '/results/mints') return pageRows('mints', finds, u);
  const key = p.split('/').at(-1);
  return pageRows(key, [], u);
}
let browser, server;
before(async () => {
  server = await serve({ intake: { store: {} }, files: { serve: async () => false }, web: createWeb({ records: async () => ({}) }),
    publicAPI: { handles: () => true, read }, bindings: { read: () => ({ binding: { request: { address: 'bcrt1ptestwallet' }, acceptedAt: 1 } }) } });
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function open(t, path) {
  const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(8000);
  t.after(() => context.close());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no script errors'));
  if (path) await page.goto(server.url + path);
  return page;
}
const panel = (p, name) => p.locator('section.panel').filter({ has: p.getByRole('heading', { name, exact: true }) });

test('shared fragment links open About and follow hash changes alongside public paths', async t => {
  const p = await open(t, '/#/about');
  await p.locator('article.about').waitFor();
  await p.reload();
  await p.locator('article.about').waitFor();
  await p.evaluate(() => { location.hash = '#/agents'; });
  await p.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
  await p.getByRole('link', { name: 'About', exact: true }).click();
  assert.equal(new URL(p.url()).pathname, '/about');
  assert.equal(new URL(p.url()).hash, '');
  await p.locator('article.about').waitFor();
});

test('a mint permit remains visible in the Money feed without claiming a Bitcoin mint', async t => {
  const p = await open(t);
  await p.route('**/feed?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    events: [{ sequence: 4, id: 'permit-event', at: 1, type: 'mint_permit',
      data: { owner, asset: 'p0', amount: '1', block: 7 } }], total: 1, next: null,
  }) }));
  await p.goto(server.url + '/feed');
  await p.getByRole('button', { name: 'Money', exact: true }).click();
  await p.getByText('Mint permit', { exact: true }).waitFor();
  const text = await p.locator('tr.feed-row').innerText();
  assert.match(text, /received a permanent permit to mint 1 .* from block 7/);
  assert.doesNotMatch(text, /on Bitcoin/);
});

test('a Results tab survives a page reload', async t => {
  const p = await open(t, '/results/mints');
  await p.getByRole('tab', { name: /Unsettled records/ }).click();
  assert.equal(new URL(p.url()).pathname, '/results/owed');
  await p.reload();
  await p.getByRole('tab', { name: /Unsettled records/, selected: true }).waitFor();
});

test('a double Next click consumes only one cursor page', async t => {
  const p = await open(t, '/records'), list = panel(p, 'Public finds'), requests = [];
  await list.getByText('1–10 of 35', { exact: true }).waitFor();
  await p.route('**/finds?*', async route => { requests.push(route.request().url()); await new Promise(r => setTimeout(r, 150)); await route.continue(); });
  await list.getByRole('button', { name: 'Next page' }).evaluate(b => { b.click(); b.click(); });
  await list.getByText('11–20 of 35', { exact: true }).waitFor();
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).searchParams.get('cursor'), '10');
  assert.match(await list.locator('tbody tr').first().innerText(), /990/);
});

test('a failed cursor read preserves the current page and can retry that cursor', async t => {
  const p = await open(t, '/records'), list = panel(p, 'Public finds');
  await list.getByText('1–10 of 35', { exact: true }).waitFor();
  let calls = 0;
  await p.route('**/finds?*', async route => { if (++calls === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily_unavailable"}' }); else await route.continue(); });
  await list.getByRole('button', { name: 'Next page' }).click();
  await list.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.match(await list.locator('tbody tr').first().innerText(), /1,000/);
  await list.getByRole('button', { name: 'Retry', exact: true }).click();
  await list.getByText('11–20 of 35', { exact: true }).waitFor();
  assert.equal(calls, 2);
});

test('a summary refresh keeps the cursor page already being requested', async t => {
  const p = await open(t, '/results/mints'), requests = [];
  await p.getByText('1–25 of 35', { exact: true }).waitFor();
  await p.route('**/results/mints?*', async route => { requests.push(route.request().url()); await new Promise(r => setTimeout(r, 500)); await route.continue(); });
  await p.getByRole('button', { name: 'Next page' }).click();
  await p.getByRole('button', { name: 'Refresh', exact: true }).click();
  await p.getByText('26–35 of 35', { exact: true }).waitFor();
  assert.ok(requests.length >= 2);
  assert.ok(requests.every(url => new URL(url).searchParams.get('cursor') === '25'));
});

test('the public feed reloads its recent history after an initial read failure', async t => {
  const p = await open(t); let calls = 0;
  await p.route('**/feed?limit=200', async route => { if (++calls === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily_unavailable"}' }); else await route.continue(); });
  await p.goto(server.url + '/feed');
  await p.waitForFunction(() => document.querySelectorAll('tr.blockrow').length === 3, null, { timeout: 10000 });
  assert.equal(calls, 2);
  assert.match(await p.locator('.conn').innerText(), /Live feed: Live/);
});

test('payout lookup failures are shown as unavailable and can be retried', async t => {
  const p = await open(t); let calls = 0;
  await p.route('**/payout-bindings/*/tap', async route => { if (++calls === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily_unavailable"}' }); else await route.continue(); });
  await p.goto(server.url + '/agents/' + owner);
  const wallets = panel(p, 'Payout wallets');
  await wallets.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  assert.match(await wallets.locator('tbody tr').first().innerText(), /Unavailable/);
  assert.doesNotMatch(await wallets.locator('tbody tr').first().innerText(), /none bound/);
  await wallets.getByRole('button', { name: 'Retry', exact: true }).click();
  await wallets.locator('tbody tr').first().getByRole('button', { name: 'Copy bcrt1ptestwallet' }).waitFor();
});

test('unknown pattern and compound addresses show a missing-record message', async t => {
  const p = await open(t);
  for (const [type, asset] of [['pattern', 'punknown'], ['compound', 'cunknown']]) {
    await p.goto(server.url + `/${type}/${asset}`);
    await p.getByRole('alert').filter({ hasText: /not found/ }).waitFor();
    assert.match(await p.getByRole('alert').innerText(), new RegExp(asset));
  }
});

test('a pattern lookup failure has a retry that loads the requested pattern', async t => {
  const p = await open(t); let calls = 0;
  await p.route('**/patterns?asset=p2&limit=1', route => ++calls === 1
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily_unavailable"}' })
    : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ patterns: [{ ...pattern, asset: 'p2', number: 2, name: 'dmwretry' }] }) }));
  await p.goto(server.url + '/pattern/p2');
  await p.getByRole('alert').getByRole('button', { name: 'Retry', exact: true }).click();
  await p.getByRole('heading', { name: 'Retry', exact: true }).waitFor();
  assert.equal(calls, 2);
});

test('About prices and the existing status cell follow the live policy and unavailable reads', async t => {
  const p = await open(t);
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  let unavailable = false;
  let policy = { baseFee: '22600000000000000000', unit: { decimals: 18 },
    feeSettings: { tierMultipliers: [1, 3, 10, 30, 100], compoundMinimum: 1, link: 1 } };
  await p.route('**/status', async route => {
    await loading;
    await route.fulfill({ status: unavailable ? 503 : 200, contentType: 'application/json',
      body: JSON.stringify(unavailable ? { error: 'unavailable' } : { tip: 10, counted: 10, feePolicy: policy }) });
  });
  await p.goto(server.url + '/about', { waitUntil: 'domcontentloaded' });
  const prices = p.locator('article.about [data-fee-kind]');
  await prices.first().waitFor();
  const fallback = Array(13).fill('current price');
  assert.deepEqual(await prices.allTextContents(), fallback, 'placeholders render before status loads');
  assert.equal(await p.locator('article.about table').count(), 8);
  const firstArticle = await p.locator('article.about').elementHandle();
  release();
  await p.waitForFunction(() => document.querySelector('[data-fee-kind]')?.textContent === '2,260 TAP');
  assert.deepEqual(await prices.allTextContents(), ['2,260 TAP', '678 TAP', '226 TAP', '67.8 TAP', '22.6 TAP',
    '22.6 TAP', '67.8 TAP', '226 TAP', '678 TAP', '2,260 TAP', '22.6 TAP', '22.6 TAP', '22.6 TAP']);
  const fee = p.locator('.strip .cell').filter({ hasText: 'Base price' });
  assert.equal(await fee.locator('.v').innerText(), '22.6 TAP');
  assert.equal(await fee.getAttribute('data-tip'), 'Changes apply to new quotes. Link: 22.6 TAP; tiers: 22.6 TAP, 67.8 TAP, 226 TAP, 678 TAP, 2,260 TAP; compounds from: 22.6 TAP.');
  const refresh = () => p.evaluate(async () => {
    const { store } = await import('/web/console/js/api.js');
    await store.refreshStatus().catch(() => {});
  });
  policy = { ...policy, baseFee: '2500000000000000000', feeSettings: { tierMultipliers: [2, 4, 6, 8, 12], compoundMinimum: 7, link: 5 } };
  await refresh();
  assert.deepEqual(await prices.allTextContents(), ['30 TAP', '20 TAP', '15 TAP', '10 TAP', '5 TAP',
    '5 TAP', '10 TAP', '15 TAP', '20 TAP', '30 TAP', '17.5 TAP', '12.5 TAP', '12.5 TAP']);
  assert.equal(await firstArticle.evaluate(node => node === document.querySelector('article.about')), true, 'status updates preserve the article');
  unavailable = true;
  await refresh();
  assert.deepEqual(await prices.allTextContents(), fallback, 'failed reads clear stale prices');
  await p.reload();
  await prices.first().waitFor();
  assert.deepEqual(await prices.allTextContents(), fallback, 'initial status failure keeps placeholders');
  unavailable = false;
  await refresh();
  assert.equal(await prices.first().textContent(), '30 TAP', 'a later successful read restores prices');
  assert.doesNotMatch(await p.locator('body').innerText(), /\bB\b|\{\{price:/);
  await p.getByRole('link', { name: 'Agents', exact: true }).click();
  await p.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
  assert.equal(await p.evaluate(async () => (await import('/web/console/js/api.js')).bus.map.get('status').size), 1,
    'leaving About removes its status listener');
});
