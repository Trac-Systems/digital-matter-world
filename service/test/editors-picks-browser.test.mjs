import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
const { chromium } = await import('playwright');

const finder = encodeTracAddress('22'.repeat(32));
// The catalog's first page: satoshiera is not on it, so its card learns of it from its token read.
const patterns = [['4', 'jackpot', 4], ['41', 'firsthundred', 5]]
  .map(([number, name, tier]) => ({ asset: 'p2:' + number, number, name, pat: '0', fld: 4, tier, rarity: '100', supply: '100', discoverer: finder }));
function read(path) {
  const u = new URL(path, 'http://local'), p = u.pathname;
  if (p === '/status') return { tip: '974466', counted: '974466', feePolicy: { baseFee: '1000000000000000000', unit: { decimals: 18 } } };
  if (p === '/patterns') return { patterns, total: patterns.length, next: null };
  return { [p.split('/').at(-1)]: [], total: 0, next: null };
}
// The live reads, as the gateway answers them: jackpot's token is deployed and its block opens later,
// satoshiera has no token in its discoverer's week and a public block, firsthundred's reads fail.
const tokens = {
  'p2:4': { asset: 'p2:4', state: 'registered', entry: { tick: 'jackpot' } },
  'p2:17': { asset: 'p2:17', state: 'awaiting_player_deploy', definition: { name: 'satoshiera', discoverer: finder }, deployer: { until: '975205', discoverer: finder, onlyDiscoverer: true } },
};
const blocks = { 'p2:4/974462': { state: 'not_yet_public', publicFrom: '975470' }, 'p2:17/0': { state: 'public', amount: '1' } };
// The page's own fixture, so the checks do not depend on what the editor writes.
const point = lead => ({ lead, text: 'More words.' });
const fixture = { v: 1, updated: '2026-11-04T03:00:00Z', intro: 'Our picks.', statsNote: 'Counted up to block 974,466.', tierNote: 'Tiers count every matching block in history.',
  stats: [{ label: 'Patterns discovered', value: '3,614' }, { label: 'Discovered by', value: '64 agents' }],
  picks: [
    { asset: 'p2:4', name: 'jackpot', emoji: '🎰', title: 'jackpot: 777 in the nonce', utility: 'Prediction markets and fair loot drops', why: 'Why.', points: [point('One.'), point('Two.')], facts: [{ label: 'Blocks in history', value: '6,176' }], tier: 3, highlightBlocks: ['974462'] },
    { asset: 'p2:17', name: 'satoshiera', emoji: '🕯️', title: 'satoshiera', utility: 'Collateral and reserve asset', why: 'Why.', points: [point('One.')], facts: [], highlightBlocks: ['0', '9', '170'], related: [{ asset: 'p2:4', name: 'jackpot' }] },
    { asset: 'p2:41', name: 'firsthundred', emoji: '🔑', title: 'firsthundred', utility: 'Memberships and access keys', why: 'Why.', points: [point('One.'), point('Two.'), point('Three.')], facts: [], highlightBlocks: ['0', '1', '99'] },
  ] };
let browser, server;
before(async () => {
  server = await serve({ intake: { store: {} }, files: { serve: async () => false }, web: createWeb({ records: async () => ({}) }), publicAPI: { handles: () => true, read } });
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function open(t, { width = 1280, height = 900, picks = fixture } = {}) {
  const context = await browser.newContext({ viewport: { width, height } }), page = await context.newPage();
  page.setDefaultTimeout(8000);
  t.after(() => context.close());
  const errors = [], reads = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no script errors'));
  await page.route('**/mint/deployment-state/*', route => {
    const asset = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)); reads.push(asset);
    if (asset === 'p2:999') return route.fulfill({ status: 404, json: { error: 'asset_unknown' } });
    return tokens[asset] ? route.fulfill({ json: tokens[asset] }) : route.fulfill({ status: 500, json: { error: 'service_unavailable' } });
  });
  await page.route('**/public-mints/*/*', route => {
    const [asset, block] = new URL(route.request().url()).pathname.split('/').slice(-2).map(decodeURIComponent); reads.push(asset + '/' + block);
    return blocks[asset + '/' + block] ? route.fulfill({ json: { asset, block, ...blocks[asset + '/' + block] } }) : route.abort();
  });
  if (picks) await page.route('**/web/data/editors-picks.json', route => route.fulfill({ json: picks }));
  await page.goto(server.url + '/editors-picks');
  await page.locator('.pick').first().waitFor();
  return Object.assign(page, { reads });
}

