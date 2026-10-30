import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PublicViews } from '../src/public-views.mjs';
import * as r from '../../rules/src/index.js';

const document = r.settingsRevision({ network: 'test', effectiveBatch: '1', effectiveBitcoinWindow: '0',
  values: { ...r.SETTINGS_PROFILE, legacyDeployShareBps: 1000, legacyDeployPayoutMinAtoms: '1000000000000000000' } });
test('public policy uses the same execution-height gate and operator settings', async () => {
  let counted = String(BigInt(r.LEGACY_DEPLOY_SHARE_HEIGHT) - 1n);
  const view = Object.assign(Object.create(PublicViews.prototype), { network: 'test', bitcoinNetwork: 'mainnet',
    store: { get: () => null, hasRows: () => false }, head: async () => ({ tip: { height: r.LEGACY_DEPLOY_SHARE_HEIGHT }, counted }),
    reads: { rulesContext: async () => ({ ready: true, settings: document, settingsHash: r.hashObject(document), last: { n: '1', to: counted } }),
      tip: async () => ({ tip: r.LEGACY_DEPLOY_SHARE_HEIGHT }) }, feePolicyV2: async () => ({}) });
  assert.equal((await view.statusV2()).legacyDeployShare.active, false);
  counted = r.LEGACY_DEPLOY_SHARE_HEIGHT;
  assert.deepEqual((await view.statusV2()).legacyDeployShare, { active: true, shareBps: 1000, payoutMinAtoms: '1000000000000000000', cutoff: '973675' });
});
test('About, fee split and payout tables display the share using their existing components', async t => {
  const id = 'a'.repeat(64), address = '1BitcoinEaterAddressDontSendf59kuE';
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    if (path === '/') { res.setHeader('content-type', 'text/html'); res.end('<main></main><div id="toasts"></div>'); return; }
    if (path === '/web-api/target' || path === '/mint/' + id || path === '/mint/deployment-state/p2:0') {
      res.setHeader('content-type', 'application/json');
      const missing = [{ role: 'treasury', amount: '400000000000000000', to: address, ticker: 'tap', tt: 'a', dta: 'fixture' }];
      res.end(JSON.stringify(path === '/web-api/target' ? { bitcoinNetwork: 'regtest' } : path.endsWith('/p2:0') ? { state: 'registered' } : {
        requestId: id, publicMint: true, state: 'awaiting_payment', asset: 'p2:0', receiver: address, amount: '1',
        kind: 'tap', payBy: { rail: 'tap' }, missing, fees: missing, payable: false, split: { legacyDeploy: '100000000000000000' } })); return;
    }
    if (path.startsWith('/api/')) {
      res.setHeader('content-type', 'application/json');
      const row = { id, role: 'legacyDeploy', legacyDeploy: true, to: address, beneficiary: address, amount: '100000000000000000',
        accrued: '100000000000000000', paid: '0', owed: '100000000000000000', payoutMinAtoms: '1000000000000000000', eligible: false };
      res.end(JSON.stringify(path === '/api/results' ? { counts: { owed: '1', payouts: '1' } } : { items: [row], total: 1, next: null })); return;
    }
    if (/^\/(?:playground\/console\/js|rules\/src|kit\/lib)\/[a-z0-9/.-]+\.(?:js|mjs)$/.test(path) && !path.includes('..')) {
      try { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(new URL('../..' + path, import.meta.url))); return; } catch {}
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin);
  await page.evaluate(async () => {
    const { mount } = await import('/playground/console/js/views/about.js');
    window.stopView = mount(document.querySelector('main'));
    window.shareNode = document.querySelector('[data-legacy-deploy-share]');
  });
  await page.getByText('The older deployment share is inactive.', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const { bus } = await import('/playground/console/js/api.js');
    bus.emit('status', { legacyDeployShare: { active: true, shareBps: 1000, payoutMinAtoms: '1000000000000000000', cutoff: '973675' } });
  });
  assert.match(await page.locator('[data-legacy-deploy-share]').innerText(), /10 %.*from the burn.*before block 973675.*at least 1 TAP/);
  assert.equal(await page.evaluate(() => window.shareNode === document.querySelector('[data-legacy-deploy-share]')), true);
  await page.evaluate(async () => {
    window.stopView(); const { splitTable } = await import('/playground/console/js/money.js');
    document.querySelector('main').replaceChildren(splitTable({ finder: '300', landowner: '150', discoverer: '50', burn: '100', treasury: '300', legacyDeploy: '100' }));
  });
  const shareRow = page.getByRole('row').filter({ hasText: 'Older deploy holders' });
  await shareRow.waitFor(); assert.match(await shareRow.innerText(), /10\.00 %.*payout ledger/s);
  await page.evaluate(async () => {
    const { site } = await import('/playground/console/js/api.js'); site.public = true;
    const { mount } = await import('/playground/console/js/views/results.js');
    document.querySelector('main').replaceChildren(); window.stopView = mount(document.querySelector('main'), { tab: 'owed' });
  });
  await page.getByRole('cell', { name: 'Older deploy holder', exact: true }).waitFor();
  await page.getByRole('tab', { name: /Payment recipients/ }).click();
  await page.getByText('0.1 TAP · payout from 1 TAP', { exact: true }).waitFor();
  await page.evaluate(() => window.stopView());
  await page.evaluate(async id => {
    const { mount } = await import('/playground/console/js/inscribe/public.js');
    window.stopView = mount(document.querySelector('main'), { id });
  }, id);
  const shareText = "0.1 TAP from this mint's burn is held in treasury for older deploy holders and paid through the payout ledger.";
  await page.getByText(shareText, { exact: false }).waitFor().catch(async error => assert.fail(error.message + '\n' + await page.locator('main').innerText()));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal((await page.locator('.lead-text').innerText()).split(shareText).length, 2);
  await page.evaluate(() => window.stopView());
  assert.deepEqual(errors, []);
});
