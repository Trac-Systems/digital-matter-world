import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { secp256k1 } from '../../../kit/node_modules/@noble/curves/secp256k1.js';
import * as btc from '../../../kit/node_modules/@scure/btc-signer/esm/index.js';
import { fundingAddress } from '../../../kit/lib/inscription-core.mjs';
import { encodeTracAddress } from '../../../rules/src/trac-address.js';
import { serve } from '../../../service/src/http.mjs';
import { createWeb } from '../../../service/src/web.mjs';
import { Inflight } from '../../../service/src/inflight.mjs';
import { provisioningFixture } from '../../../service/test/provisioning-fixture.mjs';
import { hash } from '../../../service/src/util.mjs';

const SENT = 'Inscription sent — waiting for Bitcoin confirmation';
const shots = process.env.DMW_SHOTS;
async function shoot(page, name) {
  if (!shots) return;
  for (const [suffix, width] of [['desktop', 1280], ['390', 390]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${shots}/${name}-${suffix}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

// A loopback gateway with the real provisioner, HTTP routes and in-flight checks; Bitcoin is the wallet's own pushes.
async function gateway(t) {
  const f = await provisioningFixture(t), asset = 'p2:1', id = 'ab'.repeat(32);
  // The pattern's discoverer deploys during its week, from its bound wallet.
  const owner = encodeTracAddress(f.pattern.discoverer), key = new Uint8Array(32).fill(33);
  const publicKey = Buffer.from(secp256k1.getPublicKey(key)).toString('hex'), address = fundingAddress(publicKey, 'regtest');
  await f.store.put('patternsByAsset', asset, { ...f.pattern, number: '1', name: 'dmwnullspar' });
  f.reads.inscription = async () => ({ address }); f.reads.bindings = { resolve: () => ({ request: { address } }) };
  const mempool = new Map(); let minted = null;
  const mintStatus = () => {
    const entry = f.store.get('provisioning', asset)?.entry;
    return { requestId: id, asset, amount: '1', block: '1', receiver: address, state: minted ? 'minted' : 'permit_issued',
      fees: [], missing: [], payable: false, payBy: { rail: 'tap' }, actualTicker: entry?.tick, deploymentId: entry?.id, inscription: minted ?? undefined,
      mintContent: { p: 'tap', op: 'dmt-mint', tick: entry?.tick, blk: '1', dep: entry?.id, dta: id, prv: { address } } };
  };
  const mints = { public: mintStatus, payment: async () => mintStatus() };
  const inflight = new Inflight({ store: f.store, provisioner: f.operator, mints, settings: { recheckMs: 1 },
    bitcoin: { transaction: async txid => mempool.get(txid) ?? null, confirmations: async () => null } });
  const posts = [];
  const server = await serve({ intake: { store: f.store }, files: { serve: async () => false }, operator: { provisioner: f.operator }, mints, inflight,
    bindings: { read: () => ({ binding: { request: { agent: owner, address } } }) },
    web: createWeb({ target: { network: 'dmw-regtest', bitcoinNetwork: 'regtest' }, plan: async () => ({ ...mintStatus(), owner, payer: address }) }),
    publicAPI: { handles: path => /^\/(status|patterns|feed)(?:\?|$)/.test(path), read: async path => path.startsWith('/status') ? { tip: 100, counted: 100 } : { patterns: [], events: [], total: 0, next: null } } });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  // A browser context is one origin's storage: A broadcasts with its wallet, B is someone else.
  const context = async ({ wallet = false } = {}) => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }), page = await c.newPage(), errors = [];
    page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') posts.push([new URL(request.url()).pathname, request.postData()]); });
    await page.route('https://mempool.space/**', route => route.fulfill({ contentType: 'application/json', body: '{"halfHourFee":2}' }));
    if (wallet) {
      let funds = 0;
      await page.exposeFunction('testWallet', async (method, args) => {
        if (method === 'getCapabilities') return { version: '1.0.49', singleTxTransferExtraOutputs: true };
        if (['requestAccounts', 'getAccounts'].includes(method)) return [address];
        if (method === 'getNetwork') return 'regtest';
        if (method === 'getPublicKey') return publicKey;
        if (method === 'getBitcoinUtxos') return [{ txid: hash('cardinal-' + funds), vout: 0, satoshi: 100000,
          scriptPk: Buffer.from(btc.p2tr(secp256k1.getPublicKey(key).slice(1)).script).toString('hex'), height: 90, inscriptions: [], isSpent: false, isUserSpendable: false }];
        if (method === 'signPsbt') { const tx = btc.Transaction.fromPSBT(Buffer.from(args[0], 'hex')); tx.sign(key); tx.finalize(); return Buffer.from(tx.toPSBT(0)).toString('hex'); }
        if (method === 'pushPsbt') { funds++; return btc.Transaction.fromPSBT(Buffer.from(args[0], 'hex')).id; }
        if (method === 'pushTx') { const tx = btc.Transaction.fromRaw(Buffer.from(args[0], 'hex'), { allowUnknownInputs: true }); mempool.set(tx.id, args[0]); return tx.id; }
        assert.fail('unexpected wallet operation ' + method);
      });
      await page.addInitScript(() => {
        globalThis.tapprotocol = Object.fromEntries(['getCapabilities', 'requestAccounts', 'getAccounts', 'getNetwork', 'getPublicKey', 'getBitcoinUtxos', 'singleTxTransfer', 'signPsbt', 'pushPsbt', 'pushTx']
          .map(name => [name, (...args) => globalThis.testWallet(name, args)]));
      });
    }
    return { page, errors };
  };
  return { f, asset, id, owner, server, mempool, posts, context, setMinted: value => { minted = value; } };
}
const inflightPosts = posts => posts.filter(([path]) => path === '/mint/inflight').map(([, body]) => JSON.parse(body));

