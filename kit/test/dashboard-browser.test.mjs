import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { serveDashboard } from '../lib/dashboard.mjs';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { tapWallet1049 } from './tap-wallet-1049-fixture.mjs';
import { cleanup } from './helpers.mjs';
import { hex, unhex } from '../lib/inscription-core.mjs';
import { walletFundsReply } from './wallet-funds-fixture.mjs';

async function open(t, { provider = true } = {}) {
  const f = await dashboardFixture(t, { http: true }), dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Test traffic is strictly loopback except the intercepted public fee estimate.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/web-api/tap-reader/')) return route.fulfill({ json: walletFundsReply(url.href) });
    if (url.origin === dashboard.origin) return route.continue();
    if (url.href === 'https://mempool.space/api/v1/fees/recommended') return route.fulfill({ json: { halfHourFee: 2 } });
    return route.abort();
  });
  const key = new Uint8Array(32).fill(2), publicKey = hex(secp256k1.getPublicKey(key, true));
  const wallet = tapWallet1049({ address: f.binding.request.address, publicKey, network: 'regtest' });
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
  await page.waitForURL(dashboard.origin + '/me');
  // The standalone mint page remains at /minter; /me is served by the site shell.
  await page.goto(dashboard.origin + '/minter');
  await page.getByRole('button', { name: 'Mint', exact: true }).first().waitFor();
  return { f, dashboard, browser, page, errors, wallet, signed: () => signs, pushed: () => pushes };
}

