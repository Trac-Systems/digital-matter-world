import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../../../service/src/http.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { encodeTracAddress } from '../../../rules/src/trac-address.js';
const { chromium } = await import('playwright');
import { secp256k1 } from '../../../kit/node_modules/@noble/curves/secp256k1.js';
import { fundingAddress } from '../../../kit/lib/inscription-core.mjs';
import { tapWallet1049 } from '../../../kit/test/tap-wallet-1049-fixture.mjs';
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
  { asset: 'p2:0', block: '151', amount: '3', state: 'public', bitmapHolderOnly: false },
  { asset: 'p2:0', block: '66', amount: '2', state: 'public', bitmapHolderOnly: true },
  { asset: 'p2:0', block: '12', amount: '1', state: 'paid', bitmapHolderOnly: false },
];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function publicMintPage(t, { list = route => json(route, { v: 3, rows: publicRows, next: null, nextCursor: null, total: null }), refunds, connected = false, oneTx = true, version = '1.0.49' } = {}) {
  const p = await open(t), calls = [];
  p.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/public-mints') || u.pathname.startsWith('/mint-rights') || u.pathname === '/patterns') calls.push([r.method(), u.pathname + u.search, r.postDataJSON?.() ?? null]); });
  await p.addInitScript(([address, connected, oneTx, version]) => {
    if (connected) localStorage.setItem('dmw-web-v1/wallets', JSON.stringify({ tap: address }));
    globalThis.walletCalls = [];
    globalThis.tapprotocol = { ...(version ? { getCapabilities: async () => ({ version, singleTxTransferExtraOutputs: true }) } : {}), getNetwork: async () => { walletCalls.push('getNetwork'); return 'regtest'; }, switchNetwork: async () => {}, requestAccounts: async () => [address], getAccounts: async () => [address], on() {},
      getCurrentAuthority: async () => oneTx ? { ins: 'a1'.repeat(32) + 'i0', auth: [], addr: address } : null,
      getAuthorityStatus: async () => ({ currentAuthority: null, readyToTap: null, pendingAuthority: null }) };
  }, [tapAddress, connected, oneTx, version]);
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
  await list.getByText('Blocks show up here once their 1-week finder window has passed without a claim.', { exact: true }).waitFor();
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
  for (const [block, state] of [['151', 'public'], ['152', 'claimed'], ['153', 'already_minted'], ['154', 'paid'], ['155', 'permit_issued'], ['156', 'not_yet_public']]) {
    await p.route(`**/public-mints/p2:0/${block}`, route => json(route, { asset: 'p2:0', block, amount: '3', state, bitmapHolderOnly: false, refunds: '/public-mints/refunds' }));
    await p.goto(server.url + `/mint?asset=p2:0&block=${block}`);
    const box = panel(p, `Digit from block ${block}`);
    await box.locator('.pill').first().waitFor();
    assert.equal(await box.getByRole('button', { name: 'Mint', exact: true }).count(), state === 'public' ? 1 : 0);
    assert.equal(await box.locator('.pill').first().innerText(), ({ public: 'Public', claimed: 'Claimed', already_minted: 'Minted', paid: 'Payment confirmed', permit_issued: 'Being minted', not_yet_public: 'Not public yet' })[state]);
    assert.doesNotMatch(await box.innerText(), /claim week|claim_window_open|already_minted|price/i);
  }
  assert.ok(calls.some(([, path]) => path === '/public-mints/p2:0/151'));
});

test('unopened point reads and list rows show the exact opening block in their existing state labels', async t => {
  const publicFrom = '9007199254742001', row = { asset: 'p2:0', block: '550001', amount: null,
    state: 'not_yet_public', publicFrom, bitmapHolderOnly: false };
  const { p } = await publicMintPage(t, { list: route => json(route, { v: 3, rows: [row], next: null, nextCursor: null, total: null }) });
  await p.route('**/public-mints/p2:0/550001', route => json(route, row));
  await p.goto(server.url + '/mint?asset=p2:0&block=550001');
  const chosen = panel(p, 'Digit from block 550,001'), list = panel(p, 'Public blocks');
  for (const box of [chosen, list]) {
    await box.locator('.pill').filter({ hasText: 'Opens at block ' + publicFrom }).waitFor();
    assert.equal(await box.getByRole('button', { name: 'Mint', exact: true }).count(), 0);
  }
  await chosen.getByText('Opens at block ' + publicFrom + '.', { exact: true }).waitFor();
});

