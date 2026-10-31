import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { secp256k1 } from '../../../kit/node_modules/@noble/curves/secp256k1.js';
import * as btc from '../../../kit/node_modules/@scure/btc-signer/esm/index.js';
import { fundingAddress } from '../../../kit/lib/inscription-core.mjs';
import { encodeTracAddress } from '../../../rules/src/trac-address.js';
import { signTapWalletMessage } from '../../../rules/test/tap-wallet-signing.mjs';
import { serve } from '../../../service/src/http.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { Inflight, revealText } from '../../../service/src/inflight.mjs';
import { provisioningFixture } from '../../../service/test/provisioning-fixture.mjs';
import { hash } from '../../../service/src/util.mjs';

const shots = process.env.CT1_SHOTS;
async function shoot(page, name) {
  if (!shots) return;
  for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/${name}-${suffix}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

// A loopback gateway with the real provisioner and routes. The compound's first maker has a bound TAP Wallet.
async function gateway(t) {
  const f = await provisioningFixture(t), commitment = 'e9'.repeat(32), asset = 'c2:' + commitment, maker = 'cd'.repeat(32), owner = encodeTracAddress(maker);
  const key = new Uint8Array(32).fill(33), publicKey = Buffer.from(secp256k1.getPublicKey(key)).toString('hex'), address = fundingAddress(publicKey, 'regtest');
  const other = new Uint8Array(32).fill(44);
  await f.store.put('meta', 'ruleState', { batchVersion: 2 });
  await f.store.put('compoundTypes', asset, { id: asset, commitment, v: 4, recipe: 'fusion', firstMaker: maker, inputs: [] });
  f.reads.inscription = async () => ({ address }); f.reads.bindings = { bitcoinNetwork: 'regtest', resolve: () => ({ request: { address } }) };
  f.reads.officialName = async name => f.store.get('officialCatalogNames', name.toLowerCase()) ?? null;
  const mempool = new Map(), posts = [];
  const inflight = new Inflight({ store: f.store, provisioner: f.operator, mints: {}, settings: { recheckMs: 1 },
    bitcoin: { transaction: async txid => mempool.get(txid) ?? null, confirmations: async () => null } });
  const server = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator }, inflight,
    bindings: { read: () => ({ binding: { request: { agent: owner, rail: 'tap', address } } }) },
    web: createWeb({ target: { network: 'dmw-regtest', bitcoinNetwork: 'regtest' }, plan: async () => ({}) }),
    publicAPI: { handles: path => /^\/(status|patterns|feed)(?:\?|$)/.test(path), read: async path => path.startsWith('/status') ? { tip: 100, counted: 100 } : { patterns: [], events: [], total: 0, next: null } } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  let signer = key;
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await c.newPage(), errors = [];
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') posts.push([new URL(request.url()).pathname, request.postData()]); });
  await page.route('https://mempool.space/**', route => route.fulfill({ contentType: 'application/json', body: '{"halfHourFee":2}' }));
  let funds = 0;
  await page.exposeFunction('testWallet', async (method, args) => {
    if (method === 'getCapabilities') return { version: '1.0.49', singleTxTransferExtraOutputs: true };
    if (['requestAccounts', 'getAccounts'].includes(method)) return [address];
    if (method === 'getNetwork') return 'regtest';
    if (method === 'getPublicKey') return publicKey;
    // TAP Wallet's signMessage: a legacy compact signature of the account key, whatever type is asked for.
    if (method === 'signMessage') return signTapWalletMessage(args[0], signer);
    if (method === 'getBitcoinUtxos') return [{ txid: hash('cardinal-' + funds), vout: 0, satoshi: 100000,
      scriptPk: Buffer.from(btc.p2tr(secp256k1.getPublicKey(key).slice(1)).script).toString('hex'), height: 90, inscriptions: [], isSpent: false, isUserSpendable: false }];
    if (method === 'signPsbt') { const tx = btc.Transaction.fromPSBT(Buffer.from(args[0], 'hex')); tx.sign(key); tx.finalize(); return Buffer.from(tx.toPSBT(0)).toString('hex'); }
    if (method === 'pushPsbt') { funds++; return btc.Transaction.fromPSBT(Buffer.from(args[0], 'hex')).id; }
    if (method === 'pushTx') { const tx = btc.Transaction.fromRaw(Buffer.from(args[0], 'hex'), { allowUnknownInputs: true }); mempool.set(tx.id, args[0]); return tx.id; }
    assert.fail('unexpected wallet operation ' + method);
  });
  await page.addInitScript(() => {
    globalThis.tapprotocol = Object.fromEntries(['getCapabilities', 'requestAccounts', 'getAccounts', 'getNetwork', 'getPublicKey', 'signMessage', 'getBitcoinUtxos', 'singleTxTransfer', 'signPsbt', 'pushPsbt', 'pushTx']
      .map(name => [name, (...args) => globalThis.testWallet(name, args)]));
  });
  return { f, asset, owner, server, mempool, posts, page, errors, useSigner: secret => { signer = secret; }, other, key };
}
const choices = posts => posts.filter(([path]) => path === '/mint/deployment-ticker').map(([, body]) => JSON.parse(body));

