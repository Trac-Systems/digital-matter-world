import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createWeb } from '../../../service/src/web.mjs';
import { publicIdentities } from '../../../rules/src/trac-address.js';
import { bitcoinAddress } from '../../../kit/test/helpers.mjs';
import { walletError, payWithin, creditedAmount } from '../js/wallet-errors.js';

// The single mint payment page on the real site shell, over fixed request states: a payment that arrived after
// expiry (a fee credit), an unpaid expiry, the time left to pay, too little time left, and a matching fee credit
// offered on the agent dashboard. Nothing here pays: no wallet is injected.
const shots = process.env.DMW_SHOTS;
const id = 'd1'.repeat(32), credit = 'e2'.repeat(32), payer = bitcoinAddress('regtest', 3);
const agent = publicIdentities({ owner: '11'.repeat(32) }).owner;
const fees = [{ role: 'treasury', to: payer, amount: '10000000000000000000', ticker: 'tap', tt: 'a', dta: 'dmw-pay-v2|' + id + '|treasury' }];
const record = extra => ({ id, requestId: id, asset: 'p2:1', amount: '3', block: '12', receiver: payer, payer, kind: 'tap', fees, missing: fees,
  payBy: { rail: 'tap', untilBlock: '900006' }, payment: [], blocked: [], ...extra });