for (const publicFrom of ['1108', undefined]) test(`unopened public request text uses ${publicFrom ? 'the opening height' : 'the legacy fallback'} without offering payment`, async t => {
  const { p } = await publicMintPage(t), id = 'ac'.repeat(32);
  await p.route('**/mint/' + id, route => route.request().resourceType() === 'document' ? route.continue() : json(route, {
    requestId: id, publicMint: true, asset: 'p2:0', block: '100', amount: '3', receiver: tapAddress, payer: tapAddress,
    state: 'not_yet_public', reason: 'not_yet_public', ...(publicFrom ? { publicFrom } : {}),
    payable: false, payBy: { rail: 'tap' }, fees: [], missing: [], refunds: [],
  }));
  await p.route('**/mint/deployment-state/p2:0', route => json(route, { asset: 'p0', state: 'registered' }));
  await p.goto(server.url + '/mint/' + id);
  const request = panel(p, 'Request');
  await request.locator('.pill').filter({ hasText: publicFrom ? 'Opens at block ' + publicFrom : 'Not public yet' }).waitFor();
  if (publicFrom) await request.getByText('Opens at block ' + publicFrom + '.', { exact: true }).waitFor();
  else assert.match(await request.innerText(), /This block is not public yet/);
  assert.equal(await p.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);
  assert.equal(await p.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0);
});

test('Mint connects TAP Wallet, shows the quote and opens the payment page of the started request', async t => {
  const id = 'cd'.repeat(32);
  const { p, calls } = await publicMintPage(t), list = panel(p, 'Public blocks');
  await p.route('**/public-mints/quote', route => json(route, { asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, kind: 'tap', price: atomic(226), payable: false, reservation: 'none',
    fees: [{ role: 'treasury', to: tapAddress, ticker: 'tap', amount: atomic(150), tt: 'a', dta: 'x' }, { role: 'burn', to: tapAddress, ticker: 'tap', amount: atomic(76), tt: 'a', dta: 'x' }], feeQuote: { unit: { decimals: 18 } } }));
  await p.route('**/public-mints/start', route => json(route, { id, requestId: id, asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, kind: 'tap', state: 'awaiting_payment', payable: true, reservation: 'none', fees: [], missing: [], paymentPage: '/mint/' + id }));
  await p.goto(server.url + '/mint');
  await list.getByRole('button', { name: 'Mint', exact: true }).first().click();
  const dialog = p.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Continue to payment', exact: true }).waitFor();
  const text = await dialog.innerText();
  assert.match(text, /Nothing is reserved: the next page asks TAP Wallet to pay, then to inscribe the mint\./);
  assert.match(text, /226 TAP/); assert.match(text, /150 TAP/); assert.match(text, /3 sat\/vB/);
  assert.ok(!calls.some(([method, path]) => method === 'POST' && path === '/public-mints/start'), 'nothing starts before confirming');
  await dialog.getByRole('button', { name: 'Continue to payment', exact: true }).click();
  await p.waitForURL(u => new URL(u).pathname === '/mint/' + id);
  const posts = calls.filter(([method]) => method === 'POST');
  assert.deepEqual(posts.map(([, path, body]) => [path, body]), [['/public-mints/quote', { asset: 'p2:0', block: '151', tapAddress }], ['/public-mints/start', { asset: 'p2:0', block: '151', tapAddress }]]);
});

