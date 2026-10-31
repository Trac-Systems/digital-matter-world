import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { ed25519 } from '../../contract/node_modules/@noble/curves/ed25519.js';
import { serveDashboard } from '../lib/dashboard.mjs';
import { compoundTickerMessage } from '../../rules/src/ticker-grammar.js';
import { decodeTracAddress } from '../../rules/src/trac-address.js';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { cleanup } from './helpers.mjs';

const shots = process.env.CT1_SHOTS, COMPOUND = 'c2:' + 'ab'.repeat(32);

// My agent → Your compounds: the first maker chooses the compound's official ticker; the agent signs it.
test('Your compounds: the first maker sets and changes the ticker, then the deploy link appears', async t => {
  const f = await dashboardFixture(t, { http: true, site: true }), dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  f.balances.set(COMPOUND, { amount: '4', current: true });
  const service = f.agent.service, sent = [];
  let job = { asset: COMPOUND, catalogAsset: COMPOUND, kind: 'compound', state: 'awaiting_ticker', reason: 'ticker_choice_required', attempts: [], tickerAttempt: 0 };
  service.compounds = async ({ asset }) => ({ compounds: asset === COMPOUND ? [{ id: COMPOUND, recipe: 'fusion', firstMaker: f.agent.address, tier: { value: 5 },
    inputs: [{ asset: 'p2:1', amount: '1' }], properties: { charge: 3, spectrum: 3, generation: '1' } }] : [] });
  const rights = service.mintRights.bind(service);
  service.mintRights = async (owner, options = {}) => options.asset === COMPOUND ? { mintRights: [{ asset: COMPOUND, compound: true, deploymentRegistered: false }] } : rights(owner, options);
  const state = service.deploymentState.bind(service);
  service.deploymentState = async asset => asset === COMPOUND ? job : state(asset);
  service.chooseCompoundTicker = async value => {
    sent.push(value);
    if (value.ticker === 'taken') throw Object.assign(Error('ticker_occupied'), { code: 'ticker_occupied' });
    job = { ...job, state: 'awaiting_player_deploy', reason: null, chosenTicker: { tick: value.ticker, revision: value.revision } };
    return job;
  };
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === dashboard.origin ? route.continue() : route.abort());
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  const row = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Your compounds' }) }).locator('tbody tr').first();
  await row.getByText('You made it first, so you choose its ticker', { exact: false }).waitFor({ timeout: 20000 });
  assert.equal(await row.getByRole('link', { name: 'Deploy its TAP token' }).count(), 0);
  const name = row.getByRole('textbox', { name: 'Ticker name' });
  await name.fill('ñandu');
  await row.getByText('A compound’s official ticker uses 3 to 32 lowercase letters a–z and digits 0–9.', { exact: true }).waitFor();
  await name.fill('amber');
  await row.getByText('“amber” looks free. Set ticker checks it on TAP and against pending requests.', { exact: true }).waitFor();
  if (shots) for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 }); await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/dashboard-compound-ticker-choose-${suffix}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await row.getByRole('button', { name: 'Set ticker', exact: true }).click();
  await row.getByRole('link', { name: 'Deploy its TAP token' }).waitFor();
  assert.equal(sent.length, 1);
  const message = compoundTickerMessage({ network: f.agent.network, asset: COMPOUND, ticker: 'amber', revision: 1, expiry: sent[0].expiry, firstMaker: f.agent.address });
  assert.equal(ed25519.verify(sent[0].agentSignature, Buffer.from(message), decodeTracAddress(f.agent.address)), true);
  assert.equal(await row.getByRole('link', { name: 'Deploy its TAP token' }).getAttribute('href'), `/mint/${COMPOUND}?owner=${encodeURIComponent(f.agent.address)}`);
  await row.getByText('amber', { exact: true }).waitFor();
  // A change: the quiet button opens the same form; a refused name is said under the field.
  await row.getByRole('button', { name: 'Change ticker', exact: true }).click();
  await row.getByRole('textbox', { name: 'Ticker name' }).fill('taken');
  await row.getByText('“taken” looks free. Change ticker checks it on TAP and against pending requests.', { exact: true }).waitFor();
  await row.locator('button.btn', { hasText: 'Change ticker' }).last().click();
  await row.getByText('This ticker is already taken on TAP. Choose another name.', { exact: true }).waitFor();
  await row.getByRole('textbox', { name: 'Ticker name' }).fill('amber2');
  await row.getByText('“amber2” looks free. Change ticker checks it on TAP and against pending requests.', { exact: true }).waitFor();
  await row.locator('button.btn', { hasText: 'Change ticker' }).last().click();
  await row.getByText('amber2', { exact: true }).waitFor();
  assert.deepEqual(sent.map(s => [s.ticker, s.revision]), [['amber', 1], ['taken', 2], ['amber2', 2]]);
  if (shots) for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 }); await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/dashboard-compound-ticker-chosen-${suffix}.png` });
  }
  assert.deepEqual(errors, []);
});
