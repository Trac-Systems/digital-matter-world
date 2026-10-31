import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveDashboard } from '../lib/dashboard.mjs';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { cleanup } from './helpers.mjs';

const SENT = 'Inscription sent — waiting for Bitcoin confirmation';
const shots = process.env.DMW_SHOTS;

// The gateway's deployment state carries the in-flight record it checked on Bitcoin; the dashboard shows it
// on My agent and on its deployment page (the site's page through the dashboard) without offering a second inscription.
test('My agent and the dashboard deployment page show a pattern inscription in flight from another browser', async t => {
  const f = await dashboardFixture(t, { http: true, site: true }), dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const owner = f.agent.owner, revealTxid = 'c0'.repeat(32), request = 'e1'.repeat(32);
  f.patterns.push({ number: '2', asset: 'p2:2', name: 'dmwfresh', tier: 5 });
  f.discoveries.push({ number: '2', asset: 'p2:2', name: 'dmwfresh', tier: 5, discoverer: owner, state: 'accepted' });
  const inflight = { phase: 'element', commitTxid: 'c1'.repeat(32), revealTxid, inscriptionId: revealTxid + 'i0', seenAt: 1, confirmations: null };
  f.deployments.set('p2:2', { asset: 'p2:2', catalogAsset: 'p2:2', kind: 'dmt', displayLabel: 'dmwfresh', state: 'awaiting_player_deploy', phase: 'element',
    elementAttempt: 0, tickerAttempt: 0, attempts: [{ phase: 'element', attempt: 0, id: 'a0'.repeat(32), text: 'dmwfresh.123.4.dmt' }], inflight });
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    // The fixture site has no checkout; the deployment page only needs the network.
    if (url.origin === dashboard.origin && url.pathname === '/web-api/target') return route.fulfill({ json: { network: 'dmw-regtest', bitcoinNetwork: 'regtest' } });
    // A mint request after its permit, as the gateway shows it with a checked broadcast from another browser.
    if (url.origin === dashboard.origin && url.pathname === '/mint/' + request && route.request().resourceType() !== 'document') return route.fulfill({ json: { requestId: request, asset: 'p2:1', amount: '1', block: '12', receiver: f.binding.request.address,
      state: 'permit_issued', fees: [], missing: [], payable: false, payBy: { rail: 'tap' }, inflight: { ...inflight, phase: 'mint', revealTxid: 'c2'.repeat(32), inscriptionId: 'c2'.repeat(32) + 'i0' } } });
    return url.origin === dashboard.origin ? route.continue() : route.abort();
  });
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  const row = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Your patterns' }) }).locator('tbody tr').filter({ hasText: 'dmwfresh' });
  await row.getByText(SENT, { exact: true }).waitFor();
  await row.getByText('Pattern inscription', { exact: false }).waitFor();
  assert.equal(await row.locator('a[href^="https://mempool.space/tx/"]').getAttribute('href'), 'https://mempool.space/tx/' + revealTxid);
  assert.equal(await row.getByRole('link', { name: 'Deploy pattern' }).count(), 0);
  assert.equal(await row.getByRole('link', { name: 'Open deployment' }).getAttribute('href'), '/mint/p2:2?owner=' + encodeURIComponent(f.agent.address));

  await row.getByRole('link', { name: 'Open deployment' }).click();
  const note = page.locator('.callout.info').filter({ hasText: SENT });
  await note.waitFor();
  assert.equal(await note.locator('a').first().getAttribute('href'), 'https://mempool.space/tx/' + revealTxid);
  assert.equal(await page.getByRole('button', { name: 'Inscribe pattern', exact: true }).count(), 0);
  if (shots) for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/dashboard-mint-asset-inflight-${suffix}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(dashboard.origin + '/mint/' + request);
  const minting = page.locator('.callout.info').filter({ hasText: SENT });
  await minting.waitFor();
  assert.equal(await minting.locator('a').first().getAttribute('href'), 'https://mempool.space/tx/' + 'c2'.repeat(32));
  assert.equal(await page.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0);
  if (shots) for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/dashboard-mint-request-inflight-${suffix}.png`, fullPage: true });
  }
  await page.goto(dashboard.origin + '/mint/p2:2?owner=' + encodeURIComponent(f.agent.address));
  await note.waitFor();
  // Once the gateway's state moves on, the record is gone and the next phase is offered again.
  f.deployments.set('p2:2', { ...f.deployments.get('p2:2'), inflight: undefined });
  await page.reload();
  await page.getByRole('button', { name: 'Inscribe pattern', exact: true }).waitFor();
  assert.equal(await page.getByText(SENT, { exact: true }).count(), 0);
  assert.equal(f.calls.some(c => c.path.startsWith('/mint/deployment/')), false);
  assert.deepEqual(errors, []);
});