// A pattern's token on Bitcoin: its page and the Mint page show the status and, until it is deployed, the way
// to inscribe the pattern and deploy its token. Only the read-only deployment state is read.
const deploymentReads = p => { const asked = []; p.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/mint/deployment')) asked.push(r.method() + ' ' + u.pathname); }); return asked; };
for (const [job, label, action] of [[{ state: 'awaiting_player_deploy', phase: 'element' }, 'Token not deployed', 'Inscribe & deploy'],
  [{ state: 'awaiting_player_deploy', phase: 'deployment', elementId: 'ab'.repeat(32) + 'i0' }, 'Pattern inscribed — deploy token next', 'Deploy token']]) {
  test(`a pattern page shows “${label}” and ${action} opens its deployment page for the discoverer`, async t => {
    const { p } = await publicMintPage(t), asked = deploymentReads(p);
    await p.route('**/patterns?*', route => json(route, { patterns: [{ ...pattern, asset: 'p2:0', number: '0', discoverer: owner }], next: null }));
    await p.route('**/mint/deployment-state/p2:0', route => json(route, { asset: 'p0', kind: 'dmt', attempts: [], ...job }));
    await p.goto(server.url + '/pattern/p2:0');
    const detail = panel(p, 'Digit');
    await detail.getByText(label, { exact: true }).waitFor();
    const link = detail.getByRole('link', { name: action, exact: true });
    assert.equal(await link.getAttribute('href'), '/mint/p2:0?owner=' + owner);
    await link.click();
    await p.waitForURL(url => url.pathname === '/mint/p2:0');
    await p.getByText('This pattern has no token on Bitcoin yet.', { exact: false }).waitFor();
    assert.equal(await p.getByRole('textbox', { name: 'Agent address' }).inputValue(), owner);
    assert.ok(asked.every(r => r === 'GET /mint/deployment-state/p2:0'), asked.join());
  });
}

test('a deployed pattern shows its token and no deploy action', async t => {
  const { p } = await publicMintPage(t), asked = deploymentReads(p);
  await p.route('**/mint/deployment-state/p2:0', route => json(route, { asset: 'p0', kind: 'dmt', state: 'registered', elementId: 'ab'.repeat(32) + 'i0' }));
  await p.goto(server.url + '/pattern/p2:0');
  const detail = panel(p, 'Digit');
  await detail.getByText('Token deployed', { exact: true }).waitFor();
  assert.equal(await detail.getByRole('link', { name: /Inscribe & deploy|Deploy token/ }).count(), 0);
  // The Mint page's picked pattern says the same.
  await p.goto(server.url + '/mint');
  await panel(p, 'Public blocks').getByText('Token deployed', { exact: true }).waitFor();
  assert.equal(await p.getByRole('link', { name: /Inscribe & deploy|Deploy token/ }).count(), 0);
  assert.deepEqual([...new Set(asked)], ['GET /mint/deployment-state/p2:0']);
});

test('the Mint page leads from “Found a new pattern?” to the chosen pattern’s deployment page', async t => {
  const { p } = await publicMintPage(t), asked = deploymentReads(p);
  await p.route('**/mint/deployment-state/p2:0', route => json(route, { asset: 'p0', kind: 'dmt', state: 'not_started' }));
  await p.goto(server.url + '/mint');
  await p.getByRole('link', { name: 'Found a new pattern? Inscribe it and deploy its token', exact: true }).click();
  assert.equal(new URL(p.url()).pathname, '/mint');
  const box = panel(p, 'Found a new pattern?');
  await box.getByText('Inscribe it and deploy its token', { exact: false }).waitFor();
  const search = box.locator('input[type="search"]');
  await search.fill('Digit'); await search.dispatchEvent('change');
  await box.getByText('Token not deployed', { exact: true }).waitFor();
  await box.getByRole('link', { name: 'Inscribe & deploy', exact: true }).click();
  await p.waitForURL(url => url.pathname === '/mint/p2:0' && !url.search);
  await p.getByRole('heading', { name: 'Mint from your wallet' }).waitFor();
  assert.ok(asked.every(r => r === 'GET /mint/deployment-state/p2:0'), asked.join());
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
  await list.getByText('Public minting opens soon. Blocks show up here once their 1-week finder window has passed without a claim.', { exact: true }).waitFor();
  assert.equal(await list.getByRole('alert').count(), 0, 'no error wall');
  assert.equal(await list.getByRole('button', { name: 'Mint', exact: true }).count(), 0);
  assert.equal(await list.locator('table').count(), 0);
});

for (const [reason, message] of [['someone_paid_first', 'Another payment confirmed first'], ['claimed_first', 'An agent claimed this block before your payment was confirmed. Your payment is refunded.']]) test(`a connected TAP Wallet sees its ${reason} refund`, async t => {
  const id = 'ef'.repeat(32), seen = [];
  const { p } = await publicMintPage(t, { connected: true, refunds: route => { seen.push(new URL(route.request().url()).searchParams.get('tapAddress'));
    return json(route, { v: 3, rows: [{ id, requestId: id, asset: 'p2:0', block: '151', tapAddress, paymentId: 'ab'.repeat(32) + 'i0', reason, winner: 'cd'.repeat(32) + 'i0',
      fees: [{ role: 'treasury', amount: atomic(150) }, { role: 'burn', amount: atomic(76) }], state: 'owed' }], next: null, nextCursor: null, total: null }); } });
  await p.goto(server.url + '/mint');
  const refunds = panel(p, 'Your refunds');
  await refunds.locator('tbody tr').first().waitFor();
  assert.deepEqual(seen, [tapAddress]);
  const row = await refunds.locator('tbody tr').first().innerText();
  assert.match(row, /151/); assert.match(row, /226 TAP/); assert.ok(row.includes(message));
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

for (const reason of ['someone_paid_first', 'claimed_first']) test(`a public ${reason} request displays the owed refund without offering another payment`, async t => {
  const { p } = await publicMintPage(t), id = 'ab'.repeat(32);
  await p.route('**/mint/' + id, route => route.request().resourceType() === 'document' ? route.continue() : json(route, {
    requestId: id, publicMint: true, asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, payer: tapAddress,
    state: 'refundable', payable: false, payBy: { rail: 'tap' }, fees: [], missing: [], refunds: [{ state: 'owed', reason }],
  }));
  await p.route('**/mint/deployment-state/p2:0', route => json(route, { asset: 'p0', state: 'registered' }));
  await p.goto(server.url + '/mint/' + id);
  await p.getByText('Refund pending', { exact: true }).waitFor();
  if (reason === 'claimed_first') await p.getByText('An agent claimed this block before your payment was confirmed. Your payment is refunded.', { exact: true }).waitFor();
  assert.equal(await p.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);
  assert.equal(await p.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0);
  assert.doesNotMatch(await p.locator('main').innerText(), /units have been consumed/);
});

for (const [code, message] of [['payment_unconfirmed', 'waiting for a Bitcoin confirmation'], ['public_payment_incomplete', 'did not cover every quoted fee'], ['claimed_first', 'An agent claimed this block before your payment was confirmed. Your payment is refunded.'], ['public_minted', 'This block was already taken by a public TAP Wallet mint.']]) {
  test(`public checkout explains ${code} without starting another payment`, async t => {
    const { p, calls } = await publicMintPage(t);
    await p.route('**/public-mints/quote', route => json(route, { error: code }, 409));
    await p.goto(server.url + '/mint');
    await panel(p, 'Public blocks').getByRole('button', { name: 'Mint', exact: true }).first().click();
    await p.getByRole('status').filter({ hasText: message }).waitFor();
    assert.ok(!calls.some(([, path]) => path === '/public-mints/start'));
  });
}

test('Mint without 1-TX Transfers in TAP Wallet explains how to turn them on and asks for no quote', async t => {
  const { p, calls } = await publicMintPage(t, { connected: true, oneTx: false }), list = panel(p, 'Public blocks');
  await p.goto(server.url + '/mint');
  await list.getByRole('button', { name: 'Mint', exact: true }).first().click();
  await p.getByText(/Turn on 1-TX Transfers in TAP Wallet first/).first().waitFor();
  assert.ok(!calls.some(([, path]) => path.startsWith('/public-mints/quote') || path.startsWith('/public-mints/start')), 'nothing is quoted or started');
});

test('Mint asks TAP Wallet 1.0.49 or newer before the quote; an older wallet is refused with nothing quoted', async t => {
  const { p, calls } = await publicMintPage(t, { version: '1.0.48' }), list = panel(p, 'Public blocks');
  await p.goto(server.url + '/mint');
  await list.getByRole('button', { name: 'Mint', exact: true }).first().click();
  await p.getByText('This needs TAP Wallet 1.0.49 or newer. Update TAP Wallet, then reload this page.', { exact: true }).first().waitFor();
  assert.ok(!calls.some(([, path]) => path.startsWith('/public-mints/quote') || path.startsWith('/public-mints/start')), 'nothing is quoted or started');
  assert.deepEqual(await p.evaluate(() => globalThis.walletCalls), [], 'no wallet call besides the version check');
  assert.equal(await p.getByRole('dialog').count(), 0);
});

test('the public Mint confirmation names the Bitcoin set aside and that TAP Wallet asks once', async t => {
  const { p } = await publicMintPage(t), list = panel(p, 'Public blocks');
  await p.route('**/public-mints/quote', route => json(route, { asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, kind: 'tap', price: atomic(226), payable: false, reservation: 'none', claimDeadline: '1159',
    fees: [{ role: 'treasury', to: tapAddress, ticker: 'tap', amount: atomic(226), tt: 'a', dta: 'x' }], feeQuote: { unit: { decimals: 18 } }, mintFundingEstimate: { satoshis: 4200, feeRate: 3 } }));
  await p.goto(server.url + '/mint');
  await list.getByRole('button', { name: 'Mint', exact: true }).first().click();
  const dialog = p.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Continue to payment', exact: true }).waitFor();
  const text = await dialog.innerText();
  assert.match(text, /TAP Wallet asks once/); assert.match(text, /Bitcoin set aside for the mint inscription and a possible refund\s+4,200 sats/);
  assert.doesNotMatch(text, /\bprices?\b/i);
  await shot(p, 'public-mint-confirm-set-aside');
});

test('refunds show a returned set-aside when the read has one', async t => {
  const id = 'ef'.repeat(32);
  const { p } = await publicMintPage(t, { connected: true, refunds: route => json(route, { v: 3, rows: [{ id, requestId: id, asset: 'p2:0', block: '151', tapAddress, reason: 'someone_paid_first',
    fees: [{ role: 'treasury', amount: atomic(226) }], state: 'owed', mintSender: { state: 'returned', satoshis: 4200 } },
    { id: 'fe'.repeat(32), asset: 'p2:0', block: '66', tapAddress, reason: 'someone_paid_first', fees: [{ role: 'treasury', amount: atomic(76) }], state: 'owed' }], next: null, nextCursor: null, total: null }) });
  await p.goto(server.url + '/mint');
  const refunds = panel(p, 'Your refunds');
  await refunds.locator('tbody tr').first().waitFor();
  assert.match(await refunds.locator('tbody tr').first().innerText(), /4,200 sats returned/);
  assert.match(await refunds.locator('tbody tr').nth(1).innerText(), /–/);
});

// The /mint/<request> page with a TAP Wallet stand-in (1.0.49 fixture, or older).
const requestId = '9a'.repeat(32), walletKey = new Uint8Array(32).fill(41);
const walletPublicKey = Buffer.from(secp256k1.getPublicKey(walletKey)).toString('hex'), payer = fundingAddress(walletPublicKey, 'regtest');
const setAsideAddress = fundingAddress(Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(42))).toString('hex'), 'regtest');
const shots = process.env.DMW_SHOTS;
async function shot(p, name) { if (shots) await p.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); }
async function requestPage(t, status, { version = '1.0.49' } = {}) {
  const p = await open(t), posts = [], wallet = tapWallet1049({ address: payer, publicKey: walletPublicKey, network: 'regtest', version });
  if (version === null) delete wallet.provider.getCapabilities;
  const seen = [];
  await p.exposeFunction('tapWallet', (name, args) => { seen.push(name); return wallet.provider[name](...args); });
  await p.addInitScript(methods => { globalThis.tapprotocol = Object.fromEntries(methods.map(name => [name, (...args) => globalThis.tapWallet(name, args)])); }, Object.keys(wallet.provider));
  p.on('request', r => { if (r.method() !== 'GET') posts.push(new URL(r.url()).pathname); });
  await p.route('**/web-api/target', route => json(route, { network: 'dmw-regtest', bitcoinNetwork: 'regtest', ethereum: { chainId: '0x7a69' } }));
  await p.route('https://mempool.space/**', route => json(route, { halfHourFee: 3 }));
  await p.route('**/mint/deployment-state/*', route => json(route, { asset: 'p0', state: 'registered' }));
  await p.route(u => new URL(u).pathname === '/mint/' + requestId, route => route.request().resourceType() === 'fetch' ? json(route, status) : route.continue());
  await p.goto(server.url + '/mint/' + requestId);
  return { p, posts, wallet, seen };
}
const fee = { role: 'treasury', to: payer, ticker: 'tap', amount: atomic(226), tt: 'a' };
const awaiting = () => ({ requestId, receiver: payer, payer, asset: 'p0', amount: '3', publicMint: true, fees: [fee], missing: [fee], state: 'awaiting_payment', payable: true, payBy: { rail: 'tap' },
  mintFunding: { address: setAsideAddress, satoshis: 4200, feeRate: 3, label: 'your mint inscription' } });