async function site(t, { local = false } = {}) {
  const web = createWeb({ target: { network: 'dmw-test', bitcoinNetwork: 'regtest' }, records: async () => ({}), plan: async () => ({ owner: agent }) });
  const state = { status: record({ state: 'awaiting_payment', payable: true }), tip: '900000', credits: [], uses: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'), html = req.headers.accept?.includes('text/html');
    const send = (value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/mint/' + id && !html) return send(state.status);
    if (url.pathname === '/mint/deployment-state/p2:1') return send({ asset: 'p2:1', state: 'registered', phase: 'deployment', entry: { id: '33'.repeat(32) + 'i0' } });
    if (url.pathname === '/web-api/tap-reader/getCurrentBlock') return state.tip ? send({ result: state.tip }) : send({ error: 'unavailable' }, 503);
    // The agent dashboard's own reads, as its local server answers them.
    if (local && url.pathname === '/api/requests/' + id) return send({ ...state.status, feeCredits: { href: '/api/credits?request=' + id } });
    if (local && url.pathname === '/api/credits') return send({ credits: state.credits, next: null, unit: { decimals: 18 }, requestId: url.searchParams.get('request') });
    if (local && url.pathname === '/api/credits/use' && req.method === 'POST') {
      let text = ''; for await (const c of req) text += c; state.uses.push(JSON.parse(text)); return send({ id: 'f'.repeat(64), state: 'queued' });
    }
    if (await web.handle(req, res, async () => '')) return;
    send({ error: 'not_found' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = 'http://127.0.0.1:' + server.address().port, browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (local) await page.addInitScript(() => { window.DMW_LOCAL_AGENT = true; });
  return { origin, page, errors, state };
}
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
// The agent dashboard's header (one more nav item) is wider than 1280 px on every page, so there only 390 px is checked.
async function shoot(page, name, { local = false } = {}) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    if (!local || width === 390) assert.equal(await noSideScroll(page), true, name + ' fits ' + width + ' px');
    if (shots) await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
const lead = page => page.locator('.next-step .body');
const side = page => page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Request', exact: true }) });

test('time-window words and the wallet refusal stay plain', () => {
  assert.equal(payWithin('900006', '900000'), 'Pay within about 1 hour (by block 900,006).');
  assert.equal(payWithin('900006', '900003'), 'Pay within about 30 minutes (by block 900,006).');
  assert.equal(payWithin('900006', null), 'Pay by block 900,006 (about 10 minutes per block).');
  assert.equal(payWithin('900006', '900005'), 'Too little time is left to pay: this request ends with block 900,006.');
  const refused = Object.assign(Error('Fewer than 2 Bitcoin blocks remain to pay. Create a fresh mint request before paying.'), { code: 'payment_window_short', display: true });
  assert.match(walletError(refused), /^Nothing was paid\. Fewer than 2 Bitcoin blocks \(about 20 minutes\) are left/);
  assert.equal(creditedAmount({ state: 'expired', reason: 'credited', creditedAmount: '10' }), '10');
  assert.equal(creditedAmount({ state: 'expired', reason: 'credited', creditedAmount: '0' }), null);
  assert.equal(creditedAmount({ state: 'expired' }), null);
});

test('a payment page shows the time left, a late payment as a fee credit, and an unpaid expiry in plain words', async t => {
  const { origin, page, errors, state } = await site(t);
  await page.goto(origin + '/mint/' + id);
  await page.getByText('Pay within about 1 hour (by block 900,006).', { exact: true }).waitFor();
  assert.match(await side(page).innerText(), /Pay by\s+block 900,006/);
  await shoot(page, 'single-awaiting');

  // Paid late: the request expired, then the payment confirmed and became a fee credit for the agent.
  state.status = record({ state: 'expired', payable: false, reason: 'credited', creditedAmount: '10000000000000000000', creditId: credit, credits: [{ id: credit, amount: '10000000000000000000' }], creditsCount: 1 });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const late = lead(page).locator('.callout.warn');
  await late.getByText('Your payment arrived after this request expired.', { exact: false }).waitFor();
  assert.match(await late.innerText(), /It became a fee credit of 10 TAP\. It belongs to the agent that made this request, .+\. That agent uses it for a new mint from its own dashboard, under My agent\./);
  assert.match(await late.locator('a').getAttribute('href'), /agents/);
  assert.equal(await page.locator('ol.stepper li.bad .l').innerText(), 'Permit');
  assert.match(await side(page).innerText(), /State\s+expired, paid late[\s\S]*Fee credit\s+10 TAP/);
  assert.equal(await page.getByText(/nothing was paid/i).count(), 0);
  assert.equal(await page.getByRole('button', { name: /^Pay/ }).count(), 0);
  assert.doesNotMatch(await page.locator('main').innerText(), /credited|[0-9a-f]{64}/);
  await shoot(page, 'single-credited-site');

  // Unpaid: nothing was paid; mint again.
  state.status = record({ state: 'expired', payable: false });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await lead(page).getByText('This request expired before it was paid, so nothing was paid. Mint the block again from My agent.', { exact: true }).waitFor();
  assert.equal(await page.locator('ol.stepper li.bad .l').innerText(), 'Pay');
  await shoot(page, 'single-expired-unpaid');
  assert.deepEqual(errors, []);
});

test('with fewer than 2 blocks left the payment page offers a fresh request instead of Pay', async t => {
  const { origin, page, errors, state } = await site(t, { local: true });
  state.tip = '900005';
  await page.goto(origin + '/mint/' + id);
  const warn = lead(page).locator('.callout.warn');
  await warn.getByText('Too little time is left to pay.', { exact: false }).waitFor();
  assert.match(await warn.innerText(), /Fewer than 2 Bitcoin blocks \(about 20 minutes\) remain.*nothing was paid\. Once it expires, press Mint on the block in My agent for a fresh request\./s);
  assert.equal(await page.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Mint again from My agent', exact: true }).getAttribute('href'), '/me?pattern=p2%3A1');
  await shoot(page, 'single-window-short', { local: true });
  assert.deepEqual(errors, []);
});

test('on the agent dashboard a credited request leads to a new mint, and a matching credit pays an open request once', async t => {
  const { origin, page, errors, state } = await site(t, { local: true });
  state.status = record({ state: 'expired', payable: false, reason: 'credited', creditedAmount: '10000000000000000000', creditId: credit, credits: [{ id: credit, amount: '10000000000000000000' }], creditsCount: 1 });
  await page.goto(origin + '/mint/' + id);
  await lead(page).getByText('Your agent can use it for the fees of a new mint, such as this block minted again.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Use it for a new mint', exact: true }).getAttribute('href'), '/me?pattern=p2%3A1');
  assert.equal(await page.getByRole('link', { name: 'Your fee credits', exact: true }).getAttribute('href'), '/me#fee-credits');
  await shoot(page, 'single-credited-dashboard', { local: true });

  // A fresh open request and a credit whose fees match it.
  const older = 'a7'.repeat(32);
  state.status = record({ state: 'awaiting_payment', payable: true });
  state.credits = [{ id: credit, amount: '10000000000000000000', creditedAmount: '10000000000000000000', origin: { requestId: older, orderId: null }, state: 'available', revision: '0',
    fees: [], requestId: id, matchingAmount: '10000000000000000000', items: [{ fee: 'aa'.repeat(32), amount: '10000000000000000000' }], usable: true }];
  await page.reload();
  const use = page.getByRole('button', { name: 'Use credit (10 TAP)', exact: true });
  await use.waitFor();
  assert.equal(await use.evaluate(el => el.classList.contains('primary')), true);
  assert.equal(await page.getByRole('button', { name: 'Pay missing items', exact: true }).evaluate(el => el.classList.contains('primary')), false);
  await shoot(page, 'single-use-credit', { local: true });
  await use.click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('heading', { name: 'Use your fee credit?', exact: true }).waitFor();
  assert.match(await modal.innerText(), /pays the remaining fees of this request[\s\S]*Fee credit\s+10 TAP[\s\S]*From\s+Mint request a7a7a7a7/);
  await modal.getByRole('button', { name: 'Use credit', exact: true }).click();
  await lead(page).getByText('Your fee credit was used for this request. It counts with the next Trac batch and this page updates by itself. Do not pay these fees again.', { exact: true }).waitFor();
  assert.deepEqual(state.uses, [{ actionId: 'use-' + credit.slice(0, 24) + '-' + id.slice(0, 24), credit, request: id }]);
  assert.equal(await page.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /^Use credit/ }).count(), 0);
  // Once the credit counts, the request is paid as usual.
  state.status = record({ state: 'paid', payable: false, missing: [] });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator('ol.stepper li[aria-current="step"] .l').getByText('Permit', { exact: true }).waitFor();
  assert.equal(state.uses.length, 1);
  assert.deepEqual(errors, []);
});