test('browser click → signed request → TAP payment → permit inscription; reload does not pay twice', async t => {
  const { f, dashboard, page, errors, wallet, signed, pushed } = await open(t);
  assert.equal(await page.getByRole('button', { name: 'Mint', exact: true }).count(), 2);
  await assertReferences(page, [f.patterns[0].name], '#app');
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
  await page.getByText('State: Being minted', { exact: true }).waitFor();
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

test('dashboard formats large block units and balances without rounding or changing the quoted value', async t => {
  const { page, f, errors } = await open(t, { provider: false });
  f.claims[0].count = '3789512813';
  f.balances.set('p2:1', { amount: '9007199254740993', current: true });
  await page.reload();
  await page.getByText('3,789,512,813 / 9,007,199,254,740,993', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Mint', exact: true }).first().click();
  await page.getByRole('link', { name: 'Open payment page' }).waitFor();
  assert.equal([...f.records.values()][0].amount, '3789512813');
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

test('one approval: Pay and mint sends the set-aside with the payment; the server-sent mint replaces Inscribe mint unless it needs the wallet', async t => {
  const { f, page, errors, wallet } = await open(t);
  const setAside = btc.p2tr(secp256k1.getPublicKey(new Uint8Array(32).fill(7)).slice(1), undefined, { ...btc.TEST_NETWORK, bech32: 'bcrt' }).address;
  await page.getByRole('button', { name: 'Mint', exact: true }).first().click();
  await page.getByRole('button', { name: 'Pay missing items', exact: true }).waitFor();
  const id = [...f.records.keys()][0];
  Object.assign(f.records.get(id), { mintFunding: { address: setAside, satoshis: 4200, feeRate: 2, label: 'your mint inscription' } });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const pay = page.getByRole('button', { name: 'Pay and mint', exact: true }); await pay.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);
  await page.getByText('Bitcoin set aside for the mint inscription: 4200 sats', { exact: true }).waitFor();
  const dialogs = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
  await pay.click();
  await page.getByText('Paid. Your mint goes out automatically when the permit arrives. You can close this page.', { exact: true }).first().waitFor();
  assert.match(dialogs[0], /TAP Wallet asks once/); assert.match(dialogs[0], /Bitcoin set aside for the mint inscription: 4200 sats/);
  const sent = wallet.state.calls.filter(c => c[0] === 'singleTxTransfer');
  assert.equal(sent.length, 1); assert.deepEqual(sent[0][2], { extraOutputs: [{ address: setAside, satoshis: 4200, label: 'your mint inscription' }] });
  const reveal = 'c2'.repeat(32);
  Object.assign(f.records.get(id), { state: 'permit_issued', missing: [], payable: false, mintFunding: undefined, mintSender: { state: 'sent', commitTxid: 'c1'.repeat(32), revealTxid: reveal },
    mintContent: { p: 'tap', op: 'token-mint', tick: 'dmwfixture', amt: '3', dta: id, prv: { address: f.binding.request.address, hash: '56'.repeat(32) } } });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText(/^Mint: Mint sent\. Waiting for Bitcoin to confirm the mint\./).waitFor();
  assert.equal(await page.locator(`a[href="https://mempool.space/tx/${reveal}"]`).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0);
  f.records.get(id).mintSender = { state: 'needs_user' };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('The set-aside was not enough after a fee rise; inscribe with your wallet. The set-aside is returned to you.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Inscribe mint', exact: true }).waitFor();
  assert.equal(wallet.state.calls.filter(c => c[0] === 'singleTxTransfer').length, 1);
  assert.deepEqual(errors, []);
});

test('a TAP Wallet older than 1.0.49 is refused on the dashboard before the confirmation and any other wallet call', async t => {
  const { page, errors, wallet } = await open(t);
  wallet.provider.getCapabilities = async () => ({ version: '1.0.48' });
  await page.getByRole('button', { name: 'Mint', exact: true }).first().click();
  const dialogs = []; page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
  await page.getByRole('button', { name: 'Pay missing items', exact: true }).click();
  await page.getByText('This needs TAP Wallet 1.0.49 or newer. Update TAP Wallet, then reload this page.', { exact: true }).waitFor();
  assert.deepEqual(dialogs, []); assert.deepEqual(wallet.state.calls, []);
  assert.deepEqual(errors, []);
});

async function assertEventually(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Expected browser action did not finish');
}
// Complete references: the rendered page shows no raw pattern/compound key and no trac1… address outside a link,
// and every named pattern or compound in its text is a link. Form controls (options, tabs, buttons, labels) are exempt.
async function assertReferences(page, names, root = 'main') {
  const bad = await page.evaluate(([names, root]) => {
    const out = [], walker = document.createTreeWalker(document.querySelector(root), NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const text = node.textContent, el = node.parentElement;
      if (!text.trim() || el.closest('select, textarea, button, label, [role=tab], .toast, script, style')) continue;
      const linked = !!el.closest('a');
      if (/\b(?:p2:[0-9]|c2:[0-9a-f])/.test(text)) out.push('raw key: ' + text);
      if (/trac1[0-9a-z]{4}/.test(text) && !linked) out.push('address not linked: ' + text);
      for (const name of names) if (text.includes(name) && !linked) out.push(`${name} not linked: ${text}`);
    }
    return out;
  }, [names, root]);
  assert.deepEqual(bad, []);
}

test('dashboard explains a public mint claim refusal without preparing a payment', async t => {
  const { page, f, wallet, errors } = await open(t);
  await page.route('**/api/mint', route => route.fulfill({ status: 400, json: { error: 'public_minted' } }));
  await page.getByRole('button', { name: 'Mint', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: 'This block was already taken by a public TAP Wallet mint.' }).waitFor();
  assert.equal(f.packets.length, 0);
  assert.equal(wallet.state.calls.filter(call => call[0] === 'singleTxTransfer').length, 0);
  assert.deepEqual(errors, []);
});

test('My agent lists the agent’s patterns with Deploy for a new one, and the pattern tabs filter the claimed blocks', async t => {
  const f = await dashboardFixture(t, { http: true, site: true }), dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const owner = f.agent.owner, settingsHash = f.claims[0].settingsHash;
  f.patterns.push({ number: '2', asset: 'p2:2', name: 'dmwfresh', tier: 5 }, { number: '3', asset: 'p2:3', name: 'dmwother', tier: 2 });
  f.discoveries.push({ number: '2', asset: 'p2:2', name: 'dmwfresh', tier: 5, discoverer: owner, state: 'accepted' });
  f.unregistered.add('p2:2');
  f.claims.push({ asset: 'p2:3', block: '9', count: '3', finder: owner, findHeight: '19', finderUntil: '1027', settingsHash });
  f.balances.set('p2:3', { amount: '100', current: true });
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage({ viewport: { width: Number(process.env.DMW_DASHBOARD_WIDTH ?? 1280), height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === dashboard.origin ? route.continue() : route.abort());
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  const patterns = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Your patterns' }) });
  const row = name => patterns.locator('tbody tr').filter({ hasText: name });
  await row('dmwfresh').getByRole('link', { name: 'Deploy pattern' }).waitFor();
  assert.equal(await row('dmwfresh').getByRole('link', { name: 'Deploy pattern' }).getAttribute('href'), '/mint/p2:2?owner=' + encodeURIComponent(f.agent.address));
  assert.equal(await row('dmwfresh').getByRole('button', { name: 'Show claims' }).count(), 0);
  for (const name of ['Test', 'dmwother']) {
    await row(name).getByText('deployed', { exact: true }).waitFor();
    assert.equal(await row(name).getByRole('link').filter({ hasText: /Deploy|deployment/ }).count(), 0);
  }
  const claims = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Claimed blocks you may mint' }) });
  await claims.getByRole('tab', { name: 'All · 3' }).waitFor();
  assert.equal(await claims.getByRole('button', { name: 'Mint', exact: true }).count(), 3);
  await row('dmwother').getByRole('button', { name: 'Show claims' }).click();
  await claims.getByRole('tab', { name: 'dmwother · 1', selected: true }).waitFor();
  await assertEventually(async () => await claims.locator('tbody tr').count() === 1);
  assert.equal(await claims.locator('tbody tr').filter({ hasText: 'dmwother' }).getByRole('button', { name: 'Mint', exact: true }).count(), 1);
  await claims.getByRole('tab', { name: 'Test · 2' }).click();
  await assertEventually(async () => (await claims.locator('tbody tr').allTextContents()).join().includes('Test') && await claims.locator('tbody tr').count() === 2);
  await claims.getByRole('tab', { name: 'All · 3' }).click();
  await assertEventually(async () => await claims.locator('tbody tr').count() === 3);
  if (process.env.DMW_DASHBOARD_SCREENSHOT) { await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: process.env.DMW_DASHBOARD_SCREENSHOT, fullPage: true }); }
  await assertReferences(page, ['Test', 'dmwfresh', 'dmwother']);
  assert.equal(await row('dmwfresh').getByRole('link', { name: 'dmwfresh' }).getAttribute('href'), '/pattern/p2:2');
  assert.equal(await page.getByRole('link', { name: '9', exact: true }).first().getAttribute('href'), '/block/9');
  assert.equal(f.calls.some(c => c.path.startsWith('/mint/deployment/')), false);
  assert.deepEqual(errors, []);
});

test('My agent sends units on Trac: labelled rows and a pasted list, one review, progress to confirmed, and the own Trac address', async t => {
  const f = await dashboardFixture(t, { http: true, site: true });
  f.patterns.push({ number: '2', asset: 'p2:2', name: 'dmwmuffinite', tier: 2 }); f.balances.set('p2:2', { amount: '7', current: true });
  const { createHash } = await import('node:crypto'), { encodeTracAddress } = await import('../../rules/src/trac-address.js');
  const sha = value => createHash('sha256').update(value).digest('hex'), to = n => encodeTracAddress(String(n).repeat(64));
  const calls = [], events = [], service = f.agent.service, profile = service.profile.bind(service);
  service.profile = async (owner, options) => options.collection === 'history' ? { history: events, nextCursor: null } : profile(owner, options);
  // The kit transfer action, observed; it writes the journal rows the real one writes.
  f.agent.transaction = async ({ actionId, op, value }) => {
    calls.push({ actionId, op, value });
    f.journal.reserve(`tx/${actionId}/v2-intent`, { op, value }, { version: 2, actions: [{ nonce: sha('n' + actionId) }] });
    f.journal.reserve(`tx/${actionId}/v2-move`, { type: 'transfer-v2' }, { v: 2 });
    f.journal.mark(`tx/${actionId}/v2-move`, 'received', { move: sha('m' + actionId), batch: '41' });
    return { state: 'received' };
  };
  const dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const width = Number(process.env.DMW_DASHBOARD_WIDTH ?? 1280), shots = process.env.DMW_DASHBOARD_SHOTS;
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === dashboard.origin ? route.continue() : route.abort());
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  // Units on Trac starts collapsed under its header.
  await page.getByRole('button', { name: 'Show Units on Trac', exact: true }).click();
  const send = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Send units on Trac' }) });
  const receive = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Your Trac address' }) });
  const shot = async (name, locator) => { if (shots) { await locator.evaluate(el => el.scrollIntoView({ block: 'center' })); await locator.screenshot({ path: `${shots}/send-${name}-${width}.png` }); } };
  await receive.getByText(f.agent.address).waitFor();
  assert.equal(await receive.getByRole('button', { name: 'Copy address' }).count(), 1);
  await send.getByText('not a Bitcoin or TAP token transfer and not an inscription').first().waitFor();
  // Units are offered by name, tier and available amount; the key is a muted detail.
  const unit = send.getByRole('combobox', { name: 'Units, row 1' });
  assert.deepEqual((await unit.locator('option').allTextContents()).slice(1), ['Test · T3 · 100 available', 'dmwmuffinite · T2 · 7 available']);
  await send.getByRole('textbox', { name: 'Recipient Trac address, row 1' }).fill(to(1).slice(0, -1) + 'x');
  await send.getByText('Not a valid Trac address').waitFor();
  await send.getByRole('textbox', { name: 'Recipient Trac address, row 1' }).fill(to(1));
  await unit.selectOption('p2:2');
  await send.getByText('#2', { exact: true }).waitFor();
  await send.getByRole('button', { name: 'Max' }).click();
  assert.equal(await send.getByRole('textbox', { name: 'Amount, row 1' }).inputValue(), '7');
  await send.getByRole('textbox', { name: 'Amount, row 1' }).fill('2');
  await send.getByRole('button', { name: 'Add row' }).click();
  await send.getByRole('textbox', { name: 'Recipient Trac address, row 2' }).fill(to(2));
  await send.getByRole('combobox', { name: 'Units, row 2' }).selectOption('p2:1');
  await send.getByRole('textbox', { name: 'Amount, row 2' }).fill('5');
  await shot('send', send);
  await send.getByRole('button', { name: 'Review send' }).click();
  await send.getByText('Send 2 dmwmuffinite, 5 Test to 2 Trac addresses?').waitFor();
  await assertReferences(page, ['dmwmuffinite']);
  await send.getByText('Free, arrives with the next Bitcoin block.', { exact: false }).waitFor();
  assert.equal(calls.length, 0, 'review signs nothing');
  await shot('confirm', send);
  await send.getByRole('button', { name: 'Send on Trac' }).click();
  const recent = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Recent sends on Trac' }) });
  await recent.getByText('Confirms in batch 41').first().waitFor();
  assert.deepEqual(calls.map(c => [c.op, c.value]), [['tf', { to: to(1), assets: [['p2:2', '2']] }], ['tf', { to: to(2), assets: [['p2:1', '5']] }]]);
  dashboard.state.confirmCache = null;
  events.push({ id: sha('v2-event/transfer/' + sha('m' + calls[0].actionId) + '/' + sha('n' + calls[0].actionId)), type: 'transfer', provenance: { batch: '42' } });
  await recent.getByText('Confirmed in batch 42').waitFor({ timeout: 10000 });
  await shot('progress', recent);
  await assertReferences(page, ['dmwmuffinite', 'Test']);
  assert.equal(await recent.getByRole('link', { name: 'batch 42' }).first().getAttribute('href'), '/records/batches/42');
  assert.equal(await recent.getByRole('link', { name: 'dmwmuffinite' }).first().getAttribute('href'), '/pattern/p2:2');
  assert.equal(await recent.locator(`a[href="/agents/${to(1)}"]`).count(), 1);
  await shot('receive', receive);
  // A pasted list by pattern name; a wrong line is explained and nothing is signed.
  await send.getByRole('button', { name: 'Paste a list' }).click();
  await send.getByRole('textbox', { name: 'List of sends' }).fill(`${to(3)}, dmwmuffinite, 1\n${to(4)} dmwnothing 1`);
  await send.getByRole('button', { name: 'Review send' }).click();
  await send.getByText('Your agent holds no units by that name').waitFor();
  assert.equal(calls.length, 2);
  await shot('paste-error', send);
  assert.deepEqual(errors, []);
});

test('My agent shows TNK apart from units: balance, fee and funding address; one TNK send reviewed, then pending → confirmed', async t => {
  const f = await dashboardFixture(t, { http: true, site: true });
  const { nativeTnk } = await import('../lib/tnk-runtime.mjs'), { fixtureBus } = await import('./fixtures/tnk-adapter.mjs');
  const { encodeTracAddress } = await import('../../rules/src/trac-address.js'), { testWallet } = await import('./helpers.mjs');
  const { bus, state: msb } = fixtureBus(testWallet()), to = encodeTracAddress(testWallet(2).publicKey);
  Object.assign(f.agent.trac, nativeTnk(bus));
  const dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const width = Number(process.env.DMW_DASHBOARD_WIDTH ?? 1280), shots = process.env.DMW_DASHBOARD_SHOTS;
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === dashboard.origin ? route.continue() : route.abort());
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  const section = name => page.locator('section.panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await page.getByRole('button', { name: 'Show TNK', exact: true }).click();
  const card = section('TNK (Trac network gas)'), send = section('Send TNK'), recent = section('Recent TNK sends');
  const shot = async (name, locator) => { if (shots) { await locator.evaluate(el => el.scrollIntoView({ block: 'center' })); await locator.screenshot({ path: `${shots}/tnk-${name}-${width}.png` }); } };
  await card.getByText('10 TNK', { exact: true }).waitFor();
  await card.getByText('0.01 TNK', { exact: true }).waitFor();
  await card.getByText('Send TNK here to fund your agent').waitFor();
  await card.getByText(f.agent.address).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Copy address' }).count(), 1);
  await card.getByText('Game moves and unit sends are free; TNK is only needed for paid Trac transactions.').waitFor();
  await shot('card', card);
  await send.getByRole('textbox', { name: 'TNK recipient Trac address' }).fill(to.slice(0, -1) + 'x');
  await send.getByText('Not a valid Trac address').waitFor();
  await send.getByRole('textbox', { name: 'TNK recipient Trac address' }).fill(to);
  await send.getByRole('button', { name: 'Max' }).click();
  assert.equal(await send.getByRole('textbox', { name: 'TNK amount' }).inputValue(), '9.99');
  await send.getByRole('textbox', { name: 'TNK amount' }).fill('1.25');
  await shot('send', send);
  await send.getByRole('button', { name: 'Review TNK send' }).click();
  await send.getByText(/^Send 1\.25 TNK to trac1\S+…\S+\? Network fee 0\.01 TNK\.$/).waitFor();
  await assertReferences(page, []);
  await send.getByText('not game units', { exact: false }).waitFor();
  assert.equal(msb.signed, 0, 'review signs nothing');
  await shot('review', send);
  await send.getByRole('button', { name: 'Send TNK', exact: true }).click();
  await recent.getByText('Sent to the Trac network. Waiting', { exact: false }).waitFor();
  assert.equal(msb.signed, 1); assert.equal(msb.sent.length, 3);
  const packet = JSON.parse(msb.sent[0].bytes);
  msb.pending.set(packet.tro.tx, { decoded: packet });
  await recent.getByText('Pending on the Trac network.', { exact: false }).waitFor({ timeout: 15000 });
  await shot('progress', recent);
  msb.confirmed.set(packet.tro.tx, { decoded: packet });
  await recent.getByText('Confirmed. The TNK is at the recipient.').waitFor({ timeout: 15000 });
  await shot('confirmed', recent);
  await assertReferences(page, []);
  assert.equal(await recent.locator(`a[href="/agents/${to}"]`).count(), 1);
  assert.equal(msb.signed, 1);
  assert.deepEqual(errors, []);
});

// Craft on My agent: the owner's mix of two v2 patterns and imported units.
async function craftPage(t, setup = () => {}) {
  const f = await dashboardFixture(t, { http: true, site: true });
  const { DashboardState } = await import('../lib/dashboard-state.mjs'), { createHash } = await import('node:crypto');
  const sha = value => createHash('sha256').update(value).digest('hex'), made = 'c2:' + 'ef'.repeat(32);
  f.patterns.length = 0;
  f.patterns.push({ number: '0', asset: 'p2:0', name: 'dmwflorite', legacy: { asset: 'p0' }, tier: 4, fld: 10, knownMatchCount: '571' },
    { number: '1', asset: 'p2:1', name: 'dmwnullspar', tier: 3, fld: 10, knownMatchCount: '40' }, { number: '2', asset: 'p2:2', name: 'dmwmuffinite', tier: 2, fld: 4, knownMatchCount: '900' });
  f.balances.set('p2:1', { amount: '92', current: true }); f.balances.set('p2:2', { amount: '100', current: true }); f.balances.set('p0', { amount: '99', current: true });
  const events = [], previews = [], crafts = [], service = f.agent.service, profile = service.profile.bind(service);
  const compounds = new Map([[made, { id: made, recipe: 'fusion', inputs: [{ asset: 'p2:1', amount: '1' }, { asset: 'p2:2', amount: '1' }], properties: { charge: 3, spectrum: 3, generation: '1' }, tier: { value: null } }]]);
  service.compounds = async ({ asset }) => ({ compounds: compounds.has(asset) ? [compounds.get(asset)] : [] });
  service.profile = async (owner, options) => options.collection === 'history' ? { history: events, nextCursor: null } : profile(owner, options);
  setup(f);
  const state = new DashboardState(f.context);
  // The verified preview and the kit craft action, observed.
  state.preview = async ({ recipe, inputs }) => { previews.push({ recipe, inputs });
    return { result: { amount: inputs[0][1] === inputs[1][1] ? inputs[0][1] : '1', record: { id: made, snapshot: { height: '20' }, tier: { value: 4 }, properties: { charge: 3, spectrum: 3, generation: '1' } } } }; };
  f.agent.craft = async ({ actionId, recipe, inputs }) => {
    crafts.push({ actionId, recipe, inputs });
    f.journal.reserve(`craft/${actionId}/v2-intent`, { recipe, inputs }, { result: { record: { id: made }, amount: '2' } });
    f.journal.reserve(`craft/${actionId}`, { type: 'craft-v2' }, { v: 2 });
    f.journal.mark(`craft/${actionId}`, 'received', { move: sha('m' + actionId), batch: '51' });
    for (const [asset, amount] of inputs) f.balances.set(asset, { amount: String(BigInt(f.balances.get(asset).amount) - BigInt(amount)), current: true });
    f.balances.set(made, { amount: '2', current: true });
    return { state: 'received' };
  };
  const dashboard = await serveDashboard(f.context, { state }); cleanup(t, () => dashboard.close());
  const width = Number(process.env.DMW_DASHBOARD_WIDTH ?? 1280), shots = process.env.DMW_DASHBOARD_SHOTS;
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  // Screenshots use a tall window so the site's fixed bars never cover the card.
  const page = await browser.newPage({ viewport: { width, height: shots ? 2400 : 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === dashboard.origin ? route.continue() : route.abort());
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  const section = name => page.locator('section.panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const shot = async (name, locator) => { if (shots) { await locator.evaluate(el => el.scrollIntoView({ block: 'center' })); await locator.screenshot({ path: `${shots}/craft-${name}-${width}.png` }); } };
  await page.getByRole('button', { name: 'Show Compounds & crafting', exact: true }).click();
  return { f, page, errors, section, shot, previews, crafts, events, sha, state, made };
}

test('My agent: with units of one pattern only, Craft explains that a second pattern is needed', async t => {
  const { page, errors, section, shot } = await craftPage(t, f => f.balances.delete('p2:2'));
  const craft = section('Craft a compound');
  await craft.getByText('You need units of at least two patterns to craft — claim blocks of another pattern first.').waitFor();
  assert.equal(await craft.getByRole('checkbox', { name: /Florite/ }).isDisabled(), true);
  await craft.getByText('These units become craftable at the compound upgrade activation height.', { exact: false }).waitFor();
  await shot('empty', craft);
  assert.equal(await page.getByRole('button', { name: 'Review craft' }).isDisabled(), true);
  assert.deepEqual(errors, []);
});

test('My agent crafts: ingredients by name, Resonance explained, preview before review, warning, one confirm, progress to the batch, compounds with Refine', async t => {
  const { page, errors, section, shot, previews, crafts, events, sha, state } = await craftPage(t);
  const craft = section('Craft a compound');
  await craft.getByRole('checkbox', { name: /dmwnullspar/ }).waitFor();
  await craft.getByText('Charge 1 · Spectrum: nonce · Generation 0 · a pattern · 40 known blocks').waitFor();
  assert.equal(await craft.getByRole('checkbox', { name: /Florite/ }).isDisabled(), true, 'legacy crafting waits for activation');
  await craft.getByRole('checkbox', { name: /dmwnullspar/ }).check();
  await craft.getByRole('checkbox', { name: /dmwmuffinite/ }).check();
  await shot('picker', craft);
  // Charges 1 and 2: Resonance is disabled and says why.
  assert.equal(await craft.getByRole('radio', { name: /Resonance/ }).isDisabled(), true);
  await craft.getByText('dmwnullspar has charge 1, dmwmuffinite has charge 2', { exact: false }).waitFor();
  await craft.getByText('Nullspar + Muffinite fusion').waitFor();
  await craft.getByText('preview — nothing signed').waitFor();
  assert.equal(crafts.length, 0);
  await craft.getByRole('textbox', { name: 'Units of dmwnullspar to use' }).fill('2');
  await craft.getByRole('textbox', { name: 'Units of dmwmuffinite to use' }).fill('2');
  await craft.getByText('2 dmwnullspar (90 left) + 2 dmwmuffinite (98 left)', { exact: false }).waitFor();
  await shot('preview', craft);
  // Using almost all dmwnullspar leaves too few for its two claimed blocks (3 units each).
  await craft.getByRole('button', { name: 'Use all 92 dmwnullspar' }).click();
  await craft.getByText('You have 2 claimed blocks of dmwnullspar waiting to mint that need 6 units.', { exact: false }).waitFor();
  await shot('warning', craft);
  await craft.getByRole('textbox', { name: 'Units of dmwnullspar to use' }).fill('2');
  await craft.getByText('2 dmwnullspar (90 left)', { exact: false }).waitFor();
  await assertEventually(async () => !await craft.getByRole('button', { name: 'Review craft' }).isDisabled());
  await craft.getByRole('button', { name: 'Review craft' }).click();
  await craft.getByText('Creates Nullspar + Muffinite fusion with 2 units from 2 dmwnullspar + 2 dmwmuffinite?').waitFor();
  await assertReferences(page, ['dmwmuffinite']);
  await shot('confirm', craft);
  assert.ok(previews.length > 0); assert.equal(crafts.length, 0, 'review signs nothing');
  await craft.getByRole('button', { name: 'Craft now' }).click();
  const recent = section('Recent crafts');
  await recent.getByText('Confirms in batch 51', { exact: false }).waitFor();
  assert.equal(crafts.length, 1);
  assert.deepEqual(crafts[0].inputs, [['p2:1', '2'], ['p2:2', '2']]);
  assert.match(crafts[0].actionId, /^dash-craft-[0-9a-f]{12}$/);
  state.craftEvents = null;
  events.push({ id: sha('v2-event/craft/' + sha('m' + crafts[0].actionId)), type: 'craft', provenance: { batch: '52' } });
  await recent.getByText('Confirmed in batch 52. The compound is in your units.').waitFor({ timeout: 15000 });
  await shot('progress', recent);
  const mine = section('Your compounds');
  await mine.getByRole('button', { name: 'Refine' }).waitFor({ timeout: 20000 });
  await mine.getByText('2 dmwnullspar', { exact: false }).count();
  await shot('compounds', mine);
  await assertReferences(page, ['dmwnullspar', 'dmwmuffinite', 'Nullspar + Muffinite fusion']);
  assert.equal(await mine.getByRole('link', { name: 'Nullspar + Muffinite fusion' }).getAttribute('href'), '/compound/c2:' + 'ef'.repeat(32));
  // The new compound is offered under Send units with its label.
  await page.getByRole('button', { name: 'Show Units on Trac', exact: true }).click();
  const unit = section('Send units on Trac').getByRole('combobox', { name: 'Units, row 1' });
  await assertEventually(async () => (await unit.locator('option').allTextContents()).some(o => o.startsWith('Nullspar + Muffinite fusion')));
  assert.equal(crafts.length, 1);
  assert.deepEqual(errors, []);
});


test('My agent enables florite after activation and says when a craft adds units', async t => {
  const { COMPOUND_IDENTITY_V4_HEIGHT } = await import('../../rules/src/index.js');
  const { page, errors, section, state, previews } = await craftPage(t, f => { f.clock.counted = COMPOUND_IDENTITY_V4_HEIGHT; });
  const original = state.preview;
  state.preview = async args => { const result = await original(args); result.result.existing = true; return result; };
  const craft = section('Craft a compound');
  const florite = craft.getByRole('checkbox', { name: /Florite/ });
  await florite.waitFor(); assert.equal(await florite.isDisabled(), false);
  await florite.check(); await craft.getByRole('checkbox', { name: /dmwnullspar/ }).check();
  await craft.getByText('Adds 1 units to Florite + Nullspar fusion', { exact: true }).waitFor();
  assert.deepEqual(previews.at(-1).inputs, [['p0', '1'], ['p2:1', '1']]);
  assert.deepEqual(errors, []);
});

// My agent's layout: claims, open requests and patterns first; compounds, units on Trac and TNK collapsed under one header each.
test('My agent: order of sections, collapsed groups with summaries, remembered and auto-opened; patterns search and pages; claims page size', async t => {
  const f = await dashboardFixture(t, { http: true, site: true }), owner = f.agent.owner, settingsHash = f.claims[0].settingsHash;
  for (let n = 2; n <= 15; n++) {
    f.patterns.push({ number: String(n), asset: `p2:${n}`, name: `dmwpat${n}`, tier: 2 });
    f.discoveries.push({ number: String(n), asset: `p2:${n}`, name: `dmwpat${n}`, tier: 2, discoverer: owner, state: 'accepted' });
  }
  for (const block of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '13', '14', '15', '16', '17']) f.claims.push({ asset: 'p2:1', block, count: '3', finder: owner, findHeight: '19', finderUntil: '1027', settingsHash });
  const { nativeTnk } = await import('../lib/tnk-runtime.mjs'), { fixtureBus } = await import('./fixtures/tnk-adapter.mjs'), { testWallet } = await import('./helpers.mjs');
  Object.assign(f.agent.trac, nativeTnk(fixtureBus(testWallet()).bus));
  const dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const width = Number(process.env.DMW_DASHBOARD_WIDTH ?? 1280), shots = process.env.DMW_DASHBOARD_SHOTS;
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === dashboard.origin ? route.continue() : route.abort());
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  const section = name => page.locator('section.panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const toggle = (verb, name) => page.getByRole('button', { name: `${verb} ${name}`, exact: true });
  const headings = () => page.locator('main section.panel > header h2').evaluateAll(list => list.filter(h => h.offsetParent).map(h => h.textContent));
  // Nothing on My agent reaches past the page's own gutters; wide tables and tabs scroll inside their own box. The site's top bar is measured apart.
  const noSideScroll = () => page.evaluate(() => { const pg = document.querySelector('main .page'), box = pg.getBoundingClientRect(), pad = parseFloat(getComputedStyle(pg).paddingRight);
    return [...pg.querySelectorAll('*')].every(e => !e.offsetParent || e.parentElement.closest('.tablewrap, .tabs') || e.getBoundingClientRect().right <= Math.min(box.right - pad, innerWidth) + 1); });
  const topbar = () => page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  const patterns = section('Your patterns'), claims = section('Claimed blocks you may mint');
  await claims.getByRole('tab', { name: 'All · 16' }).waitFor();
  await patterns.locator('tbody tr').first().waitFor();
  await section('TNK').getByText('Balance 10 TNK', { exact: true }).waitFor();
  assert.deepEqual(await headings(), ['Claimed blocks you may mint', 'Open requests', 'Bitmap links', 'Your patterns', 'Compounds & crafting', 'Units on Trac', 'TNK']);
  for (const name of ['Compounds & crafting', 'Units on Trac', 'TNK']) assert.equal(await toggle('Show', name).getAttribute('aria-expanded'), 'false');
  for (const name of ['Craft a compound', 'Your compounds', 'Recent crafts', 'Send units on Trac', 'Your Trac address', 'Send TNK', 'Recent TNK sends']) assert.equal(await section(name).isVisible(), false, name);
  // Summaries while collapsed: compounds, the agent's address (short, linked) and the TNK balance.
  await section('Compounds & crafting').getByText('No compounds yet', { exact: true }).waitFor();
  assert.equal(await section('Units on Trac').locator(`a[href="/agents/${f.agent.address}"]`).count(), 1);
  // Claimed blocks: twelve per page; the rest on the next.
  assert.equal(await claims.locator('tbody tr').count(), 12);
  await claims.getByRole('button', { name: 'Next page' }).click();
  await assertEventually(async () => await claims.locator('tbody tr').count() === 4);
  await claims.getByRole('button', { name: 'First page' }).click();
  await assertEventually(async () => await claims.locator('tbody tr').count() === 12);
  // Your patterns: ten per page, a search over name, key and ticker.
  assert.equal(await patterns.locator('tbody tr').count(), 10);
  await patterns.getByText('1–10 of 15', { exact: true }).waitFor();
  assert.equal(await patterns.getByRole('button', { name: 'Previous page' }).isDisabled(), true);
  await patterns.getByRole('button', { name: 'Next page' }).click();
  await patterns.getByText('11–15 of 15', { exact: true }).waitFor();
  assert.equal(await patterns.locator('tbody tr').count(), 5);
  const search = patterns.getByRole('searchbox', { name: 'Search your patterns' });
  await search.fill('dmwpat1');
  await assertEventually(async () => (await patterns.locator('tbody tr').count()) === 6);
  assert.equal(await patterns.locator('.pager-foot').count(), 0, 'one page: no pager');
  await search.fill('#7');
  await assertEventually(async () => (await patterns.locator('tbody tr').allTextContents()).join() .includes('dmwpat7') && await patterns.locator('tbody tr').count() === 1);
  await search.fill('nothing here');
  await patterns.getByText('No pattern matches “nothing here”.', { exact: true }).waitFor();
  await search.fill('');
  await patterns.getByText('1–10 of 15', { exact: true }).waitFor();
  assert.equal(await noSideScroll(), true);
  if (shots) { console.log('page width', width, await topbar()); await page.screenshot({ path: `${shots}/me-collapsed-${width}.png`, fullPage: true }); }
  // Opened sections show their panels and stay open after a reload.
  await toggle('Show', 'TNK').click();
  await section('Send TNK').waitFor();
  assert.equal(await toggle('Hide', 'TNK').getAttribute('aria-expanded'), 'true');
  assert.equal(await noSideScroll(), true);
  if (shots) await page.screenshot({ path: `${shots}/me-tnk-open-${width}.png`, fullPage: true });
  await page.reload();
  await section('Send TNK').waitFor();
  assert.equal(await section('Craft a compound').isVisible(), false);
  // A running craft opens its section by itself, without remembering it as the user's choice.
  await page.route('**/api/craft', async route => {
    const response = await route.fetch(), body = await response.json();
    body.crafts = [{ id: 'craft-1', kind: 'craft', recipe: 'fusion', state: 'received', signed: true, createdAt: Date.now(), label: 'Test + Pat fusion', inputs: [{ asset: 'p2:1', amount: '1', name: 'dmwtest' }] }, ...body.crafts];
    return route.fulfill({ response, json: body });
  });
  await page.reload();
  await section('Recent crafts').getByText('Sent to the gateway. Confirms with the next Bitcoin block.', { exact: true }).waitFor();
  await section('Compounds & crafting').getByText('No compounds yet · 1 craft in progress', { exact: true }).waitFor();
  assert.equal(await toggle('Hide', 'Compounds & crafting').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('dmw.dashboard.agent.open'))), { tnk: true });
  // Without localStorage the page still works, collapsed.
  await page.unroute('**/api/craft');
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw Error('blocked'); } }));
  await page.reload();
  await section('Your patterns').locator('tbody tr').first().waitFor();
  assert.equal(await section('Send TNK').isVisible(), false);
  await toggle('Show', 'Units on Trac').click();
  await section('Your Trac address').getByText(f.agent.address).waitFor();
  assert.deepEqual(errors, []);
});