test('one approval: Pay and mint sends one TAP Wallet payment with the set-aside, then the server-sent mint is followed in plain words', async t => {
  const status = awaiting(), { p, wallet } = await requestPage(t, status);
  const pay = p.getByRole('button', { name: 'Pay and mint', exact: true });
  await pay.waitFor();
  assert.equal(await p.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);
  assert.match(await p.locator('main').innerText(), /Bitcoin set aside for the mint inscription and a possible refund\s+4,200 sats/);
  await pay.click();
  const dialog = p.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Pay and mint', exact: true }).waitFor();
  assert.match(await dialog.innerText(), /TAP Wallet asks once/); assert.match(await dialog.innerText(), /Bitcoin set aside for the mint inscription and a possible refund\s+4,200 sats/);
  await shot(p, 'request-pay-and-mint-confirm');
  await dialog.getByRole('button', { name: 'Pay and mint', exact: true }).click();
  await p.getByText('Paid. Your mint goes out automatically when the permit arrives. You can close this page.', { exact: true }).first().waitFor();
  const sent = wallet.state.calls.filter(c => c[0] === 'singleTxTransfer');
  assert.equal(sent.length, 1, 'one wallet approval');
  assert.deepEqual(sent[0][2], { extraOutputs: [{ address: setAsideAddress, satoshis: 4200, label: 'your mint inscription' }] });
  await shot(p, 'request-paid-once');
  // The gateway follows the set-aside: payment confirmed → permit → mint sent → minted.
  Object.assign(status, { state: 'paid', missing: [], payable: false, mintFunding: undefined, mintSender: { state: 'funded', fundingOutpoint: 'ab'.repeat(32) + ':1' } });
  await p.getByRole('button', { name: 'Refresh', exact: true }).click();
  const mine = panel(p, 'Your mint');
  await mine.getByText(/Done: your payment and the set-aside confirmed on Bitcoin\./).waitFor();
  await mine.getByText(/Now: waiting for the permit/).waitFor();
  assert.equal(await p.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0);
  const commit = 'c1'.repeat(32), reveal = 'c2'.repeat(32);
  Object.assign(status, { state: 'permit_issued', mintSender: { state: 'sent', commitTxid: commit, revealTxid: reveal, inscriptionId: reveal + 'i0' } });
  await p.getByRole('button', { name: 'Refresh', exact: true }).click();
  await mine.getByText(/Now: waiting for Bitcoin to confirm the mint\./).waitFor();
  assert.equal(await mine.locator(`a[href="https://mempool.space/tx/${commit}"]`).count(), 1);
  assert.equal(await mine.locator(`a[href="https://mempool.space/tx/${reveal}"]`).count(), 1);
  assert.equal(await p.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0, 'no second wallet step');
  await shot(p, 'request-mint-sent');
  Object.assign(status, { state: 'minted', inscription: reveal + 'i0', mintSender: { ...status.mintSender, state: 'minted' } });
  await p.getByRole('button', { name: 'Refresh', exact: true }).click();
  await p.getByText(/^Minted\. Inscription/).waitFor();
  assert.equal(wallet.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 1);
  assert.doesNotMatch(await p.locator('main').innerText(), /\bprices?\b/i);
});

