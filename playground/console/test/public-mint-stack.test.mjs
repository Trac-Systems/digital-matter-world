import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import * as btc from '../../../kit/node_modules/@scure/btc-signer/esm/index.js';
import { secp256k1 } from '../../../kit/node_modules/@noble/curves/secp256k1.js';
import * as r from '../../../rules/src/index.js';
import { v2StackFixture } from '../../../service/test/v2-stack-fixture.mjs';
import { firstMintStack } from '../../../service/test/first-mint-fixture.mjs';
import { Feeds } from '../../../service/src/feeds.mjs';
import { createPublicAPI } from '../../../service/src/public-api.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { buildInscription, signCommit } from '../../../kit/lib/inscription-core.mjs';
import { tapWallet1049 } from '../../../kit/test/tap-wallet-1049-fixture.mjs';

// The gateway, five HTTP signer policies, financial batches and notary are real
// local fixtures. Only the wallet extension and Bitcoin/TAP indexing are mocked.
test('a TAP-only browser deploys and mints a public block through the activated v2 stack', { timeout: 180000 }, async t => {
  await v2StackFixture(t, { finderWindow: 2, scenario: async s => {
    const { store, files, history, contract, network, document, drain, legacyRecord, players } = s;
    const asset = 'p2:0', ledger = 'p0', block = '201';
    await players[0].agent.submitOccurrences({ actionId: 'public-browser-block', patternKey: legacyRecord.key,
      anchor: { height: '1010', hash: history.hashAt(1010) }, matches: [{ height: block, hash: history.hashAt(block), count: '1' }] });
    await drain();
    const successor = r.settingsRevision({ network, previous: document,
      effectiveBatch: r.addUint((await contract.state().batchLast()).n, '2'), effectiveBitcoinWindow: '1012',
      values: { ...document.values, ...r.PUBLIC_MINT_SETTINGS, publicMintActivationHeight: '1013', publicMintLegacyFinderWindow: 2 } });
    assert.equal(await contract.run('ad_settings', { document: successor }), null);
    await s.advance(1011); assert.equal(await contract.run('ad_apply', { id: 'settings' }), null);
    await s.advance(1012); assert.equal(contract.db.get('v2/settings').revision, successor.revision);
    const feeds = new Feeds({ store, files, history, reads: {} });
    const project = async () => { for (let i = 0; store.count('feedEvents') && i < 100; i++) await feeds.events(); assert.equal(store.count('feedEvents'), 0); };
    await project();
    const f = await firstMintStack(t, { ...s, document: successor, httpOptions: ({ mints }) => ({
      web: createWeb({ target: { network, bitcoinNetwork: 'regtest', ethereum: { chainId: '0x7a69' } }, plan: () => assert.fail('public flow does not read an agent payment plan') }),
      publicAPI: createPublicAPI({ views: { store, mints, status: async () => ({ tip: s.tip, counted: store.get('meta', 'ruleState').counted }) } }),
      bindings: { wallets: () => ({ players: [], next: null }), read: () => assert.fail('public flow does not read an agent binding') },
    }) });
    const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
    const page = await browser.newPage(); page.setDefaultTimeout(15000);
    const errors = [], requests = [], pending = [];
    let signs = 0, funds = 0, payments = 0, checkoutId, minted;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() }));
    await page.route('https://mempool.space/**', route => route.fulfill({ contentType: 'application/json', body: '{"halfHourFee":2}' }));
    // No request can leave the local fixture, including accidental API redirects.
    await page.route('**/*', route => new URL(route.request().url()).origin === f.http.url || route.request().url().startsWith('https://mempool.space/')
      ? route.fallback() : route.abort());
    const extension = tapWallet1049({ address: f.receiver, publicKey: f.bitcoinPublic, network: 'regtest', active: true });
    const script = Buffer.from(btc.p2tr(secp256k1.getPublicKey(f.bitcoinSecret).slice(1)).script).toString('hex');
    await page.exposeFunction('testWallet', async (method, args) => {
      if (method === 'getBitcoinUtxos') return [{ txid: r.hash('browser-cardinal-' + funds), vout: 0, satoshi: 100000,
        scriptPk: script, height: 90, inscriptions: [], isSpent: false, isUserSpendable: false }];
      if (method === 'signPsbt') {
        signs++; assert.equal(args[1].inputForSigns[0].address, f.receiver);
        const tx = btc.Transaction.fromPSBT(Buffer.from(args[0], 'hex')); tx.sign(f.bitcoinSecret); tx.finalize(); return Buffer.from(tx.toPSBT(0)).toString('hex');
      }
      if (method === 'pushPsbt') { funds++; return btc.Transaction.fromPSBT(Buffer.from(args[0], 'hex')).id; }
      if (method === 'pushTx') {
        const tx = btc.Transaction.fromRaw(Buffer.from(args[0], 'hex'), { allowUnknownInputs: true });
        const job = store.get('provisioning', ledger);
        if (job.state !== 'registered') { pending.push({ id: tx.id + 'i0', text: job.content }); f.f.contents.set(tx.id + 'i0', job.content); }
        else {
          minted = tx.id + 'i0';
          const status = f.mints.public(checkoutId), source = contract.db.get('fi/source/' + checkoutId);
          f.mintedObservations.set(checkoutId, { accepted: true, fail: false, confirmations: 1, inscription: minted,
            deployment: source.deployment.id, tick: source.deployment.tick, receiver: f.receiver, amount: status.amount, block,
            dta: status.mintContent.dta, permitHash: status.mintContent.prv.hash, committee: f.publicKey });
        }
        return tx.id;
      }
      if (method === 'singleTxTransfer') {
        payments++; assert.equal(payments, 1);
        const status = f.mints.public(checkoutId); assert.deepEqual(args[0], r.walletFeeItems(status.fees, 'regtest'));
        const payload = { p: 'tap', op: 'token-auth', redeem: { items: args[0] } };
        const payment = buildInscription({ text: JSON.stringify(payload), receiver: f.receiver, publicKey: f.bitcoinPublic, network: 'regtest', feeRate: 1, maxFeeSats: '1000000',
          utxos: [{ txid: r.hash('browser-payment'), vout: 0, value: '10000000', script, confirmed: true, cardinal: true }] });
        const signed = signCommit(payment, f.bitcoinSecret), height = String((await s.stamp()).counted);
        f.transfers.set(payment.inscriptionId, status.fees.map(fee => ({ ins: payment.inscriptionId, fail: false, int: true, addr: f.receiver, taddr: fee.to, tick: fee.ticker, amt: fee.amount, dta: fee.dta })));
        f.f.contents.set(payment.inscriptionId, payload); f.f.canonical.set(payment.inscriptionId, Number(height));
        f.publicBlocks.set(height, [{ ...payment, revealHex: signed.revealHex }]);
        // TAP Wallet 1.0.48 returns the funding transaction, never a payment ID.
        return { txid: payment.commitTxid };
      }
      assert.equal(typeof extension.provider[method], 'function', method);
      return extension.provider[method](...args);
    });
    await page.addInitScript(names => {
      globalThis.tapprotocol = Object.fromEntries(names.map(name => [name, (...args) => globalThis.testWallet(name, args)]));
      globalThis.tapprotocol.on = () => {};
    }, Object.keys(extension.provider));
    await page.goto(f.http.url + '/mint');
    await page.getByText('Public minting opens soon. Blocks nobody has claimed yet will be listed here.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Mint', exact: true }).count(), 0);
    assert.equal(payments + signs, 0);
    await s.advance(1017); await s.runtime.intake.seal(); await drain(); await project();
    assert.equal(f.mints.publicMints.state(asset, block).state, 'public');
    const beforeAccounts = structuredClone([...contract.db].filter(([key]) => key.startsWith('ar/')));
    await page.reload();
    await page.locator('#mint').getByRole('button', { name: 'Mint', exact: true }).waitFor();
    await page.goto(f.http.url + '/mint?' + new URLSearchParams({ asset, block }));
    await page.getByRole('heading', { name: 'Florite from block 201' }).waitFor();
    await page.locator('#mint').getByRole('button', { name: 'Mint', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/mint/' + asset && url.searchParams.get('public') === '1');
    await page.getByRole('button', { name: 'Inscribe pattern', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Agent address' }).count(), 0);
    assert.equal(store.count('publicMintRequests'), 0);
    for (const [index, label] of ['Inscribe pattern', 'Deploy token'].entries()) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Inscribe', exact: true }).click();
      await page.getByRole('button', { name: 'Check now', exact: true }).waitFor();
      assert.equal(signs, index + 1);
      await page.reload();
      await page.getByRole('button', { name: 'Check now', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0);
      f.f.mine(); f.f.index(pending[index].text, pending[index].id);
      if (index === 1) f.f.deployments.get('dmt-' + pending[index].text.tick).max = '1000000';
      await page.getByRole('button', { name: 'Check now', exact: true }).click();
      await page.getByRole('button', { name: index ? 'Continue to payment' : 'Deploy token', exact: true }).waitFor();
    }
    assert.equal(store.get('provisioning', ledger).receiver, f.receiver);
    assert.equal(store.get('provisioning', ledger).state, 'registered');
    await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'registration is being confirmed' }).waitFor();
    assert.equal(store.count('publicMintRequests'), 0);
    await drain(); await f.mints.deploymentTick();
    await page.getByRole('button', { name: 'Continue to payment', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Continue to payment', exact: true }).click();
    await page.waitForURL(url => /^\/mint\/[0-9a-f]{64}$/.test(url.pathname));
    checkoutId = new URL(page.url()).pathname.slice(6);
    assert.equal(f.mints.public(checkoutId).payer, f.receiver);
    await page.getByRole('button', { name: 'Pay missing items', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pay from my wallet', exact: true }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Pay missing items' && b.disabled));
    assert.equal(payments, 1);
    await page.reload();
    await page.getByRole('button', { name: 'Pay missing items', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pay from my wallet', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'A payment was already requested' }).waitFor();
    assert.equal(payments, 1, 'reloading cannot duplicate a payment');
    f.f.mine(s.tip - (await f.f.reads.tip()).tip);
    for (let i = 0; i < 20 && f.mints.public(checkoutId).state !== 'permit_issued'; i++) { await f.mints.tick(); await drain(); }
    assert.equal(f.mints.public(checkoutId).state, 'permit_issued');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Inscribe mint', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Inscribe', exact: true }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Refresh' && b.disabled));
    assert.equal(signs, 3); assert.match(minted, /^[0-9a-f]{64}i0$/);
    await f.mints.tick(); await drain(); await f.mints.tick();
    assert.equal(f.mints.public(checkoutId).state, 'minted');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('main .pill').filter({ hasText: /^Minted$/ }).waitFor();
    assert.equal(contract.db.get('ao/' + checkoutId), undefined);
    assert.equal(contract.db.get('dc/' + checkoutId).state, 'minted');
    assert.deepEqual([...contract.db].filter(([key]) => key.startsWith('ar/')), beforeAccounts, 'no public units debit');
    assert.ok(requests.some(r => r.path === '/public-mints/p2:0/201'));
    assert.ok(requests.some(r => r.path === '/public-mints/quote' && r.body.tapAddress === f.receiver));
    assert.ok(!requests.some(r => r.path === '/mint/null' || r.path.startsWith('/mint/deployment/') || r.path.startsWith('/payout-bindings/') || r.path.startsWith('/web-api/mint/')));
    assert.deepEqual(errors, []);
  } });
});
