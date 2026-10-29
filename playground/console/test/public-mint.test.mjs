import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { secp256k1 } from '../../../kit/node_modules/@noble/curves/secp256k1.js';
import * as btc from '../../../kit/node_modules/@scure/btc-signer/esm/index.js';
import { fundingAddress } from '../../../kit/lib/inscription-core.mjs';
import { encodeTracAddress } from '../../../rules/src/trac-address.js';
import { serve } from '../../../service/src/http.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { provisioningFixture } from '../../../service/test/provisioning-fixture.mjs';
import { hash } from '../../../service/src/util.mjs';

for (const mode of ['asset', 'request']) test(`public ${mode} link resumes both confirmed deployment phases through TapWalletMint`, async t => {
  const f = await provisioningFixture(t), asset = mode === 'asset' ? 'p2:1' : 'p0', catalog = mode === 'asset' ? asset : 'p2:0';
  const owner = encodeTracAddress('11'.repeat(32)), id = 'ab'.repeat(32), key = new Uint8Array(32).fill(33);
  const publicKey = Buffer.from(secp256k1.getPublicKey(key)).toString('hex'), address = fundingAddress(publicKey, 'regtest');
  const legacy = { ...f.pattern, number: 0, name: 'dmwflorite' };
  await f.store.put('meta', 'patterns', [legacy]);
  await f.store.put('patternsByAsset', catalog, mode === 'asset' ? { ...f.pattern, number: '1', name: 'dmwnullspar' } :
    { ...legacy, number: '0', legacy: { asset, record: legacy } });
  f.reads.inscription = async () => ({ address });
  const pending = [], bindings = [], requests = [], errors = []; let signs = 0, funds = 0, minted;
  const mintStatus = () => {
    const entry = f.store.get('provisioning', asset)?.entry;
    return { requestId: id, asset, amount: '1', block: '1', receiver: address, state: minted ? 'minted' : 'permit_issued',
      fees: [], missing: [], payable: false, payBy: { rail: 'tap' }, actualTicker: entry?.tick, deploymentId: entry?.id, inscription: minted,
      mintContent: { p: 'tap', op: 'dmt-mint', tick: entry?.tick, blk: '1', dep: entry?.id, dta: id, prv: { address } } };
  };
  const server = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator },
    mints: { public: mintStatus, payment: async input => { minted = input.inscription; return mintStatus(); } },
    bindings: { read: path => { bindings.push(path); return { binding: { request: { agent: owner, address } } }; } },
    web: createWeb({ target: { network: 'dmw-regtest', bitcoinNetwork: 'regtest' }, plan: async () => ({ ...mintStatus(), owner, payer: address }) }),
    publicAPI: { handles: path => /^\/(status|patterns|feed)(?:\?|$)/.test(path), read: async path => path.startsWith('/status') ? { tip: 100, counted: 100 } : path.startsWith('/patterns') ? { patterns: [], total: 0, next: null } : { events: [], total: 0, next: null } } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push([new URL(request.url()).pathname, request.method()]));
  await page.route('https://mempool.space/**', route => route.fulfill({ contentType: 'application/json', body: '{"halfHourFee":2}' }));
  await page.exposeFunction('testWallet', async (method, args) => {
    if (['requestAccounts', 'getAccounts'].includes(method)) return [address];
    if (method === 'getNetwork') return 'regtest';
    if (method === 'getPublicKey') return publicKey;
    if (method === 'getBitcoinUtxos') return [{ txid: hash('browser-cardinal-' + funds), vout: 0, satoshi: 100000,
      scriptPk: Buffer.from(btc.p2tr(secp256k1.getPublicKey(key).slice(1)).script).toString('hex'), height: 90, inscriptions: [], isSpent: false, isUserSpendable: false }];
    if (method === 'signPsbt') {
      signs++;
      assert.equal(args[1].inputForSigns[0].address, address);
      const tx = btc.Transaction.fromPSBT(Buffer.from(args[0], 'hex')); tx.sign(key); tx.finalize(); return Buffer.from(tx.toPSBT(0)).toString('hex');
    }
    if (method === 'pushPsbt') { funds++; return btc.Transaction.fromPSBT(Buffer.from(args[0], 'hex')).id; }
    if (method === 'pushTx') {
      const tx = btc.Transaction.fromRaw(Buffer.from(args[0], 'hex'), { allowUnknownInputs: true });
      const job = f.store.get('provisioning', asset);
      if (job.state !== 'registered') { pending.push({ id: tx.id + 'i0', text: job.content }); f.contents.set(tx.id + 'i0', job.content); }
      return tx.id;
    }
    assert.fail('unexpected wallet operation ' + method);
  });
  await page.addInitScript(() => {
    globalThis.tapprotocol = Object.fromEntries(['requestAccounts', 'getAccounts', 'getNetwork', 'getPublicKey', 'getBitcoinUtxos', 'singleTxTransfer', 'signPsbt', 'pushPsbt', 'pushTx']
      .map(name => [name, (...args) => globalThis.testWallet(name, args)]));
  });
  const path = mode === 'asset' ? `/mint/${catalog}?owner=${owner}` : `/mint/${id}?owner=${encodeTracAddress('22'.repeat(32))}`;
  await page.goto(server.url + path);
  await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0);
  assert.ok(requests.some(([path]) => path.startsWith('/mint/deployment-state/')));
  assert.ok(!requests.some(([path]) => path.startsWith('/mint/deployment/')), 'load does not call the mutating GET');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  for (const [index, label] of ['Inscribe pattern', 'Deploy token'].entries()) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Inscribe', exact: true }).click();
    await page.getByRole('button', { name: 'Check now', exact: true }).waitFor();
    assert.equal(signs, index + 1);
    assert.equal(await page.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0);
    await page.reload();
    await page.getByRole('button', { name: 'Check now', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0, 'saved receipt prevents a second inscription');
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /confirm|included|block/i }).first().waitFor();
    assert.equal(f.store.get('provisioning', asset).state, 'awaiting_player_deploy');
    f.mine(); f.index(pending[index].text, pending[index].id);
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    if (index === 0) await page.getByRole('button', { name: 'Deploy token', exact: true }).waitFor();
    else if (mode === 'request') await page.getByRole('button', { name: 'Inscribe mint', exact: true }).waitFor();
    else await page.getByText('The token is deployed. Ask your agent to mint now, then open the payment link it gives you.', { exact: true }).waitFor();
  }
  assert.equal(f.store.get('provisioning', asset).state, 'registered');
  assert.deepEqual(bindings, [`/payout-bindings/${owner}/tap`, `/payout-bindings/${owner}/tap`]);
  if (mode === 'request') {
    await page.getByRole('button', { name: 'Inscribe mint', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Inscribe', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('main').textContent.includes('minted'));
    assert.equal(signs, 3); assert.match(minted, /^[0-9a-f]{64}i0$/);
  } else await page.getByText('The token is deployed. Ask your agent to mint now, then open the payment link it gives you.', { exact: true }).waitFor();
  assert.ok(!requests.some(([path]) => path.startsWith('/mint/deployment/')));
  assert.deepEqual(errors, []);
});

