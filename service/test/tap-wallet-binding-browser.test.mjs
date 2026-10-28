import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { Store } from '../src/store.mjs';
import { bindingFixture } from './bindings-fixture.mjs';
import { agent, temp } from './helpers.mjs';
import { signTapWalletMessage } from '../../rules/test/tap-wallet-signing.mjs';

// Run with the shared browser lock held, like the other service browser tests.
test('TAP Wallet page signs legacy output, reports refusals plainly and shows the accepted receipt', { timeout: 60000 }, async t => {
  const store = await Store.open(await temp('tap-wallet-page-')); t.after(() => store.close());
  const f = bindingFixture(store, { bitcoinNetwork: 'mainnet' }), who = agent(84);
  const { walletSignature, ...body } = f.packet(who, 'tap', who.secret.toString('hex'));
  const pending = await f.bindings.request(body);
  const target = { network: f.bindings.network, bitcoinNetwork: 'mainnet', ethereum: { chainId: '0x1' } };
  const server = await serve({ intake: { store }, files: { serve: async () => false }, bindings: f.bindings,
    web: createWeb({ target }), publicAPI: { handles: () => true, read: () => ({}) } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('tapSign', message => signTapWalletMessage(message, who.secret));
  await page.addInitScript(address => {
    window.activeAddress = address;
    window.badSignature = true;
    window.tapprotocol = { getNetwork: async () => 'mainnet', requestAccounts: async () => [window.activeAddress],
      // TAP Wallet ignores the second argument; reproduce that provider contract.
      signMessage: async message => window.badSignature ? 'bad' : window.tapSign(message) };
  }, pending.request.address);
  await page.goto(server.url + '/bind-payout/' + pending.id);
  const button = page.getByRole('button', { name: 'Sign with wallet and bind' });
  await button.click();
  await page.getByText("Your wallet's signature was not accepted. Make sure the wallet shown above is the active account and try again.", { exact: true }).waitFor();
  assert.equal(f.bindings.current(who.address, 'tap'), null);
  await page.evaluate(() => { window.activeAddress = 'bc1pwrong'; });
  await button.click();
  await page.getByText('Select the TAP payer wallet shown in this request.', { exact: true }).waitFor();
  await page.evaluate(address => { window.activeAddress = address; window.badSignature = false; }, pending.request.address);
  await button.click();
  await page.getByRole('heading', { name: 'Accepted binding receipt' }).waitFor();
  assert.equal(await button.isDisabled(), true);
  assert.equal(f.bindings.current(who.address, 'tap').walletSignature, signTapWalletMessage(pending.message, who.secret));
  await page.reload();
  await page.getByText('Payout wallet bound.', { exact: true }).waitFor();
  assert.equal(await button.isDisabled(), true);
  assert.deepEqual(errors, []);
});
