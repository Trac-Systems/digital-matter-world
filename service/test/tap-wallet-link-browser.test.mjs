import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '../src/http.mjs';
import { createWeb } from '../src/web.mjs';
import { WebCheckout } from '../src/web-checkout.mjs';
import { Store } from '../src/store.mjs';
import { agent, temp } from './helpers.mjs';
import { testPayoutAddress } from './payout-wallets.mjs';
import { signTapWalletMessage } from '../../rules/test/tap-wallet-signing.mjs';
import { tapWallet1048 } from '../../kit/test/tap-wallet-1048-fixture.mjs';
import { rules } from '../src/rules.mjs';

// Source-contract browser test, no installed extension or chain transactions.
// Run while holding the shared browser lock, like the binding browser test.
test('fresh Link prepares, preserves its secret on cancellation, activates authority, and releases only a verified lock after reload', { timeout: 60000 }, async t => {
  const store = await Store.open(await temp('tap-link-page-')); t.after(() => store.close());
  const who = agent(85), payer = testPayoutAddress(who.secret.toString('hex'), 'tap', 'mainnet');
  const wallet = tapWallet1048({ address: payer, active: false });
  const config = { network: 'dmw-mainnet', mode: 'prod', prod: { ethereum: { chainId: '1' } } };
  const lockId = 'd4'.repeat(32) + 'i0:0'; let lockMessage, claimMessage, lockReads = 0, cancelSignature = true, failOrderRead = true;
  const reads = {
    counted: async () => 20, bitmap: async () => ({ agent: who.address, address: payer }), link: async () => null,
    linkLockPayment: async row => {
      lockReads++;
      if (lockReads === 1) throw Error('payment_unconfirmed');
      const split = rules.splitFee(rules.feeFor('link', row.terms.baseFee), { kind: 'link' });
      return { id: row.paymentId, requestId: row.id, kind: 'tap', payer, total: rules.feeFor('link', row.terms.baseFee),
        tick: 'tap', lockKind: 'htlc', conditionType: 'hashlock', hash: row.terms.hash, refund: payer, claim: row.terms.treasury,
        base: split.treasury, allocations: rules.tapPaymentAllocations(split, {}, 'link'), refundAfter: row.request.until + 144,
        consumed: !!claimMessage, confirmations: 1, verifiedHeight: 19, eventIndex: 0 };
    },
  };
  const checkout = new WebCheckout({ store, config, reads, post: async (_, body) => {
    const id = rules.linkId(config.network, body.request);
    await store.put('linkIntents', id, { id, request: body.request, sig: body.sig, terms: { payer, hash: body.paymentHash, baseFee: '1000000000000000000', treasury: payer } });
    return { id };
  } });
  const request = { owner: who.address, height: 5, nonce: '44'.repeat(32), until: 100 };
  const enrollment = await checkout.enrollLink({ request, sig: rules.signLink(config.network, request, who.secret), payer });
  const server = await serve({ intake: { store }, files: { serve: async () => false }, web: createWeb(checkout),
    publicAPI: { handles: () => true, read: () => ({}) }, links: { payment: async ({ id, paymentId }) => {
      assert.equal(paymentId, lockId); assert.ok(claimMessage);
      assert.equal(rules.hash(Buffer.from(claimMessage.actions[0].preimage, 'hex')), lockMessage.actions[0].condition.hash);
      await store.put('linkStatus', id, { state: 'accepted' }); return { id, state: 'accepted' };
    } } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), errors = [], prepareBodies = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.url().endsWith('/prepare')) prepareBodies.push(req.postDataJSON()); });
  wallet.provider.signMessage = async message => {
    if (cancelSignature) { cancelSignature = false; throw { code: 4001, message: 'User rejected the request.' }; }
    return signTapWalletMessage(message, who.secret);
  };
  wallet.provider.redeemTapActions = async (message, options) => {
    wallet.state.calls.push(['redeemTapActions', message, options]);
    assert.equal(message.auth, wallet.authId);
    if (message.actions[0].op === 'lock') {
      lockMessage = message;
      return { orderId: 'link-order', paymentTxid: wallet.funding, inscriptionId: '', pending: true };
    }
    assert.ok(lockReads >= 2, 'claim must follow verified lock, not order readiness');
    claimMessage = message;
    return { orderId: 'claim-order', paymentTxid: 'e5'.repeat(32), txid: 'f6'.repeat(32), inscriptionId: 'f6'.repeat(32) + 'i0', pending: false };
  };
  wallet.provider.getTapActionOrderResult = async orderId => {
    assert.equal(orderId, 'link-order');
    // 1.0.48's paidApi route can fail. The second read models a backend that
    // can resolve the ID; this does not claim a production bridge exists.
    if (failOrderRead) throw { code: -32603, message: 'Order not found' };
    return { orderId, txid: lockId.slice(0, 64), inscriptionId: lockId.split(':')[0], pending: false, status: 3 };
  };
  await page.exposeFunction('walletCall', async (method, args) => {
    try { return { value: await wallet.provider[method](...args) }; }
    catch (error) { return { error: { code: error.code, message: error.message } }; }
  });
  await page.addInitScript(methods => {
    window.tapprotocol = Object.fromEntries(methods.map(method => [method, async (...args) => {
      const response = await window.walletCall(method, args); if (response.error) throw response.error; return response.value;
    }]));
  }, Object.keys(wallet.provider));
  await page.goto(server.url + '/link/' + enrollment.id);
  const prepare = page.getByRole('button', { name: 'Prepare Bitmap payment with wallet' });
  await prepare.click(); await page.getByText(/Wallet request closed/).waitFor();
  const savedSecret = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage)[0])).linkSecret);
  assert.match(savedSecret, /^[0-9a-f]{64}$/);
  await page.reload(); await prepare.click(); await page.getByText(/Payment prepared/).waitFor();
  assert.deepEqual(Object.keys(prepareBodies[0]).sort(), ['paymentHash', 'walletSignature']);
  assert.doesNotMatch(JSON.stringify(prepareBodies), new RegExp(savedSecret));
  assert.equal(wallet.state.calls.length, 0, 'preparation does not pay');
  await page.getByRole('button', { name: 'Approve payment in wallet' }).click();
  await page.getByText(/could not read the saved inscription order/).waitFor();
  assert.equal(claimMessage, undefined);
  failOrderRead = false;
  await page.reload(); await page.getByRole('button', { name: 'Resume payment' }).click();
  await page.getByText('Confirmed: accepted.', { exact: true }).waitFor();
  assert.equal(claimMessage.actions[0].preimage, savedSecret);
  assert.equal(wallet.state.calls.filter(c => c[0] === 'createGlobalTapAuthority').length, 1);
  assert.equal(wallet.state.calls.filter(c => c[0] === 'sendInscription').length, 1);
  assert.deepEqual(wallet.state.calls.filter(c => c[0] === 'redeemTapActions').map(c => c[1].actions[0].op), ['lock', 'claim']);
  assert.deepEqual(errors, []);
});