test('public deployment rechecks eligibility before opening the wallet and reports a lost race', async t => {
  const f = await provisioningFixture(t), asset = 'p2:1', address = fundingAddress(Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(33))).toString('hex'), 'regtest');
  await f.store.put('patternsByAsset', asset, { ...f.pattern, number: '1' });
  await f.operator.request(asset); await f.operator.work.drain();
  let lost = false, quotes = 0, connects = 0;
  const server = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator },
    mints: { document: { values: { moveBytes: 8192 } }, publicMints: { quote: async input => {
      quotes++; assert.deepEqual(input, { asset, block: '201', tapAddress: address });
      if (lost) throw Object.assign(Error('someone_paid_first'), { status: 409 });
      return { ...input, receiver: address, publicMint: true, kind: 'tap', state: 'deployment_needed', requestId: null, payable: false };
    } } },
    web: createWeb({ target: { network: 'dmw-regtest', bitcoinNetwork: 'regtest' } }),
    publicAPI: { handles: path => /^\/(status|patterns|feed)(?:\?|$)/.test(path), read: async () => ({ patterns: [], events: [], next: null }) } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  await page.exposeFunction('testConnect', () => { connects++; return [address]; });
  await page.addInitScript(() => { globalThis.tapprotocol = { requestAccounts: () => globalThis.testConnect() }; });
  await page.goto(server.url + '/mint/' + asset + '?' + new URLSearchParams({ public: '1', block: '201', tapAddress: address }));
  await page.getByRole('button', { name: 'Inscribe pattern', exact: true }).waitFor();
  const before = quotes; lost = true;
  await page.getByRole('button', { name: 'Inscribe pattern', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Someone else’s payment for this block confirmed first' }).waitFor();
  assert.ok(quotes > before); assert.equal(connects, 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Agent address' }).count(), 0);
});
