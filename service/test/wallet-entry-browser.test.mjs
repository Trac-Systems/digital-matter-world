import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { encodeTracAddress } from '../../rules/src/trac-address.js';
import { chromium } from 'playwright';
// Set DMW_WALLET_SHOTS to a directory to keep screenshots of each state.
const shots = process.env.DMW_WALLET_SHOTS;
const ownerKey = '11'.repeat(32), owner = encodeTracAddress(ownerKey);
const linked = 'bcrt1p' + 'q'.repeat(58), unlinked = 'bcrt1p' + 'z'.repeat(58);
const target = { network: 'wallet-entry-test', bitcoinNetwork: 'regtest', ethereum: { chainId: '0x7a69' } };
const policy = { baseFee: '1000000000000000000', feeSettings: { link: 3, tierMultipliers: [1, 3, 10, 30, 100], compoundMinimum: 10 }, unit: { decimals: 18 } };
const right = mine => ({ asset: 'p0', block: 7, amount: '1', deploymentRegistered: true, allowed: mine, rightAllowed: true, whoMayMint: 'finder', reason: 'finder', finderUntil: 1015, finder: owner, minted: null, pending: null, balance: '1' });
function pageRows(key, rows, u) {
  const limit = Number(u.searchParams.get('limit') ?? 50);
  return { [key]: rows.slice(0, limit), total: rows.length, next: null };
}
function read(path) {
  const u = new URL(path, 'http://local'), p = u.pathname, mine = u.searchParams.get('owner') === owner;
  if (p === '/status') return { tip: 10, counted: 10, feePolicy: policy };
  if (p === '/world') return pageRows('plots', [{ height: 7, x: 1, y: 0, found: true }], u);
  if (p === '/world/map') return { tip: 10, counted: 10, from: 0, to: 10, marks: [] };
  if (p === '/blocks/7') return { height: 7, x: 1, y: 0, halving: 0, region: 0, found: true, header: { hash: 'ab'.repeat(32), time: 1 }, mintRights: [right(false)] };
  if (p === '/blocks/7/mintRights') return pageRows('mintRights', [right(mine)], u);
  if (p === '/mint-rights') return pageRows('mintRights', mine && u.searchParams.get('allowed') !== 'false' ? [right(true)] : [], u);
  if (p === '/patterns') return pageRows('patterns', [{ asset: 'p0', number: 0, name: 'dmwdigit', pat: '[0-9]', fld: 4, tier: 1, rarity: 1, supply: '10' }], u);
  return pageRows(p.split('/').at(-1), [], u);
}
const lookups = [];
let browser, server;
before(async () => {
  server = await serve({ intake: { store: {} }, files: { serve: async () => false }, web: createWeb({ target, records: async () => ({}) }),
    publicAPI: { handles: () => true, read },
    bindings: { read: () => ({}), wallets: address => { lookups.push(address); return { address, rail: 'tap', players: address === linked ? [{ agent: ownerKey, rail: 'tap', binding: 'cd'.repeat(32), acceptedAt: 1 }] : [], more: false }; } } });
  browser = await chromium.launch({ headless: true });
  if (shots) await mkdir(shots, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function open(t, { address = linked, phone = false, ethereum } = {}) {
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
  await context.addInitScript(account => {
    window.walletPrompts = 0;
    window.tapprotocol = { getNetwork: async () => 'regtest', switchNetwork: async () => {}, requestAccounts: async () => { window.walletPrompts++; return [account]; } };
  }, address);
  // A MetaMask stand-in: eth_requestAccounts answers the account granted earlier, not the selected one, as MetaMask does.
  if (ethereum) await context.addInitScript(selected => {
    const listeners = [], mm = window.metamask = { selected, granted: [], calls: [] };
    mm.emit = accounts => listeners.forEach(fn => fn(accounts));
    window.ethereum = {
      on: (event, fn) => { if (event === 'accountsChanged') listeners.push(fn); },
      request: async ({ method }) => {
        mm.calls.push(method);
        if (method === 'eth_chainId') return '0x7a69';
        if (method === 'eth_accounts') return mm.granted;
        if (method === 'eth_requestAccounts') { if (!mm.granted.length) mm.granted = [mm.selected]; return mm.granted; }
        if (method === 'wallet_requestPermissions') { mm.granted = [mm.selected]; return [{ parentCapability: 'eth_accounts' }]; }
        if (method === 'wallet_revokePermissions') { mm.granted = []; return null; }
        throw Object.assign(Error('unsupported ' + method), { code: 4200 });
      },
    };
  }, ethereum);
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'no script errors'); });
  return page;
}
const shot = (page, name) => shots ? page.screenshot({ path: join(shots, name + '.png'), fullPage: true }) : null;
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const panel = (p, name) => p.locator('section.panel').filter({ has: p.getByRole('heading', { name, exact: true }) });