test('the menu shows Editor\'s Picks after the separator, right before Mint', async t => {
  const page = await open(t);
  const nav = await page.$$eval('nav.nav > *', items => items.map(i => i.matches('.sep') ? '|' : i.querySelector('span').textContent));
  assert.deepEqual(nav.slice(-4), ['Records', '|', 'Editor\'s Picks', 'Mint']);
  assert.equal(await page.locator('nav.nav a.on').getAttribute('href'), '/editors-picks');
  assert.equal(await page.title(), 'Editor\'s Picks · Digital Matter World');
});

test('each pick leads with its utility and shows what is possible right now', async t => {
  const page = await open(t);
  const cards = page.locator('.pick');
  assert.equal(await cards.count(), 3);
  const jackpot = cards.nth(0), satoshiera = cards.nth(1), hundred = cards.nth(2);
  assert.deepEqual(await page.locator('.picks-stats .figures > div').allInnerTexts(), ['Patterns discovered\n3,614', 'Discovered by\n64 agents']);
  assert.equal(await page.locator('.picks-stats p').textContent(), 'Counted up to block 974,466.');
  assert.equal(await page.locator('.picks-note').textContent(), 'Tiers count every matching block in history.');
  // The editor's tier wins over the live one (jackpot is tier 4 in the catalog); without it, the live tier shows.
  assert.equal(await jackpot.locator('header .tier').textContent(), 'T3');
  assert.equal(await jackpot.locator('header .tier').getAttribute('data-tip'), 'Tiers count every matching block in history.');
  assert.equal(await hundred.locator('header .tier').textContent(), 'T5');
  assert.equal(await satoshiera.getByRole('link', { name: 'jackpot' }).getAttribute('href'), '/pattern/p2:4');
  assert.equal(await jackpot.locator('.pick-use .v').textContent(), 'Prediction markets and fair loot drops');
  assert.equal(await page.locator('.page-head p').first().textContent(), 'Our picks.');
  await jackpot.locator('.pick-now:not([hidden])').waitFor();
  assert.match(await jackpot.locator('.pick-now').textContent(), /Token created.*Block 974,462 opens for public minting at block 975,470 \(about 7 days\)/);
  assert.equal(await jackpot.getByRole('link', { name: 'All public blocks' }).getAttribute('href'), '/mint?asset=p2%3A4');
  assert.equal(await jackpot.getByRole('link', { name: 'Claim with an agent' }).getAttribute('href'), '/about#steps');
  assert.equal(await jackpot.getByRole('link', { name: 'Pattern page' }).getAttribute('href'), '/pattern/p2:4');
  assert.equal(await jackpot.locator('.pick-links a[href^="/agents/"]').getAttribute('href'), '/agents/' + finder);
  assert.equal(await jackpot.locator('.pick-links a[href="/block/974462"]').count(), 1);

  await satoshiera.locator('.pick-now:not([hidden])').waitFor();
  assert.match(await satoshiera.locator('.pick-now').textContent(), /No token yet.*Until block 975,205 \(about 5 days\) only its discoverer can create it/);
  assert.equal(await satoshiera.getByRole('link', { name: 'Token page' }).getAttribute('href'), '/mint/p2:17');
  assert.equal(await satoshiera.getByRole('link', { name: 'Mint block 0' }).getAttribute('href'), '/mint?asset=p2%3A17&block=0');
  assert.deepEqual(await satoshiera.locator('.pick-links a[href^="/block/"]').allTextContents(), ['0', '9', '170']);
  assert.equal(await satoshiera.getByRole('link', { name: 'Pattern page' }).getAttribute('href'), '/pattern/p2:17');
  assert.equal(await satoshiera.locator('.pick-links a[href^="/agents/"]').getAttribute('href'), '/agents/' + finder);

  // Both reads failed: the card is all there, without the live part.
  await hundred.scrollIntoViewIfNeeded();
  for (let i = 0; i < 50 && !page.reads.includes('p2:41/0'); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(300);
  assert.equal(await hundred.locator('.pick-now').isHidden(), true);
  assert.equal(await hundred.locator('.pick-points li').count(), 3);
  assert.equal(await hundred.getByRole('link', { name: 'Pattern page' }).count(), 1);
  // One token read and one block read per card, nothing repeated.
  assert.deepEqual([...page.reads].sort(), ['p2:17', 'p2:17/0', 'p2:4', 'p2:4/974462', 'p2:41', 'p2:41/0']);

  // Following a card's link stays in the page.
  await satoshiera.getByRole('link', { name: 'Mint block 0' }).click();
  await page.waitForURL('**/mint?asset=p2%3A17&block=0');
  assert.equal(await page.locator('h1').first().textContent(), 'Mint & wallets');
});

test('unknown assets, missing fields and an empty file still draw a page', async t => {
  const page = await open(t, { picks: { v: 1, picks: [
    { title: 'Only a title' },
    { asset: 'p2:999', name: 'ghost', title: 'Not in the catalog', utility: 'Nothing yet', highlightBlocks: ['5'] },
    { asset: '../../etc', title: '<img src=x onerror=alert(1)>', why: '<b>plain</b>', kind: 'meme' },
    'junk',
  ] } });
  const cards = page.locator('.pick');
  assert.equal(await cards.count(), 3);
  assert.equal(await cards.nth(0).locator('h2').textContent(), 'Only a title');
  assert.equal(await cards.nth(1).locator('.pick-now').isHidden(), true);
  assert.equal(await cards.nth(1).getByRole('link', { name: 'Pattern page' }).count(), 0);
  assert.equal(await cards.nth(1).locator('a[href="/block/5"]').count(), 1);
  assert.equal(await cards.nth(2).locator('h2').textContent(), '<img src=x onerror=alert(1)>');
  assert.equal(await cards.nth(2).locator('img, b').count(), 0);
  assert.equal(await cards.nth(2).locator('.pill').textContent(), 'Meme pick');
  for (let i = 0; i < 50 && !page.reads.length; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(300);
  assert.deepEqual(page.reads, ['p2:999'], 'a pattern the gateway does not know gets no block read');
  assert.equal(await cards.nth(1).getByRole('link', { name: 'Pattern page' }).count(), 0);

  const empty = await browser.newContext(), other = await empty.newPage();
  t.after(() => empty.close());
  await other.route('**/web/data/editors-picks.json', route => route.fulfill({ status: 503, json: { error: 'data_unavailable' } }));
  await other.goto(server.url + '/editors-picks');
  await other.getByText('The picks did not load. Reload the page to try again.').waitFor();
});

test('the editor\'s picks file renders every pick', async t => {
  const page = await open(t, { picks: null });
  const raw = JSON.parse(await readFile(new URL('../public/web/data/editors-picks.json', import.meta.url), 'utf8'));
  assert.equal(await page.locator('.pick').count(), raw.picks.length);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('a phone shows the picks without sideways scrolling', async t => {
  const page = await open(t, { width: 375, height: 760 });
  await page.locator('.pick-now:not([hidden])').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('nav.nav a[href="/editors-picks"] span:visible').textContent(), 'Picks');
});
