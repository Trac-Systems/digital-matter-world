import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { serveDashboard } from '../lib/dashboard.mjs';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { tapWallet1048 } from './tap-wallet-1048-fixture.mjs';
import { cleanup } from './helpers.mjs';
import { hex, unhex } from '../lib/inscription-core.mjs';

async function open(t, { provider = true } = {}) {
  const f = await dashboardFixture(t, { http: true }), dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Test traffic is strictly loopback except the intercepted public fee estimate.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === dashboard.origin) return route.continue();
    if (url.href === 'https://mempool.space/api/v1/fees/recommended') return route.fulfill({ json: { halfHourFee: 2 } });
    return route.abort();
  });
  const key = new Uint8Array(32).fill(2), publicKey = hex(secp256k1.getPublicKey(key, true));
  const wallet = tapWallet1048({ address: f.binding.request.address, publicKey, network: 'regtest' });
  let signs = 0, pushes = 0;
  wallet.provider.getBitcoinUtxos = async () => [{ txid: 'ab'.repeat(32), vout: 0, satoshi: 1000000,
    scriptPk: hex(btc.p2tr(secp256k1.getPublicKey(key).slice(1)).script), height: 1, inscriptions: [], isSpent: false }];
  wallet.provider.signPsbt = async raw => { signs++; const tx = btc.Transaction.fromPSBT(unhex(raw)); tx.sign(key); tx.finalize(); return hex(tx.toPSBT(0)); };
  wallet.provider.pushPsbt = async raw => { pushes++; return btc.Transaction.fromPSBT(unhex(raw)).id; };
  wallet.provider.pushTx = async raw => { pushes++; return btc.Transaction.fromRaw(unhex(raw), { allowUnknownInputs: true }).id; };
  if (provider) {
    await page.exposeFunction('walletFixture', (name, args) => wallet.provider[name](...args));
    await page.addInitScript(methods => { window.tapprotocol = Object.fromEntries(methods.map(name => [name, (...args) => window.walletFixture(name, args)])); }, Object.keys(wallet.provider));
  }
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/');
  await page.getByRole('button', { name: 'Mint', exact: true }).first().waitFor();
  return { f, dashboard, browser, page, errors, wallet, signed: () => signs, pushed: () => pushes };
}

test('browser click → signed request → TAP payment → permit inscription; reload does not pay twice', async t => {
  const { f, dashboard, page, errors, wallet, signed, pushed } = await open(t);
  assert.equal(await page.getByRole('button', { name: 'Mint', exact: true }).count(), 2);
  assert.equal(await page.evaluate(() => document.cookie), '', 'signer session is HttpOnly');
  await page.getByRole('button', { name: 'Mint', exact: true }).first().click();
  await page.getByRole('button', { name: 'Pay missing items', exact: true }).waitFor();
  assert.equal(f.packets.length, 2);
  const id = [...f.records.keys()][0];
  assert.equal(f.records.get(id).receiver, f.binding.request.address);
  assert.equal(wallet.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 0, 'mint click does not pay');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Pay missing items', exact: true }).click();
  await page.getByText('Payment submitted. Waiting for confirmation.', { exact: true }).waitFor();
  assert.equal(wallet.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 1);
  await page.reload();
  await page.getByRole('button', { name: 'Open request', exact: true }).first().click();
  await page.getByRole('button', { name: 'Pay missing items', exact: true }).click();
  await page.getByText(/A payment was already requested/).waitFor();
  assert.equal(wallet.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 1);
  Object.assign(f.records.get(id), { state: 'permit_issued', missing: [], payable: false,
    mintContent: { p: 'tap', op: 'token-mint', tick: 'dmwfixture', amt: '3', dta: id, prv: { address: f.binding.request.address, hash: '56'.repeat(32) } } });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Inscribe mint', exact: true }).click();
  // The helper saves the signed commit and reveal before the fake broadcasts.
  await assertEventually(() => pushed() === 2 && f.calls.some(c => c.path === '/mint/payment' && c.method === 'POST'));
  assert.equal(signed(), 1); assert.ok(f.calls.some(c => c.path === '/mint/payment' && c.method === 'POST'));
  const saved = dashboard.state.walletGet(`regtest/${f.binding.request.address}/${id}`);
  assert.equal(saved.mint.broadcast, true); assert.ok(saved.mint.signedCommitPsbt);
  f.minted.add('12'); f.records.get(id).state = 'minted';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await assertEventually(async () => await page.getByRole('button', { name: 'Mint', exact: true }).count() === 1);
  assert.deepEqual(errors, []);
});

test('browser without injected TAP Wallet offers the configured request payment page', async t => {
  const { page, f, errors } = await open(t, { provider: false });
  await page.getByRole('button', { name: 'Mint', exact: true }).first().click();
  const fallback = page.getByRole('link', { name: 'Open payment page' }); await fallback.waitFor();
  assert.equal(await fallback.getAttribute('href'), f.service.paymentLink([...f.records.keys()][0]));
  assert.equal(await page.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('browser shows the units role and balance, mints a non-finder block, and explains a short balance', async t => {
  const { page, f, errors } = await open(t);
  f.clock.counted = '1027'; f.claims[0].finder = 'ff'.repeat(32);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const publicRow = page.locator('tbody tr').filter({ has: page.getByRole('cell', { name: '12', exact: true }) });
  await publicRow.getByText('units · unminted', { exact: true }).waitFor();
  assert.equal(await publicRow.getByRole('cell', { name: '3 / 100', exact: true }).count(), 1);
  await publicRow.getByRole('button', { name: 'Mint', exact: true }).click();
  await page.getByRole('button', { name: 'Pay missing items', exact: true }).waitFor();
  assert.equal(f.packets.length, 2); assert.equal(f.packets[1].reserve.owner, f.agent.owner);
  f.balances.set('p2:1', { amount: '2', current: true });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const shortRow = page.locator('tbody tr').filter({ has: page.getByRole('cell', { name: '11', exact: true }) });
  await shortRow.getByText('units · unminted · Not mintable: insufficient units (need 3, balance 2)', { exact: true }).waitFor();
  assert.equal(await shortRow.getByRole('button', { name: 'Mint', exact: true }).count(), 0);
  assert.equal(await shortRow.getByRole('cell', { name: '3 / 2', exact: true }).count(), 1);
  f.minted.add('12'); f.records.values().next().value.state = 'minted';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await publicRow.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('checkbox').count(), 0);
  f.balances.set('p2:1', { amount: '100', current: true }); f.unregistered.add('p2:1');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const deploy = shortRow.getByRole('link', { name: 'Deploy pattern' }); await deploy.waitFor();
  assert.equal(await deploy.getAttribute('href'), f.service.deploymentLink('p2:1', f.agent.address));
  assert.equal(f.calls.some(call => call.path.startsWith('/mint/deployment/')), false);
  assert.deepEqual(errors, []);
});

async function assertEventually(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Expected browser action did not finish');
}