test('a visitor finds Connect wallet in the header and in the block panel, and then sees what they may mint', async t => {
  const page = await open(t);
  await page.goto(server.url + '/block/7');
  await page.locator('header.topbar').getByRole('button', { name: 'Connect wallet' }).waitFor();
  const header = page.locator('header.topbar .wallet-btn');
  const offer = page.getByRole('button', { name: 'Connect wallet to mint', exact: true });
  await offer.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Mint On-Chain' }).count(), 1);
  assert.equal(await page.locator('button.primary', { hasText: 'Mint On-Chain' }).count(), 0, 'no primary mint before the person is known');
  await shot(page, 'desktop-block-logged-out');

  await offer.click();
  const menu = page.getByRole('dialog', { name: 'Wallet' });
  await menu.getByText('One connection for the whole site', { exact: false }).waitFor();
  await menu.getByText('proves you hold a Bitmap', { exact: false }).waitFor();
  await menu.getByRole('button', { name: 'Connect TAP wallet', exact: true }).click();
  await menu.getByText('Linked to player', { exact: false }).waitFor();
  assert.equal(await menu.getByRole('link', { name: /^trac1/ }).getAttribute('href'), '/agents/' + owner);
  await menu.getByRole('link', { name: 'Mint & wallets', exact: true }).waitFor();
  assert.equal(await menu.getByRole('link').filter({ hasNotText: /^trac1/ }).count(), 1, 'one wallet page, not three');
  await shot(page, 'desktop-header-menu-linked');
  await page.keyboard.press('Escape');

  // The block's rows are now read for the person's player.
  await page.getByText('You may mint', { exact: true }).waitFor();
  await page.locator('button.primary', { hasText: 'Mint On-Chain' }).waitFor();
  assert.equal(await offer.count(), 0);
  assert.match(await header.innerText(), /bcrt1p…qqqq/);
  await shot(page, 'desktop-block-connected');

  // The choice is remembered per browser without asking the wallet again.
  await page.reload();
  await page.getByText('You may mint', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.walletPrompts), 0);
});