test('the first maker chooses and changes the compound ticker on its deploy page; the deploy inscribes that ticker', async t => {
  const g = await gateway(t), { f, asset, owner, server, page } = g;
  await page.goto(`${server.url}/mint/${asset}?owner=${owner}`);
  await page.getByText('Choose the ticker of its TAP token first.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Deploy token', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).count(), 0);
  const name = page.getByRole('textbox', { name: 'Ticker name' });
  // The same grammar words as deploying your own ticker, plus the official-ticker rule.
  await name.fill('dmt-moon');
  await page.getByText('This name cannot be a TAP ticker. Use 1 to 32 characters; it cannot start with “-” or “dmt-”.', { exact: true }).waitFor();
  await name.fill('ñandu');
  await page.getByText('A compound’s official ticker uses 3 to 32 lowercase letters a–z and digits 0–9.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Set ticker', exact: true }).isDisabled(), true);
  // Taken on TAP: refused by the gateway with the same words, under the field.
  f.index({ p: 'tap', op: 'token-deploy', tick: 'taken', prv: 'outsider' });
  await name.fill('taken');
  await page.getByText('“taken” looks free. Set ticker checks it on TAP and against pending requests.', { exact: true }).waitFor();
  await shoot(page, 'site-compound-ticker-choose');
  await page.getByRole('button', { name: 'Set ticker', exact: true }).click();
  await page.getByText('This ticker is already taken on TAP. Choose another name.', { exact: true }).waitFor();
  // A free name: the bound TAP Wallet signs the choice and the deploy is ready.
  await name.fill('nullspar');
  await page.getByText('“nullspar” looks free. Set ticker checks it on TAP and against pending requests.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Set ticker', exact: true }).click();
  await page.getByRole('button', { name: 'Deploy token', exact: true }).waitFor();
  const [, first] = choices(g.posts);
  assert.equal(first.ticker, 'nullspar'); assert.equal(first.revision, 1); assert.ok(first.walletSignature);
  let job = f.store.get('provisioning', asset);
  assert.equal(job.chosenTicker.tick, 'nullspar'); assert.equal(job.chosenTicker.by, 'wallet'); assert.equal(job.content.tick, 'nullspar');
  await page.locator('.kv').getByText('nullspar', { exact: true }).waitFor();
  await shoot(page, 'site-compound-ticker-chosen');

  // A changed choice signed by another key is refused by the gateway, not by the page.
  g.useSigner(g.other);
  await page.getByRole('textbox', { name: 'Ticker name' }).fill('fusion');
  await page.getByText('“fusion” looks free. Change ticker checks it on TAP and against pending requests.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Change ticker', exact: true }).click();
  await page.getByText('Only the compound’s first maker can set its ticker: sign with that agent or the TAP Wallet bound to it.', { exact: true }).waitFor();
  assert.equal(f.store.get('provisioning', asset).chosenTicker.tick, 'nullspar');
  g.useSigner(g.key);
  await page.getByRole('button', { name: 'Change ticker', exact: true }).click();
  await page.locator('.kv').getByText('fusion', { exact: true }).waitFor();
  job = f.store.get('provisioning', asset);
  assert.equal(job.tickerAttempt, 1); assert.equal(job.content.tick, 'fusion'); assert.equal(job.chosenTicker.revision, 2);

  // The deploy inscribes exactly the chosen ticker, and the in-flight check matches it.
  await page.getByRole('button', { name: 'Deploy token', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Inscribe', exact: true }).click();
  await page.getByRole('button', { name: 'Check now', exact: true }).waitFor();
  const sent = g.posts.filter(([path]) => path === '/mint/inflight').map(([, body]) => JSON.parse(body)).at(-1);
  assert.equal(sent.attempt, 1);
  assert.equal(revealText(g.mempool.get(sent.revealTxid)), f.store.get('provisioning', asset).inscriptionText);
  assert.equal(JSON.parse(revealText(g.mempool.get(sent.revealTxid))).tick, 'fusion');
  assert.equal(f.store.get('inflight', `deployment/${asset}/deployment`).revealTxid, sent.revealTxid);
  // Sent: the ticker form is gone.
  assert.equal(await page.getByRole('button', { name: 'Change ticker', exact: true }).count(), 0);
  // In a block: it registers under the chosen ticker.
  f.mine(); f.index(f.store.get('provisioning', asset).content, sent.inscriptionId); f.mine();
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await page.getByText('The token is deployed.', { exact: false }).first().waitFor();
  assert.equal((await f.reads.registry()).assets[asset].tick, 'fusion');
  await shoot(page, 'site-compound-ticker-deployed');
  assert.deepEqual(g.errors, []);
});