test('needs_user: the server cannot send, so the page explains it and offers Inscribe mint with the wallet', async t => {
  const status = { ...awaiting(), state: 'permit_issued', missing: [], payable: false, mintFunding: undefined, mintSender: { state: 'needs_user' },
    mintContent: { p: 'tap', op: 'token-mint', tick: 'dmwfixture', amt: '3', dta: requestId, prv: { address: payer, hash: '56'.repeat(32) } } };
  const { p, wallet } = await requestPage(t, status);
  await p.getByText('The set-aside was not enough after a fee rise; inscribe with your wallet. The set-aside is returned to you.', { exact: true }).waitFor();
  await p.getByRole('button', { name: 'Inscribe mint', exact: true }).waitFor();
  assert.equal(await p.getByRole('heading', { name: 'Your mint', exact: true }).count(), 0);
  await shot(p, 'request-needs-user');
  // A mint without any server sending keeps today's Inscribe mint step.
  Object.assign(status, { mintSender: undefined });
  await p.getByRole('button', { name: 'Refresh', exact: true }).click();
  await p.getByText('Your payment won. This permit has no expiry; you can inscribe when ready.', { exact: true }).waitFor();
  await p.getByRole('button', { name: 'Inscribe mint', exact: true }).waitFor();
  assert.deepEqual(wallet.state.calls, []);
});

