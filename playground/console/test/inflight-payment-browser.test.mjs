import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { schnorr } from '../../../kit/node_modules/@noble/curves/secp256k1.js';
import * as btc from '../../../kit/node_modules/@scure/btc-signer/esm/index.js';
import { buildInscription, fundingAddress, hex } from '../../../kit/lib/inscription-core.mjs';
import { tapWallet1049 } from '../../../kit/test/tap-wallet-1049-fixture.mjs';
import { walletFundsReply } from '../../../kit/test/wallet-funds-fixture.mjs';
import { serve } from '../../../service/src/http.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { WebCheckout } from '../../../service/src/web-checkout.mjs';
import { Inflight } from '../../../service/src/inflight.mjs';
import { Store } from '../../../service/src/store.mjs';
import { rules } from '../../../service/src/rules.mjs';
import { temp } from '../../../service/test/helpers.mjs';

const SENT = 'Payment sent — waiting for Bitcoin confirmation';
const shots = process.env.IF2_SHOTS;
async function shoot(page, name) {
  if (!shots) return;
  for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/${name}-${suffix}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
// The redeem TAP Wallet inscribes for a one-transaction transfer: its commit funds a script-path reveal.
function redeemReveal(items) {
  const key = schnorr.utils.randomPrivateKey(), publicKey = hex(schnorr.getPublicKey(key)), address = fundingAddress(publicKey, 'regtest');
  const script = hex(btc.OutScript.encode(btc.Address({ ...btc.TEST_NETWORK, bech32: 'bcrt' }).decode(address)));
  const text = JSON.stringify({ p: 'tap', op: 'token-auth', redeem: { items, auth: 'a1'.repeat(32) + 'i0', data: '' }, sig: { v: '1', r: '1', s: '1' }, hash: '00', salt: '1' });
  return buildInscription({ text, receiver: address, publicKey, network: 'regtest', feeRate: 2, maxFeeSats: '100000',
    utxos: [{ txid: 'ab'.repeat(32), vout: 0, value: '100000', script, confirmed: true, cardinal: true }] });
}
const token = '0x' + '7a'.repeat(20), escrow = '0x' + '8b'.repeat(20), ethPayer = '0x' + '9c'.repeat(20);

// A loopback gateway on mainnet terms: the real web checkout, HTTP routes and in-flight checks; Bitcoin is a map of the
// reveals the wallet sent, and mempool.space answers the page's point reads by txid.
async function gateway(t) {
  const store = await Store.open(await temp('inflight-payment-')); t.after(() => store.close());
  const key = schnorr.utils.randomPrivateKey(), publicKey = hex(schnorr.getPublicKey(key)), payer = fundingAddress(publicKey, 'mainnet');
  const link = 'b7'.repeat(32), free = 'b8'.repeat(32), mint = 'c9'.repeat(32);
  const linkFees = rules.mintFeeItems({ treasury: '10', burn: '2' }, { treasury: 'bc1ptreasury' }, link, payer, 'tap', 'mainnet');
  const mintFees = rules.mintFeeItems({ treasury: '30' }, { treasury: 'bc1ptreasury' }, mint, payer, 'tap', 'mainnet');
  const state = { link: 'awaiting_payment', paid: ['0', '0'], mint: 'awaiting_payment' };
  const linkStatus = (id, price, fees) => ({ id, requestId: id, financialVersion: 2, state: state.link, payer, receiver: payer, block: '42', price, ...(price === '0' ? { fee: 'Free' } : {}),
    fees, fullFees: fees, missing: state.link === 'paid' ? [] : fees, unit: rules.TAP_UNIT, payable: state.link === 'awaiting_payment', payBy: { rail: 'tap', untilBlock: '532' }, blocked: [],
    funding: { state: 'open', paid: price === '0' ? [] : state.paid, root: '00' } });
  const links = { financialVersion: 2, public: async id => id === free ? linkStatus(free, '0', []) : linkStatus(link, '12', linkFees),
    payment: async () => { throw Object.assign(Error('payment_unconfirmed'), { status: 409 }); } };
  const mintStatus = () => ({ requestId: mint, id: mint, asset: 'p2:1', amount: '1', block: '12', receiver: payer, payer, state: state.mint, kind: 'tap', price: '30',
    fees: mintFees, fullFees: mintFees, missing: mintFees, payable: true, payBy: { rail: 'tap', untilBlock: 500 }, payment: [], blocked: [], unit: rules.TAP_UNIT });
  const mints = { public: mintStatus, payment: async () => { throw Object.assign(Error('payment_unseen'), { status: 409 }); } };
  await store.put('financialLinks', link, { id: link }); await store.put('financialLinks', free, { id: free });
  const bitcoin = new Map();
  const inflight = new Inflight({ store, mints, links, settings: { recheckMs: 1 }, bitcoin: { transaction: async txid => bitcoin.get(txid) ?? null, confirmations: async () => null } });
  const checkout = new WebCheckout({ store, links, mints, inflight, reads: { counted: async () => '100' },
    config: { network: 'dmw-mainnet', mode: 'prod', prod: { ethereum: { chainId: '1', token, address: escrow } } } });
  const results = { unit: rules.TAP_UNIT, mints: [], payments: [], payouts: [], owed: [], paid: [], links: [], treasury: {}, burn: {},
    ethereum: [{ id: mint, requestId: mint, payer: ethPayer, deposit: { status: 1, amount: '5', payer: ethPayer, split: {} }, confirmations: 3 }] };
  // The mint's pattern token is deployed already.
  const operator = { provisioner: { state: async asset => ({ asset, state: 'registered', entry: { id: 'd1'.repeat(32) + 'i0', tick: 'dmwnullspar' } }) } };
  const server = await serve({ intake: { store }, files: { serve: async () => false }, links, mints, inflight, operator, web: createWeb(checkout),
    publicAPI: { handles: path => /^\/(status|patterns|feed|results)(?:[/?]|$)/.test(path), read: async path => path.startsWith('/status') ? { tip: 100, counted: 100 } : path.startsWith('/results') ? results : { patterns: [], events: [], total: 0, next: null } } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const posts = [], spends = new Map();
  const context = async ({ wallet = false } = {}) => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await c.newPage(), errors = [];
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') posts.push([new URL(request.url()).pathname, request.postData()]); });
    // Point reads by txid: the receipt's funding transaction and the reveal that spends its output 0.
    await page.route('https://mempool.space/**', route => {
      const path = new URL(route.request().url()).pathname, m = /^\/api\/tx\/([0-9a-f]{64})(\/outspend\/0)?$/.exec(path);
      if (m && spends.has(m[1])) return route.fulfill({ json: m[2] ? { spent: true, txid: spends.get(m[1]) } : { txid: m[1], vin: [{ witness: ['00'] }] } });
      const value = walletFundsReply(route.request().url()); return value ? route.fulfill({ json: value }) : route.fulfill({ status: 404, body: '' });
    });
    await page.route('https://reader.tapscope.io/**', route => route.fulfill({ json: walletFundsReply(route.request().url()) }));
    if (wallet) {
      const w = tapWallet1049({ address: payer, publicKey, active: true });
      // TAP Wallet broadcasts the commit and the redeem reveal and answers with the commit (its funding) txid.
      w.provider.singleTxTransfer = async items => {
        const plan = redeemReveal(items); bitcoin.set(plan.revealTxid, plan.revealHex); spends.set(plan.commitTxid, plan.revealTxid);
        w.state.calls.push(['singleTxTransfer', items, plan]); return { txid: plan.commitTxid };
      };
      await page.exposeFunction('walletCall', async (method, args) => {
        try { return { value: await w.provider[method](...args) }; } catch (error) { return { error: { code: error.code, message: error.message } }; }
      });
      await page.addInitScript(methods => {
        window.tapprotocol = Object.fromEntries(methods.map(method => [method, async (...args) => {
          const response = await window.walletCall(method, args); if (response.error) throw response.error; return response.value;
        }]));
      }, Object.keys(w.provider));
      return { page, errors, wallet: w };
    }
    return { page, errors };
  };
  return { store, server, link, free, mint, state, posts, context, bitcoin };
}
const inflightPosts = posts => posts.filter(([path]) => path === '/mint/inflight').map(([, body]) => JSON.parse(body));
async function eventually(check, ms = 8000) {
  const until = Date.now() + ms;
  while (!await check()) { if (Date.now() > until) assert.fail('condition not reached'); await new Promise(resolve => setTimeout(resolve, 100)); }
}

test('a Bitmap link payment sent in one browser shows as waiting for Bitcoin in a fresh browser, until it is counted; free links have none', { timeout: 120000 }, async t => {
  const g = await gateway(t), { store, server, link } = g;
  const a = await g.context({ wallet: true }), b = await g.context();
  await a.page.goto(`${server.url}/link/${link}`);
  await a.page.getByRole('button', { name: 'Approve payment in wallet' }).click();
  await a.page.locator('.callout.info').filter({ hasText: SENT }).waitFor();
  const [sent] = inflightPosts(g.posts), [, , plan] = a.wallet.state.calls.find(c => c[0] === 'singleTxTransfer');
  assert.deepEqual(sent, { kind: 'link', ref: link, phase: 'payment', attempt: 0, commitTxid: plan.commitTxid, revealTxid: plan.revealTxid, inscriptionId: plan.revealTxid + 'i0' });
  assert.equal(store.get('inflight', `link/${link}/payment`).revealTxid, plan.revealTxid);
  // The not-yet-confirmed payment is not an error for the sender.
  assert.equal(await a.page.locator('.callout.bad').count(), 0);

  // Browser B never saw the payment: the gateway's record shows it with the transaction linked, and no Pay button.
  await b.page.goto(`${server.url}/link/${link}`);
  const note = b.page.locator('.callout.info').filter({ hasText: SENT });
  await note.waitFor();
  await note.getByText('TAP fee payment', { exact: false }).waitFor();
  assert.equal(await note.locator('a').first().getAttribute('href'), 'https://mempool.space/tx/' + plan.revealTxid);
  assert.equal(await b.page.getByRole('button', { name: 'Approve payment in wallet' }).count(), 0);
  assert.equal(await b.page.locator('.kv').getByText('Payment sent', { exact: true }).count(), 1);
  // Explorer references on mainnet: the payment contracts open on Etherscan.
  assert.equal(await b.page.locator(`a[href="https://etherscan.io/address/${token}"]`).count(), 1);
  assert.equal(await b.page.locator(`a[href="https://etherscan.io/address/${escrow}"]`).count(), 1);
  await shoot(b.page, 'site-link-payment-inflight');

  // A payment sent before this release: the gateway has no record, A's saved receipt reports it again on load.
  await store.put('inflight', `link/${link}/payment`, undefined);
  await b.page.reload();
  await b.page.getByRole('button', { name: 'Approve payment in wallet' }).waitFor();
  const before = inflightPosts(g.posts).length;
  await a.page.reload();
  await eventually(() => store.get('inflight', `link/${link}/payment`)?.revealTxid === plan.revealTxid);
  assert.equal(inflightPosts(g.posts).length, before + 1);
  await b.page.reload();
  await b.page.locator('.callout.info').filter({ hasText: SENT }).waitFor();

  // Counted: the request's funding moves and the note disappears for everyone.
  g.state.paid = ['10', '2']; g.state.link = 'paid';
  await b.page.reload();
  await b.page.getByText(/Request state: paid/).waitFor();
  assert.equal(await b.page.getByText(SENT, { exact: true }).count(), 0);

  // A free link (fee 0, from block 973996) has no payment, so nothing is in flight and nothing is reported.
  const reports = inflightPosts(g.posts).length;
  await a.page.goto(`${server.url}/link/${g.free}`);
  await a.page.getByText('No payment required', { exact: true }).waitFor();
  await a.page.waitForTimeout(500);
  assert.equal(await a.page.getByText(SENT, { exact: true }).count(), 0);
  assert.equal(inflightPosts(g.posts).length, reports);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test('a mint fee payment sent with Pay shows on the request page in another browser; Ethereum values link to Etherscan on mainnet only', { timeout: 120000 }, async t => {
  const g = await gateway(t), { store, server, mint } = g;
  const a = await g.context({ wallet: true }), b = await g.context();
  await a.page.goto(`${server.url}/mint/${mint}`);
  await a.page.getByRole('button', { name: 'Pay missing items', exact: true }).click();
  await a.page.getByRole('dialog').getByRole('button', { name: 'Pay from my wallet', exact: true }).click();
  await eventually(() => store.get('inflight', `mint/${mint}/payment`));
  const sent = inflightPosts(g.posts).find(r => r.kind === 'mint'), [, , plan] = a.wallet.state.calls.find(c => c[0] === 'singleTxTransfer');
  assert.deepEqual(sent, { kind: 'mint', ref: mint, phase: 'payment', attempt: 0, revealTxid: plan.revealTxid, inscriptionId: plan.revealTxid + 'i0' });
  await a.page.locator('.callout.info').filter({ hasText: SENT }).waitFor();

  await b.page.goto(`${server.url}/mint/${mint}`);
  const note = b.page.locator('.callout.info').filter({ hasText: SENT });
  await note.waitFor();
  assert.equal(await note.locator('a').first().getAttribute('href'), 'https://mempool.space/tx/' + plan.revealTxid);
  assert.equal(await b.page.getByRole('button', { name: 'Pay missing items', exact: true }).count(), 0);
  await shoot(b.page, 'site-mint-payment-inflight');
  g.state.mint = 'paid';
  await b.page.reload();
  await b.page.getByText('Payment confirmed', { exact: true }).first().waitFor();
  assert.equal(await b.page.getByText(SENT, { exact: true }).count(), 0);

  // The escrow ledger's payer opens on Etherscan; on a test chain the same value stays a copy chip.
  await b.page.goto(`${server.url}/results/ethereum`);
  await b.page.locator(`a[href="https://etherscan.io/address/${ethPayer}"]`).waitFor();
  await shoot(b.page, 'site-results-ethereum');
  const hrefs = await b.page.evaluate(async ([address, tx]) => {
    const words = await import('/web/console/js/words.js');
    return [words.ethereumHref(tx, { chainId: '0x1' }), words.ethereumHref(address, { chainId: '0x7a69' }), words.ethereumHref(address, { chainId: 1 }),
      words.ethereumHref('0x12', { chainId: '0x1' }), words.txLink('ethereum', tx).getAttribute('href')];
  }, [ethPayer, '0x' + 'ef'.repeat(32)]);
  assert.deepEqual(hrefs, ['https://etherscan.io/tx/0x' + 'ef'.repeat(32), null, 'https://etherscan.io/address/' + ethPayer, null, 'https://etherscan.io/tx/0x' + 'ef'.repeat(32)]);
  assert.deepEqual([...a.errors, ...b.errors], []);
});