test('My agent: a pattern with several tickers gets Mint into above its blocks; each Mint names and sends the chosen ticker', async t => {
  const f = await dashboardFixture(t, { http: true, site: true }), dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const owner = f.agent.owner, settingsHash = f.claims[0].settingsHash, extra = 'ab'.repeat(32) + 'i0';
  f.patterns.push({ number: '3', asset: 'p2:3', name: 'dmwother', tier: 2 });
  f.claims.push({ asset: 'p2:3', block: '9', count: '3', finder: owner, findHeight: '19', finderUntil: '1027', settingsHash });
  f.balances.set('p2:3', { amount: '100', current: true });
  const tickerRows = { 'p2:1': [{ ticker: 'dmt-test', tick: 'test', ordinal: '1', deploymentId: 'cd'.repeat(32) + 'i0', unitsMinted: '0' },
    { ticker: 'dmt-second', tick: 'second', ordinal: '2', deploymentId: extra, unitsMinted: '0' }],
    'p2:3': [{ ticker: 'dmt-dmwother', tick: 'dmwother', ordinal: '1', deploymentId: 'ef'.repeat(32) + 'i0', unitsMinted: '0' }] };
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage({ viewport: { width: Number(process.env.DMW_DASHBOARD_WIDTH ?? 1280), height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const minted = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== dashboard.origin) return route.abort();
    const asset = decodeURIComponent(url.pathname.match(/^\/assets\/([^/]+)\/tickers$/)?.[1] ?? '');
    if (tickerRows[asset]) return route.fulfill({ json: { asset, catalogAsset: asset, rows: tickerRows[asset] } });
    if (url.pathname === '/api/mint') { minted.push(route.request().postDataJSON()); return route.fulfill({ json: { state: 'request_pending' } }); }
    return route.continue();
  });
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  const claims = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Claimed blocks you may mint' }) });
  await claims.getByRole('tab', { name: 'All · 3' }).waitFor();
  // All patterns, or a pattern with one ticker: no picker, plain Mint.
  assert.equal(await claims.getByText('Mint into', { exact: true }).isVisible(), false);
  await claims.getByRole('tab', { name: 'dmwother · 1' }).click();
  await assertEventually(async () => await claims.locator('tbody tr').count() === 1);
  assert.equal(await claims.getByText('Mint into', { exact: true }).isVisible(), false);
  // Several tickers: the picker sits above the blocks, and every Mint says where it goes.
  await claims.getByRole('tab', { name: 'Test · 2' }).click();
  const picker = claims.getByRole('combobox', { name: 'Ticker' });
  await picker.waitFor();
  assert.equal(await claims.getByText('Your mints go into this ticker. The rewards are the same whichever ticker.').isVisible(), true);
  await picker.selectOption(extra);
  await claims.getByRole('button', { name: 'Mint into second' }).first().waitFor();
  assert.equal(await claims.getByRole('button', { name: 'Mint into second' }).count(), 2);
  await claims.getByRole('button', { name: 'Mint into second' }).first().click();
  await assertEventually(async () => minted.length === 1);
  assert.equal(minted[0].deployment, extra); assert.equal(minted[0].asset, 'p2:1');
  // Back to the official ticker: plain Mint, no deployment sent.
  await picker.selectOption('');
  await claims.getByRole('button', { name: 'Mint', exact: true }).first().waitFor();
  await claims.getByRole('button', { name: 'Mint', exact: true }).first().click();
  await assertEventually(async () => minted.length === 2);
  assert.equal(minted[1].deployment, undefined);
  assert.deepEqual(errors, []);
});