test('Mint & wallets without a request link connects, lists the player’s finds and gives the agent message', async t => {
  const page = await open(t);
  await page.goto(server.url + '/mint');
  await page.getByRole('heading', { name: 'Mint & wallets', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'How minting works', exact: true }).waitFor();
  const nav = page.getByRole('navigation', { name: 'Sections' });
  assert.equal(await nav.getByRole('link', { name: 'Mint', exact: true }).getAttribute('href'), '/mint');
  for (const old of ['Mint On-Chain', 'Link Bitmap', 'Payout wallets']) assert.equal(await nav.getByText(old, { exact: true }).count(), 0, old + ' is no longer a tab');
  assert.equal(await page.getByRole('tab').count(), 0, 'no sub-tabs');
  for (const name of ['Your wallets', 'What you can mint', 'Link a Bitmap']) await panel(page, name).waitFor();
  await page.getByText('Connect a wallet to see the finds', { exact: false }).waitFor();
  await page.getByText('tier 5: 100 TAP', { exact: false }).waitFor();
  const wallet = panel(page, 'Your wallets');
  await shot(page, 'desktop-mint-logged-out');
  await wallet.getByRole('button', { name: 'Connect TAP wallet', exact: true }).click();
  const rights = panel(page, 'What you can mint');
  await rights.getByText('You may mint', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect TAP wallet', exact: true }).count(), 0, 'no page asks for a wallet the header already has');
  assert.equal(await page.getByRole('button', { name: 'Connect MetaMask', exact: true }).count(), 1, 'the missing wallet is offered once');
  await wallet.getByText('Linked to player', { exact: false }).waitFor();
  await shot(page, 'desktop-mint-connected');
  await rights.getByRole('button', { name: 'Mint On-Chain' }).click();
  const dialog = page.getByRole('dialog');
  assert.match(await dialog.locator('pre').innerText(), new RegExp(`^Mint p0 \\(.+\\) from block 7 on-chain and give me the payment link\\.\\nTAP wallet: ${linked}$`));
  await shot(page, 'desktop-mint-agent-message');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByText('Already have a payment link from your agent?', { exact: false }).waitFor();
});

test('an unlinked wallet explains linking with the README message; /link and /bind-payout open the same page', async t => {
  const page = await open(t, { address: unlinked });
  await page.goto(server.url + '/mint?asset=p0&block=7');
  await panel(page, 'Your wallets').getByRole('button', { name: 'Connect TAP wallet', exact: true }).click();
  await page.getByText('Not linked to a player yet.', { exact: false }).first().waitFor();
  assert.equal(await page.locator('pre').first().innerText(), `Link my payout wallet and give me the link to sign:\nTAP wallet: ${unlinked}`);
  await page.getByText('Your wallet is not linked to a player yet, so there is nothing to mint.', { exact: false }).waitFor();
  await page.getByText('Link your wallet first', { exact: false }).waitFor();
  await shot(page, 'desktop-mint-not-linked');

  for (const path of ['/bind-payout', '/link?block=7']) {
    await page.goto(server.url + path);
    await page.getByRole('heading', { name: 'Mint & wallets', exact: true }).waitFor();
    await page.getByText('Your agent starts the link; you sign it', { exact: false }).waitFor();
    await page.getByText('TAP Wallet proves you hold the Bitmap', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Connect TAP wallet', exact: true }).count(), 0, 'the header connection is reused');
    assert.equal(await page.getByRole('button', { name: 'Connect MetaMask', exact: true }).count(), 1);
  }
  await panel(page, 'Link a Bitmap').getByText('hold 7.bitmap in TAP Wallet', { exact: false }).waitFor();
});

test('phone width: the header wallet control fits and no page scrolls sideways', async t => {
  const page = await open(t, { phone: true });
  for (const path of ['/block/7', '/mint', '/bind-payout']) {
    await page.goto(server.url + path);
    await page.locator('header.topbar').getByRole('button', { name: 'Wallet', exact: true }).waitFor();
    if (path === '/block/7') await page.getByRole('button', { name: 'Connect wallet to mint', exact: true }).waitFor();
    else await page.locator('h1').waitFor();
    await page.waitForLoadState('networkidle');
    assert.ok(await noSideScroll(page), path + ' has no horizontal scroll');
    await shot(page, 'phone' + path.replace(/\//g, '-') + '-logged-out');
  }
  await page.locator('header.topbar').getByRole('button', { name: 'Wallet', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Wallet' });
  await menu.getByRole('button', { name: 'Connect TAP wallet', exact: true }).click();
  await menu.getByText('Linked to player', { exact: false }).waitFor();
  const box = await menu.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, 'menu fits the phone width');
  assert.ok(await noSideScroll(page));
  await shot(page, 'phone-header-menu-linked');
  await page.keyboard.press('Escape');
  await page.goto(server.url + '/mint');
  await panel(page, 'What you can mint').getByText('You may mint', { exact: true }).waitFor();
  assert.ok(await noSideScroll(page), '/mint connected has no horizontal scroll');
  await shot(page, 'phone-mint-connected');
  assert.ok(lookups.includes(linked));
});

test('MetaMask: a new connect uses the selected account, and the site follows account switches', async t => {
  const a = '0x' + 'a'.repeat(40), b = '0x' + 'b'.repeat(40);
  const page = await open(t, { ethereum: a });
  await page.goto(server.url + '/bind-payout');
  const header = page.locator('header.topbar .wallet-btn'), mine = panel(page, 'Your wallets');
  const shows = async address => {
    await page.waitForFunction(text => document.querySelector('header.topbar .wallet-btn').innerText.includes(text), address.slice(0, 6) + '…' + address.slice(-4));
    await mine.locator(`.hash[title="${address}"]`).waitFor();
  };
  await mine.getByRole('button', { name: 'Connect MetaMask', exact: true }).click();
  await shows(a);

  // Disconnect, switch to B in MetaMask, connect again: B.
  await header.click();
  await page.getByRole('dialog', { name: 'Wallet' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.keyboard.press('Escape');
  await mine.getByRole('button', { name: 'Connect MetaMask', exact: true }).waitFor();
  assert.match(await header.innerText(), /Connect wallet/);
  assert.equal(await page.evaluate(() => localStorage.getItem('dmw-web-v1/wallets')), '{}', 'no address is kept after disconnect');
  await page.evaluate(b => { window.metamask.selected = b; }, b);
  await mine.getByRole('button', { name: 'Connect MetaMask', exact: true }).click();
  await shows(b);
  assert.ok((await page.evaluate(() => window.metamask.calls)).includes('wallet_requestPermissions'), 'connect lets the person pick the account');

  // A switch in MetaMask while connected updates the header and the page.
  await page.evaluate(a => { window.metamask.granted = [a]; window.metamask.emit([a]); }, a);
  await shows(a);
  assert.equal(await mine.locator(`.hash[title="${b}"]`).count(), 0);
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('dmw-web-v1/wallets'))).ethereum, a);

  // No accounts: disconnected.
  await page.evaluate(() => window.metamask.emit([]));
  await mine.getByRole('button', { name: 'Connect MetaMask', exact: true }).waitFor();
  assert.match(await header.innerText(), /Connect wallet/);
  assert.equal(await page.evaluate(() => localStorage.getItem('dmw-web-v1/wallets')), '{}');
});
