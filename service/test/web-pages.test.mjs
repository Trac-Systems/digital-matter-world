import { rules } from '../src/rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pager, route } from '../public/web/data.js';
import { presentation, site } from '../public/web/api.js';
import { formatTap, fmtAmount } from '../../playground/console/js/amount-format.js';
import { webTarget, WebCheckout } from '../src/web-checkout.mjs';
import { createWeb } from '../src/web.mjs';
import { serve } from '../src/http.mjs';
const id = 'ab'.repeat(32);
test('page routes cover explorer and payment links without interpreting hex keys as agents', () => {
  for (const path of ['/', '/explore', '/block/7', '/plot/7', '/pattern/p0', '/compound/c1', '/table', '/agents', '/records', '/results/payouts', '/mint/'+id, '/link/'+id, '/bind-payout/'+id]) assert.notEqual(route(path).kind, 'missing', path);
  assert.equal(route('/agents/'+id).kind, 'missing');
});
test('mint, link and payout wallets are one page; request links keep their own flow', () => {
  for (const type of ['mint', 'link', 'bind-payout']) {
    assert.deepEqual(route('/' + type), { kind: 'money', type, id: undefined });
    assert.deepEqual(route(`/${type}/${id}/`), { kind: 'money', type, id });
  }
});

test('first-mint asset links reach the public wallet page before a request exists', async t => {
  const web = await serve({ intake: { store: {} }, files: { serve: async () => false }, web: createWeb() }); t.after(() => web.close());
  for (const asset of ['p2:0', 'p2:1', 'p0']) {
    assert.deepEqual(route('/mint/' + asset), { kind: 'money', type: 'mint', id: asset });
    const response = await fetch(web.url + '/mint/' + asset, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/html/);
  }
  assert.equal(route('/mint/p2:01').kind, 'missing');
});
test('results show a summary meaning as words, without changing other keys', () => {
  const shown = presentation({ treasury: { meaning: 'independently_verified_address_balances', tap: '1' }, burn: { meaning: 'verified_accepted_payment_receipts' }, rows: [{ meaning: 'new_key', countMeaning: 'verified_submitted_blocks' }] });
  assert.equal(shown.treasury.meaning, 'Balances checked independently against each address');
  assert.equal(shown.treasury.tap, '1');
  assert.equal(shown.burn.meaning, 'Counted from checked and accepted payment receipts');
  assert.deepEqual(shown.rows, [{ meaning: 'New key', countMeaning: 'verified_submitted_blocks' }]);
  assert.match(site.words.patternBlocks, /submitted so far/);
  assert.equal(site.words.patternBlocksEmpty, 'No blocks submitted yet — agents submit them in pages of up to 100.');
});
test('paging retains filters, uses opaque cursors, replaces rows and discards late replies', async () => {
  const calls = [], p = new Pager('/patterns?asset=p0', 'patterns', { limit: 2, params: { sort: 'number', order: 'asc' }, fetcher: async path => {
    calls.push(path); return { patterns: [{ number: calls.length }], total: 3, next: calls.length === 1 ? 'opaque+/=' : null }; } });
  assert.equal((await p.load()).rows.length, 1); p.at++;
  assert.equal((await p.load()).rows[0].number, 2);
  const url = new URL(calls[1], 'http://local'); assert.equal(url.searchParams.get('cursor'), 'opaque+/='); assert.equal(url.searchParams.get('asset'), 'p0');
  p.reset({ q: 'small' }); await p.load(); assert.ok(!calls[2].includes('cursor'));
  let resolve; p.fetcher = () => new Promise(r => { resolve = r; }); const stale = p.load(); p.reset(); resolve({ patterns: [], total: 0, next: null }); assert.equal(await stale, null);
});
test('amounts use the console exact string boundary and explicit units', () => {
  assert.equal(formatTap('22600000000000000000'), '22.6 TAP'); assert.equal(formatTap('1'), '<0.00000001 TAP');
  assert.equal(fmtAmount('900719925474099300000000000000000000', 18, 18), '900,719,925,474,099,300');
});
test('target projection contains contract addresses and no production endpoints', () => {
  const t = webTarget({ mode: 'prod', network: 'dmw', prod: { ethereum: { chainId: '1', token: 'TOKEN', address: 'ESCROW', secret: 'SECRET', rpc: 'PRIVATE' } } });
  assert.equal(t.bitcoinNetwork, 'mainnet'); assert.equal(t.ethereum.chainId, '0x1'); assert.doesNotMatch(JSON.stringify(t), /PRIVATE|SECRET/);
});
test('checkout projection formats only public terms, never signatures or private row fields', async () => {
  const row = { id, state: 'awaiting_payment', kind: 'tap', payer: 'payer', receiver: 'receiver', request: { owner: '11'.repeat(32), asset: 'p0', block: 7, amount: '2' },
    expiry: 100, paymentHash: 'cc'.repeat(32), signature: 'PRIVATE', authorization: 'PRIVATE', context: { deployment: { kind: 'dmt' }, secrets: 'PRIVATE' },
    quote: { fees:[{role:'treasury',to:'treasury',ticker:'tap',amount:'80000000000000000000',tt:'a'},{role:'burn',to:rules.tapBurnAddress('regtest'),ticker:'tap',amount:'20000000000000000000',tt:'a'}],price: '100000000000000000000', baseFee: '22600000000000000000', split: { treasury: '80000000000000000000', burn: '20000000000000000000', finder: '0', landowner: '0', discoverer: '0' }, destinations: { treasury: 'treasury' }, networkFeeSats: '100000' } };
  const c = new WebCheckout({ store: { get: () => row }, config: { mode: 'regtest', network: 'dmw-regtest', endpoints: { ethereum: 'http://127.0.0.1:1' }, local: { escrow: { chainId: '31337' } } }, reads: { counted: async () => 10 } });
  const p = await c.plan('mint', id); assert.match(p.owner, /^trac1/); assert.equal(p.fees[0].amount,'80000000000000000000');assert.deepEqual(p.blocked,[]);assert.ok(p.redeem.items.some(i=>i.address===rules.tapBurnAddress('regtest')));assert.deepEqual(p.redeem.actions,[]);assert.equal(p.networkFee,null);
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE|authorization|signature/);
  row.quote.fees.at(-1).to = rules.TAP_BURN;
  await assert.rejects(c.plan('mint', id), /tap_payment_item/);
});
test('gateway serves HTML to navigation and retains JSON for clients, with security headers', async t => {
  const web = await serve({ intake: { store: {} }, files: { serve: async () => false }, publicAPI: { handles: path => path === '/agents', read: async () => ({ agents: [] }) }, web: createWeb() });
  t.after(() => web.close());
  const html = await fetch(web.url + '/agents', { headers: { accept: 'text/html' } }); assert.match(html.headers.get('content-type'), /text\/html/); assert.match(await html.text(), /Digital Matter World/);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const json = await fetch(web.url + '/agents', { headers: { accept: 'application/json' } }); assert.deepEqual(await json.json(), { agents: [] });
  assert.equal((await fetch(web.url + '/web/../../run.mjs')).status, 404);
  assert.equal((await fetch(web.url + '/web/amount-format.js')).status, 200);
  const errors = await fetch(web.url + '/web/console/js/wallet-errors.js');
  assert.equal(errors.status, 200); assert.match(await errors.text(), /Your wallet's signature was not accepted/);
});

test('production targets require Ethereum 1 and never fall back to local configuration', () => {
  const local = { escrow: { chainId: '31337' } };
  for (const config of [
    { mode: 'prod', local },
    { mode: 'prod', prod: { ethereum: { chainId: '31337' } } },
    { mode: 'prod', prod: { ethereum: { chainId: '11155111' } } },
    { mode: 'prod', prod: { ethereum: { chainId: '1' } }, local },
    { mode: 'prod', prod: { ethereum: { chainId: '1' } }, endpoints: { ethereum: 'http://127.0.0.1:58545' } },
    { mode: 'unknown', local },
  ]) assert.throws(() => webTarget(config), /web_target_unavailable/);
});