test('My agent mints several blocks of one pattern as one order, next to the single Mint buttons', async t => {
  const f = await dashboardFixture(t, { http: true, site: true }), dashboard = await serveDashboard(f.context); cleanup(t, () => dashboard.close());
  const owner = f.agent.owner, settingsHash = f.claims[0].settingsHash;
  for (const block of ['13', '14', '15']) f.claims.push({ asset: 'p2:1', block, count: '3', finder: owner, findHeight: '19', finderUntil: '1027', settingsHash });
  f.patterns.push({ number: '3', asset: 'p2:3', name: 'dmwother', tier: 2 });
  f.claims.push({ asset: 'p2:3', block: '9', count: '3', finder: owner, findHeight: '19', finderUntil: '1027', settingsHash });
  f.balances.set('p2:3', { amount: '100', current: true });
  const width = Number(process.env.DMW_DASHBOARD_WIDTH ?? 1280), shots = process.env.DMW_DASHBOARD_SHOTS;
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === dashboard.origin ? route.continue() : route.abort());
  await page.goto(dashboard.loginLink);
  await page.waitForURL(dashboard.origin + '/me');
  const claims = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Claimed blocks you may mint' }) });
  await claims.getByRole('button', { name: 'Mint all 6 blocks', exact: true }).waitFor();
  await page.getByText('Loading your agent…', { exact: true }).waitFor({ state: 'hidden' });
  await claims.getByText('One wallet approval per 64 blocks. Fees and the Bitcoin set-aside are shown before you pay.', { exact: true }).waitFor();
  await claims.getByRole('tab', { name: 'Test · 5' }).click();
  await claims.getByRole('button', { name: 'Mint all 5 blocks', exact: true }).waitFor();
  await assertEventually(async () => await claims.locator('tbody tr').count() === 5);
  await claims.getByRole('spinbutton', { name: 'Number of blocks' }).fill('3');
  await claims.getByRole('button', { name: 'Mint 3 blocks', exact: true }).click();
  const pay = claims.getByRole('link', { name: 'Pay and mint 3 blocks', exact: true });
  await pay.waitFor();
  const bulk = f.packets.filter(p => p.terms);
  assert.equal(bulk.length, 1); assert.equal(bulk[0].terms.asset, 'p2:1'); // The first three blocks as the list shows them (this fixture lists them unsorted).
  assert.deepEqual(bulk[0].terms.members.map(m => m.block), ['11', '12', '13']);
  const orderId = dashboard.state.bulkLive()[0].orderId;
  assert.equal(await pay.getAttribute('href'), '/mint/bulk/' + orderId);
  const order = claims.locator('tbody tr').filter({ has: page.getByRole('link', { name: 'Pay and mint 3 blocks', exact: true }) });
  await order.getByText('ready to pay', { exact: true }).waitFor();
  await order.getByText('minted 0/3', { exact: true }).waitFor();
  assert.equal(await order.getByRole('link', { name: '11', exact: true }).getAttribute('href'), '/block/11');
  assert.equal(await order.getByRole('link', { name: '13', exact: true }).getAttribute('href'), '/block/13');
  await order.getByText(/^Bitcoin set-aside/).waitFor();
  // Nothing reaches past the page's gutters; tables scroll inside their own box.
  assert.equal(await page.evaluate(() => { const pg = document.querySelector('main .page'), box = pg.getBoundingClientRect(), pad = parseFloat(getComputedStyle(pg).paddingRight);
    return [...pg.querySelectorAll('*')].every(e => !e.offsetParent || e.parentElement.closest('.tablewrap, .tabs') || e.getBoundingClientRect().right <= Math.min(box.right - pad, innerWidth) + 1); }), true);
  if (shots) {
    await page.evaluate(() => { const box = document.getElementById('toasts'); if (box) box.style.display = 'none'; });
    await page.setViewportSize({ width, height: 2400 }); await page.mouse.move(0, 0);
    await claims.screenshot({ path: `${shots}/mint-several-${width}.png` }); await page.setViewportSize({ width, height: 900 });
  }
  assert.equal(await claims.getByRole('button', { name: 'Try again', exact: true }).isVisible(), false);
  // The single Mint of one row still signs its own request and opens its payment page.
  await claims.locator('tbody tr').filter({ hasText: 'block 15' }).getByRole('button', { name: 'Mint', exact: true }).click();
  await page.waitForURL(/\/mint\/[0-9a-f]{64}$/);
  assert.ok(f.packets.some(p => p.request?.block === '15' && p.request.asset === 'p2:1'));
  assert.equal(f.packets.filter(p => p.terms).length, 1);
  assert.deepEqual(errors, []);
});
