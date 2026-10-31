import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../../../service/src/http.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { encodeTracAddress } from '../../../rules/src/trac-address.js';
const { chromium } = await import('playwright');

// One compound whose name is not on the first page of the catalog, made from a known and an unknown pattern.
const owner = encodeTracAddress('22'.repeat(32));
const COMPOUND = 'c2:' + 'e9f0843e'.padEnd(64, '7');
const digit = { asset: 'p2:0', number: '0', name: 'dmwdigit', pat: '[0-9]', fld: 4, tier: 1, rarity: 1, supply: '10', legacy: { asset: 'p0' } };
const moonite = { ...digit, asset: 'p2:7', number: '7', name: 'dmwmoonite' };
const compound = { id: COMPOUND, recipe: 'fusion', inputs: [{ asset: 'p2:0', amount: '1' }, { asset: 'p2:7', amount: '1' }], supply: '3' };
const craft = { sequence: 5, id: 'event5', at: 1, type: 'craft', data: { owner, id: COMPOUND, amount: '3' } };
const page = (key, rows) => ({ [key]: rows, total: rows.length, next: null });
const reads = [];
function read(path) {
  const u = new URL(path, 'http://local'), p = u.pathname, asset = u.searchParams.get('asset');
  reads.push(p + u.search);
  if (p === '/status') return { tip: 10, counted: 10, feePolicy: { baseFee: '1000000000000000000', unit: { decimals: 18 } } };
  const q = u.searchParams.get('q');
  if (p === '/patterns') return page('patterns', asset ? [digit, moonite].filter(x => x.asset === asset) : q ? [digit, moonite].filter(x => x.name.includes(q)) : [digit]);
  if (p === '/compounds') return page('compounds', asset === COMPOUND ? [compound] : []);
  if (p === '/feed') return page('events', Number(u.searchParams.get('since') ?? 0) < 5 ? [craft] : []);
  if (p === '/agents') return page('agents', [{ address: owner, crafts: 1 }]);
  if (p === '/agents/' + owner) return { address: owner, scores: { crafts: 1 } };
  if (p === `/agents/${owner}/balances`) return page('balances', [{ asset: COMPOUND, amount: '3' }, { asset: 'p2:7', amount: '5' }]);
  if (p === `/agents/${owner}/history`) return page('history', [craft]);
  return page(p.split('/').at(-1), []);
}
// The gateway's ticker lookup: "moon" is anyone's ticker of Moonite, "fizz" the compound's own.
const tickers = { find: async tick => ({ moon: { ticker: 'dmt-moon', tick: 'moon', asset: 'p2:7', official: false, ordinal: '2' },
  fizz: { ticker: 'fizz', tick: 'fizz', asset: COMPOUND, official: true, ordinal: '1' } })[tick.toLowerCase().replace(/^dmt-/, '')] ?? { ticker: tick.toLowerCase(), asset: null } };
let browser, server;
before(async () => {
  server = await serve({ intake: { store: {} }, files: { serve: async () => false }, web: createWeb({ records: async () => ({}) }), operator: { provisioner: { tickers } },
    publicAPI: { handles: url => !url.startsWith('/tickers/'), read }, bindings: { wallets: () => ({ players: [], more: false }), read: () => ({ binding: null }) } });
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function open(t, path) {
  const context = await browser.newContext(), p = await context.newPage();
  p.setDefaultTimeout(8000);
  t.after(() => context.close());
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no script errors'));
  await p.goto(server.url + path);
  return p;
}
// Visible text and every tooltip: neither may hold a raw compound id.
async function noRawIds(p) {
  const text = await p.locator('body').innerText();
  assert.doesNotMatch(text, /c2:[0-9a-f]/, 'no raw compound id on the page');
  const tips = await p.$$eval('[data-tip],[title],[aria-label]', es => es.flatMap(e => ['data-tip', 'title', 'aria-label'].map(a => e.getAttribute(a) ?? '')));
  assert.deepEqual(tips.filter(tip => /c2:[0-9a-f]/.test(tip)), [], 'no raw compound id in a tooltip');
}

test('an agent page names a compound and a pattern that are not loaded yet, by one point read each', async t => {
  reads.length = 0;
  const p = await open(t, '/agents/' + owner), balances = p.locator('section.panel').filter({ has: p.getByRole('heading', { name: 'Wallet balances' }) });
  await balances.getByText('Digit + Moonite fusion', { exact: true }).waitFor();
  await balances.getByText('Moonite', { exact: true }).waitFor();
  await p.getByText('crafted 3 Digit + Moonite fusion', { exact: true }).waitFor();
  await noRawIds(p);
  assert.ok(!reads.some(r => r.startsWith('/compounds?') && !r.includes('asset=') && !r.includes('firstMaker=')), 'no catalog download');
});

test('the live feed fills in a compound name once its point read answers', async t => {
  const p = await open(t, '/feed');
  await p.getByText('crafted 3 Digit + Moonite fusion', { exact: true }).waitFor();
  await noRawIds(p);
});

test('an unknown compound address names its short key, never the raw id', async t => {
  const p = await open(t, '/compound/c2:' + 'ab'.repeat(32));
  await p.getByText('Compound #abababab was not found.', { exact: true }).waitFor();
  await noRawIds(p);
});

test('a ticker in the pattern search finds its pattern or compound and says which ticker matched', async t => {
  const p = await open(t, '/mint'), box = p.locator('#deploy'), publicBox = p.locator('#mint');
  const search = box.locator('input[type="search"]');
  await search.fill('MOON'); await search.dispatchEvent('change');
  await box.getByText('ticker moon', { exact: true }).waitFor();
  assert.equal(await search.inputValue(), 'Moonite · ticker moon');
  assert.equal(await box.getByRole('link', { name: 'Moonite', exact: true }).getAttribute('href'), '/pattern/p2:7');
  await search.fill('dmt-moon'); await search.dispatchEvent('change');
  await box.getByText('ticker dmt-moon', { exact: true }).waitFor();
  await search.fill('fizz'); await search.dispatchEvent('change');
  await box.getByText('ticker fizz', { exact: true }).waitFor();
  await box.getByRole('link', { name: 'Digit + Moonite fusion', exact: true }).waitFor();
  // Public blocks are patterns only: a compound's ticker is named, not picked.
  const pick = publicBox.locator('input[type="search"]');
  await pick.fill('fizz'); await pick.dispatchEvent('change');
  await publicBox.getByText('Ticker fizz belongs to the compound Digit + Moonite fusion. Public blocks are patterns only.', { exact: true }).waitFor();
  await pick.fill('moon'); await pick.dispatchEvent('change');
  await p.waitForFunction(() => document.querySelector('#mint input[type="search"]').value === 'Moonite · ticker moon');
  await search.fill('nothing-here'); await search.dispatchEvent('change');
  await box.getByText('No pattern named “nothing-here”.', { exact: true }).waitFor();
  await noRawIds(p);
});

test('a compound page shows its name and short key; the key chip copies the full id without showing it', async t => {
  const p = await open(t, '/compound/' + COMPOUND);
  await p.getByRole('heading', { name: 'Digit + Moonite fusion' }).first().waitFor();
  const chip = p.locator('.hash', { hasText: '#e9f0843e' }).first();
  await chip.waitFor();
  assert.equal(await chip.getAttribute('title'), 'compound key #e9f0843e');
  await noRawIds(p);
});
