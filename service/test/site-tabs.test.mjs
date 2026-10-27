import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { serveControl } from '../../playground/http.mjs';

const pages = [
  { path: '/mint', tab: 'Mint On-Chain', heading: 'Mint from your wallet' },
  { path: '/link', tab: 'Link Bitmap', heading: 'Link a Bitmap' },
  { path: '/bind-payout', tab: 'Payout wallets', heading: 'Bind payout wallet' },
];
const target = { network: 'tabs-test', bitcoinNetwork: 'regtest' };
const id = 'ab'.repeat(32);
const mint = { id, requestId: id, state: 'awaiting_payment', receiver: 'wallet-fixture', amount: '1', fees: [], missing: [], payBy: { rail: 'tap' } };
const binding = { state: 'awaiting_wallet', request: { agent: 'agent-fixture', rail: 'tap', address: 'wallet-fixture', expiry: Date.now() + 3600000 } };
function read(path) {
  const p = new URL(path, 'http://local').pathname;
  if (p === '/status') return { state: 'ready', tip: 1, counted: 1 };
  if (p === '/patterns' || p === '/compounds') return { [p.slice(1)]: [], total: 0, next: null };
  return { events: [], total: 0, next: null };
}
let browser, server, control, consoleURL;
before(async () => {
  server = await serve({ intake: { store: {} }, files: { serve: async () => false },
    web: createWeb({ target, records: async () => ({}), plan: async () => ({ id, state: 'awaiting_wallet' }) }),
    mints: { public: () => mint }, bindings: { read: () => binding }, publicAPI: { handles: path => !path.startsWith('/mint/'), read } });
  control = await serveControl({ token: 'tabs-browser-fixture', events: [], port: 0,
    route: async (_method, url) => read(url.pathname.replace(/^\/api/, '') + url.search) });
  consoleURL = `http://127.0.0.1:${control.server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await control?.close(); await server?.close(); });

async function open(t) {
  const context = await browser.newContext(), page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'no page errors'); });
  return page;
}
async function selected(page, item, address = item.path) {
  await page.getByRole('heading', { name: item.heading, exact: true }).waitFor();
  await page.getByRole('tab', { name: item.tab, exact: true, selected: true }).waitFor();
  assert.equal(await page.getByRole('tab', { selected: true }).count(), 1);
  assert.deepEqual(await page.getByRole('tab').allTextContents(), pages.map(p => p.tab));
  const url = new URL(page.url());
  assert.equal(url.pathname + url.search + url.hash, address);
}
async function loaded(page, item) {
  if (item.path === '/mint') await page.getByText('Open the mint request link issued by your agent.', { exact: false }).waitFor();
  else {
    await page.getByRole('button', { name: 'Connect TAP wallet', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Connect MetaMask', exact: true }).count(), item.path === '/bind-payout' ? 1 : 0);
  }
}

for (const start of pages) for (const fragment of [false, true]) {
  const address = fragment ? '/#' + start.path : start.path;
  test(`wallet tabs, reload and history stay in sync from ${address}`, async t => {
    const page = await open(t);
    await page.goto(server.url + address);
    await selected(page, start, address);
    await loaded(page, start);
    await page.reload();
    await selected(page, start, address);
    await loaded(page, start);
    // Every directed transition, including mint -> payout and payout -> link.
    const visits = [{ item: start, address }];
    let current = start;
    for (const item of [pages[0], pages[1], pages[0], pages[2], pages[1], pages[2], pages[0]]) {
      const historyLength = await page.evaluate(() => history.length);
      await page.getByRole('tab', { name: item.tab, exact: true }).click();
      if (item === current) {
        assert.equal(await page.evaluate(() => history.length), historyLength, 'active tab does not add history');
        await selected(page, item, visits.at(-1).address);
      } else {
        await selected(page, item);
        visits.push({ item, address: item.path });
        current = item;
      }
      await loaded(page, item);
    }
    for (let i = visits.length - 2; i >= 0; i--) {
      await page.goBack();
      await selected(page, visits[i].item, visits[i].address);
      await loaded(page, visits[i].item);
    }
    for (const visit of visits.slice(1)) {
      await page.goForward();
      await selected(page, visit.item, visit.address);
      await loaded(page, visit.item);
    }
  });
}

test('each request URL loads its request content and all wallet tabs', async t => {
  const page = await open(t);
  for (const [index, item] of pages.entries()) {
    await page.goto(server.url + item.path + '/' + id);
    await selected(page, item, item.path + '/' + id);
    await page.getByRole('heading', { name: ['Remaining fees', 'Review request', 'Review payout binding'][index], exact: true }).waitFor();
    await page.getByRole('tab', { name: pages[(index + 1) % pages.length].tab, exact: true }).click();
    await selected(page, pages[(index + 1) % pages.length]);
  }
});

test('request URLs keep their selected tab and allow leaving before reads finish', async t => {
  const page = await open(t);
  // Hold the read open until after navigating away; no wallet is connected.
  await page.route('**/web-api/target', async route => {
    await new Promise(resolve => setTimeout(resolve, 150));
    await route.fulfill({ json: target });
  });
  for (const item of pages) {
    await page.goto(server.url + item.path + '/' + id);
    await selected(page, item, item.path + '/' + id);
    const next = pages[(pages.indexOf(item) + 1) % pages.length];
    await page.getByRole('tab', { name: next.tab, exact: true }).click();
    await selected(page, next);
    await page.getByRole('link', { name: 'About', exact: true }).click();
    await page.locator('article.about').waitFor();
  }
});

for (const local of [false, true]) for (const result of ['{}', 'Promise.resolve({})']) {
  test(`${local ? 'console' : 'public'} router ignores a ${result} mount result`, async t => {
    const page = await open(t), prefix = local ? '' : '/web/console';
    await page.route(`**${prefix}/js/views/about.js`, route => route.fulfill({
      contentType: 'text/javascript', body: `export function mount(root) { root.innerHTML = '<h1>Fixture view</h1>'; return ${result}; }`,
    }));
    if (local) {
      await page.goto(consoleURL + '/?t=tabs-browser-fixture#/about');
    } else await page.goto(server.url + '/about');
    await page.getByRole('heading', { name: 'Fixture view' }).waitFor();
    await page.getByRole('link', { name: 'Periodic table', exact: true }).click();
    await page.getByRole('heading', { name: 'Periodic table of patterns', exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Fixture view' }).waitFor();
  });
}

for (const local of [false, true]) {
  test(`${local ? 'console' : 'public'} router mounts only the latest visit after a slow import`, async t => {
    const page = await open(t), prefix = local ? '' : '/web/console';
    const requested = Promise.withResolvers(), release = Promise.withResolvers();
    await page.route(`**${prefix}/js/views/about.js`, async route => {
      requested.resolve();
      await release.promise;
      await route.fulfill({ contentType: 'text/javascript', body: `export function mount(root) {
        window.fixtureMounts = (window.fixtureMounts ?? 0) + 1;
        root.innerHTML = '<h1>Latest view</h1>';
        return () => { window.fixtureDisposals = (window.fixtureDisposals ?? 0) + 1; };
      }` });
    });
    t.after(() => release.resolve());
    await page.goto(local ? consoleURL + '/?t=tabs-browser-fixture#/table' : server.url + '/table');
    await page.getByRole('heading', { name: 'Periodic table of patterns' }).waitFor();
    await page.getByRole('link', { name: 'About', exact: true }).click();
    await requested.promise;
    await page.getByRole('link', { name: 'Periodic table', exact: true }).click();
    await page.getByRole('heading', { name: 'Periodic table of patterns' }).waitFor();
    await page.getByRole('link', { name: 'About', exact: true }).click();
    await page.waitForURL(local ? '**/#/about' : '**/about');
    release.resolve();
    await page.getByRole('heading', { name: 'Latest view' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureMounts), 1);
    await page.getByRole('link', { name: 'Periodic table', exact: true }).click();
    await page.getByRole('heading', { name: 'Periodic table of patterns' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureDisposals), 1, 'function cleanups still run');
  });
}
