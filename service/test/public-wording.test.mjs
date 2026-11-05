import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { webTarget } from '../src/web-checkout.mjs';
import { presentation } from '../public/web/api.js';
import { encodeTracAddress } from '../../rules/src/trac-address.js';

const forbidden = /\b(?:local|regtest|anvil|devnet|testnet|playground|mainnet|network)\b|networkFee|\b(?:chain[ _-]?id|network[ _-]?id|bitcoinNetwork|localRpc|Ethereum chain)\b|31337|0x7a69|bcrt1|\btb1|https?:\/\/(?:localhost|127\.|0\.0\.0\.0|\[::1\])/i;
const id = 'ab'.repeat(32), owner = encodeTracAddress('11'.repeat(32));
const address = 'bc1p' + 'q'.repeat(58), ethAddress = '0x' + '12'.repeat(20);
const config = { mode: 'prod', network: 'dmw-mainnet', prod: {
  bitcoin: { kind: 'core', urlFile: '/private/bitcoin-url' },
  ethereum: { chainId: '1', token: '0x' + '34'.repeat(20), address: ethAddress, urlFile: '/private/ethereum-url' },
  trac: { bootstrap: '11'.repeat(32), msbBootstrap: '22'.repeat(32), networkId: 1, runtimeConfig: '/private/trac-config' },
} };
const target = webTarget(config);
const pattern = { asset: 'p0', number: 0, name: 'dmwdigit', pat: '[0-9]', fld: 4, tier: 1, rarity: 1, supply: '10', discoverer: owner };
const compound = { id: 'c1', asset: 'c1', mass: '2', properties: { mass: '2', generation: 1 }, supply: '1', firstMaker: owner, inputs: [['p0', '2']] };
const event = { sequence: 1, at: 1, id, type: 'block', data: { height: 7, tip: 7 } };
const batch = { n: 1, from: 1, to: 7, root: 'cd'.repeat(32), ops: [] };
const find = { asset: 'p0', block: 7, count: 1, finder: owner };
const mint = { id, asset: 'p0', block: 7, amount: '1', kind: 'tap', state: 'awaiting_payment', receiver: address, price: '1000000000000000000', networkFeeSats: '0' };
const pending = { state: 'pending', request: { agent: owner, rail: 'tap', address, expiry: Date.now() + 3600000, network: config.network }, message: `signed binding\n${config.network}\n${address}` };
const plans = type => ({ ...mint, type, ...(type === 'mint' ? { payable: true, reservation: 'reserved', fees: [], missing: [], blocked: [] } : {}), payer: address, owner, target, deadline: 100, counted: 7, refundAfter: 144, networkFee: type === 'mint' ? null : { address, sats: '1000' } });
function pageRows(key, rows, u) {
  const limit = Number(u.searchParams.get('limit') ?? 50);
  return { [key]: rows.slice(0, limit), total: rows.length, next: null };
}
function read(input) {
  const u = new URL(input, 'http://fixture.invalid'), p = u.pathname;
  if (p === '/status') return { network: config.network, tip: 7, counted: 7, batch, feePolicy: { baseFee: '1000000000000000000', unit: { decimals: 18 } } };
  if (p === '/world') return pageRows('plots', [{ height: 7, x: 1, y: 0, claimable: true }], u);
  if (p === '/world/map') return { tip: 7, counted: 7, from: Number(u.searchParams.get('from') ?? 0), to: Number(u.searchParams.get('to') ?? 7), marks: [] };
  if (p === '/blocks/7') return { height: 7, x: 1, y: 0, halving: 0, region: 0, claimable: true, header: { hash: id, time: 1 }, network: config.network };
  if (p === '/patterns') return pageRows('patterns', [pattern], u);
  if (p === '/compounds') return pageRows('compounds', [compound], u);
  if (p === '/feed' || p === '/events') return pageRows('events', u.searchParams.has('since') ? [] : [event], u);
  if (p === '/events/1') return { ...event, network: config.network };
  if (p === '/finds') return pageRows('finds', [find], u);
  if (p === '/agents') return pageRows('agents', [{ address: owner, finds: 1 }], u);
  if (p === '/agents/' + owner) return { address: owner, scores: { finds: 1 }, network: config.network };
  if (p === '/results') return { counts: { mints: 1 }, treasury: { bitcoin: address, tap: '1000' }, burn: { tap: '1' }, outstandingSupply: {} };
  if (p === '/results/mints') return pageRows('mints', [mint], u);
  if (p === '/results/ethereum') return pageRows('ethereum', [{ id, payer: ethAddress, chainId: 1, deposit: { amount: '1', status: 1 }, network: config.network }], u);
  if (p === '/results/paid') return pageRows('paid', [{ agent: owner, address, amount: '1', state: 'paid', network: config.network }], u);
  if (p === '/records/batches') return pageRows('batches', [batch], u);
  if (p === '/records/batches/1') return { batch, network: config.network };
  if (p === '/receipts') return pageRows('receipts', [{ height: 7, seal: { count: 1, hash: id }, network: config.network }], u);
  const key = p.endsWith('/blocks') ? 'rows' : p.split('/').at(-1);
  return pageRows(key, [], u);
}
const routes = ['/', '/explore', '/blocks', '/block/7', '/plot/7', '/table', '/patterns', '/compounds', '/pattern/p0', '/compound/c1', '/agents', '/agents/' + owner, '/feed', '/events/1', '/results',
  ...['mints', 'payments', 'ethereum', 'payouts', 'owed', 'paid', 'links', 'treasury', 'burn'].map(k => '/results/' + k),
  '/records', '/records/batches/1', '/editors-picks', '/explore?collection=/finds&key=finds', '/explore?collection=/results/mints&key=mints',
  ...['mint', 'link', 'bind-payout'].flatMap(k => ['/' + k, '/' + k + '/' + id]), '/operator'];

