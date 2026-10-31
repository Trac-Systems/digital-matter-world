import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveDashboard } from '../lib/dashboard.mjs';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { cleanup } from './helpers.mjs';

const SENT = 'Payment sent — waiting for Bitcoin confirmation';
const shots = process.env.IF2_SHOTS;
const token = '0x' + '7a'.repeat(20), escrow = '0x' + '8b'.repeat(20);

// The gateway's link status carries the payment it checked on Bitcoin; the dashboard shows it on My agent and on its
// link and mint pages (the site's pages through the dashboard) without offering a second payment.
test('My agent and the dashboard link and mint pages show a fee payment in flight from another browser', async t => {
  const f = await dashboardFixture(t, { http: true, site: true }), dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const link = 'b7'.repeat(32), mint = 'c9'.repeat(32), revealTxid = 'c3'.repeat(32), payer = f.binding.request.address;
  const inflight = { phase: 'payment', commitTxid: 'c4'.repeat(32), revealTxid, inscriptionId: revealTxid + 'i0', seenAt: 1, confirmations: null };
  // A link request this agent signed, as the journal keeps it.
  f.journal.reserve('link/' + link, { height: 42 }, { request: { height: 42 } });
  f.journal.mark('link/' + link, 'submitted', { request: { id: link } });
  let status = { id: link, requestId: link, financialVersion: 2, state: 'awaiting_payment', block: '42', price: '12', payable: true, inflight };
  f.service.linkStatus = async id => { assert.equal(id, link); return status; };
  const fees = [{ role: 'treasury', to: payer, amount: '12', ticker: 'tap', tt: 'a', dta: 'dmw-pay-v2|' + link + '|treasury' }];
  const plan = () => ({ ...status, type: 'link', kind: 'tap', payer, receiver: payer, owner: f.agent.address, fees, missing: fees, payBy: { rail: 'tap', untilBlock: '532' },
    funding: { state: 'open', paid: ['0'] }, unit: { decimals: 18 }, deadline: '532', counted: '100', submit: '/link/payment', walletPreparation: false, refundAfter: null, networkFee: null,
    redeem: { items: [], data: '', actions: [] }, blocked: [] });
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url()), data = route.request().resourceType() !== 'document';
    // The fixture site has no checkout: the payment target (mainnet) and the link plan, as the gateway serves them.
    if (url.origin === dashboard.origin && url.pathname === '/web-api/target') return route.fulfill({ json: { network: 'dmw-mainnet', bitcoinNetwork: 'mainnet', ethereum: { chainId: '0x1', token, escrow } } });
    if (url.origin === dashboard.origin && url.pathname === '/web-api/link/' + link) return route.fulfill({ json: plan() });
    if (url.origin === dashboard.origin && url.pathname === '/mint/' + mint && data) return route.fulfill({ json: { requestId: mint, asset: 'p2:1', amount: '1', block: '12', receiver: payer, payer,
      state: 'awaiting_payment', kind: 'tap', price: '30', fees, missing: fees, payable: true, payBy: { rail: 'tap', untilBlock: 500 }, payment: [], blocked: [], inflight: { ...inflight, revealTxid: 'c5'.repeat(32), inscriptionId: 'c5'.repeat(32) + 'i0' } } });
    if (url.origin === dashboard.origin) return route.continue();
    // TAP Wallet funds reads are never needed: nobody pays here.
    return route.abort();
  });
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  const row = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Bitmap links' }) }).locator('tbody tr').filter({ hasText: '42.bitmap' });
  await row.getByText(SENT, { exact: true }).waitFor();
  await row.getByText('TAP fee payment', { exact: false }).waitFor();
  assert.equal(await row.locator('a[href^="https://mempool.space/tx/"]').getAttribute('href'), 'https://mempool.space/tx/' + revealTxid);
  assert.equal(await row.getByRole('link', { name: 'Pay' }).count(), 0);
  assert.equal(await row.getByRole('link', { name: 'Open' }).getAttribute('href'), '/link/' + link);
  if (shots) for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/dashboard-me-link-inflight-${suffix}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await row.getByRole('link', { name: 'Open' }).click();
  const note = page.locator('.callout.info').filter({ hasText: SENT });
  await note.waitFor();
  assert.equal(await note.locator('a').first().getAttribute('href'), 'https://mempool.space/tx/' + revealTxid);
  assert.equal(await page.getByRole('button', { name: 'Approve payment in wallet' }).count(), 0);
  assert.equal(await page.locator(`a[href="https://etherscan.io/address/${token}"]`).count(), 1);
  if (shots) for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/dashboard-link-payment-inflight-${suffix}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(dashboard.origin + '/mint/' + mint);
  const paying = page.locator('.callout.info').filter({ hasText: SENT });
  await paying.waitFor();
  assert.equal(await paying.locator('a').first().getAttribute('href'), 'https://mempool.space/tx/' + 'c5'.repeat(32));
  assert.equal(await page.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);

  // Once counted, the gateway drops the record: the row offers the usual action again.
  status = { ...status, inflight: undefined };
  await page.goto(dashboard.origin + '/me');
  await row.getByRole('link', { name: 'Pay' }).waitFor();
  assert.equal(await row.getByText(SENT, { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});
