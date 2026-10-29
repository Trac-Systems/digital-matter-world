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
    publicAPI: { handles: () => true, read }, bindings: { wallets: () => ({ players: [], more: false }), read: () => ({ binding: { request: { address: 'bcrt1ptestwallet' }, acceptedAt: 1 } }) } });
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
  await p.route('**/feed?limit=200&order=desc', async route => { if (++calls === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily_unavailable"}' }); else await route.continue(); });
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
  const fallback = Array(13).fill('current fee');
  assert.deepEqual(await prices.allTextContents(), fallback, 'placeholders render before status loads');
  assert.equal(await p.locator('article.about table').count(), 8);
  const firstArticle = await p.locator('article.about').elementHandle();
  release();
  await p.waitForFunction(() => document.querySelector('[data-fee-kind]')?.textContent === '2,260 TAP');
  assert.deepEqual(await prices.allTextContents(), ['2,260 TAP', '678 TAP', '226 TAP', '67.8 TAP', '22.6 TAP',
    '22.6 TAP', '67.8 TAP', '226 TAP', '678 TAP', '2,260 TAP', '22.6 TAP', '22.6 TAP', '22.6 TAP']);
  const fee = p.locator('.strip .cell').filter({ hasText: 'Base fee' });
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

// Public mints: the Mint page lists only what /public-mints returns and mints with TAP Wallet alone.
const tapAddress = 'bcrt1pzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsqysakq';
const atomic = n => (BigInt(n) * 10n ** 18n).toString();
const publicRows = [
  { asset: 'p2:0', block: '151', amount: '3', claimDeadline: '1159', state: 'public', bitmapHolderOnly: false },
  { asset: 'p2:0', block: '66', amount: '2', claimDeadline: '1074', state: 'public', bitmapHolderOnly: true },
  { asset: 'p2:0', block: '12', amount: '1', claimDeadline: '1020', state: 'paid', bitmapHolderOnly: false },
];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function publicMintPage(t, { list = route => json(route, { v: 3, rows: publicRows, next: null, nextCursor: null, total: null }), refunds, connected = false } = {}) {
  const p = await open(t), calls = [];
  p.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/public-mints') || u.pathname.startsWith('/mint-rights') || u.pathname === '/patterns') calls.push([r.method(), u.pathname + u.search, r.postDataJSON?.() ?? null]); });
  await p.addInitScript(([address, connected]) => {
    if (connected) localStorage.setItem('dmw-web-v1/wallets', JSON.stringify({ tap: address }));
    globalThis.tapprotocol = { getNetwork: async () => 'regtest', switchNetwork: async () => {}, requestAccounts: async () => [address], getAccounts: async () => [address], on() {} };
  }, [tapAddress, connected]);
  // The server's name search: q matches part of the name.
  await p.route('**/patterns?*', route => { const q = new URL(route.request().url()).searchParams.get('q');
    json(route, { patterns: !q || pattern.name.includes(q) ? [{ ...pattern, asset: 'p2:0', number: '0', legacy: { asset: 'p0' } }] : [], next: null }); });
  await p.route('**/web-api/target', route => json(route, { network: 'dmw-regtest', bitcoinNetwork: 'regtest', ethereum: { chainId: '0x7a69' } }));
  await p.route('https://mempool.space/**', route => json(route, { halfHourFee: 3 }));
  await p.route(/\/public-mints\?/, list);
  await p.route(/\/public-mints\/refunds\?/, refunds ?? (route => json(route, { v: 3, rows: [], next: null, nextCursor: null, total: null })));
  return { p, calls };
}

test('the Mint page lists only the public blocks the API returns, with one Mint button per public row', async t => {
  const { p, calls } = await publicMintPage(t), list = panel(p, 'Public blocks');
  await p.goto(server.url + '/mint');
  await list.locator('tbody tr').nth(2).waitFor();
  assert.equal(await list.locator('tbody tr').count(), 3);
  assert.deepEqual(await list.locator('tbody tr td:nth-child(2)').allInnerTexts(), ['151', '66', '12']);
  assert.equal(await list.getByRole('button', { name: 'Mint', exact: true }).count(), 2, 'a paid row is not offered');
  assert.match(await list.locator('tbody tr').nth(1).innerText(), /Bitmap holder only/);
  assert.match(await list.locator('tbody tr').nth(2).innerText(), /Payment confirmed/);
  assert.equal(await list.locator('tbody tr').first().locator('td').first().getByRole('link').getAttribute('href'), '/pattern/p2:0');
  assert.equal(await list.locator('tbody tr').first().getByRole('link', { name: '151' }).getAttribute('href'), '/block/151');
  await list.getByText('First confirmed payment wins. If someone else’s payment confirms first, yours is refunded.', { exact: true }).waitFor();
  assert.ok(!calls.some(([, path]) => path.startsWith('/mint-rights')), 'no agent mint rights are read');
  assert.equal(await p.getByRole('heading', { name: 'What you can mint', exact: true }).count(), 0);
  assert.doesNotMatch(await p.locator('main').innerText(), /ask your agent to mint|Mint On-Chain/i);
  // A pattern is picked by a server-side name search; thousands of patterns never render as controls.
  const search = p.locator('#mint input[type="search"]');
  await search.fill('Digit'); await search.dispatchEvent('change');
  await p.waitForFunction(() => document.querySelectorAll('#mint tbody tr').length === 3 && !document.querySelector('#mint .paged[aria-busy="true"]'));
  assert.equal(new URL(calls.filter(([, path]) => path.startsWith('/public-mints?')).at(-1)[1], 'http://x').searchParams.get('asset'), 'p2:0');
  // Part of a name finds its pattern; text that names no pattern is never sent as a pattern id.
  const asked = () => calls.filter(([, path]) => path.startsWith('/public-mints?')).map(([, path]) => new URL(path, 'http://x').searchParams.get('asset'));
  await search.fill('zzz'); await search.dispatchEvent('change');
  await p.getByText('No pattern named “zzz”.').waitFor();
  await search.fill('dig'); await search.dispatchEvent('change');
  await p.waitForFunction(() => document.querySelector('#mint input[type="search"]').value === 'Digit');
  assert.ok(!asked().includes('zzz') && !asked().includes('dig'));
  const searched = calls.map(([, path]) => new URL(path, 'http://x')).filter(u => u.pathname === '/patterns' && u.searchParams.get('q') === 'dig');
  assert.ok(searched.length && searched.every(u => u.searchParams.get('limit') === '10'), 'suggestions come from the server, ten at most');
  assert.ok(await p.locator('#public-pattern-names option').count() <= 10);
});

test('a block opened from elsewhere shows its point-read state and mints only when public', async t => {
  const { p, calls } = await publicMintPage(t);
  for (const [block, state] of [['151', 'public'], ['152', 'claim_window_open']]) {
    await p.route(`**/public-mints/p2:0/${block}`, route => json(route, { asset: 'p2:0', block, amount: '3', claimDeadline: '1159', state, bitmapHolderOnly: false, refunds: '/public-mints/refunds' }));
    await p.goto(server.url + `/mint?asset=p2:0&block=${block}`);
    const box = panel(p, `Digit from block ${block}`);
    await box.locator('.pill').first().waitFor();
    assert.equal(await box.getByRole('button', { name: 'Mint', exact: true }).count(), state === 'public' ? 1 : 0);
    if (state !== 'public') await box.getByText(/claim week is not over yet/).waitFor();
  }
  assert.ok(calls.some(([, path]) => path === '/public-mints/p2:0/151'));
});

test('Mint connects TAP Wallet, shows the quote and opens the payment page of the started request', async t => {
  const id = 'cd'.repeat(32);
  const { p, calls } = await publicMintPage(t), list = panel(p, 'Public blocks');
  await p.route('**/public-mints/quote', route => json(route, { asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, kind: 'tap', price: atomic(226), payable: false, reservation: 'none', claimDeadline: '1159',
    fees: [{ role: 'treasury', to: tapAddress, ticker: 'tap', amount: atomic(150), tt: 'a', dta: 'x' }, { role: 'burn', to: tapAddress, ticker: 'tap', amount: atomic(76), tt: 'a', dta: 'x' }], feeQuote: { unit: { decimals: 18 } } }));
  await p.route('**/public-mints/start', route => json(route, { id, requestId: id, asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, kind: 'tap', state: 'awaiting_payment', payable: true, reservation: 'none', fees: [], missing: [], paymentPage: '/mint/' + id }));
  await p.goto(server.url + '/mint');
  await list.getByRole('button', { name: 'Mint', exact: true }).first().click();
  const dialog = p.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Continue to payment', exact: true }).waitFor();
  const text = await dialog.innerText();
  assert.match(text, /First confirmed payment wins\. If someone else’s payment confirms first, yours is refunded\./);
  assert.match(text, /226 TAP/); assert.match(text, /150 TAP/); assert.match(text, /3 sat\/vB/);
  assert.ok(!calls.some(([method, path]) => method === 'POST' && path === '/public-mints/start'), 'nothing starts before confirming');
  await dialog.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await p.waitForURL(u => new URL(u).pathname === '/mint/' + id);
  const posts = calls.filter(([method]) => method === 'POST');
  assert.deepEqual(posts.map(([, path, body]) => [path, body]), [['/public-mints/quote', { asset: 'p2:0', block: '151', tapAddress }], ['/public-mints/start', { asset: 'p2:0', block: '151', tapAddress }]]);
});

test('a lost race or a cancelled quote leaves the list without starting a request', async t => {
  const { p, calls } = await publicMintPage(t), list = panel(p, 'Public blocks');
  await p.route('**/public-mints/quote', route => json(route, { error: 'someone_paid_first' }, 409));
  await p.goto(server.url + '/mint');
  await list.getByRole('button', { name: 'Mint', exact: true }).first().click();
  await list.getByText(/Someone else’s payment for this block confirmed first/).waitFor();
  await p.waitForFunction(() => document.querySelectorAll('#mint tbody tr').length === 3);
  assert.ok(calls.filter(([method, path]) => method === 'GET' && path.startsWith('/public-mints?')).length >= 2, 'the list is read again');
  assert.ok(!calls.some(([, path]) => path === '/public-mints/start'));
});

for (const [name, status, error] of [['missing', 404, 'not_found'], ['inactive', 503, 'public_mint_inactive']]) test(`a ${name} public mint API shows a calm opens-soon note`, async t => {
  const { p } = await publicMintPage(t, { list: route => json(route, { error }, status) }), list = panel(p, 'Public blocks');
  await p.goto(server.url + '/mint');
  await list.getByText('Public minting opens soon. Blocks that nobody claimed in their claim week will be listed here.', { exact: true }).waitFor();
  assert.equal(await list.getByRole('alert').count(), 0, 'no error wall');
  assert.equal(await list.getByRole('button', { name: 'Mint', exact: true }).count(), 0);
  assert.equal(await list.locator('table').count(), 0);
});

test('a connected TAP Wallet with owed refunds sees a Your refunds box', async t => {
  const id = 'ef'.repeat(32), seen = [];
  const { p } = await publicMintPage(t, { connected: true, refunds: route => { seen.push(new URL(route.request().url()).searchParams.get('tapAddress'));
    return json(route, { v: 3, rows: [{ id, requestId: id, asset: 'p2:0', block: '151', tapAddress, paymentId: 'ab'.repeat(32) + 'i0', reason: 'someone_paid_first', winner: 'cd'.repeat(32) + 'i0',
      fees: [{ role: 'treasury', amount: atomic(150) }, { role: 'burn', amount: atomic(76) }], state: 'owed' }], next: null, nextCursor: null, total: null }); } });
  await p.goto(server.url + '/mint');
  const refunds = panel(p, 'Your refunds');
  await refunds.locator('tbody tr').first().waitFor();
  assert.deepEqual(seen, [tapAddress]);
  const row = await refunds.locator('tbody tr').first().innerText();
  assert.match(row, /151/); assert.match(row, /226 TAP/); assert.match(row, /Another payment confirmed first/);
  assert.equal(await refunds.getByRole('link', { name: 'Request', exact: true }).getAttribute('href'), '/mint/' + id);
});

test('no refunds box without owed refunds or without a TAP Wallet', async t => {
  for (const connected of [true, false]) {
    const { p } = await publicMintPage(t, { connected });
    await p.goto(server.url + '/mint');
    await panel(p, 'Public blocks').locator('tbody tr').first().waitFor();
    await p.waitForTimeout(200);
    assert.equal(await p.getByRole('heading', { name: 'Your refunds', exact: true }).isVisible(), false);
  }
});

for (const endpoint of ['quote', 'start']) for (const state of ['deployment_needed', 'deployment_pending']) {
  test(`public ${endpoint} ${state} keeps the block and receiver without opening a null request`, async t => {
    const { p, calls } = await publicMintPage(t);
    const quote = { asset: 'p0', block: '151', amount: '3', receiver: tapAddress, kind: 'tap', price: atomic(226), fees: [], payable: false, reservation: 'none' };
    const preparation = { ...quote, catalogAsset: 'p2:0', publicMint: true, state, id: null, requestId: null, price: undefined };
    let quotes = 0;
    await p.route('**/public-mints/quote', route => json(route, ++quotes === 1 && endpoint === 'start' ? quote : preparation));
    await p.route('**/public-mints/start', route => json(route, preparation));
    await p.route('**/mint/deployment-state/p2:0', route => json(route, { asset: 'p0', kind: 'dmt', state: 'queued', attempts: [] }));
    await p.goto(server.url + '/mint');
    await panel(p, 'Public blocks').getByRole('button', { name: 'Mint', exact: true }).first().click();
    if (endpoint === 'start') await p.getByRole('dialog').getByRole('button', { name: 'Continue to payment', exact: true }).click();
    if (state === 'deployment_needed') {
      await p.waitForURL(url => url.pathname === '/mint/p2:0');
      const url = new URL(p.url());
      assert.equal(url.searchParams.get('public'), '1'); assert.equal(url.searchParams.get('block'), '151');
      assert.equal(url.searchParams.get('tapAddress'), tapAddress);
      await p.getByRole('heading', { name: 'Mint from your wallet' }).waitFor();
      assert.equal(await p.getByRole('textbox', { name: 'Agent address' }).count(), 0);
    } else {
      await p.getByRole('status').filter({ hasText: 'registration is being confirmed' }).waitFor();
      assert.equal(new URL(p.url()).pathname, '/mint');
    }
    assert.equal(calls.filter(([method, path]) => method === 'POST' && path === '/public-mints/start').length, endpoint === 'start' ? 1 : 0);
  });
}

test('the public list reads past an empty page of a bounded scan and always sends the selected pattern', async t => {
  const cursors = [];
  const { p, calls } = await publicMintPage(t, { list: route => {
    const params = new URL(route.request().url()).searchParams; cursors.push(params.get('cursor'));
    assert.equal(params.get('asset'), 'p2:0'); assert.equal(params.get('limit'), '25');
    return json(route, { v: 3, rows: params.has('cursor') ? publicRows : [], next: params.has('cursor') ? null : 'opaque:next', total: null });
  } });
  await p.goto(server.url + '/mint');
  const list = panel(p, 'Public blocks');
  await list.locator('tbody tr').nth(2).waitFor();
  assert.deepEqual(cursors, [null, 'opaque:next']);
  assert.equal(await list.getByRole('button', { name: 'Next page' }).isDisabled(), true);
  assert.ok(calls.every(([, path]) => !path.startsWith('/public-mints?') || new URL(path, 'http://local').searchParams.has('asset')));
});

test('cancelling a public quote creates no checkout', async t => {
  const { p, calls } = await publicMintPage(t);
  await p.route('**/public-mints/quote', route => json(route, { asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, kind: 'tap', price: atomic(226), fees: [] }));
  await p.goto(server.url + '/mint');
  await panel(p, 'Public blocks').getByRole('button', { name: 'Mint', exact: true }).first().click();
  await p.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok(!calls.some(([, path]) => path === '/public-mints/start'));
  assert.equal(new URL(p.url()).pathname, '/mint');
});

for (const change of [{ asset: 'p2:9' }, { receiver: 'different' }, { block: '152' }, { paymentPage: 'https://invalid.example/mint' }]) {
  test(`a changed public start ${Object.keys(change)[0]} cannot open a payment page`, async t => {
    const { p } = await publicMintPage(t);
    const quote = { asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, kind: 'tap', price: atomic(226), fees: [] };
    await p.route('**/public-mints/quote', route => json(route, quote));
    await p.route('**/public-mints/start', route => json(route, { ...quote, id: 'ab'.repeat(32), ...change }));
    await p.goto(server.url + '/mint');
    await panel(p, 'Public blocks').getByRole('button', { name: 'Mint', exact: true }).first().click();
    await p.getByRole('dialog').getByRole('button', { name: 'Continue to payment', exact: true }).click();
    await p.getByRole('status').filter({ hasText: 'payment request is not valid' }).waitFor();
    assert.equal(new URL(p.url()).pathname, '/mint');
  });
}

test('a public refundable request displays the owed refund without offering another payment', async t => {
  const { p } = await publicMintPage(t), id = 'ab'.repeat(32);
  await p.route('**/mint/' + id, route => route.request().resourceType() === 'document' ? route.continue() : json(route, {
    requestId: id, publicMint: true, asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, payer: tapAddress,
    state: 'refundable', payable: false, payBy: { rail: 'tap' }, fees: [], missing: [], refunds: [{ state: 'owed', reason: 'someone_paid_first' }],
  }));
  await p.route('**/mint/deployment-state/p2:0', route => json(route, { asset: 'p0', state: 'registered' }));
  await p.goto(server.url + '/mint/' + id);
  await p.getByText('Owed; not sent automatically', { exact: true }).waitFor();
  assert.equal(await p.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);
  assert.equal(await p.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0);
  assert.doesNotMatch(await p.locator('main').innerText(), /units have been consumed/);
});

for (const [code, message] of [['payment_unconfirmed', 'waiting for a Bitcoin confirmation'], ['public_payment_incomplete', 'did not cover every quoted fee']]) {
  test(`public checkout explains ${code} without starting another payment`, async t => {
    const { p, calls } = await publicMintPage(t);
    await p.route('**/public-mints/quote', route => json(route, { error: code }, 409));
    await p.goto(server.url + '/mint');
    await panel(p, 'Public blocks').getByRole('button', { name: 'Mint', exact: true }).first().click();
    await p.getByRole('status').filter({ hasText: message }).waitFor();
    assert.ok(!calls.some(([, path]) => path === '/public-mints/start'));
  });
}