test('display projection removes connection metadata without altering signed input or payment terms', () => {
  const input = { network: 'dmw-mainnet', target, message: pending.message, request: pending.request, price: '10', networkFee: { sats: '1', address },
    nested: [{ chainId: 31337, networkId: 1, rpc: 'http://127.0.0.1:1', explorer: 'https://example.invalid/regtest', state: 'ready' }] };
  const before = JSON.stringify(input), output = presentation(input);
  assert.doesNotMatch(JSON.stringify(output), forbidden);
  assert.deepEqual(output.inscriptionFee, input.networkFee);
  assert.equal(output.request.address, address);
  assert.equal(JSON.stringify(input), before, 'signature input is not modified');
});

test('every public view renders production-shaped data without connection wording or local endpoints', { timeout: 840000 }, async t => {
  // The shared lock covers Chromium only; it never touches another owner's lock.
  const lock = process.env.DMW_BROWSER_LOCK ?? join(tmpdir(), 'dmw-browser.lock');
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + 600000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (e) { if (e.code !== 'EEXIST' || Date.now() >= deadline) throw e; t.diagnostic('Waiting for the shared browser lock.'); await delay(30000); }
  }
  let browser, server, browserDeadline;
  try {
    const { chromium } = await import('playwright');
    server = await serve({ intake: { store: {} }, files: { serve: async () => false },
      web: createWeb({ target, records: async () => ({ biggestCompound: compound }), plan: async type => plans(type) }),
      mints: { public: () => ({ ...mint, payable: true, missing: [], payBy: { rail: 'tap', untilBlock: 100 }, fees: [] }), quote: async () => ({ ...mint, target, networkFeeSats: '1000' }) },
      publicAPI: { handles: () => true, read }, bindings: { read: path => path.includes('/requests/') ? pending : { binding: pending } },
      operator: { status: async () => ({ network: config.network, provisioning: [{ state: 'ready' }], payouts: { paid: [{ address, network: config.network }] }, committee: { healthy: ['a', 'b', 'c'] } }) },
    });
    browser = await chromium.launch({ headless: true });
    browserDeadline = setTimeout(() => { void browser.close(); }, 12 * 60000);
    const page = await browser.newPage(), errors = [], outside = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (!r.url().startsWith(server.url + '/') && !r.url().startsWith('data:')) outside.push(r.url()); });
    page.setDefaultTimeout(10000);
    async function checkText(label) {
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && ![...document.querySelectorAll('.empty')].some(e => e.textContent === 'Loading…' && e.getClientRects().length));
      const text = await page.evaluate(() => [document.title, document.body.innerText,
        ...Array.from(document.querySelectorAll('[aria-label], [title], [data-tip], a[href], input[value]')).flatMap(e => ['aria-label', 'title', 'data-tip', 'href', 'value'].map(a => e.getAttribute(a) ?? ''))].join('\n'));
      assert.doesNotMatch(text, forbidden, label);
      assert.doesNotMatch(text, /Unable to load:|failed to load|did not load|could not be loaded|Could not load this list|Loading…/i, label + ': loaded view');
    }
    for (const route of routes) {
      await page.goto(server.url + route);
      await page.waitForLoadState('networkidle');
      await page.locator('h1').waitFor();
      await checkText(route);
      if (route === '/table') { await page.getByRole('button', { name: 'List', exact: true }).click(); await page.waitForLoadState('networkidle'); await checkText(route + ' list'); }
      if (route === '/feed') { await page.getByRole('button', { name: 'History', exact: true }).click(); await page.waitForLoadState('networkidle'); await checkText(route + ' history'); }
      if (await page.getByRole('dialog').count()) await page.getByRole('button', { name: 'Close', exact: true }).click();
      const inspect = page.getByRole('button', { name: 'Inspect', exact: true });
      for (let i = 0, n = await inspect.count(); i < n; i++) {
        await inspect.nth(i).click(); await checkText(route + ' inspect ' + i);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
      }
    }
    // The legacy binding page is selected by the non-HTML Accept path.
    await page.route('**/bind-payout/' + id, r => r.continue({ headers: { ...r.request().headers(), accept: 'application/json' } }));
    await page.goto(server.url + '/bind-payout/' + id); await page.waitForLoadState('networkidle');
    assert.match(await page.locator('#request').innerText(), /Wallet: bc1p/);
    await checkText('legacy binding');
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    t.diagnostic(`Rendered ${routes.length} public routes plus legacy binding, list/history modes and Inspect drawers.`);
    await page.close();
    if (process.env.DMW_WORDING_LIVE_EVIDENCE === '1') await (await import('./public-wording-live.mjs')).captureLive(browser);
  } finally {
    clearTimeout(browserDeadline);
    try { await browser?.close(); } finally { await rmdir(lock); await server?.close(); }
  }
});
