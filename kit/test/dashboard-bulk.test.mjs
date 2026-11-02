import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hex } from '../lib/inscription-core.mjs';
import { tapWallet1049 } from './tap-wallet-1049-fixture.mjs';
import { walletFundsReply } from './wallet-funds-fixture.mjs';
import { ed25519 } from '@noble/curves/ed25519';
import fixture from '../../rules/test/fixtures/bulk-v1.json' with { type: 'json' };
import { hashObject, stableJSON } from '../../rules/src/core.js';
import { bulkOrderId, bulkMemberId, bulkMembersRoot, bulkFeeRoot } from '../../rules/src/bulk-mint.js';
import { reserveNonceDigest } from '../../contract/root-accounts.js';
import { DashboardState } from '../lib/dashboard-state.mjs';
import { serveDashboard } from '../lib/dashboard.mjs';
import { ServiceClient } from '../lib/service-client.mjs';
import { dashboardFixture } from './fixtures/dashboard-service.mjs';
import { bitcoinAddress, cleanup } from './helpers.mjs';

// Fee per block in TAP atoms; the site page tests use a realistic one.
let memberFee = 100n;
function prepared(f, input, count = input.blocks.length) {
  const terms = structuredClone(fixture.terms), feeManifest = [];
  Object.assign(terms, { network: f.agent.network, bitcoinNetwork: 'regtest', owner: input.owner, nonce: input.nonce, asset: input.asset,
    deployment: input.deployment, receiver: input.receiver, payer: input.payer });
  terms.members = input.blocks.slice(0, count).map(block => ({ block, amount: '3' }));
  terms.totalAmount = String(3 * count); terms.membersRoot = bulkMembersRoot(terms.members);
  for (let i = 0; i < count; i++) {
    const row = { ...structuredClone(fixture.feeManifest[0]), member: i, grossFeeAtoms: String(memberFee) };
    row.shares = row.shares.map(share => ({ ...share, gross: String(memberFee), payable: String(memberFee) })); feeManifest.push(row);
  }
  terms.feeRoot = bulkFeeRoot(feeManifest); terms.groups[0].to = bitcoinAddress();
  terms.groups[0].amount = terms.grossFeeAtoms = terms.payableFeeAtoms = String(memberFee * BigInt(count));
  Object.assign(terms.mintFunding, { address: bitcoinAddress('regtest', 2), satoshis: count * 546 + 6546 + Number(terms.mintFunding.maxFeeSats) });
  terms.feeQuote.network = terms.network; terms.feeQuote.deploymentId = terms.deployment;
  terms.feeQuote.scope = stableJSON(['mint-bulk-v1', terms.asset, terms.deployment, terms.membersRoot]);
  return { v: 1, orderId: bulkOrderId(terms.network, terms.owner, terms.nonce), quoteId: hashObject(terms), terms, feeManifest, skipped: [],
    deferred: input.blocks.slice(count).map(block => ({ block, reason: 'bulk_funding_limit' })), payable: false };
}
async function setup(t, count = 5) {
  const f = await dashboardFixture(t), quotes = [], packets = [], records = new Map(), reports = [], deployment = fixture.terms.deployment;
  const options = { prefix: 64, failRequest: false, failQuote: false };
  let origin;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin); let raw = ''; for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : null;
      const send = (value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      if (url.pathname === '/mint/bulk/quote') {
        quotes.push(body); if (options.failQuote) return send({ error: 'bulk_source_unavailable' }, 503); return send(prepared(f, body, Math.min(body.blocks.length, options.prefix)));
      }
      if (url.pathname === '/mint/bulk/request') {
        packets.push(body); const { sig, ...action } = body.reserve;
        assert.equal(ed25519.verify(sig, reserveNonceDigest(f.agent.network, action), f.agent.owner), true);
        const id = bulkOrderId(body.terms.network, body.terms.owner, body.terms.nonce), n = body.terms.members.length;
        records.set(id, records.get(id) ?? { body, status: { v: 1, orderId: id, termsHash: hashObject(body.terms), state: 'awaiting_payment', payable: true,
          ...Object.fromEntries(['asset', 'deployment', 'ticker', 'receiver', 'payer', 'totalAmount', 'grossFeeAtoms', 'payableFeeAtoms'].map(k => [k, body.terms[k]])),
          count: n, payBy: { rail: 'tap', untilBlock: body.terms.expires }, payment: { reference: null, state: 'unseen', missingGroups: [0] },
          progress: { reserved: n, issued: 0, minted: 0, released: 0, unresolved: n }, permit: { root: null, readyCount: 0, complete: false },
          mintSender: { state: 'waiting_funding', sentBatches: 0, totalBatches: Math.ceil(n / 16) }, creditReferences: [], reason: null } });
        if (options.failRequest) return send({ error: 'offline' }, 503);
        return send(records.get(id).status, 202);
      }
      if (url.pathname === '/mint/bulk/payment') { reports.push(body); return send(records.get(body.orderId).status, 202); }
      const match = /^\/mint\/bulk\/([0-9a-f]{64})(?:\/(terms|members|permit))?$/.exec(url.pathname);
      if (match && records.has(match[1])) {
        const row = records.get(match[1]), { terms, feeManifest } = row.body;
        if (!match[2]) return send(row.status);
        if (match[2] === 'terms') return send({ v: 1, orderId: match[1], terms, feeManifest });
        if (match[2] === 'members') {
          const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
          return send({ v: 1, orderId: match[1], offset, next: offset + limit < terms.members.length ? offset + limit : null, count: terms.members.length,
            members: terms.members.slice(offset, offset + limit).map((m, index) => ({ ...m, index: offset + index, memberId: bulkMemberId(match[1], offset + index), state: 'reserved', inscription: null, reason: null })) });
        }
        return send({ v: 1, orderId: match[1], readyCount: 0, complete: false, members: [], offset: 0, next: null });
      }
      send({ error: 'not_found' }, 404);
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  cleanup(t, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const service = new ServiceClient({ origin, network: f.agent.network, busyRetries: 0 });
  for (const name of ['bulkMintQuote', 'requestBulkMint', 'bulkMintStatus', 'bulkMintTerms', 'bulkMintMembers', 'bulkMintPermit', 'reportBulkPayment']) f.service[name] = service[name].bind(service);
  const slots = Array.from({ length: count }, (_, i) => ({ asset: 'p2:1', deployment, block: String(900000 + i), canMint: true, count: '3', balance: '10000', balanceCurrent: true, state: 'unminted' }));
  f.context.candidates = async (asset, { block }) => [{ deployment, find: { asset, block, count: '3' } }];
  const configure = state => {
    state.payout = async () => f.binding.request.address;
    state.claims = async ({ cursor, limit = 50 }) => {
      const offset = Number(cursor ?? 0); return { claims: slots.slice(offset, offset + limit), next: offset + limit < slots.length ? String(offset + limit) : null };
    }; return state;
  };
  const state = configure(new DashboardState(f.context)); cleanup(t, () => state.close());
  return { ...f, quotes, packets, records, reports, options, state, slots, configure };
}
async function login(t, f) {
  const dashboard = await serveDashboard(f.context, { state: f.state }); cleanup(t, () => dashboard.close());
  const token = new URL(dashboard.loginLink).hash.slice(1), response = await fetch(dashboard.origin + '/login', { method: 'POST', headers: { origin: dashboard.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const call = (path, body) => fetch(dashboard.origin + path, { headers: { cookie, origin: dashboard.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { dashboard, call };
}

test('bulk dashboard paginates claims, groups up to 64 and waits at four live orders; issued unresolved slots stay occupied', async t => {
  const f = await setup(t, 320); f.state.bulkLiveOrders = 4; f.state.mintAll(); await f.state.batchTask;
  assert.equal(f.packets.length, 4); assert.deepEqual(f.packets.map(p => p.terms.members.length), [64, 64, 64, 64]);
  assert.equal(f.state.batch.state, 'waiting_slots');
  for (const row of f.records.values()) Object.assign(row.status, { state: 'permit_issued', payable: false, progress: { reserved: 0, issued: 64, minted: 0, released: 0, unresolved: 64 } });
  f.state.resumeBulkPlanner(); await f.state.batchTask; assert.equal(f.packets.length, 4);
  const first = [...f.records.values()][0]; first.status.state = 'minted'; first.status.progress.minted = 64; first.status.progress.unresolved = 0;
  f.state.resumeBulkPlanner(); await f.state.batchTask;
  assert.equal(f.packets.length, 5); assert.equal(f.packets[4].terms.members.length, 64); assert.equal(f.state.bulkLive().length, 4);
});

test('bulk dashboard keeps funding-deferred blocks and prepares them in another exact order', async t => {
  const f = await setup(t, 8); f.options.prefix = 3; f.state.mintAll(); await f.state.batchTask;
  assert.deepEqual(f.packets.map(p => p.terms.members.length), [3, 3, 2]);
  const blocks = f.packets.flatMap(p => p.terms.members.map(m => m.block)); assert.equal(new Set(blocks).size, 8);
  const orders = await f.state.bulkOrders(); assert.equal(orders.orders.find(o => o.quote.deferred.length === 5).quote.terms.members.length, 3);
});

test('bulk dashboard restarts stale claim cursors without duplicate members and follows empty continuation pages', async t => {
  const f = await setup(t, 70); let stale = true, calls = 0;
  f.state.claims = async ({ cursor }) => {
    calls++;
    if (!cursor) return { claims: f.slots.slice(0, 50), next: 'page2' };
    if (stale) { stale = false; throw Object.assign(Error('claimed_cursor_stale'), { code: 'claimed_cursor_stale' }); }
    if (cursor === 'page2') return { claims: [], next: 'page3' };
    return { claims: f.slots.slice(50), next: null };
  };
  f.state.mintAll(); await f.state.batchTask;
  if (f.state.batch.state === 'waiting_slots') { f.state.resumeBulkPlanner(); await f.state.batchTask; }
  assert.equal(new Set(f.packets.flatMap(p => p.terms.members.map(m => m.block))).size, 70);
  assert.equal(f.packets.reduce((n, p) => n + p.terms.members.length, 0), 70); assert.ok(calls >= 5);
});

test('bulk dashboard reload preserves accepted sets and unknown signed requests; explicit resume sends identical bytes', async t => {
  const f = await setup(t, 4); f.options.failRequest = true; f.state.mintAll(); await f.state.batchTask;
  const packet = structuredClone(f.packets[0]), row = f.state.bulkLive()[0]; assert.equal(f.state.batch.state, 'needs_attention');
  await f.state.close();
  const resumed = f.configure(new DashboardState(f.context)); cleanup(t, () => resumed.close());
  f.options.failRequest = false;
  await resumed.bulkRequest({ actionId: row.actionId, quoteId: row.quote.quoteId, maxPayableFeeAtoms: row.quote.terms.payableFeeAtoms, maxSetAsideSats: 100000 });
  await resumed.batchTask;
  assert.deepEqual(f.packets[1], packet); assert.equal(f.quotes.length, 1); assert.equal(resumed.batch.completed, 4);
});

test('bulk dashboard routes use private access controls and forward exact terms, pages and payment hints over loopback HTTP', async t => {
  const f = await setup(t, 2), { dashboard, call } = await login(t, f);
  assert.equal((await fetch(dashboard.origin + '/api/bulk')).status, 401);
  await call('/api/mint-all', {}); await f.state.batchTask;
  const id = [...f.records.keys()][0];
  assert.equal((await call('/api/bulk/' + id)).status, 200);
  const terms = await (await call('/api/bulk/' + id + '/terms')).json(); assert.equal(terms.terms.owner, f.agent.owner);
  assert.equal((await call(`/api/bulk/${id}/members?offset=0&limit=64`)).status, 200);
  assert.equal((await call(`/api/bulk/${id}/permit?offset=0&limit=17`)).status, 400);
  assert.equal((await call(`/api/bulk/${id}/terms?extra=1`)).status, 400);
  const report = { orderId: id, paymentId: null, commitTxid: 'a'.repeat(64), revealTxid: null };
  assert.equal((await call('/api/bulk/payment', report)).status, 200); assert.deepEqual(f.reports[0], report);
  assert.equal((await call('/api/bulk/payment', { ...report, untrusted: true })).status, 400);
  f.records.get(id).body.terms.owner = 'a'.repeat(64);
  assert.equal((await call('/api/bulk/' + id + '/terms')).status, 403);
});

test('bulk dashboard partitions distinct deployments and does not hold the single-mint click gate', async t => {
  const f = await setup(t, 4); f.slots[2].deployment = f.slots[3].deployment = '9'.repeat(64) + 'i0';
  f.state.mintAll(); await f.state.batchTask;
  assert.equal(f.packets.length, 2); assert.equal(new Set(f.packets.map(p => p.terms.deployment)).size, 2);
  assert.equal(f.state.inflight.size, 0);
});

test('Mint all takes only the chosen pattern and stops after the chosen number of blocks', async t => {
  const f = await setup(t, 10), reads = [], claims = f.state.claims;
  f.slots.slice(6).forEach(slot => { slot.asset = 'p2:2'; });
  f.state.claims = async options => { reads.push(options); return claims(options); };
  f.state.mintAll({ asset: 'p2:2', limit: 3 }); await f.state.batchTask;
  assert.equal(f.packets.length, 1); assert.deepEqual(f.packets[0].terms.members.map(m => m.block), ['900006', '900007', '900008']);
  assert.equal(f.packets[0].terms.asset, 'p2:2'); assert.equal(f.state.batch.state, 'complete'); assert.equal(f.state.batch.completed, 3);
  assert.deepEqual(f.state.batch.filter, { asset: 'p2:2', limit: 3 }); assert.equal(reads[0].asset, 'p2:2');
});

test('blocks in an open bulk order are held from single Mint, and the planner waits at 24 open orders', async t => {
  const f = await setup(t, 64 * 25 + 5);
  f.state.mintAll(); await f.state.batchTask;
  assert.equal(f.packets.length, 24); assert.equal(f.state.batch.state, 'waiting_slots'); assert.equal(f.state.bulkLive().length, 24);
  const held = f.state.bulkHeldBlocks(); assert.equal(held.size, 24 * 64);
  assert.equal(held.has('p2:1/' + f.packets[0].terms.members[0].block), true);
});

test('Mint all into one ticker takes only blocks of that deployment', async t => {
  const f = await setup(t, 4), other = '9'.repeat(64) + 'i0';
  f.slots[1].deployment = other; delete f.slots[3].deployment;
  f.state.mintAll({ asset: 'p2:1', deployment: other }); await f.state.batchTask;
  assert.equal(f.packets.length, 1); assert.equal(f.packets[0].terms.deployment, other);
  assert.deepEqual(f.packets[0].terms.members.map(m => m.block), ['900001', '900003']);
});

test('Mint all checks its filter and refuses a different one while it runs', async t => {
  const f = await setup(t, 2);
  for (const bad of [{ asset: 'x' }, { deployment: 'a'.repeat(64) + 'i0' }, { asset: 'p2:1', limit: 0 }, { asset: 'p2:1', limit: 1.5 }, { blocks: 2 }])
    assert.throws(() => f.state.mintAll(bad), { code: 'invalid_mint_all' });
  const running = f.state.mintAll({ asset: 'p2:1' });
  assert.throws(() => f.state.mintAll({}), { code: 'mint_all_running', status: 409 });
  assert.equal(f.state.mintAll({ asset: 'p2:1' }).id, running.id); await f.state.batchTask;
  assert.equal(f.state.batch.state, 'complete'); assert.notEqual(f.state.mintAll({}).id, running.id); await f.state.batchTask;
});

test('Mint all keeps its filter and count across a restart', async t => {
  const f = await setup(t, 150); f.state.bulkLiveOrders = 1;
  f.slots.slice(0, 20).forEach(slot => { slot.asset = 'p2:2'; });
  const started = f.state.mintAll({ asset: 'p2:1', limit: 100 }); await f.state.batchTask;
  assert.equal(f.packets.length, 1); assert.equal(f.packets[0].terms.members.length, 64); assert.equal(f.state.batch.state, 'waiting_slots');
  await f.state.close();
  const resumed = f.configure(new DashboardState(f.context)); cleanup(t, () => resumed.close()); resumed.bulkLiveOrders = 1;
  assert.deepEqual(resumed.batch.filter, { asset: 'p2:1', limit: 100 }); assert.equal(resumed.batch.id, started.id);
  assert.throws(() => resumed.mintAll({ asset: 'p2:2' }), { code: 'mint_all_running' });
  const minted = () => { for (const row of f.records.values()) Object.assign(row.status, { state: 'minted', payable: false, progress: { reserved: 0, issued: 1, minted: 1, released: 0, unresolved: 0 } }); };
  minted(); resumed.resumeBulkPlanner(); await resumed.batchTask;
  assert.equal(f.packets.length, 2); assert.equal(f.packets[1].terms.members.length, 36);
  minted(); resumed.resumeBulkPlanner(); await resumed.batchTask;
  assert.equal(f.packets.length, 2); assert.equal(resumed.batch.state, 'complete'); assert.equal(resumed.batch.completed, 100);
  const blocks = f.packets.flatMap(p => p.terms.members.map(m => Number(m.block)));
  assert.equal(new Set(blocks).size, 100); assert.ok(blocks.every(block => block >= 900020)); assert.ok(f.packets.every(p => p.terms.asset === 'p2:1'));
});

test('the Mint all route passes a pattern and a count and rejects other fields', async t => {
  const f = await setup(t, 5), { call } = await login(t, f);
  assert.equal((await call('/api/mint-all', { asset: 'p2:1', limit: 2, extra: true })).status, 400);
  const response = await call('/api/mint-all', { asset: 'p2:1', limit: 2 }); assert.equal(response.status, 202);
  assert.deepEqual((await response.json()).filter, { asset: 'p2:1', limit: 2 }); await f.state.batchTask;
  assert.equal(f.packets[0].terms.members.length, 2);
  const orders = await (await call('/api/bulk')).json(); assert.equal(orders.orders.length, 1); assert.deepEqual(orders.planner.filter, { asset: 'p2:1', limit: 2 });
});

async function browser(t, origin, address) {
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage(), errors = []; page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  // Only the page's own origin, plus the Bitcoin fee estimate the funds check reads (answered offline).
  await page.route('**/*', route => { const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : url.origin === 'https://mempool.space' ? route.fulfill({ json: walletFundsReply(url.href) }) : route.abort(); });
  const publicKey = hex(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true)), wallet = tapWallet1049({ address, publicKey, network: 'regtest' });
  await page.exposeFunction('bulkFixtureWallet', (name, args) => wallet.provider[name](...args));
  await page.addInitScript(methods => { window.tapprotocol = Object.fromEntries(methods.map(name => [name, (...args) => window.bulkFixtureWallet(name, args)])); }, Object.keys(wallet.provider));
  return { page, errors, wallet };
}

test('bulk dashboard browser pays one order once, resumes after reload, and distinguishes reveal broadcasts from confirmed mints', async t => {
  const f = await setup(t, 3), dashboard = await serveDashboard(f.context, { state: f.state }); cleanup(t, () => dashboard.close());
  const { page, errors, wallet } = await browser(t, dashboard.origin, f.binding.request.address);
  await page.goto(dashboard.loginLink); await page.waitForURL(dashboard.origin + '/me'); await page.goto(dashboard.origin + '/minter');
  await page.getByRole('button', { name: 'Mint all', exact: true }).click();
  await page.getByRole('button', { name: 'Pay and mint 3 blocks', exact: true }).click();
  await page.getByText('Wallet payment sent. Waiting for confirmed TAP transfers; you can close this page.', { exact: true }).waitFor();
  assert.equal(wallet.state.calls.filter(row => row[0] === 'singleTxTransfer').length, 1);
  await page.reload();
  await page.getByText('Wallet payment sent. Waiting for confirmed TAP transfers; you can close this page.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Pay and mint 3 blocks', exact: true }).count(), 0);
  const row = [...f.records.values()][0]; row.status.state = 'minting'; row.status.payable = false;
  row.status.payment.state = 'paid'; row.status.progress.issued = 3; row.status.progress.reserved = 0;
  row.status.permit = { readyCount: 3, complete: true, root: 'f'.repeat(64) }; row.status.mintSender = { state: 'sent', sentBatches: 1, totalBatches: 1 };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Inscription transactions were sent. Waiting for confirmed TAP mints and final accounting.', { exact: true }).waitFor();
  await page.getByText('Confirmed mints: 0/3 · Released: 0 · Unresolved: 3', { exact: true }).waitFor();
  row.status.state = 'minted'; row.status.progress.minted = 3; row.status.progress.unresolved = 0;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Confirmed mints: 3/3 · Released: 0 · Unresolved: 0', { exact: true }).waitFor();
  assert.equal(wallet.state.calls.filter(row => row[0] === 'singleTxTransfer').length, 1); assert.deepEqual(errors, []);
});

// The public site (service/src/web.mjs) over the fixture's bulk order: the real app shell, routes and views.
async function bulkSite(t, f, id) {
  const { createWeb } = await import('../../service/src/web.mjs');
  const web = createWeb({ target: { network: f.agent.network, bitcoinNetwork: 'regtest' }, records: async () => ({}) });
  const row = f.records.get(id), reports = [], site = { reports, failReports: 0, members: null, tipFail: 0, tip: null }; let origin;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin); res.setHeader('cache-control', 'no-store');
    const send = (value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/web-api/mint/bulk/' + id) return send(row.status);
    if (url.pathname === '/web-api/mint/bulk/' + id + '/terms') return send({ v: 1, orderId: id, terms: row.body.terms, feeManifest: row.body.feeManifest });
    if (url.pathname === '/mint/bulk/' + id + '/members') {
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit')), all = row.body.terms.members;
      return send({ v: 1, orderId: id, offset, next: offset + limit < all.length ? offset + limit : null, count: all.length,
        members: all.slice(offset, offset + limit).map((m, n) => ({ ...m, index: offset + n, memberId: bulkMemberId(id, offset + n), state: site.members ?? 'reserved',
          inscription: site.members === 'minted' ? 'ab'.repeat(32) + 'i' + (offset + n) : null, reason: null })) });
    }
    if (url.pathname === '/mint/bulk/payment') {
      let text = ''; for await (const c of req) text += c; reports.push(JSON.parse(text));
      if (reports.length <= site.failReports) return send({ error: 'bulk_report_temporarily_unavailable' }, 503);
      return send(row.status);
    }
    // The Bitcoin tip the page and the wallet read; tipFail answers that many reads with an error.
    if (url.pathname === '/web-api/tap-reader/getCurrentBlock' && site.tipFail > 0) { site.tipFail--; return send({ error: 'unavailable' }, 503); }
    if (url.pathname === '/web-api/tap-reader/getCurrentBlock' && site.tip) return send({ result: site.tip });
    if (url.pathname.startsWith('/web-api/tap-reader/')) return send(walletFundsReply(url.href));
    // The page first asks whether the order is a public one; this gateway has none (as an older gateway answers).
    if (url.pathname.startsWith('/web-api/public-mints/bulk/')) return send({ error: 'not_found' }, 404);
    if (await web.handle(req, res, async () => '')) return;
    send({ error: 'not_found' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  cleanup(t, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { origin, row, site };
}
const shots = process.env.DMW_BULK_SHOTS;
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('public bulk payment page uses the site design, pays once through the confirmation, and recovers a receipt when the page closes', async t => {
  memberFee = 3607500000000000000n; t.after(() => { memberFee = 100n; });
  const f = await setup(t, 2); f.state.mintAll(); await f.state.batchTask;
  const id = [...f.records.keys()][0], { origin, row, site } = await bulkSite(t, f, id); site.failReports = 2;
  const { page, errors, wallet } = await browser(t, origin, f.binding.request.address), dialogs = [];
  page.on('dialog', dialog => dialogs.push(dialog.message()));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin + '/mint/bulk/' + id);
  await page.getByRole('heading', { name: 'Mint 2 blocks · ' + row.status.ticker, exact: true }).waitFor();
  await page.locator('header.topbar').getByRole('button', { name: 'Connect wallet' }).waitFor();
  assert.equal(await page.locator('nav a.on').getAttribute('href'), '/mint');
  assert.deepEqual(await page.locator('ol.stepper li .l').allInnerTexts(), ['Reserve', 'Pay', 'Permits', 'Mint sent', 'Minted']);
  assert.equal(await page.locator('ol.stepper li[aria-current="step"] .l').innerText(), 'Pay');
  await page.getByText('Remaining to pay', { exact: true }).waitFor();
  assert.equal(await page.locator('.next-step .price').innerText(), '7.215 TAP');
  const fees = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Remaining fees', exact: true }) });
  assert.match(await fees.innerText(), /Treasury\s+7\.215 TAP[\s\S]*/);
  const blocks = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Blocks in this order', exact: true }) });
  assert.deepEqual(await blocks.locator('tbody a').allInnerTexts(), ['900,000', '900,001']);
  assert.equal(await blocks.locator('tbody .pill').first().innerText(), 'reserved');
  const order = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Order', exact: true }) });
  assert.match(await order.innerText(), /Bitcoin for the mint inscriptions[\s\S]*Returned to you after the mint, minus the Bitcoin network fees and the 546 sats per block that stay with the inscriptions\./);
  assert.doesNotMatch(await page.locator('main').innerText(), /unseen|Unresolved|Reveal batches|units ·|[0-9a-f]{64}/);
  if (shots) await page.screenshot({ path: shots + '/bulk-awaiting-1280.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await noSideScroll(page), true);
  if (shots) await page.screenshot({ path: shots + '/bulk-awaiting-390.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Pay and mint 2 blocks', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('heading', { name: 'Pay and mint 2 blocks?', exact: true }).waitFor();
  assert.match(await modal.innerText(), /Bitcoin for the mint inscriptions/); assert.doesNotMatch(await modal.innerText(), /Returned to you/);
  assert.equal(wallet.state.calls.filter(call => call[0] === 'singleTxTransfer').length, 0);
  await modal.getByRole('button', { name: 'Pay and mint', exact: true }).click();
  await page.getByText(/^The wallet or gateway request could not be completed \(bulk_report_temporarily_unavailable\)/).waitFor();
  assert.equal(wallet.state.calls.filter(call => call[0] === 'singleTxTransfer').length, 1);
  await page.reload();
  await page.getByText('Paid. It is counted once Bitcoin confirms it, and the mint goes out automatically. You can close this page.', { exact: true }).waitFor();
  await page.waitForResponse(response => new URL(response.url()).pathname === '/mint/bulk/payment' && response.status() === 200, { timeout: 12000 });
  assert.equal(await page.getByRole('button', { name: 'Pay and mint 2 blocks', exact: true }).count(), 0);
  assert.equal(wallet.state.calls.filter(call => call[0] === 'singleTxTransfer').length, 1);
  assert.equal(site.reports.length, 3); assert.deepEqual(site.reports[0], site.reports[2]);
  assert.equal(site.reports[0].commitTxid, wallet.funding); assert.equal(site.reports[0].paymentId, null);
  // Paid, permits ready, mint sent, then minted: plain progress words and the last step done.
  Object.assign(row.status, { state: 'minting', payable: false, payment: { ...row.status.payment, state: 'paid', reference: 'cd'.repeat(32) + 'i0' },
    permit: { readyCount: 2, complete: true, root: 'f'.repeat(64) }, mintSender: { state: 'sent', sentBatches: 1, totalBatches: 1 } });
  site.members = 'issued';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const mint = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Your mint', exact: true }) });
  await mint.getByText('Done: payment seen on Bitcoin.', { exact: true }).waitFor();
  assert.match(await mint.innerText(), /permits ready 2 of 2\.[\s\S]*mint sent\.[\s\S]*minted 0 of 2\./);
  assert.equal(await blocks.locator('tbody .pill').first().innerText(), 'mint sent');
  row.status.state = 'minted'; row.status.progress = { ...row.status.progress, minted: 2, unresolved: 0, reserved: 0 }; site.members = 'minted';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Minted 2 of 2. The tokens are in your TAP Wallet.', { exact: true }).waitFor();
  assert.equal(await page.locator('ol.stepper li.done').count(), 5);
  assert.equal(await blocks.locator('tbody .pill').first().innerText(), 'minted');
  if (shots) await page.screenshot({ path: shots + '/bulk-minted-1280.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await noSideScroll(page), true);
  if (shots) await page.screenshot({ path: shots + '/bulk-minted-390.png', fullPage: true });
  assert.deepEqual(dialogs, []); assert.deepEqual(errors, []);
});

test('a bulk order paid late shows its fee credit; a refused short window and an unpaid expiry lead to a fresh order', async t => {
  memberFee = 3607500000000000000n; t.after(() => { memberFee = 100n; });
  const f = await setup(t, 2); f.state.mintAll(); await f.state.batchTask;
  const id = [...f.records.keys()][0], { origin, row, site } = await bulkSite(t, f, id);
  const { page, errors, wallet } = await browser(t, origin, f.binding.request.address);
  const lead = page.locator('.next-step .body'), order = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Order', exact: true }) });
  const fits = async name => { for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    // The agent dashboard's header is wider than 1280 px on every page; there only 390 px is checked.
    if (width === 390 || !await page.evaluate(() => window.DMW_LOCAL_AGENT === true)) assert.equal(await noSideScroll(page), true, name + ' fits ' + width + ' px');
    if (shots) await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
  } await page.setViewportSize({ width: 1280, height: 900 }); };
  await page.setViewportSize({ width: 1280, height: 900 });
  // One block left and the page could not read the tip: the wallet itself refuses before any approval.
  const until = Number(row.status.payBy.untilBlock), by = until.toLocaleString('en-US');
  site.tip = String(until - 1); site.tipFail = 1;
  await page.goto(origin + '/mint/bulk/' + id);
  await page.getByText(`Pay by block ${by} (about 10 minutes per block).`, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pay and mint 2 blocks', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pay and mint', exact: true }).click();
  const warn = lead.locator('.callout.warn');
  await warn.getByText('Too little time is left to pay.', { exact: false }).waitFor();
  assert.match(await warn.innerText(), /nothing was paid\. Once it expires, its blocks are released and the agent that made it can start a fresh order\./);
  assert.equal(await page.getByRole('button', { name: 'Pay and mint 2 blocks', exact: true }).count(), 0);
  assert.equal(wallet.state.calls.filter(call => call[0] === 'singleTxTransfer').length, 0);
  assert.equal(site.reports.length, 0);
  await fits('bulk-window-short-site');

  // Paid late: the order expired, released its blocks, and the payment became a fee credit.
  const credit = 'e3'.repeat(32);
  Object.assign(row.status, { state: 'credited', payable: false, reason: 'credited', creditedAmount: '7215000000000000000', creditId: credit,
    credits: [{ id: credit, amount: '3607500000000000000' }, { id: 'e4'.repeat(32), amount: '3607500000000000000' }], creditsCount: 2,
    creditReferences: [{ reference: 'cd'.repeat(32) + 'i0' }], payment: { ...row.status.payment, state: 'paid', reference: 'cd'.repeat(32) + 'i0' } });
  site.members = 'released';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const late = lead.locator('.callout.warn');
  await late.getByText('Your payment arrived after this order expired.', { exact: false }).waitFor();
  assert.match(await late.innerText(), /It became a fee credit of 7\.215 TAP\. Its blocks are released\. It belongs to the agent that made this order/);
  assert.match(await order.innerText(), /State\s+expired, paid late[\s\S]*Fee credit\s+7\.215 TAP\s+In 2 credits/);
  assert.equal(await page.locator('ol.stepper li.bad .l').innerText(), 'Permits');
  assert.doesNotMatch(await page.locator('main').innerText(), /owed back|credited|[0-9a-f]{64}/);
  await fits('bulk-credited-site');

  // On the agent dashboard the credit leads to a new mint and the credit list.
  await page.addInitScript(() => { window.DMW_LOCAL_AGENT = true; });
  await page.reload();
  await lead.getByText('Your agent can use the credit for the fees of a new mint.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Use it for a new mint', exact: true }).getAttribute('href'), '/me?' + new URLSearchParams({ pattern: row.status.asset }));
  assert.equal(await page.getByRole('link', { name: 'Your fee credits', exact: true }).getAttribute('href'), '/me#fee-credits');
  await fits('bulk-credited-dashboard');

  // Expired unpaid: nothing was paid; mint again.
  for (const key of ['reason', 'creditedAmount', 'creditId', 'credits', 'creditsCount']) delete row.status[key];
  Object.assign(row.status, { state: 'expired', creditReferences: [], payment: { ...row.status.payment, state: 'unseen', reference: null } });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await lead.getByText('This order expired before it was paid, so nothing was paid. Its blocks are released for a new order.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Mint again from My agent', exact: true }).count(), 1);
  await fits('bulk-expired-unpaid');

  // A fresh order with six blocks to pay shows the time left in plain words.
  Object.assign(row.status, { state: 'awaiting_payment', payable: true }); site.members = null; site.tip = String(until - 6);
  await page.reload();
  await page.getByText(`Pay within about 1 hour (by block ${by}).`, { exact: true }).waitFor();
  assert.match(await order.innerText(), new RegExp('Pay by\\s+block ' + by));
  await fits('bulk-awaiting-pay-by');
  assert.equal(wallet.state.calls.filter(call => call[0] === 'singleTxTransfer').length, 0);
  assert.deepEqual(errors, []);
});

test('a bulk order with more than 25 blocks lists them 25 per page', async t => {
  const f = await setup(t, 30); f.state.mintAll(); await f.state.batchTask;
  const id = [...f.records.keys()][0], { origin } = await bulkSite(t, f, id);
  const { page, errors } = await browser(t, origin, f.binding.request.address);
  await page.goto(origin + '/mint/bulk/' + id);
  const blocks = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Blocks in this order', exact: true }) });
  await blocks.getByText('1–25 of 30', { exact: true }).waitFor();
  assert.equal(await blocks.locator('tbody tr').count(), 25);
  await blocks.getByRole('button', { name: 'Next ›' }).click();
  await blocks.getByText('26–30 of 30', { exact: true }).waitFor();
  assert.deepEqual(await blocks.locator('tbody a').allInnerTexts(), ['900,025', '900,026', '900,027', '900,028', '900,029']);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await noSideScroll(page), true);
  assert.deepEqual(errors, []);
});

test('the agent dashboard opens a bulk order in the site shell through its proxy', async t => {
  const f = await setup(t, 2); f.state.mintAll(); await f.state.batchTask;
  const id = [...f.records.keys()][0], { origin } = await bulkSite(t, f, id);
  f.state.agent.paymentOrigin = origin;
  const dashboard = await serveDashboard(f.context, { state: f.state }); cleanup(t, () => dashboard.close());
  const { page, errors } = await browser(t, dashboard.origin, f.binding.request.address);
  await page.goto(dashboard.loginLink); await page.waitForURL(dashboard.origin + '/me');
  await page.goto(dashboard.origin + '/mint/bulk/' + id);
  await page.getByRole('heading', { name: /^Mint 2 blocks · / }).waitFor();
  await page.locator('nav').getByRole('link', { name: 'My agent' }).waitFor();
  await page.getByRole('button', { name: 'Pay and mint 2 blocks', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('bulk concurrent exact dashboard retries advance deferred work and counters only once', async t => {
  const f = await setup(t, 5); f.options.prefix = 3; f.options.failRequest = true;
  f.state.mintAll(); await f.state.batchTask; const row = f.state.bulkLive()[0];
  f.options.failRequest = false;
  const args = { actionId: row.actionId, quoteId: row.quote.quoteId, maxPayableFeeAtoms: row.quote.terms.payableFeeAtoms, maxSetAsideSats: 100000 };
  await Promise.all([f.state.bulkRequest(args), f.state.bulkRequest(args)]); await f.state.batchTask;
  assert.equal(f.state.batch.completed, 5);
  assert.deepEqual(f.packets.slice(1).map(p => p.terms.members.length), [3, 2]);
  assert.equal(f.state.bulkLive().length, 2);
});

test('Mint all explicitly resumes an unavailable quote using the saved action and nonce', async t => {
  const f = await setup(t, 2); f.options.failQuote = true;
  const started = f.state.mintAll(); await f.state.batchTask;
  const original = f.state.bulkLive()[0]; assert.equal(f.packets.length, 0); assert.equal(f.state.batch.state, 'needs_attention');
  f.options.failQuote = false; assert.equal(f.state.mintAll().id, started.id); await f.state.batchTask;
  assert.equal(f.quotes[0].nonce, f.quotes[1].nonce); assert.equal(f.state.bulkLive()[0].actionId, original.actionId);
  assert.equal(f.packets.length, 1); assert.equal(f.state.batch.completed, 2);
});

test('bulk orders needing recovery stay on the first page after many newer orders complete', async t => {
  const f = await setup(t, 30); f.state.bulkLiveOrders = 4;
  f.slots.forEach((slot, index) => { slot.deployment = (index + 1).toString(16).padStart(64, '0') + 'i0'; });
  f.state.mintAll(); await f.state.batchTask;
  const oldest = [...f.records.keys()][0];
  while (f.packets.length < f.slots.length) {
    for (const [id, row] of f.records) if (id !== oldest) Object.assign(row.status, { state: 'minted', payable: false,
      progress: { reserved: 0, issued: 1, minted: 1, released: 0, unresolved: 0 } });
    f.state.resumeBulkPlanner(); await f.state.batchTask;
  }
  const first = await f.state.bulkOrders();
  assert.equal(first.orders.length, 25); assert.equal(first.next, 25);
  assert.equal(first.orders.some(row => row.orderId === oldest && !row.terminal), true);
  assert.equal(f.packets.length, 30);
});
