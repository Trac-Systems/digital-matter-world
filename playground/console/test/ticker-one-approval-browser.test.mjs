import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../../../service/src/http.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { provisioningFixture } from '../../../service/test/provisioning-fixture.mjs';

const shots = process.env.DMW_SHOTS;
async function shoot(page, name) {
  if (!shots) return;
  for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/${name}-${suffix}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
const AUTO = 'Payment sent — the deploy inscription is sent to your wallet automatically once it confirms.';
const asset = 'p2:1', id = 'ab'.repeat(32), receiver = 'bcrt1p' + 'q'.repeat(58), reveal = 'cd'.repeat(32);
const fee = { state: 'awaiting_payment', payable: true, price: '20000', unit: '1', fees: [], missing: [{ role: 'ticker_deploy', amount: '20000', to: 'bcrt1qtreasury', ticker: 'tap', tt: 'a', dta: 'x' }],
  refundFunding: { address: 'bcrt1p' + 'f'.repeat(58), satoshis: 4028, deploySats: 2184, refundReserveSats: 1844, label: 'your ticker deploy inscription' } };
const base = { id, asset, catalogAsset: asset, kind: 'dmt', ticker: 'one go', indexTick: 'dmt-one go', receiver, officialDeployment: 'ef'.repeat(32) + 'i0' };

// The page's own routes, answered from a scripted request state; the site files come from the real gateway.
for (const local of [false, true]) test(`one-approval ticker page on the ${local ? 'dashboard' : 'site'}`, async t => {
  const f = await provisioningFixture(t);
  await f.store.put('patternsByAsset', asset, { ...f.pattern, number: '1', name: 'dmwnullspar' });
  const server = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator },
    web: createWeb({ target: { network: 'dmw-regtest', bitcoinNetwork: 'regtest' }, plan: async () => ({}) }),
    publicAPI: { handles: path => /^\/(status|patterns|feed)(?:\?|$)/.test(path), read: async path => path.startsWith('/status') ? { tip: 100, counted: 100 } : { patterns: [], events: [], total: 0, next: null } } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(), errors = [], posts = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
  if (local) await page.addInitScript(() => { globalThis.DMW_LOCAL_AGENT = true; });
  let job = { ...base, state: 'awaiting_fee', oneApproval: true, fee };
  await page.route('**/mint/ticker-state/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(job) }));
  await page.route('**/mint/deploy-ticker', route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"deployment_confirmations"}' }));
  await page.goto(`${server.url}/mint/${asset}?ticker=${id}`);
  // One step to pay and deploy; the deploy's Bitcoin in the overview, the refund part in the details.
  await page.getByRole('button', { name: 'Pay & deploy', exact: true }).waitFor();
  await page.getByText('Bitcoin for the deploy inscription', { exact: true }).waitFor();
  await page.getByText('2,184 sats', { exact: true }).waitFor();
  await page.getByText('1,844 sats', { exact: true }).waitFor();
  await page.getByText('Returned to you after the deploy is registered, minus the Bitcoin network fee.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Pay fee', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Deploy ticker', { exact: true }).count(), 0);
  await shoot(page, `pay-and-deploy${local ? '-dashboard' : ''}`);
  // Paid and counted: the server sends the deploy; the page shows it in flight and asks for no approval.
  job = { ...base, state: 'awaiting_player_deploy', oneApproval: true, phase: 'deployment', fee: { ...fee, state: 'paid', payable: false },
    deploySender: { state: 'sent', revealTxid: reveal, inscriptionId: reveal + 'i0' }, inflight: { phase: 'deployment', revealTxid: reveal, inscriptionId: reveal + 'i0', seenAt: 1 } };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText(AUTO + ' This page updates by itself once it is in a block.', { exact: true }).waitFor();
  assert.ok(await page.locator(`a[href*="${reveal}"]`).count() > 0, 'in-flight transaction link');
  assert.equal(await page.getByRole('button', { name: 'Deploy ticker', exact: true }).count(), 0);
  await shoot(page, `deploy-sent${local ? '-dashboard' : ''}`);
  // Handed back (an older wallet's payment, or a fee rise): the two-step fallback with its Deploy button.
  job = { ...job, oneApproval: false, deploySender: { state: 'needs_user' } }; delete job.inflight;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Deploy ticker', exact: true }).waitFor();
  await page.getByText('Pay fee', { exact: true }).waitFor();
  await shoot(page, `fallback${local ? '-dashboard' : ''}`);
  assert.deepEqual(errors, []);
});