test('a pattern inscription sent in one browser shows as in flight to a fresh browser, and an old receipt is reported again on load', async t => {
  const g = await gateway(t), { f, asset, owner, server } = g;
  const a = await g.context({ wallet: true }), b = await g.context();
  await a.page.goto(`${server.url}/mint/${asset}?owner=${owner}`);
  await a.page.getByRole('button', { name: 'Start', exact: true }).click();
  await a.page.getByRole('button', { name: 'Inscribe pattern', exact: true }).click();
  await a.page.getByRole('dialog').getByRole('button', { name: 'Inscribe', exact: true }).click();
  await a.page.getByRole('button', { name: 'Check now', exact: true }).waitFor();
  const [sent] = inflightPosts(g.posts);
  assert.equal(sent.kind, 'deployment'); assert.equal(sent.ref, asset); assert.equal(sent.phase, 'element'); assert.equal(sent.attempt, 0);
  assert.ok(g.mempool.has(sent.revealTxid)); assert.match(sent.commitTxid, /^[0-9a-f]{64}$/);
  const record = f.store.get('inflight', `deployment/${asset}/element`);
  assert.equal(record.revealTxid, sent.revealTxid);
  // The broadcaster keeps its own controls and sees the same words.
  await a.page.getByText(SENT, { exact: true }).waitFor();

  // Browser B never saw the broadcast: the gateway's record shows it, linked, and offers no second inscription.
  await b.page.goto(`${server.url}/mint/${asset}`);
  const note = b.page.locator('.callout.info').filter({ hasText: SENT });
  await note.waitFor();
  await note.getByText('Pattern inscription', { exact: false }).waitFor();
  assert.equal(await note.locator('a').first().getAttribute('href'), 'https://mempool.space/tx/' + sent.revealTxid);
  assert.equal(await b.page.getByRole('button', { name: 'Inscribe pattern', exact: true }).count(), 0);
  assert.equal(await b.page.getByRole('button', { name: 'Check now', exact: true }).count(), 0);
  await shoot(b.page, 'site-mint-asset-inflight');
  // The pattern's token status reads the same record.
  const token = await b.page.evaluate(async asset => (await import('/web/console/js/api.js')).site.token(asset), asset);
  assert.equal(token.step, 'inflight'); assert.equal(token.label, SENT); assert.equal(token.inflight.revealTxid, sent.revealTxid);

  // A broadcast made before this release: the gateway has no record, A's saved receipt reports it again on load.
  await f.store.put('inflight', `deployment/${asset}/element`, undefined);
  await b.page.reload();
  await b.page.getByRole('button', { name: 'Inscribe pattern', exact: true }).waitFor();
  const before = inflightPosts(g.posts).length;
  await a.page.reload();
  await a.page.getByRole('button', { name: 'Check now', exact: true }).waitFor();
  await assertEventually(() => f.store.get('inflight', `deployment/${asset}/element`)?.revealTxid === sent.revealTxid);
  assert.equal(inflightPosts(g.posts).length, before + 1);
  assert.equal(inflightPosts(g.posts).at(-1).revealTxid, sent.revealTxid);
  await b.page.reload();
  await b.page.locator('.callout.info').filter({ hasText: SENT }).waitFor();
  assert.equal(await b.page.getByRole('button', { name: 'Inscribe pattern', exact: true }).count(), 0);

  // The normal path: the element is indexed and registered; the in-flight note goes away and the next phase is offered.
  f.mine(); f.index(f.store.get('provisioning', asset).content, sent.inscriptionId);
  await a.page.getByRole('button', { name: 'Check now', exact: true }).click();
  await a.page.getByRole('button', { name: 'Deploy token', exact: true }).waitFor();
  await b.page.reload();
  await b.page.getByRole('button', { name: 'Deploy token', exact: true }).waitFor();
  assert.equal(await b.page.getByText(SENT, { exact: true }).count(), 0);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test('a mint inscription sent after its permit shows as in flight on the request page in another browser', async t => {
  const g = await gateway(t), { f, asset, id, server } = g;
  await f.complete(asset, { ...f.pattern, number: '1', name: 'dmwnullspar' });
  assert.equal(f.store.get('provisioning', asset).state, 'registered');
  const a = await g.context({ wallet: true }), b = await g.context();
  await a.page.goto(`${server.url}/mint/${id}`);
  await a.page.getByRole('button', { name: 'Inscribe mint', exact: true }).click();
  await a.page.getByRole('dialog').getByRole('button', { name: 'Inscribe', exact: true }).click();
  await a.page.locator('.callout.info').filter({ hasText: SENT }).waitFor();
  const sent = inflightPosts(g.posts).find(r => r.kind === 'mint');
  assert.equal(sent.ref, id); assert.equal(sent.phase, 'mint');
  assert.equal(f.store.get('inflight', `mint/${id}/mint`).revealTxid, sent.revealTxid);

  await b.page.goto(`${server.url}/mint/${id}`);
  const note = b.page.locator('.callout.info').filter({ hasText: SENT });
  await note.waitFor();
  await note.getByText('Mint', { exact: false }).first().waitFor();
  assert.equal(await note.locator('a').first().getAttribute('href'), 'https://mempool.space/tx/' + sent.revealTxid);
  assert.equal(await b.page.getByRole('button', { name: 'Inscribe mint', exact: true }).count(), 0);
  await shoot(b.page, 'site-mint-request-inflight');
  g.setMinted(sent.inscriptionId);
  await b.page.reload();
  await b.page.locator('.pill').filter({ hasText: /^Minted$/ }).waitFor();
  assert.equal(await b.page.getByText(SENT, { exact: true }).count(), 0);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

async function assertEventually(check, ms = 8000) {
  const until = Date.now() + ms;
  while (!await check()) { if (Date.now() > until) assert.fail('condition not reached'); await new Promise(resolve => setTimeout(resolve, 100)); }
}