for (const version of [null, '1.0.48']) test(`a TAP Wallet ${version ?? 'without getCapabilities'} is refused on the request page before any other wallet call`, async t => {
  const { p, posts, wallet, seen } = await requestPage(t, awaiting(), { version });
  const tooOld = 'This needs TAP Wallet 1.0.49 or newer. Update TAP Wallet, then reload this page.';
  await p.getByText(tooOld, { exact: true }).waitFor();
  await p.getByRole('button', { name: 'Pay and mint', exact: true }).click();
  await p.getByText(tooOld, { exact: true }).waitFor();
  assert.equal(await p.getByRole('dialog').count(), 0, 'no confirmation');
  assert.deepEqual(seen.filter(name => name !== 'getCapabilities'), []);
  assert.deepEqual(wallet.state.calls, []); assert.deepEqual(posts, []);
  if (version === null) await shot(p, 'request-wallet-too-old');
});

for (const [state, text] of [['refund_pending', 'Refund pending'], ['refund_waiting_funds', 'Refund waiting for operator funds'], ['refund_needs_operator', 'Refund waiting for operator action'], ['refund_sent', 'Refund sent:'], ['refund_confirmed', 'Refund sent:']]) {
  test(`public request and refunds list display ${state} with the sent transaction link`, async t => {
    const id = 'ab'.repeat(32), txid = 'cd'.repeat(32), refund = { id, requestId: id, asset: 'p2:0', block: '151', tapAddress,
      state: 'owed', reason: 'someone_paid_first', fees: [{ ticker: 'tap', amount: atomic(226) }], refundDelivery: { state, revealTxid: txid } };
    const { p } = await publicMintPage(t, { connected: true, refunds: route => json(route, { v: 3, rows: [refund], next: null, nextCursor: null, total: null }) });
    await p.goto(server.url + '/mint');
    const refunds = panel(p, 'Your refunds'); await refunds.locator('tbody tr').first().waitFor();
    assert.ok((await refunds.innerText()).includes(text));
    if (['refund_sent', 'refund_confirmed'].includes(state)) assert.equal(await refunds.getByRole('link', { name: txid, exact: true }).getAttribute('href'), 'https://mempool.space/tx/' + txid);
    await p.route('**/mint/' + id, route => route.request().resourceType() === 'document' ? route.continue() : json(route, {
      requestId: id, publicMint: true, asset: 'p2:0', block: '151', amount: '3', receiver: tapAddress, payer: tapAddress,
      state: 'refundable', payable: false, payBy: { rail: 'tap' }, fees: [], missing: [], refunds: [refund],
    }));
    await p.route('**/mint/deployment-state/p2:0', route => json(route, { asset: 'p2:0', state: 'registered' }));
    await p.goto(server.url + '/mint/' + id);
    await p.getByText(text, { exact: !text.endsWith(':') }).waitFor();
    if (['refund_sent', 'refund_confirmed'].includes(state)) assert.equal(await p.getByRole('link', { name: txid, exact: true }).getAttribute('href'), 'https://mempool.space/tx/' + txid);
  });
}
