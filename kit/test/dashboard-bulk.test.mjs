import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hex } from '../lib/inscription-core.mjs';
import { tapWallet1049 } from './tap-wallet-1049-fixture.mjs';
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

function prepared(f, input, count = input.blocks.length) {
  const terms = structuredClone(fixture.terms), feeManifest = [];
  Object.assign(terms, { network: f.agent.network, bitcoinNetwork: 'regtest', owner: input.owner, nonce: input.nonce, asset: input.asset,
    deployment: input.deployment, receiver: input.receiver, payer: input.payer });
  terms.members = input.blocks.slice(0, count).map(block => ({ block, amount: '3' }));
  terms.totalAmount = String(3 * count); terms.membersRoot = bulkMembersRoot(terms.members);
  for (let i = 0; i < count; i++) feeManifest.push({ ...structuredClone(fixture.feeManifest[0]), member: i });
  terms.feeRoot = bulkFeeRoot(feeManifest); terms.groups[0].to = bitcoinAddress();
  terms.groups[0].amount = terms.grossFeeAtoms = terms.payableFeeAtoms = String(100 * count);
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

async function browser(t, origin, address) {
  const browser = await chromium.launch({ headless: true }); cleanup(t, () => browser.close());
  const page = await browser.newPage(), errors = []; page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
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

test('public bulk payment entry and raw web API preserve terms and recover a receipt when the page closes', async t => {
  const f = await setup(t, 2); f.state.mintAll(); await f.state.batchTask;
  const id = [...f.records.keys()][0], row = f.records.get(id), files = new Map([
    ['/web/bulk-mint.js', new URL('../../service/public/web/bulk-mint.js', import.meta.url)],
    ['/web/bulk-wallet.js', new URL('../dashboard/wallet.js', import.meta.url)],
    ['/web/console/js/api.js', new URL('../../service/public/web/api.js', import.meta.url)]
  ]);
  const reports = []; let origin;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin); res.setHeader('cache-control', 'no-store');
    if (files.has(url.pathname)) { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(files.get(url.pathname))); return; }
    if (url.pathname === '/mint/bulk/' + id && req.headers.accept?.includes('text/html')) {
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><div id="app"></div><script type="module" src="/web/bulk-mint.js"></script>'); return;
    }
    const send = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/web-api/target') return send({ bitcoinNetwork: 'regtest' });
    if (url.pathname === '/web-api/mint/bulk/' + id) return send(row.status);
    if (url.pathname === '/web-api/mint/bulk/' + id + '/terms') return send({ v: 1, orderId: id, terms: row.body.terms, feeManifest: row.body.feeManifest });
    if (url.pathname.endsWith('/members')) return send({ v: 1, orderId: id, offset: 0, next: null, count: 2,
      members: row.body.terms.members.map((m, index) => ({ ...m, index, memberId: bulkMemberId(id, index), state: 'reserved', inscription: null, reason: null })) });
    if (url.pathname === '/mint/bulk/payment') {
      let text = ''; for await (const c of req) text += c; reports.push(JSON.parse(text));
      if (reports.length <= 2) { res.statusCode = 503; return send({ error: 'bulk_report_temporarily_unavailable' }); }
      return send(row.status);
    }
    res.statusCode = 404; send({ error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  cleanup(t, () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { page, errors, wallet } = await browser(t, origin, f.binding.request.address);
  await page.goto(origin + '/mint/bulk/' + id);
  await page.getByRole('button', { name: 'Pay and mint 2 blocks', exact: true }).click();
  await page.getByText('bulk_report_temporarily_unavailable', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Payment sent. Waiting for confirmed successful TAP transfers. You can close this page.', { exact: true }).waitFor();
  await page.waitForResponse(response => new URL(response.url()).pathname === '/mint/bulk/payment' && response.status() === 200);
  assert.equal(await page.getByRole('button', { name: 'Pay and mint 2 blocks', exact: true }).count(), 0);
  assert.equal(wallet.state.calls.filter(row => row[0] === 'singleTxTransfer').length, 1);
  assert.equal(reports.length, 3); assert.deepEqual(reports[0], reports[2]);
  assert.equal(reports[0].commitTxid, wallet.funding); assert.equal(reports[0].paymentId, null); assert.deepEqual(errors, []);
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
